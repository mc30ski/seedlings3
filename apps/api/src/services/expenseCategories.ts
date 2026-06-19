import { prisma } from "../db/prisma";

// Configurable expense-category taxonomy. The EXPENSE_CATEGORIES setting is a
// JSON array; each entry maps a category label to its Schedule C line. It is
// the single source of truth for both business-expense categories and the
// Schedule C line numbers used in the QuickBooks export — no hardcoded maps.

/** P&L report section. QB's chart of accounts has an "Account Type"
 *  that determines whether an account rolls into Cost of Goods Sold or
 *  Expenses on the P&L; this is the app's mirror of that decision.
 *
 *    COGS              — Cost of Goods Sold (above Gross Profit on the P&L)
 *    OPERATING_EXPENSE — Operating Expenses (below Gross Profit)
 *    EXCLUDE_FROM_PNL  — category does not appear on the P&L at all.
 *                        Default for newly-added categories — the operator
 *                        must proactively classify a category as COGS or
 *                        Operating Expense before it shows up on the report.
 *                        Safer default than silently lumping rows into a
 *                        section the operator hasn't reviewed. */
export type PlSection = "COGS" | "OPERATING_EXPENSE" | "EXCLUDE_FROM_PNL";

const PL_SECTION_VALUES: PlSection[] = ["COGS", "OPERATING_EXPENSE", "EXCLUDE_FROM_PNL"];

export type ExpenseCategoryConfig = {
  /** Display label, stored verbatim on BusinessExpense.category / Supply.category. */
  label: string;
  /** Schedule C (Form 1040) line number, e.g. "10", "22", "27a". */
  scheduleCLine: string;
  /** QuickBooks chart-of-accounts name this category posts to on import.
   *  Null or empty → row lands in "Unmapped" in the QB CSV so the operator
   *  re-categorizes after import. Must match QB exactly (capitalization /
   *  spacing). A colon-delimited name like "Other business expenses:Payment
   *  processing fees" signals a QB parent:child account; the P&L renderer
   *  parses this to group children under their parent. */
  qbAccount: string | null;
  /** Selectable in expense-logging pickers. false = export-only synthetic
   *  category (e.g. "Payment Processing Fees", which is sourced from Payment
   *  rows, never hand-logged). */
  selectable: boolean;
  /** Which section of the P&L report this category rolls into. Optional in
   *  storage so a live taxonomy that predates this field still validates;
   *  the loader defaults missing values to OPERATING_EXPENSE. Only Supplies
   *  (and any other COGS line you configure) ends up under Cost of Goods
   *  Sold on the P&L. */
  plSection: PlSection;
};

const ALLOWED_KEYS = new Set(["label", "scheduleCLine", "qbAccount", "selectable", "plSection"]);

/**
 * Parse the raw JSON value of the EXPENSE_CATEGORIES setting into a typed
 * array. Throws on shape errors so a bad save can't silently break the export.
 */
export function parseExpenseCategoriesSetting(raw: string | null | undefined): ExpenseCategoryConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("EXPENSE_CATEGORIES setting is not valid JSON.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("EXPENSE_CATEGORIES setting must be a JSON array.");
  }
  return parsed.map((row: any, idx: number) => {
    if (!row || typeof row !== "object") {
      throw new Error(`EXPENSE_CATEGORIES[${idx}] must be an object.`);
    }
    for (const k of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(k)) {
        throw new Error(`EXPENSE_CATEGORIES[${idx}] has unknown field "${k}".`);
      }
    }
    if (typeof row.label !== "string" || !row.label.trim()) {
      throw new Error(`EXPENSE_CATEGORIES[${idx}].label is required.`);
    }
    if (typeof row.scheduleCLine !== "string" || !row.scheduleCLine.trim()) {
      throw new Error(`EXPENSE_CATEGORIES[${idx}].scheduleCLine is required.`);
    }
    // qbAccount is optional in storage to preserve back-compat with older
    // taxonomies that predate the QB-account migration. Empty string is
    // normalized to null (= "Unmapped" in the QB export).
    let qbAccount: string | null = null;
    if (row.qbAccount != null) {
      if (typeof row.qbAccount !== "string") {
        throw new Error(`EXPENSE_CATEGORIES[${idx}].qbAccount must be a string or null.`);
      }
      const trimmed = row.qbAccount.trim();
      qbAccount = trimmed === "" ? null : trimmed;
    }
    // plSection is optional in storage. Missing values default to
    // OPERATING_EXPENSE so the category SHOWS UP on the report —
    // possibly under "Unmapped" if qbAccount is blank — rather than
    // silently disappearing. The previous default (EXCLUDE_FROM_PNL)
    // forced "proactive classification" but the practical effect
    // was silent data loss: operators added expenses, didn't see
    // them on the P&L, and got no signal explaining why. Showing
    // it under Unmapped is recoverable; hiding it isn't.
    //
    // Categories that legitimately should NOT appear on the P&L
    // (e.g. tracked-but-excluded line items) can still be explicitly
    // set to EXCLUDE_FROM_PNL by the operator — that's an opt-out,
    // not the default.
    let plSection: PlSection = "OPERATING_EXPENSE";
    if (row.plSection != null) {
      if (typeof row.plSection !== "string" || !PL_SECTION_VALUES.includes(row.plSection as PlSection)) {
        throw new Error(
          `EXPENSE_CATEGORIES[${idx}].plSection must be one of: ${PL_SECTION_VALUES.join(", ")}.`,
        );
      }
      plSection = row.plSection as PlSection;
    }
    return {
      label: row.label,
      scheduleCLine: row.scheduleCLine,
      qbAccount,
      selectable: row.selectable !== false, // default true if omitted
      plSection,
    };
  });
}

/**
 * Validate the JSON shape for an EXPENSE_CATEGORIES PATCH. Throws on any
 * violation so the Settings route can return a clean 400.
 */
export function validateExpenseCategoriesJson(raw: string): ExpenseCategoryConfig[] {
  const rows = parseExpenseCategoriesSetting(raw);
  if (rows.length === 0) {
    throw new Error("EXPENSE_CATEGORIES must have at least one category.");
  }
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    if (seen.has(rows[i].label)) {
      throw new Error(`Duplicate label "${rows[i].label}" at EXPENSE_CATEGORIES[${i}].`);
    }
    seen.add(rows[i].label);
  }
  return rows;
}

/** Load the parsed taxonomy. Returns [] if the setting is missing or invalid. */
export async function loadExpenseCategories(
  client: typeof prisma | any = prisma,
): Promise<ExpenseCategoryConfig[]> {
  const row = await client.setting.findUnique({ where: { key: "EXPENSE_CATEGORIES" } });
  try {
    return parseExpenseCategoriesSetting(row?.value);
  } catch {
    return [];
  }
}

/** Map of category label → Schedule C line, for the QuickBooks export. */
export async function loadScheduleCLineMap(
  client: typeof prisma | any = prisma,
): Promise<Record<string, string>> {
  const cats = await loadExpenseCategories(client);
  const map: Record<string, string> = {};
  for (const c of cats) map[c.label] = c.scheduleCLine;
  return map;
}

/** Map of category label → QuickBooks chart-of-accounts name. Labels missing
 *  a mapping are simply absent — callers should fall back to "Unmapped". */
export async function loadQbAccountMap(
  client: typeof prisma | any = prisma,
): Promise<Record<string, string>> {
  const cats = await loadExpenseCategories(client);
  const map: Record<string, string> = {};
  for (const c of cats) {
    if (c.qbAccount) map[c.label] = c.qbAccount;
  }
  return map;
}

/** Set of valid category labels (all entries, selectable or not). */
export async function loadCategoryLabels(
  client: typeof prisma | any = prisma,
): Promise<Set<string>> {
  const cats = await loadExpenseCategories(client);
  return new Set(cats.map((c) => c.label));
}

/** Map of category label → P&L section. Backward-compatible: a category
 *  with no plSection set in the live setting defaults to OPERATING_EXPENSE
 *  via the loader. The P&L endpoint calls this once per request. */
export async function loadPlSectionMap(
  client: typeof prisma | any = prisma,
): Promise<Record<string, PlSection>> {
  const cats = await loadExpenseCategories(client);
  const map: Record<string, PlSection> = {};
  for (const c of cats) map[c.label] = c.plSection;
  return map;
}

/**
 * Synthetic P&L categories that don't live in the EXPENSE_CATEGORIES taxonomy
 * because they're not hand-logged BusinessExpense rows — they're computed
 * from Payment / PaymentSplit data at export time. The exports pipeline
 * already hardcodes these qbAccount names; the P&L endpoint reads from this
 * same constant so both stay in sync.
 *
 *   PROCESSOR_FEES   — sourced from Payment.processorFeeAmount.
 *                      Sub-account of "Other business expenses" in QB
 *                      (colon-delimited → renders indented under its parent).
 *   CONTRACT_LABOR   — sourced from contractor PaymentSplit.amount
 *                      (excluding GP-flagged splits) + GP advance disbursements.
 */
export const SYNTHETIC_PL_CATEGORIES = {
  PROCESSOR_FEES: {
    label: "Payment Processing Fees",
    qbAccount: "Other business expenses:Payment processing fees",
    plSection: "OPERATING_EXPENSE" as PlSection,
  },
  CONTRACT_LABOR: {
    label: "Contract labor",
    qbAccount: "Contract labor",
    plSection: "OPERATING_EXPENSE" as PlSection,
  },
} as const;
