import { prisma } from "../db/prisma";

// Configurable expense-category taxonomy. The EXPENSE_CATEGORIES setting is a
// JSON array; each entry maps a category label to its Schedule C line. It is
// the single source of truth for both business-expense categories and the
// Schedule C line numbers used in the QuickBooks export — no hardcoded maps.

export type ExpenseCategoryConfig = {
  /** Display label, stored verbatim on BusinessExpense.category / Supply.category. */
  label: string;
  /** Schedule C (Form 1040) line number, e.g. "10", "22", "27a". */
  scheduleCLine: string;
  /** Selectable in expense-logging pickers. false = export-only synthetic
   *  category (e.g. "Payment Processing Fees", which is sourced from Payment
   *  rows, never hand-logged). */
  selectable: boolean;
};

const ALLOWED_KEYS = new Set(["label", "scheduleCLine", "selectable"]);

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
    return {
      label: row.label,
      scheduleCLine: row.scheduleCLine,
      selectable: row.selectable !== false, // default true if omitted
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

/** Set of valid category labels (all entries, selectable or not). */
export async function loadCategoryLabels(
  client: typeof prisma | any = prisma,
): Promise<Set<string>> {
  const cats = await loadExpenseCategories(client);
  return new Set(cats.map((c) => c.label));
}
