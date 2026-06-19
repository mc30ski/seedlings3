import { prisma } from "../db/prisma";

// Configurable "Payment From" presets. The PAYMENT_FROM_OPTIONS setting
// is a JSON array of small objects; each entry shows up as a dropdown
// option in the Super Money Ledger → Add/Edit Expense dialog's
// "Payment From" picker. Pure presentation taxonomy — the value the
// operator picks (or types via the Other escape hatch) is persisted
// verbatim to BusinessExpense.paymentFrom for reconciliation against
// bank/card statements.

export type PaymentFromOptionConfig = {
  /** Display label, also used as the persisted value. */
  label: string;
};

const ALLOWED_KEYS = new Set(["label"]);

/**
 * Parse the raw JSON value of the PAYMENT_FROM_OPTIONS setting into a
 * typed array. Throws on shape errors so a bad save can't silently
 * break the Expense dialog.
 */
export function parsePaymentFromOptionsSetting(
  raw: string | null | undefined,
): PaymentFromOptionConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAYMENT_FROM_OPTIONS setting is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("PAYMENT_FROM_OPTIONS setting must be a JSON array.");
  }
  return parsed.map((row: any, idx: number) => {
    if (!row || typeof row !== "object") {
      throw new Error(`PAYMENT_FROM_OPTIONS[${idx}] must be an object.`);
    }
    for (const k of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(k)) {
        throw new Error(`PAYMENT_FROM_OPTIONS[${idx}] has unknown field "${k}".`);
      }
    }
    if (typeof row.label !== "string" || !row.label.trim()) {
      throw new Error(`PAYMENT_FROM_OPTIONS[${idx}].label is required.`);
    }
    return { label: row.label.trim() };
  });
}

/**
 * Validate the JSON shape for a PAYMENT_FROM_OPTIONS PATCH. Throws on
 * any violation so the Settings route can return a clean 400.
 * Duplicates are rejected — the dropdown wouldn't be able to
 * disambiguate them anyway.
 */
export function validatePaymentFromOptionsJson(raw: string): PaymentFromOptionConfig[] {
  const rows = parsePaymentFromOptionsSetting(raw);
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const lower = rows[i].label.toLowerCase();
    if (seen.has(lower)) {
      throw new Error(`Duplicate label "${rows[i].label}" at PAYMENT_FROM_OPTIONS[${i}].`);
    }
    seen.add(lower);
  }
  return rows;
}

/** Load the parsed presets. Returns [] if the setting is missing or invalid. */
export async function loadPaymentFromOptions(
  client: typeof prisma | any = prisma,
): Promise<PaymentFromOptionConfig[]> {
  const row = await client.setting.findUnique({ where: { key: "PAYMENT_FROM_OPTIONS" } });
  try {
    return parsePaymentFromOptionsSetting(row?.value);
  } catch {
    return [];
  }
}
