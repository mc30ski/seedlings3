import { prisma } from "../db/prisma";

// Configurable payment-methods taxonomy. The PAYMENT_METHODS setting is a
// JSON array; each entry controls fee, contexts, deep link, and client
// instructions. Adding/removing/modifying methods is a Settings edit — no
// code changes anywhere else.

export type PaymentMethodConfig = {
  /** Unique identifier. Stored verbatim on Payment.method (a plain string —
   *  no DB enum). The taxonomy is the sole source of valid method keys. */
  key: string;
  /** Display name. */
  label: string;
  /** Percentage fee charged by the processor (e.g. 1.9 for Venmo Goods & Services). */
  feePercent: number;
  /** Fixed per-transaction fee in dollars. */
  feeFixed: number;
  /** Visible on the public /pay/[token] page. */
  supportsClientRequest: boolean;
  /** Visible in the worker on-site Initiate Payment dialog. */
  supportsOnSite: boolean;
  /** Optional mobile deep link with {SETTING_KEY} and {{runtimeValue}} placeholders. */
  deepLinkTemplate: string | null;
  /** Optional human instructions with {SETTING_KEY} and {{runtimeValue}} placeholders. */
  instructions: string | null;
  /** When false, hidden everywhere; historical records preserved. */
  active: boolean;
};

export type PaymentContext = "CLIENT_REQUEST" | "ON_SITE" | "ADMIN";

const ALLOWED_KEYS = new Set([
  "key",
  "label",
  "feePercent",
  "feeFixed",
  "supportsClientRequest",
  "supportsOnSite",
  "deepLinkTemplate",
  "instructions",
  "active",
]);

/**
 * Parse the raw JSON value of the PAYMENT_METHODS setting into a typed array.
 * Tolerant of missing fields (sensible defaults applied) but throws on shape
 * errors so a bad save can't silently break payment recording.
 */
export function parsePaymentMethodsSetting(raw: string | null | undefined): PaymentMethodConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAYMENT_METHODS setting is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("PAYMENT_METHODS setting must be a JSON array.");
  }
  return parsed.map((row: any, idx: number) => {
    if (!row || typeof row !== "object") {
      throw new Error(`PAYMENT_METHODS[${idx}] must be an object.`);
    }
    for (const k of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(k)) {
        throw new Error(`PAYMENT_METHODS[${idx}] has unknown field "${k}".`);
      }
    }
    if (typeof row.key !== "string" || !row.key.trim()) {
      throw new Error(`PAYMENT_METHODS[${idx}].key is required.`);
    }
    if (typeof row.label !== "string" || !row.label.trim()) {
      throw new Error(`PAYMENT_METHODS[${idx}].label is required.`);
    }
    return {
      key: row.key,
      label: row.label,
      feePercent: Number(row.feePercent ?? 0) || 0,
      feeFixed: Number(row.feeFixed ?? 0) || 0,
      supportsClientRequest: !!row.supportsClientRequest,
      supportsOnSite: !!row.supportsOnSite,
      deepLinkTemplate: row.deepLinkTemplate == null ? null : String(row.deepLinkTemplate),
      instructions: row.instructions == null ? null : String(row.instructions),
      active: row.active !== false, // default true if omitted
    };
  });
}

/**
 * Validate the JSON shape for a PAYMENT_METHODS PATCH. Same checks as the
 * parser, plus singleton key constraint. Throws on any violation so the
 * Settings route layer can return a clean 400.
 */
export function validatePaymentMethodsJson(raw: string): PaymentMethodConfig[] {
  const rows = parsePaymentMethodsSetting(raw);
  const seenKeys = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (seenKeys.has(r.key)) {
      throw new Error(`Duplicate key "${r.key}" at PAYMENT_METHODS[${i}].`);
    }
    seenKeys.add(r.key);
    if (r.feePercent < 0 || r.feePercent > 100) {
      throw new Error(`feePercent on "${r.key}" must be between 0 and 100.`);
    }
    if (r.feeFixed < 0) {
      throw new Error(`feeFixed on "${r.key}" must be >= 0.`);
    }
  }
  return rows;
}

/**
 * Load the parsed taxonomy from the DB. Returns [] if the setting is missing
 * (covers a fresh production install before the seed has been applied).
 */
export async function loadPaymentMethods(client: typeof prisma | any = prisma): Promise<PaymentMethodConfig[]> {
  const row = await client.setting.findUnique({ where: { key: "PAYMENT_METHODS" } });
  try {
    return parsePaymentMethodsSetting(row?.value);
  } catch {
    // A bad JSON in production shouldn't crash payment recording — surface
    // an empty taxonomy and let the caller fall back to zero-fee defaults.
    return [];
  }
}

/**
 * Filter the taxonomy by context. ADMIN sees ALL active methods regardless
 * of context flags (the admin manual-recording surface mirrors what the
 * business actually accepts, not what's wired into a specific UI).
 */
export function listActivePaymentMethods(
  methods: PaymentMethodConfig[],
  context: PaymentContext,
): PaymentMethodConfig[] {
  const active = methods.filter((m) => m.active);
  if (context === "ADMIN") return active;
  if (context === "CLIENT_REQUEST") return active.filter((m) => m.supportsClientRequest);
  return active.filter((m) => m.supportsOnSite);
}

/**
 * Look up the fee configuration for a given method key. Returns zero-fee as
 * the safe fallback when the key isn't in the taxonomy (e.g. legacy method,
 * or method removed after a payment was recorded).
 */
export function getProcessorFee(
  methodKey: string,
  methods: PaymentMethodConfig[],
): { feePercent: number; feeFixed: number } {
  const found = methods.find((m) => m.key === methodKey);
  if (!found) return { feePercent: 0, feeFixed: 0 };
  return { feePercent: found.feePercent, feeFixed: found.feeFixed };
}

/**
 * Resolve {SETTING_KEY} and {{runtimeValue}} placeholders against current
 * Settings and runtime values. Order:
 *   1. {ALL_CAPS_KEY}   → look up in the Setting rows, replace with value
 *   2. {{lowercase}}    → replace with runtimeValues[key]
 * Missing keys are replaced with the empty string (silent fallback — never
 * leak the raw placeholder string into a deep-link or display).
 *
 * This is the SINGLE path for placeholder substitution in payment-method
 * templates. Inline string replacement elsewhere is a bug.
 */
export function resolvePlaceholders(
  template: string,
  settings: Array<{ key: string; value: string | null }>,
  runtimeValues: Record<string, string | number | null | undefined>,
): string {
  const settingByKey = new Map(settings.map((s) => [s.key, s.value ?? ""]));
  // Step 1: {SETTING_KEY} — ALL_CAPS only, to disambiguate from {{...}}.
  let out = template.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (_, key) => {
    const v = settingByKey.get(key);
    return v == null ? "" : String(v);
  });
  // Step 2: {{runtimeValue}} — lowercase identifier.
  out = out.replace(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
    const v = runtimeValues[key];
    return v == null ? "" : String(v);
  });
  return out;
}

/**
 * Compute the processor fee for a gross amount and a method config.
 * Returns rounded-to-cents values.
 *
 *   processorFeeAmount = round(grossCharged × feePercent / 100 + feeFixed, 2)
 *   netReceived        = grossCharged − processorFeeAmount
 */
export function computeProcessorFee(
  grossCharged: number,
  fee: { feePercent: number; feeFixed: number },
): { processorFeeAmount: number; netReceived: number } {
  const pct = Math.max(0, fee.feePercent);
  const fixed = Math.max(0, fee.feeFixed);
  const raw = grossCharged * (pct / 100) + fixed;
  const processorFeeAmount = Math.round(raw * 100) / 100;
  const netReceived = Math.round((grossCharged - processorFeeAmount) * 100) / 100;
  return { processorFeeAmount, netReceived };
}
