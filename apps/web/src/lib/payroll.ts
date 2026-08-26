import { apiGet, apiPost, apiDelete } from "@/src/lib/api";
import {
  bizToday,
  bizAddDays,
  bizAddMonths,
  bizDaysBetween,
  bizStartOfYear,
  type EtDateKey,
} from "@/src/lib/dates";

// ─────────────────────────────────────────────────────────────────────────────
// Payroll client — mirrors apps/api/src/services/payroll.ts.
// Canonical spec: docs/features/payroll.md.
//
// THE SERVER DECIDES WHAT YOU GET. An admin's response genuinely does not
// contain tax fields; they are not hidden client-side. That is why
// `values` is a partial record rather than a fixed shape — read what is
// present, never assume a field exists.
// ─────────────────────────────────────────────────────────────────────────────

/** Every numeric column the API can return. Presence depends on the viewer. */
export type PayrollValues = Partial<{
  regularHours: number | null;
  regularRate: number | null;
  regularAmount: number | null;
  additionalEarnings: number | null;
  grossEarnings: number | null;
  employeeTaxes: number | null;
  federalIncomeTax: number | null;
  socialSecurityEmployee: number | null;
  medicareEmployee: number | null;
  additionalMedicareEmployee: number | null;
  stateTaxEmployee: number | null;
  employerTaxes: number | null;
  socialSecurityEmployer: number | null;
  medicareEmployer: number | null;
  futaEmployer: number | null;
  stateUnemploymentEmployer: number | null;
  netPay: number | null;
  reimbursements: number | null;
  donations: number | null;
  checkAmount: number | null;
  employerCost: number | null;
}>;

export type PayrollPeriodSummary = {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDay: string;
  label: string | null;
  /** Operator views only. */
  teamTotals?: {
    grossEarnings: number | null;
    netPay: number | null;
    employerCost: number | null;
  };
  /** Worker view only — their own figures for the period. */
  mine?: { grossEarnings: number | null; netPay: number | null };
  entryCount?: number;
  unmatchedCount?: number;
};

export type PayrollEntryView = {
  id: string;
  userId: string | null;
  displayName: string | null;
  rawLastName: string;
  rawFirstName: string;
  employeeType: string | null;
  paymentMethod: string | null;
  values: PayrollValues;
  /** Super only. */
  unmatched?: boolean;
};

export type PayrollPeriodDetail = {
  id: string;
  periodStart: string;
  periodEnd: string;
  payDay: string;
  label: string | null;
  archivedAt?: string | null;
  entries: PayrollEntryView[];
};

export type PayrollLatest = {
  payDay: string;
  periodStart: string;
  periodEnd: string;
  netPay: number | null;
  grossEarnings: number | null;
  periodsOnRecord: number;
};

export type UnmatchedName = {
  lastName: string;
  firstName: string;
  entryCount: number;
};

export type ImportedPeriod = {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  payDay: string;
  label: string | null;
  entryCount: number;
  replaced: boolean;
  unmatched: Array<{ lastName: string; firstName: string }>;
};

/** Present when the server refused the file. */
export type ImportFailure = {
  ok: false;
  error: "PAYROLL_DOES_NOT_BALANCE" | "PAYROLL_UNREADABLE";
  message: string;
  mismatches?: Array<{
    field: string;
    header: string;
    summed: number;
    reported: number;
    difference: number;
  }>;
};

type AsParam = { viewAsUserId?: string | null };

function asQuery(opts?: AsParam): string {
  if (!opts?.viewAsUserId) return "";
  return `?viewAsUserId=${encodeURIComponent(opts.viewAsUserId)}`;
}

// ── Worker surfaces ──────────────────────────────────────────────────────────

export async function fetchMyPayrollPeriods(opts?: AsParam): Promise<PayrollPeriodSummary[]> {
  return apiGet<PayrollPeriodSummary[]>(`/api/me/payroll${asQuery(opts)}`);
}

export async function fetchMyPayrollPeriod(
  periodId: string,
  opts?: AsParam,
): Promise<PayrollPeriodDetail> {
  return apiGet<PayrollPeriodDetail>(`/api/me/payroll/${periodId}${asQuery(opts)}`);
}

/**
 * "Is a pay period of mine sitting unmatched?"
 *
 * Payroll attaches to an account BY NAME, so a name change (marriage, a
 * Gusto typo, Mike vs Michael) imports as an unattributed row and the
 * worker just sees a silent gap. This is the only signal they get that the
 * money exists and is waiting on an admin. Flag + date only — never a name
 * or an amount.
 */
export async function fetchPayrollPendingMatch(
  opts?: AsParam,
): Promise<{ affected: boolean; payDay: string | null }> {
  return apiGet<{ affected: boolean; payDay: string | null }>(
    `/api/me/payroll/pending-match${asQuery(opts)}`,
  );
}

/** Home-tab summary. Null when the worker has no payroll on record. */
export async function fetchMyLatestPayroll(opts?: AsParam): Promise<PayrollLatest | null> {
  return apiGet<PayrollLatest | null>(`/api/me/payroll/latest${asQuery(opts)}`);
}

// ── Operator surfaces ────────────────────────────────────────────────────────

export async function fetchPayrollPeriods(): Promise<PayrollPeriodSummary[]> {
  return apiGet<PayrollPeriodSummary[]>("/api/payroll/periods");
}

export async function fetchPayrollEntries(
  periodId: string,
  forUserId?: string | null,
): Promise<PayrollPeriodDetail> {
  const q = forUserId ? `?userId=${encodeURIComponent(forUserId)}` : "";
  return apiGet<PayrollPeriodDetail>(`/api/payroll/periods/${periodId}/entries${q}`);
}

// ── Super mutations ──────────────────────────────────────────────────────────

export async function importPayrollCsv(
  csvText: string,
  filename: string,
): Promise<{ ok: true; periods: ImportedPeriod[] }> {
  return apiPost<{ ok: true; periods: ImportedPeriod[] }>("/api/payroll/import", {
    csvText,
    filename,
  });
}

export async function fetchUnmatchedPayrollNames(): Promise<UnmatchedName[]> {
  return apiGet<UnmatchedName[]>("/api/payroll/identities/unmatched");
}

export async function linkPayrollIdentity(input: {
  lastName: string;
  firstName: string;
  userId: string;
}): Promise<{ entriesRelinked: number }> {
  return apiPost<{ entriesRelinked: number }>("/api/payroll/identities", input);
}

export async function unlinkPayrollIdentity(input: {
  lastName: string;
  firstName: string;
}): Promise<{ entriesDetached: number }> {
  return apiDelete<{ entriesDetached: number }>("/api/payroll/identities", input);
}

export async function archivePayrollPeriod(periodId: string): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/api/payroll/periods/${periodId}/archive`);
}

// ── Display helpers ──────────────────────────────────────────────────────────

/**
 * Format a payroll figure.
 *
 * Renders null as an em dash rather than $0.00 — blank and zero mean
 * different things in the source data ("not applicable" vs "computed to
 * zero"), and flattening them here would undo the distinction the whole
 * import pipeline preserves.
 */
export function fmtPayrollMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

export function fmtPayrollHours(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(2)} h`;
}

/**
 * Human label for a period, e.g. "Aug 10 – Aug 16". Uses the canonical web
 * date formatters so a YYYY-MM-DD key never rolls a calendar day.
 */
export function payrollPeriodLabel(
  periodStart: string,
  periodEnd: string,
  fmt: (k: string) => string,
): string {
  return `${fmt(periodStart)} – ${fmt(periodEnd)}`;
}

// ── Timeframe selection ──────────────────────────────────────────────────────
//
// Pay periods are whatever was uploaded — weekly today, but the cadence can
// change and the app must not assume one. So the UI never says "this week";
// it filters the periods ON RECORD by their PAY DAY, which is the date a
// worker actually recognises ("when did the money arrive").
//
// Filtering by payDay rather than by period start/end is deliberate: a
// period worked in December and paid in January belongs to the January
// timeframe for anyone reconciling against their bank.

export type PayrollRangeKey = "latest" | "90d" | "6m" | "ytd" | "all";

export const PAYROLL_RANGES: Array<{ key: PayrollRangeKey; label: string }> = [
  { key: "latest", label: "Latest pay period" },
  { key: "90d", label: "Last 90 days" },
  { key: "6m", label: "Last 6 months" },
  { key: "ytd", label: "This year" },
  { key: "all", label: "All time" },
];

export function payrollRangeLabel(key: PayrollRangeKey): string {
  return PAYROLL_RANGES.find((r) => r.key === key)?.label ?? "All time";
}

/**
 * Earliest pay day included by a range, or null for "everything".
 * Uses the canonical ET helpers — a raw Date here would drift a period
 * across a boundary at the exact moment it matters most (year end).
 */
export function payrollRangeStart(key: PayrollRangeKey): EtDateKey | null {
  const today = bizToday();
  switch (key) {
    case "90d":
      return bizAddDays(today, -90);
    case "6m":
      return bizAddMonths(today, -6);
    case "ytd":
      return bizStartOfYear();
    default:
      return null;
  }
}

/**
 * Periods within a range, newest pay day first.
 *
 * "latest" is not a date window — it is literally the most recent period,
 * which is what someone means by "what was I last paid?" even if that
 * payment was months ago.
 */
export function filterPeriodsByRange<T extends { payDay: string }>(
  periods: T[],
  key: PayrollRangeKey,
): T[] {
  const sorted = [...periods].sort((a, b) => b.payDay.localeCompare(a.payDay));
  if (key === "latest") return sorted.slice(0, 1);
  const from = payrollRangeStart(key);
  if (!from) return sorted;
  return sorted.filter((p) => p.payDay >= from);
}

/**
 * Totals across a set of periods, from the WORKER's own figures.
 *
 * Nulls are skipped rather than coerced to 0 — blank and zero mean
 * different things in the source data, and a period with no figure at all
 * shouldn't quietly read as a $0 payday. `counted` reports how many periods
 * actually contributed so the UI can be honest about it.
 */
export function sumMine(
  periods: Array<{ mine?: { grossEarnings: number | null; netPay: number | null } }>,
): { netPay: number; grossEarnings: number; counted: number } {
  let netPay = 0;
  let grossEarnings = 0;
  let counted = 0;
  for (const p of periods) {
    if (!p.mine) continue;
    if (p.mine.netPay != null) netPay += p.mine.netPay;
    if (p.mine.grossEarnings != null) grossEarnings += p.mine.grossEarnings;
    counted += 1;
  }
  return { netPay: round2(netPay), grossEarnings: round2(grossEarnings), counted };
}

/** Same, for the operator view's team totals. */
export function sumTeam(
  periods: Array<{
    teamTotals?: { grossEarnings: number | null; netPay: number | null; employerCost: number | null };
  }>,
): { netPay: number; grossEarnings: number; employerCost: number; counted: number } {
  let netPay = 0;
  let grossEarnings = 0;
  let employerCost = 0;
  let counted = 0;
  for (const p of periods) {
    if (!p.teamTotals) continue;
    if (p.teamTotals.netPay != null) netPay += p.teamTotals.netPay;
    if (p.teamTotals.grossEarnings != null) grossEarnings += p.teamTotals.grossEarnings;
    if (p.teamTotals.employerCost != null) employerCost += p.teamTotals.employerCost;
    counted += 1;
  }
  return {
    netPay: round2(netPay),
    grossEarnings: round2(grossEarnings),
    employerCost: round2(employerCost),
    counted,
  };
}

/** Money is Float in this schema; keep sums at cent precision. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ── Cadence chip ─────────────────────────────────────────────────────────────

/**
 * The pay-cadence chip shown on a period row.
 *
 * DERIVED FROM THE DATES, not from Gusto's label. Real exports disagree
 * with each other: the same operator's weekly runs came through as both
 *   "Weekly Payroll payroll period"   -> label "Weekly Payroll"
 * and
 *   "Payroll period"                  -> label "" -> null, no chip at all
 * so identical runs rendered differently. The period length is the one
 * thing that is always present and always true.
 *
 * Gusto's own label still wins when it says something the dates CANNOT —
 * "Off-Cycle Payroll", "Bonus" — because that is real information. It is
 * only ignored when it merely restates the cadence, which is exactly the
 * case that was inconsistent.
 */
export function payrollCadenceLabel(
  periodStart: string,
  periodEnd: string,
  label?: string | null,
): string | null {
  const raw = (label ?? "").trim();

  // A label that isn't just a cadence word carries information the dates
  // can't (off-cycle, bonus, correction). Keep it.
  if (raw && !/^(weekly|bi-?weekly|semi-?monthly|monthly)\s*payroll$/i.test(raw)) {
    return raw;
  }

  // Inclusive span: a Mon–Sun week is 7 days, not 6.
  const days = bizDaysBetween(periodStart as EtDateKey, periodEnd as EtDateKey) + 1;
  if (!Number.isFinite(days) || days <= 0) return raw || null;

  if (days === 7) return "Weekly";
  if (days === 14) return "Bi-weekly";
  if (days >= 15 && days <= 16) return "Semi-monthly";
  if (days >= 28 && days <= 31) return "Monthly";
  // Anything else is genuinely unusual — say the length rather than guess
  // a cadence name for it.
  return `${days}-day period`;
}

// ── Pending pay day ──────────────────────────────────────────────────────────

/**
 * Has this period's money not landed yet?
 *
 * A payroll is usually RUN before its pay day — Gusto's export exists days
 * ahead of the deposit. Such a period is real and its figures are final,
 * but calling it "Paid 8/28" on the 26th is simply false.
 *
 * Derived from today's date, never stored: the chip disappears on its own
 * the morning the pay day arrives, with no job, no flag to flip, and no
 * risk of a row being left permanently "pending".
 */
export function isPayDayPending(payDay: string): boolean {
  return !!payDay && payDay > bizToday();
}

/** "Paid" once the money has landed, "Pays" while it is still ahead. */
export function payDayVerb(payDay: string): "Paid" | "Pays" {
  return isPayDayPending(payDay) ? "Pays" : "Paid";
}
