// ─────────────────────────────────────────────────────────────────────────────
// Payroll import — Gusto Payroll Journal CSV adapter.
//
// Canonical spec: docs/features/payroll.md.
//
// PURE PARSING ONLY. No Prisma, no R2, no auth. Everything here is a
// deterministic function of the uploaded text, which is what makes it
// testable against the real export byte-for-byte
// (__fixtures__/gusto-payroll-journal.csv).
//
// Named an ADAPTER on purpose: Gusto pays 1099 contractors through a
// different report with a different shape. When that lands it becomes a
// second adapter beside this one, selected by PayrollSourceKind — not an
// `if` bolted into this function.
// ─────────────────────────────────────────────────────────────────────────────

import {
  parseUsDateToEtDateKey,
  parseUsDateRangeToEtDateKeys,
  type EtDateKey,
} from "../lib/dates";

// ── CSV tokenizer ────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV → rows of raw cell strings.
 *
 * Hand-rolled rather than pulling a dependency: the repo has no CSV parser
 * (exports.ts only generates), and the grammar this needs is small.
 *
 * `split(",")` is NOT sufficient and never was — the real export contains
 *   "225 Stony Branch Trl, Chapel Hill, NC 27516"
 * as a single field, with two commas inside the quotes.
 *
 * Handles: quoted fields, escaped quotes (""), embedded commas and
 * newlines, and CRLF. A trailing newline does not produce a phantom row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // has the current row seen any content?

  const endField = () => {
    row.push(field);
    field = "";
    started = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // "" inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch === "\r") {
      // CRLF — swallow; the \n does the work.
    } else {
      field += ch;
      started = true;
    }
  }

  // Final row, unless the file ended on a clean newline.
  if (started || field.length > 0 || row.length > 0) endRow();

  return rows;
}

// ── Column mapping ───────────────────────────────────────────────────────────

/**
 * One parsed money/hours column.
 *
 * `additive` is load-bearing for the conservation check. Most columns sum
 * across employees; RATES DO NOT. In the real export the two hourly workers
 * are both at 7.25 and the "Payroll Totals" row reports 7.25 — not 14.50.
 * Summing a rate column and comparing it to the totals row would reject
 * every legitimate upload.
 */
type NumericColumn = {
  field: NumericField;
  additive: boolean;
};

export type NumericField =
  | "regularHours"
  | "regularRate"
  | "regularAmount"
  | "additionalEarnings"
  | "grossEarnings"
  | "employeeTaxes"
  | "federalIncomeTax"
  | "socialSecurityEmployee"
  | "medicareEmployee"
  | "additionalMedicareEmployee"
  | "stateTaxEmployee"
  | "employerTaxes"
  | "socialSecurityEmployer"
  | "medicareEmployer"
  | "futaEmployer"
  | "stateUnemploymentEmployer"
  | "netPay"
  | "reimbursements"
  | "donations"
  | "checkAmount"
  | "employerCost";

/** Exact header → field. Checked before the patterns below. */
const EXACT_NUMERIC: Record<string, NumericColumn> = {
  "Regular (Hours)": { field: "regularHours", additive: true },
  "Regular (Rate)": { field: "regularRate", additive: false },
  "Regular (Amount)": { field: "regularAmount", additive: true },
  "Additional Earnings": { field: "additionalEarnings", additive: true },
  "Gross Earnings": { field: "grossEarnings", additive: true },
  "Employee Taxes": { field: "employeeTaxes", additive: true },
  "Federal Income Tax (Employee)": { field: "federalIncomeTax", additive: true },
  "Social Security (Employee)": { field: "socialSecurityEmployee", additive: true },
  // These two are safe from collision because lookup is exact-key equality
  // on this Record — there is no substring matching, so "Medicare
  // (Employee)" cannot swallow "Additional Medicare (Employee)". Do NOT
  // "simplify" this into an includes()/startsWith() scan.
  "Medicare (Employee)": { field: "medicareEmployee", additive: true },
  "Additional Medicare (Employee)": { field: "additionalMedicareEmployee", additive: true },
  "Employer Taxes": { field: "employerTaxes", additive: true },
  "Social Security (Employer)": { field: "socialSecurityEmployer", additive: true },
  "Medicare (Employer)": { field: "medicareEmployer", additive: true },
  "FUTA (Employer)": { field: "futaEmployer", additive: true },
  "Net Pay": { field: "netPay", additive: true },
  Reimbursements: { field: "reimbursements", additive: true },
  Donations: { field: "donations", additive: true },
  "Check Amount": { field: "checkAmount", additive: true },
  "Employer Cost": { field: "employerCost", additive: true },
};

/**
 * Jurisdiction-dependent headers, matched by PATTERN.
 *
 * Gusto names state lines after the state: "NC State Tax (Employee)",
 * "NC Unemployment Tax (Employer)". Hire someone in SC and the literal
 * changes. Matching on the invariant part means the first out-of-state
 * hire doesn't silently drop a tax column on the floor.
 *
 * The original header is preserved verbatim in each entry's `raw`, so the
 * specific state remains recoverable.
 */
const PATTERN_NUMERIC: Array<{ re: RegExp; col: NumericColumn }> = [
  { re: /^[A-Z]{2} State Tax \(Employee\)$/, col: { field: "stateTaxEmployee", additive: true } },
  {
    re: /^[A-Z]{2} Unemployment Tax \(Employer\)$/,
    col: { field: "stateUnemploymentEmployer", additive: true },
  },
];

function numericColumnFor(header: string): NumericColumn | null {
  const h = header.trim();
  // Exact before pattern. No current pattern can match an exact header, so
  // the order is not load-bearing today — it is defensive against a future
  // pattern broad enough to shadow one (e.g. /Medicare/).
  if (EXACT_NUMERIC[h]) return EXACT_NUMERIC[h];
  for (const { re, col } of PATTERN_NUMERIC) if (re.test(h)) return col;
  return null;
}

/**
 * Parse a money/hours cell.
 *
 * BLANK IS NOT ZERO — this is the rule the whole model hangs on. In the
 * real export Caleb's `Regular (Hours)` is "" while his `Gross Earnings`
 * is "0.00"; Jacob's `FUTA (Employer)` is "" while Justin's is "3.38".
 * Empty means "not applicable", 0.00 means "computed to zero". Collapsing
 * them makes "did we owe FUTA this period?" unanswerable, so "" → null.
 *
 * Tolerates thousands separators, currency symbols, and parenthesised
 * negatives — Gusto writes plain numbers today, but a reader that throws
 * on "$1,290.08" would be a latent import failure.
 */
export function parseMoneyCell(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;

  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[()$,\s]/g, "");
  if (cleaned === "") return null;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new Error(`parseMoneyCell: not a number: ${raw}`);
  }
  return negative ? -n : n;
}

// ── Parsed shapes ────────────────────────────────────────────────────────────

export type ParsedPayrollEntry = {
  rawLastName: string;
  rawFirstName: string;
  workAddress: string | null;
  employeeType: string | null;
  paymentMethod: string | null;
  /** Typed numeric fields; every one nullable (see parseMoneyCell). */
  values: Partial<Record<NumericField, number | null>>;
  /** Complete source row keyed by original header, verbatim. */
  raw: Record<string, string>;
};

export type ParsedPayrollPeriod = {
  periodStart: EtDateKey;
  periodEnd: EtDateKey;
  payDay: EtDateKey;
  /** Gusto's descriptive label, e.g. "Weekly Payroll". Display only. */
  label: string | null;
  entries: ParsedPayrollEntry[];
  /** The "Payroll Totals" row: typed values + verbatim raw. */
  totals: {
    values: Partial<Record<NumericField, number | null>>;
    raw: Record<string, string>;
  };
  /** Header row exactly as it appeared, for provenance. */
  headers: string[];
};

export class PayrollParseError extends Error {}

// ── Adapter ──────────────────────────────────────────────────────────────────

const TOTALS_LABEL = "Payroll Totals";

/**
 * Parse a Gusto Payroll Journal CSV into one or more periods.
 *
 * MULTIPLE SECTIONS ARE SUPPORTED. A journal contains one "Employee
 * Earnings" block per pay schedule, so a company running weekly and
 * bi-weekly payrolls exports both in one file. Taking only the first would
 * silently drop people's pay.
 *
 * Throws PayrollParseError on anything it cannot read unambiguously. An
 * import that fails loudly beats a period filed under the wrong week.
 */
export function parseGustoPayrollJournal(text: string): ParsedPayrollPeriod[] {
  const rows = parseCsv(text);
  const periods: ParsedPayrollPeriod[] = [];

  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] ?? "").trim() !== "Employee Earnings") continue;
    periods.push(parseSection(rows, i));
  }

  if (periods.length === 0) {
    throw new PayrollParseError(
      'No "Employee Earnings" section found. Is this a Gusto Payroll Journal export?',
    );
  }
  return periods;
}

function parseSection(rows: string[][], sectionIdx: number): ParsedPayrollPeriod {
  // ── Period + pay day: the two lines between the section marker and the
  //    header row. Matched by their label rather than by fixed offset, so a
  //    future Gusto tweak that adds a line doesn't shift everything.
  let periodStart: EtDateKey | null = null;
  let periodEnd: EtDateKey | null = null;
  let payDay: EtDateKey | null = null;
  let label: string | null = null;
  let headerIdx = -1;

  for (let i = sectionIdx + 1; i < rows.length; i++) {
    const first = (rows[i][0] ?? "").trim();
    const second = rows[i][1] ?? "";

    if (/payroll period$/i.test(first)) {
      const range = parseUsDateRangeToEtDateKeys(second);
      periodStart = range.start;
      periodEnd = range.end;
      // "Weekly Payroll payroll period" -> "Weekly Payroll"
      label = first.replace(/\s*payroll period$/i, "").trim() || null;
      continue;
    }
    if (/^pay day$/i.test(first)) {
      payDay = parseUsDateToEtDateKey(second);
      continue;
    }
    if (first === "Last Name") {
      headerIdx = i;
      break;
    }
    // A blank line or an unrecognised label between marker and header is
    // tolerated; anything else means the shape changed underneath us.
  }

  if (headerIdx === -1) {
    throw new PayrollParseError('Section has no "Last Name" header row.');
  }
  if (!periodStart || !periodEnd) {
    throw new PayrollParseError("Section has no payroll period line.");
  }
  if (!payDay) {
    throw new PayrollParseError("Section has no pay day line.");
  }

  const headers = rows[headerIdx].map((h) => h.trim());
  const idxOf = (name: string) => headers.indexOf(name);

  const lastNameIdx = idxOf("Last Name");
  const firstNameIdx = idxOf("First Name");
  const addressIdx = idxOf("Work Address");
  const typeIdx = idxOf("Employee Type");
  const paymentIdx = idxOf("Payment");

  // Header index -> typed column, resolved once.
  const numericCols = headers.map((h) => numericColumnFor(h));

  const readRow = (row: string[]) => {
    const raw: Record<string, string> = {};
    const values: Partial<Record<NumericField, number | null>> = {};
    headers.forEach((h, c) => {
      const cell = row[c] ?? "";
      raw[h] = cell;
      const col = numericCols[c];
      if (col) values[col.field] = parseMoneyCell(cell);
    });
    return { raw, values };
  };

  const entries: ParsedPayrollEntry[] = [];
  let totals: ParsedPayrollPeriod["totals"] | null = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const first = (row[0] ?? "").trim();

    // Blank separator line ends nothing on its own — Gusto pads sections.
    if (row.every((c) => (c ?? "").trim() === "")) continue;
    // The next section's marker ends this one.
    if (first === "Employee Earnings") break;

    if (first === TOTALS_LABEL) {
      const { raw, values } = readRow(row);
      totals = { raw, values };
      break; // Totals is always last within a section.
    }

    const { raw, values } = readRow(row);
    entries.push({
      rawLastName: first,
      rawFirstName: (firstNameIdx >= 0 ? row[firstNameIdx] ?? "" : "").trim(),
      workAddress: addressIdx >= 0 ? (row[addressIdx] ?? "").trim() || null : null,
      employeeType: typeIdx >= 0 ? (row[typeIdx] ?? "").trim() || null : null,
      paymentMethod: paymentIdx >= 0 ? (row[paymentIdx] ?? "").trim() || null : null,
      values,
      raw,
    });
    void lastNameIdx; // header position asserted above; first cell is the name
  }

  if (!totals) {
    throw new PayrollParseError(
      `Section is missing its "${TOTALS_LABEL}" row — the file may be truncated.`,
    );
  }
  if (entries.length === 0) {
    throw new PayrollParseError("Section has no employee rows.");
  }

  return { periodStart, periodEnd, payDay, label, entries, totals, headers };
}

// ── Conservation check ───────────────────────────────────────────────────────

export type ConservationMismatch = {
  field: NumericField;
  /** Original CSV header, so the operator sees the column they recognise. */
  header: string;
  summed: number;
  reported: number;
  difference: number;
};

/**
 * Verify every ADDITIVE column sums across employees to the "Payroll
 * Totals" row.
 *
 * This is the tripwire on a truncated, hand-edited, or misparsed file, and
 * it runs BEFORE anything is persisted — these numbers end up on a
 * worker's screen labelled as what they were actually paid.
 *
 * Rate columns are excluded (see NumericColumn.additive): two workers at
 * $7.25/hr total $7.25 in Gusto's report, not $14.50.
 *
 * Money is Float in this schema (matching Payment.amountPaid), so the
 * comparison is at cent precision. Summing many rows can land a fraction
 * of a cent away from Gusto's total; exact equality would reject those.
 * Anything at or above half a cent is reported.
 */
export function checkConservation(period: ParsedPayrollPeriod): ConservationMismatch[] {
  const mismatches: ConservationMismatch[] = [];

  for (const header of period.headers) {
    const col = numericColumnFor(header);
    if (!col || !col.additive) continue;

    const reported = period.totals.values[col.field];
    if (reported == null) continue; // Gusto left the total blank — nothing to check.

    let summed = 0;
    let sawValue = false;
    for (const e of period.entries) {
      const v = e.values[col.field];
      if (v == null) continue; // blank ≠ zero, but contributes nothing to a sum
      summed += v;
      sawValue = true;
    }
    if (!sawValue && reported === 0) continue;

    const diff = round2(summed) - round2(reported);
    if (Math.abs(diff) >= 0.005) {
      mismatches.push({
        field: col.field,
        header,
        summed: round2(summed),
        reported: round2(reported),
        difference: round2(diff),
      });
    }
  }

  return mismatches;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
