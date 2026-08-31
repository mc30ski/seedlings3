import { prisma } from "../db/prisma";
import { etFormatDate } from "../lib/dates";
import {
  loadExpenseCategories,
  SYNTHETIC_PL_CATEGORIES,
  type PlSection,
} from "./expenseCategories";
import {
  isFixedAsset,
  loadFixedAssetMinCost,
  isEmployeeClass,
  expenseAnchorDateWhere,
  effectiveExpenseDate,
} from "./exports";
import { computeBreakdown, loadRates, type WorkerInput } from "./payments";
import {
  breakdownEmployerTaxes,
  loadPayrollTaxEstimates,
  totalEmployerTaxPct,
} from "./payrollTaxEstimates";

// qbAccount labels for the two synthetic operator-perspective lines.
// Both share a "Payroll" parent so they render grouped (same colon-
// parsed parent/child pattern Vehicle expenses uses) — keeps related
// labor costs together with a "Total for Payroll" subtotal instead of
// scattered across the Expenses section. The "(accrued)" / "(est.)"
// suffixes signal divergence from QB so an operator reconciling
// against QB knows where the gap will be.
const ACCOUNT_WAGES_ACCRUED = "Payroll:Wages (accrued)";
const ACCOUNT_EMPLOYER_PAYROLL_TAXES = "Payroll:Employer payroll taxes (est.)";

/**
 * Compute the W-2 wage base for a period using the CASH-basis anchor:
 * jobs whose `completedAt` falls in [start, end], per-worker net =
 * `promisedPayouts` snapshot (falling back to a runtime `computeBreakdown`
 * for legacy occurrences). Sums employee + trainee splits ONLY.
 *
 * This mirrors the exact math the workdays CSV export uses (which is
 * the Gusto data source), so the P&L's cash-basis wages line matches
 * what the operator actually keys into Gusto for a given work period.
 *
 * Owner-earnings splits are not part of the snapshot at all (they're
 * booked as draws), so they don't need explicit exclusion here.
 */
async function loadCashBasisWageEvents(
  start: Date,
  end: Date,
): Promise<Array<{ occurrenceId: string; userId: string; net: number; completedAt: Date }>> {
  const occs = await prisma.jobOccurrence.findMany({
    where: {
      completedAt: { gte: start, lte: end },
      workflow: { in: ["STANDARD", "ONE_OFF"] as any },
      status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
    },
    select: {
      id: true,
      completedAt: true,
      price: true,
      proposalAmount: true,
      completionSplits: true,
      promisedPayouts: true,
      addons: { select: { price: true } },
      expenses: { select: { cost: true } },
      assignees: {
        // SQL NULL-safety on role (see equipment.ts / exports.ts pattern).
        where: { OR: [{ role: null }, { role: { not: "observer" } }] },
        select: {
          userId: true,
          user: { select: { workerType: true } },
        },
      },
    },
  });
  if (occs.length === 0) return [];
  const rates = await loadRates(prisma);
  const events: Array<{ occurrenceId: string; userId: string; net: number; completedAt: Date }> = [];
  for (const occ of occs) {
    if (!occ.completedAt) continue;
    // Employee/trainee assignees only — this line synthesizes ONLY the
    // W-2 wage base. Contract labor is handled separately via the
    // accrual path (which is the correct model for 1099 contractors —
    // they're paid when the client's payment clears).
    const w2Assignees = occ.assignees.filter((a) => isEmployeeClass(a.user.workerType));
    if (w2Assignees.length === 0) continue;

    // Snapshot path — locked at completion time. Preserves the exact
    // wage that would have been keyed into Gusto for the pay period
    // this workday fell in.
    const snapshot = (occ as any).promisedPayouts as
      | Array<{ userId: string; net: number }>
      | null
      | undefined;
    const snapshotByUser = new Map<string, number>(
      Array.isArray(snapshot)
        ? snapshot.map((r) => [String(r.userId), Number(r.net) || 0] as [string, number])
        : [],
    );

    // Runtime fallback — for legacy occurrences without a snapshot.
    // Uses the same computeBreakdown math the snapshot itself would
    // have captured at completion, so the result is identical modulo
    // any post-completion price/assignee edits.
    const completionSplits = (occ as any).completionSplits as
      | Array<{ userId: string; percent: number }>
      | null
      | undefined;
    const splitPctById = new Map<string, number>(
      Array.isArray(completionSplits)
        ? completionSplits.map((s) => [s.userId, Number(s.percent) || 0])
        : [],
    );
    const active = occ.assignees;
    const fallbackPct = active.length > 0 ? 100 / active.length : 0;
    const workersList: WorkerInput[] = active.map((a) => ({
      userId: a.userId,
      splitPercent: splitPctById.get(a.userId) ?? fallbackPct,
      workerType: a.user.workerType,
    }));
    const priceTotal =
      (occ.price ?? occ.proposalAmount ?? 0) +
      occ.addons.reduce((s, a) => s + (a.price ?? 0), 0);
    const expTotal = occ.expenses.reduce((s, e) => s + (e.cost ?? 0), 0);
    const fallbackBreakdown = computeBreakdown(priceTotal, expTotal, workersList, rates);

    for (const a of w2Assignees) {
      const snapshotNet = snapshotByUser.get(a.userId);
      let net: number;
      if (snapshotNet != null && snapshotNet > 0) {
        net = snapshotNet;
      } else {
        const promisedRow = fallbackBreakdown.find((r) => r.userId === a.userId);
        if (!promisedRow || promisedRow.net <= 0) continue;
        net = promisedRow.net;
      }
      events.push({
        occurrenceId: occ.id,
        userId: a.userId,
        net,
        completedAt: occ.completedAt,
      });
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L Report — structured Profit & Loss for the in-app P&L Report tab.
//
// Mirrors QuickBooks Online's P&L:
//   Income → Cost of Goods Sold → Gross Profit → Expenses → Net Operating
//   Income.
//
// All filters match the QB Income + QB Expenses exports exactly so the
// in-app numbers reconcile against QB to the penny:
//   • Income: Payment.confirmedAt + Checkout.releasedAt
//   • Expenses: BusinessExpense.date (operating, fixed assets excluded)
//                Payment.confirmedAt (processor fees)
//                Payment.confirmedAt (contractor PaymentSplit)
//   • Cash basis throughout (confirmed, !writtenOff)
//
// Section assignment (COGS vs OPERATING_EXPENSE) is config-driven via the
// EXPENSE_CATEGORIES taxonomy's plSection field. Synthetic categories
// (Processor Fees, Contract Labor) come from SYNTHETIC_PL_CATEGORIES.
//
// Account hierarchy: QB chart-of-account names with a colon (e.g.
// "Other business expenses:Payment processing fees") are parsed as
// parent:child. The report groups children under their parent and emits
// a "Total for {parent}" subtotal row to match QB's P&L rendering.
// ─────────────────────────────────────────────────────────────────────────────

export type PnLRow = {
  qbAccount: string;
  total: number;
  /** Present only when at least some of the dollars under this account
   *  are not fully tax-deductible (i.e. a contributing EXPENSE_CATEGORIES
   *  row had `taxDeductiblePercent < 100`). The UI uses this to render
   *  the row as a parent with two children — "(X% deductible)" and
   *  "(non-deductible)" — plus a footnote, while still preserving
   *  `total` (cash truth) and QB-line reconciliation. */
  taxBreakdown?: {
    /** Effective deductible % across this row's contributing dollars.
     *  When all dollars came from a single category, this is the
     *  category's own taxDeductiblePercent. When the row aggregates
     *  multiple categories (rare — same qbAccount, different
     *  deductibility), it's the weighted average rounded to one
     *  decimal so the label reads cleanly. */
    deductiblePct: number;
    /** Dollar amount that reduces taxable income. */
    deductibleAmount: number;
    /** Dollar amount that does NOT reduce taxable income (added back
     *  when computing Estimated Taxable Operating Income). */
    nonDeductibleAmount: number;
  };
};

export type PnLExpenseGroup = {
  /** Parent account name (everything before the first ":"). */
  parent: string;
  /** Sum of rows tagged at exactly the parent (qbAccount === parent, no colon). */
  directTotal: number;
  /** Child rows under this parent. Each child's qbAccount keeps the full
   *  "parent:child" form so the UI can display the leaf name. */
  children: PnLRow[];
  /** directTotal + sum(children). */
  subtotal: number;
};

/** A bucket of rows for one section (COGS or Operating Expenses), pre-grouped
 *  by colon-delimited parent so the renderer can show parent:child hierarchy
 *  with subtotals. `flat` holds single-account rows with no colon. */
export type PnLBucket = {
  groups: PnLExpenseGroup[];
  flat: PnLRow[];
  total: number;
};

/** One row of the per-component breakdown attached to the synthetic
 *  "Employer payroll taxes (est.)" line. Surfaced separately on the
 *  PnLReport so the UI can render the expandable detail without a
 *  follow-up roundtrip. */
export type EmployerPayrollTaxComponent = {
  /** Stable component key ("socialSecurity" | "medicare" | "futa" | "suta"). */
  key: string;
  /** Display label (e.g. "Social Security"). */
  label: string;
  /** Rate as a percentage, e.g. 6.2 for 6.20%. */
  ratePct: number;
  /** Dollar contribution = wages × ratePct / 100. */
  amount: number;
};

export type PnLReport = {
  range: { from: string; to: string };
  /** Which wage-anchor mode this report was built with. "accrual" is
   *  the default and matches every historical caller — wages are
   *  anchored on Payment.confirmedAt, matching the revenue they
   *  earned (accountants' matching principle → NOI signals whether
   *  the WORK BILLED this period was profitable). "cash" anchors
   *  wages on JobOccurrence.completedAt, matching the workdays CSV
   *  export (the Gusto source of truth) — the number the operator
   *  actually keyed into payroll for the pay period this work fell
   *  in. Other than the wages + employer-tax lines, both modes are
   *  identical. */
  mode: PnLMode;
  income: { rows: PnLRow[]; total: number };
  cogs: PnLBucket;
  grossProfit: number;
  expenses: PnLBucket;
  netOperatingIncome: number;
  /** Sum of BusinessExpense rows at or above the fixed-asset threshold
   *  (i.e. rows treated as capital expenditures for GAAP). Not part of
   *  netOperatingIncome — those dollars live in the `excluded` bucket
   *  under "Fixed Assets (capitalized)". Surfaced as its own field so
   *  the UI can render the cash-adjusted subtotal below NOI without
   *  parsing the excluded bucket structure. */
  fixedAssetPurchases: number;
  /** Cash reality after equipment purchases:
   *    operatingCashAfterCapEx = netOperatingIncome − fixedAssetPurchases
   *  The number the operator wants to see for "how much did I actually
   *  keep this period after buying the mower." Their CPA makes the
   *  §179 vs multi-year depreciation call at tax time — the app just
   *  shows both numbers so decision-making has context. */
  operatingCashAfterCapEx: number;
  /** Sum of non-deductible dollars across every COGS + Expense row.
   *  Mostly comes from Meals at 50% on the default taxonomy. */
  totalNonDeductibleExpenses: number;
  /** Tax-effective operating profit:
   *    estimatedTaxableOperatingIncome = NOI + totalNonDeductibleExpenses
   *  Adds back the portion of expenses the IRS won't let you deduct
   *  so the number reads as "what taxable operating income would be"
   *  if the period ended right now. NOT a substitute for an actual
   *  tax return — wage-base caps on payroll taxes, depreciation, and
   *  every other timing thing live elsewhere. */
  estimatedTaxableOperatingIncome: number;
  /** Categories explicitly opted out of the P&L (`plSection: EXCLUDE_FROM_PNL`).
   *  Visibility-only — the dollars here do NOT roll into expenses or
   *  netOperatingIncome. Surfaced so silent exclusion can't bite the
   *  operator: every line in the Ledger is accounted for somewhere on
   *  the report. */
  excluded: PnLBucket;
  /** Per-component breakdown of the synthetic "Employer payroll taxes
   *  (est.)" line + the wages base it was applied to. Drives the
   *  expandable detail on the Reconcile P&L. Undefined when there are
   *  no wages in the period (the line itself is suppressed in that
   *  case so there's nothing to expand). */
  employerPayrollTaxes?: {
    /** W-2 wages base = employee-class PaymentSplit.amount (which
     *  already includes top-ups), excluding owner-earnings flagged
     *  rows. Matches the "Wages (accrued)" expense row total. */
    wages: number;
    /** SS / Medicare / FUTA / SUTA in that order. */
    components: EmployerPayrollTaxComponent[];
    /** Sum of components — same as the "Employer payroll taxes
     *  (est.)" expense row total. */
    total: number;
    /** Total rate as a percentage (sum of all component rates). Used
     *  by the UI to render "9.75% of wages" in the row label. */
    totalRatePct: number;
  };
};

const INCOME_ACCOUNT_SERVICES = "Services";

/**
 * Build the P&L report for [start, end]. ET-anchored boundaries are the
 * caller's responsibility (see the route handler for the conversion).
 *
 * Fixed-asset-eligible rows (cost ≥ FIXED_ASSET_MIN_COST, date after
 * FIXED_ASSET_START_DATE) are capitalized to the balance sheet — they
 * don't roll into netOperatingIncome. Instead they land in the
 * `excluded` bucket under "Fixed Assets (capitalized)" AND their total
 * is exposed via `fixedAssetPurchases` so the UI can render the
 * derived subtotal:
 *
 *     Net Operating Income (GAAP)     $8,340
 *     Less: Fixed asset purchases    -$7,000
 *     Operating Cash After CapEx      $1,340
 *
 * The CPA's §179-vs-multi-year-depreciation call happens at tax time
 * outside the app. This report shows both the GAAP number (for
 * reconciliation) and the cash-reality number (for daily decisions).
 */
export type PnLMode = "accrual" | "cash";

export async function buildPnLReport(
  start: Date,
  end: Date,
  options: { fromStr: string; toStr: string; mode?: PnLMode },
): Promise<PnLReport> {
  // Mode gates ONLY the wage-anchor swap at the bottom of this
  // function (and the corresponding drilldowns in pnlReportDetails).
  // Every other query — income, expenses, contract labor, processor
  // fees, fixed assets — is unchanged across modes. Default is
  // "accrual" so every existing caller keeps its exact prior behavior.
  const mode: PnLMode = options.mode ?? "accrual";
  const [
    payments,
    equipmentRentals,
    operatingExpenses,
    feePayments,
    contractorPayments,
    rentalIncomeConfig,
    categories,
    fixedAssetMinCost,
  ] = await Promise.all([
    // Service income — confirmed, non-written-off payments anchored on
    // confirmedAt. Matches the QB Income export's filter exactly.
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        skippedAt: null,
      },
      select: { amountPaid: true },
    }),
    // Equipment rental income — checkouts released in window with a
    // positive billed total. Matches QB Income equipment portion.
    prisma.checkout.findMany({
      where: {
        rentalCost: { gt: 0 },
        releasedAt: { gte: start, lte: end },
      },
      select: { rentalCost: true },
    }),
    // Operating expenses — BusinessExpense rows of type EXPENSE whose
    // effective date is in window. Per-occurrence rows are anchored on
    // occurrence.completedAt (not BE.date); not-yet-completed jobs are
    // excluded entirely. Matches the QB Expenses CSV. Fixed assets are
    // filtered out below (capitalized → balance sheet).
    prisma.businessExpense.findMany({
      where: { type: "EXPENSE", ...expenseAnchorDateWhere(start, end) },
      select: {
        cost: true,
        category: true,
        date: true,
        occurrenceId: true,
        occurrence: { select: { completedAt: true } },
      },
    }),
    // Processor fees synthesized from confirmed payments with a non-zero
    // fee. Same filter as the QB Expenses export's fee section.
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        skippedAt: null,
        processorFeeAmount: { gt: 0 },
      },
      select: { processorFeeAmount: true },
    }),
    // Contract labor + wages base synthesized from PaymentSplit rows on
    // confirmed payments. Deliberately DOES include written-off
    // payments (drops the `writtenOff: false` filter that every other
    // aggregate uses) because the top-up on a write-off is real money
    // the business pays via Gusto — the wages incur employer payroll
    // tax regardless of whether the client paid.
    //
    // Safe for contractors: on a written-off Payment their split
    // resolves to `amount = 0` (pro-rata loss), so including write-off
    // rows can only add employee wages, never inflate contract labor.
    //
    // Skipped rows are still excluded — those "pretend it never
    // happened" and no wages were actually paid.
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        skippedAt: null,
      },
      select: {
        splits: {
          where: { ownerEarnings: false },
          select: {
            amount: true,
            user: { select: { workerType: true } },
          },
        },
      },
    }),
    loadEquipmentRentalIncomeAccount(),
    loadExpenseCategories(),
    loadFixedAssetMinCost(),
  ]);

  // Build the category → (qbAccount, plSection, taxDeductiblePercent)
  // lookup once. Synthetic categories (Wages, Contract Labor, etc.)
  // are 100% deductible and bypass this map — they post directly.
  const catMeta = new Map<string, { qbAccount: string; plSection: PlSection; taxDeductiblePercent: number }>();
  for (const c of categories) {
    catMeta.set(c.label, {
      qbAccount: c.qbAccount ?? "Unmapped",
      plSection: c.plSection,
      taxDeductiblePercent: c.taxDeductiblePercent,
    });
  }

  // ── Income ─────────────────────────────────────────────────────────────────
  const servicesTotal = sum(payments.map((p) => p.amountPaid ?? 0));
  const equipmentRentalTotal = sum(equipmentRentals.map((c) => c.rentalCost ?? 0));
  // Processor fees (Venmo / Zelle / card transaction fees) net against
  // the gross collected, NOT against operating expenses — the business
  // never actually receives those dollars; the processor takes them
  // off the top before deposit. Modeling them as a contra-revenue
  // line under Income gives the operator a clean "this is what
  // actually hit the bank" picture without lumping a third-party
  // skim in with discretionary spend.
  const processorFeesTotal = sum(feePayments.map((p) => p.processorFeeAmount ?? 0));
  const incomeRows: PnLRow[] = [];
  if (servicesTotal > 0) incomeRows.push({ qbAccount: INCOME_ACCOUNT_SERVICES, total: servicesTotal });
  if (equipmentRentalTotal > 0) incomeRows.push({ qbAccount: rentalIncomeConfig, total: equipmentRentalTotal });
  // Render the contra-revenue line as a negative — the web side picks
  // up negative totals and formats with parentheses (QB convention).
  if (processorFeesTotal > 0) {
    incomeRows.push({
      qbAccount: SYNTHETIC_PL_CATEGORIES.PROCESSOR_FEES.qbAccount,
      total: -round2(processorFeesTotal),
    });
  }
  // Alphabetical sort — matches QB's P&L row ordering. Same pattern applies
  // to COGS and Expenses (sorted further down).
  incomeRows.sort((a, b) => a.qbAccount.localeCompare(b.qbAccount));
  const incomeTotal = round2(servicesTotal + equipmentRentalTotal - processorFeesTotal);

  // ── Expenses + COGS ───────────────────────────────────────────────────────
  // Bucket every expense row by qbAccount, tagged with its plSection.
  // Same qbAccount + same plSection → totals roll up; multiple categories
  // mapped to the same qbAccount sum together (rare but possible).
  // We also track per-account deductibility so a partially-deductible
  // category (e.g. Meals at 50%) emits the inline taxBreakdown on its
  // PnLRow downstream.
  const byAccount = new Map<string, {
    total: number;
    deductible: number;
    nonDeductible: number;
    section: PlSection;
  }>();
  const addToAccount = (
    qbAccount: string,
    section: PlSection,
    amount: number,
    deductiblePct: number = 100,
  ) => {
    if (amount === 0) return;
    const deductible = amount * (deductiblePct / 100);
    const nonDeductible = amount - deductible;
    const existing = byAccount.get(qbAccount);
    if (existing) {
      existing.total += amount;
      existing.deductible += deductible;
      existing.nonDeductible += nonDeductible;
    } else {
      byAccount.set(qbAccount, { total: amount, deductible, nonDeductible, section });
    }
  };

  // Parallel bucket for explicitly EXCLUDE_FROM_PNL categories. These
  // dollars do NOT roll into Net Operating Income, but we surface
  // them in a dedicated section at the bottom of the report so the
  // operator can verify that every Ledger entry is accounted for
  // SOMEWHERE — silent disappearance was the problem this whole
  // thread chased down.
  const excludedByAccount = new Map<string, { total: number; section: PlSection }>();
  const addToExcludedAccount = (qbAccount: string, amount: number) => {
    if (amount === 0) return;
    const existing = excludedByAccount.get(qbAccount);
    if (existing) {
      existing.total += amount;
    } else {
      excludedByAccount.set(qbAccount, { total: amount, section: "EXCLUDE_FROM_PNL" });
    }
  };

  // Operating expense rows from BusinessExpense. Fixed-asset-eligible
  // rows are capitalized to the balance sheet (surfaced in the
  // Excluded bucket under "Fixed Assets (capitalized)" for visibility);
  // their total is exposed via `fixedAssetPurchases` on the report so
  // the UI can render the cash-adjusted subtotal below NOI.
  let fixedAssetPurchases = 0;
  for (const r of operatingExpenses) {
    // Capitalization check uses effective date to stay consistent with
    // the QB Expenses CSV's split (see effectiveExpenseDate).
    if (isFixedAsset({ cost: r.cost, date: effectiveExpenseDate(r) }, fixedAssetMinCost)) {
      addToExcludedAccount("Fixed Assets (capitalized)", r.cost);
      fixedAssetPurchases += r.cost;
      continue;
    }
    const meta = catMeta.get(r.category ?? "Other");
    if (meta?.plSection === "EXCLUDE_FROM_PNL") {
      // Explicit opt-out — still surface under "Excluded from P&L"
      // for visibility (not counted in any total).
      addToExcludedAccount(meta.qbAccount ?? "Unmapped", r.cost);
      continue;
    }
    // Unknown categories OR categories with no plSection set →
    // default to OPERATING_EXPENSE under "Unmapped" so the dollars
    // SHOW UP on the report instead of vanishing. The Unmapped
    // bucket is the operator's prompt to reclassify.
    const section: PlSection = meta?.plSection ?? "OPERATING_EXPENSE";
    const qbAccount = meta?.qbAccount ?? "Unmapped";
    addToAccount(qbAccount, section, r.cost, meta?.taxDeductiblePercent ?? 100);
  }

  // Processor fees used to land here as an operating expense — they're
  // now modeled as a contra-revenue line under Income (see above), so
  // the dollars never reach the expense side. Net Operating Income
  // ends up identical either way; the difference is presentation —
  // Income now shows what actually deposited, and Expenses no longer
  // includes a third-party skim mixed in with discretionary spend.

  // Synthetic: Contract Labor + Wages (accrued).
  //
  // Single iteration over the same split set: contractors go to Contract
  // Labor (QB-tied), employees+trainees go to Wages (accrued) — the
  // operator-perspective addition that gives Net Operating Income a
  // meaningful "company kept this" number even before Gusto cuts the
  // payroll check. Owner-earnings splits were filtered out at the query
  // level; they don't belong in either bucket (owner takes draws).
  let contractLaborTotal = 0;
  // Accrual wage total — ALWAYS computed. This is byte-for-byte the
  // same loop that shipped before the mode toggle; the value drives
  // the wages/tax lines when mode==="accrual" (default) and is left
  // unused (but still computed defensively) when mode==="cash".
  let wagesAccruedTotal = 0;
  for (const p of contractorPayments) {
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) {
        // W-2 wages base — sp.amount is already netAmount + topUpAmount
        // (the worker's paycheck gross from the payroll-tax-base
        // perspective), which is what payroll taxes apply to.
        wagesAccruedTotal += sp.amount ?? 0;
      } else {
        contractLaborTotal += sp.amount ?? 0;
      }
    }
  }
  if (contractLaborTotal > 0) {
    addToAccount(
      SYNTHETIC_PL_CATEGORIES.CONTRACT_LABOR.qbAccount,
      SYNTHETIC_PL_CATEGORIES.CONTRACT_LABOR.plSection,
      contractLaborTotal,
    );
  }

  // Cash-basis wage total — computed only when the operator asked for
  // that mode. Same math as the workdays CSV (the Gusto source of
  // truth), anchored on JobOccurrence.completedAt. See
  // loadCashBasisWageEvents for the exact snapshot → fallback rules.
  let wagesCashTotal = 0;
  if (mode === "cash") {
    const events = await loadCashBasisWageEvents(start, end);
    for (const e of events) wagesCashTotal += e.net;
  }

  // Pick the wage total that feeds the "Wages (accrued)" line + the
  // employer-tax base for this response. Accrual is the default so
  // every existing caller behaves exactly as before.
  const effectiveWagesTotal = mode === "cash" ? wagesCashTotal : wagesAccruedTotal;
  if (effectiveWagesTotal > 0) {
    addToAccount(ACCOUNT_WAGES_ACCRUED, "OPERATING_EXPENSE", effectiveWagesTotal);
  }

  // Synthetic: Employer payroll taxes (est.) — operator-tunable rates
  // applied to the wages base above. Only synthesized when there are
  // W-2 wages to tax, otherwise the line is suppressed entirely (same
  // self-hide behavior as Contract Labor when there are no
  // contractors). The per-component breakdown is attached to the
  // PnLReport so the UI can render the expand-detail without another
  // roundtrip — see PnLReport.employerPayrollTaxes.
  let employerPayrollTaxes: PnLReport["employerPayrollTaxes"] | undefined;
  if (effectiveWagesTotal > 0) {
    const taxConfig = await loadPayrollTaxEstimates(prisma);
    const totalRatePct = totalEmployerTaxPct(taxConfig);
    const components = breakdownEmployerTaxes(effectiveWagesTotal, taxConfig);
    const employerTaxTotal = round2((effectiveWagesTotal * totalRatePct) / 100);
    if (employerTaxTotal > 0) {
      addToAccount(ACCOUNT_EMPLOYER_PAYROLL_TAXES, "OPERATING_EXPENSE", employerTaxTotal);
      employerPayrollTaxes = {
        wages: round2(effectiveWagesTotal),
        components,
        total: employerTaxTotal,
        totalRatePct,
      };
    }
  }

  // Split COGS vs OPERATING_EXPENSE, then group each side by colon-parsed
  // parent so QB-style hierarchical accounts ("Cost of goods sold:Direct
  // supplies & materials", "Other business expenses:Payment processing
  // fees") render with proper parent → child indentation and subtotals.
  const cogsRaw: PnLRow[] = [];
  const expenseRaw: PnLRow[] = [];
  // Attach `taxBreakdown` to rows where any contributing category
  // wasn't 100% deductible. The threshold of >0.005 avoids attaching a
  // breakdown to rows where only sub-cent rounding produced a tiny
  // non-deductible amount.
  for (const [qbAccount, { total, deductible, nonDeductible, section }] of byAccount) {
    const row: PnLRow = { qbAccount, total: round2(total) };
    if (nonDeductible > 0.005 && total > 0) {
      row.taxBreakdown = {
        deductiblePct: Math.round((deductible / total) * 1000) / 10,
        deductibleAmount: round2(deductible),
        nonDeductibleAmount: round2(nonDeductible),
      };
    }
    if (section === "COGS") cogsRaw.push(row);
    else expenseRaw.push(row);
  }

  const cogs = groupByParent(cogsRaw);
  const expenses = groupByParent(expenseRaw);

  // Excluded bucket — same shape as cogs/expenses so the renderer
  // can reuse the BucketRows component. Total exists for the section
  // subtotal display; it intentionally does NOT roll into
  // netOperatingIncome.
  const excludedRaw: PnLRow[] = [];
  for (const [qbAccount, { total }] of excludedByAccount) {
    excludedRaw.push({ qbAccount, total: round2(total) });
  }
  const excluded = groupByParent(excludedRaw);

  const grossProfit = round2(incomeTotal - cogs.total);
  const netOperatingIncome = round2(grossProfit - expenses.total);

  // Sum the non-deductible portion across COGS + Expense rows (Income
  // is always fully taxable — non-deductibility is an expense concept).
  // Iterating cogsRaw / expenseRaw catches both flat and parent:child
  // rows without re-walking the grouped bucket structure.
  const totalNonDeductibleExpenses = round2(
    cogsRaw.reduce((s, r) => s + (r.taxBreakdown?.nonDeductibleAmount ?? 0), 0) +
      expenseRaw.reduce((s, r) => s + (r.taxBreakdown?.nonDeductibleAmount ?? 0), 0),
  );
  // Adding back the non-deductible portion that NOI already subtracted
  // yields tax-effective operating profit. If a category is 50%
  // deductible, half the dollars went out the door but only the other
  // half offset taxable income — so taxable income is higher than NOI
  // by that non-deductible half.
  const estimatedTaxableOperatingIncome = round2(
    netOperatingIncome + totalNonDeductibleExpenses,
  );

  return {
    range: { from: options.fromStr, to: options.toStr },
    mode,
    income: { rows: incomeRows, total: incomeTotal },
    cogs,
    grossProfit,
    expenses,
    excluded,
    netOperatingIncome,
    fixedAssetPurchases: round2(fixedAssetPurchases),
    operatingCashAfterCapEx: round2(netOperatingIncome - fixedAssetPurchases),
    totalNonDeductibleExpenses,
    estimatedTaxableOperatingIncome,
    employerPayrollTaxes,
  };
}

/**
 * Group a flat list of {qbAccount, total} rows into parent:child buckets,
 * preserving non-hierarchical entries as flat rows at the top level.
 *
 *   "Other business expenses"                          → flat OR a parent
 *                                                        with a direct total
 *                                                        when a child is
 *                                                        also present
 *   "Other business expenses:Payment processing fees"  → child under
 *                                                        "Other business
 *                                                        expenses"
 *   "Insurance"                                        → flat (no colon)
 *
 * Single-account parents with no children stay flat — no point in showing
 * a "Total for X" subtotal when X has a single line.
 */
function groupByParent(rows: PnLRow[]): PnLBucket {
  type AccBucket = {
    directTotal: number;
    // Accumulated deductibility for the parent's own (no-colon) rows.
    // Children carry their own taxBreakdown on the row object, so we
    // only need to track this for the parent's direct portion.
    directDeductible: number;
    directNonDeductible: number;
    children: PnLRow[];
  };
  const buckets = new Map<string, AccBucket>();
  for (const row of rows) {
    const colon = row.qbAccount.indexOf(":");
    if (colon < 0) {
      const bucket = buckets.get(row.qbAccount) ?? {
        directTotal: 0,
        directDeductible: 0,
        directNonDeductible: 0,
        children: [],
      };
      bucket.directTotal += row.total;
      bucket.directDeductible += row.taxBreakdown?.deductibleAmount ?? row.total;
      bucket.directNonDeductible += row.taxBreakdown?.nonDeductibleAmount ?? 0;
      buckets.set(row.qbAccount, bucket);
    } else {
      const parent = row.qbAccount.slice(0, colon).trim();
      const bucket = buckets.get(parent) ?? {
        directTotal: 0,
        directDeductible: 0,
        directNonDeductible: 0,
        children: [],
      };
      bucket.children.push(row);
      buckets.set(parent, bucket);
    }
  }

  // Build a PnLRow with taxBreakdown attached when applicable. Shared
  // between the flat-row emit and the children-pass-through path so a
  // partially-deductible row renders the same way regardless of
  // whether it sits under a parent.
  const buildRow = (qbAccount: string, total: number, deductible: number, nonDeductible: number): PnLRow => {
    const row: PnLRow = { qbAccount, total: round2(total) };
    if (nonDeductible > 0.005 && total > 0) {
      row.taxBreakdown = {
        deductiblePct: Math.round((deductible / total) * 1000) / 10,
        deductibleAmount: round2(deductible),
        nonDeductibleAmount: round2(nonDeductible),
      };
    }
    return row;
  };

  const groups: PnLExpenseGroup[] = [];
  const flat: PnLRow[] = [];
  for (const [parent, bucket] of buckets) {
    bucket.children.sort((a, b) => a.qbAccount.localeCompare(b.qbAccount));
    if (bucket.children.length === 0) {
      flat.push(buildRow(parent, bucket.directTotal, bucket.directDeductible, bucket.directNonDeductible));
    } else {
      const childrenTotal = sum(bucket.children.map((c) => c.total));
      groups.push({
        parent,
        directTotal: round2(bucket.directTotal),
        children: bucket.children,
        subtotal: round2(bucket.directTotal + childrenTotal),
      });
    }
  }
  groups.sort((a, b) => a.parent.localeCompare(b.parent));
  flat.sort((a, b) => a.qbAccount.localeCompare(b.qbAccount));
  const total = round2(sum(flat.map((r) => r.total)) + sum(groups.map((g) => g.subtotal)));
  return { groups, flat, total };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Read the equipment-rental-income QB account from settings, falling back
 * to the default. We only need the account name here, not the Schedule C
 * line — the P&L groups by account, not by line.
 */
// ─────────────────────────────────────────────────────────────────────────────
// P&L drill-down — returns the per-row breakdown that contributes to a
// specific qbAccount in the report for a given window.
//
// Routes through the same filters + anchoring rules as buildPnLReport
// (cash basis, confirmed + !writtenOff, ET-anchored boundaries, effective-
// date anchoring for per-occurrence expenses) so the rows always sum to
// the section total shown in the main report.
//
// Special qbAccount values that don't come from BusinessExpense:
//   • "Services"                                → confirmed Payment rows
//   • equipment-rental-income account name      → Checkout rentalCost rows
//   • SYNTHETIC.PROCESSOR_FEES.qbAccount        → Payment.processorFeeAmount rows
//   • SYNTHETIC.CONTRACT_LABOR.qbAccount        → non-employee PaymentSplit rows
// Everything else → BusinessExpense rows whose category maps to that qbAccount.
// ─────────────────────────────────────────────────────────────────────────────

export type PnLDetailRow = {
  date: string;       // YYYY-MM-DD, ET-anchored — the anchor used for sorting (mode-dependent).
  primary: string;    // main description (vendor, client, etc.)
  secondary?: string; // optional second line (category, property, source, etc.)
  amount: number;
  // Extra display fields for Wages drill rows (may also be useful for
  // other drills that want to surface the same data). Optional so
  // non-wage drills don't have to populate them.
  /** Worker's percent of the job (from JobOccurrence.completionSplits).
   *  Undefined for one-worker jobs or non-wage rows. */
  splitPercent?: number;
  /** Date the service was performed (JobOccurrence.completedAt).
   *  YYYY-MM-DD, ET. Undefined for rows not tied to an occurrence. */
  serviceDate?: string;
  /** Date the payment was received/confirmed (Payment.confirmedAt).
   *  YYYY-MM-DD, ET. Undefined for non-payment-linked rows. */
  paymentDate?: string;
  /** JobOccurrence.id for occurrence-linked rows (wages drill). Lets
   *  the client make the row a link to the job. */
  occurrenceId?: string;
};

export type PnLDetail = {
  qbAccount: string;
  rows: PnLDetailRow[];
  total: number;
};

export async function pnlReportDetails(
  start: Date,
  end: Date,
  qbAccount: string,
  opts: { mode?: PnLMode } = {},
): Promise<PnLDetail> {
  // Drilldown mode must match the mode the main report was built with,
  // otherwise the row list won't sum to the reported bucket total.
  // Only the wages + employer-tax branches actually vary by mode —
  // every other qbAccount branch below ignores it.
  const mode: PnLMode = opts.mode ?? "accrual";
  const [equipRentalAccount, categories] = await Promise.all([
    loadEquipmentRentalIncomeAccount(),
    loadExpenseCategories(),
  ]);

  // ── Excluded: Fixed Assets (capitalized) ───────────────────────────────
  // Reachable only when the §179 toggle is OFF — otherwise these rows
  // flow to their operator-chosen category and are surfaced via the
  // normal expense drilldown above. Loads every BusinessExpense row
  // whose effective date lies in window AND meets isFixedAsset(),
  // regardless of category.
  if (qbAccount === "Fixed Assets (capitalized)") {
    const expenses = await prisma.businessExpense.findMany({
      where: { type: "EXPENSE", ...expenseAnchorDateWhere(start, end) },
      include: { occurrence: { select: { completedAt: true } } },
    });
    const fixedAssetMinCost = await loadFixedAssetMinCost();
    const rows: PnLDetailRow[] = [];
    for (const r of expenses) {
      const effDate = effectiveExpenseDate(r);
      if (!isFixedAsset({ cost: r.cost, date: effDate }, fixedAssetMinCost)) continue;
      rows.push({
        date: etFormatDate(effDate),
        primary: r.description || r.category || "(uncategorized)",
        secondary: [r.category, r.vendor].filter(Boolean).join(" · ") || undefined,
        amount: round2(r.cost),
      });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Income: Services ────────────────────────────────────────────────────
  if (qbAccount === INCOME_ACCOUNT_SERVICES) {
    const payments = await prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        skippedAt: null,
      },
      select: {
        amountPaid: true,
        confirmedAt: true,
        method: true,
        occurrence: {
          select: {
            job: {
              select: {
                property: {
                  select: { displayName: true, client: { select: { displayName: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
    });
    const rows: PnLDetailRow[] = payments.map((p) => ({
      date: p.confirmedAt ? etFormatDate(p.confirmedAt) : "",
      primary: p.occurrence?.job?.property?.client?.displayName ?? "(unknown client)",
      secondary: [p.occurrence?.job?.property?.displayName, p.method].filter(Boolean).join(" · ") || undefined,
      amount: round2(p.amountPaid ?? 0),
    }));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Income: Equipment Rental ───────────────────────────────────────────
  if (qbAccount === equipRentalAccount) {
    const checkouts = await prisma.checkout.findMany({
      where: {
        rentalCost: { gt: 0 },
        releasedAt: { gte: start, lte: end },
      },
      include: {
        equipment: { select: { shortDesc: true, brand: true, model: true } },
        user: { select: { displayName: true, email: true } },
      },
      orderBy: { releasedAt: "asc" },
    });
    const rows: PnLDetailRow[] = checkouts.map((c) => ({
      date: c.releasedAt ? etFormatDate(c.releasedAt) : "",
      primary: [c.equipment?.brand, c.equipment?.model].filter(Boolean).join(" ") || c.equipment?.shortDesc || "Equipment rental",
      secondary: c.user?.displayName ?? c.user?.email ?? undefined,
      amount: round2(c.rentalCost ?? 0),
    }));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Income contra: Payment Processing Fees (synthetic) ─────────────────
  // Modeled as contra-revenue on the parent report (line shows
  // negative on Income). Drill-down rows mirror that sign so the
  // expanded amounts sum cleanly to the header total — the operator
  // doesn't have to mentally negate.
  if (qbAccount === SYNTHETIC_PL_CATEGORIES.PROCESSOR_FEES.qbAccount) {
    const payments = await prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        skippedAt: null,
        processorFeeAmount: { gt: 0 },
      },
      select: {
        processorFeeAmount: true,
        confirmedAt: true,
        method: true,
        grossCharged: true,
        occurrence: {
          select: {
            job: {
              select: {
                property: {
                  select: { client: { select: { displayName: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
    });
    const rows: PnLDetailRow[] = payments.map((p) => ({
      date: p.confirmedAt ? etFormatDate(p.confirmedAt) : "",
      primary: p.occurrence?.job?.property?.client?.displayName ?? "(unknown client)",
      secondary: `${p.method ?? ""} fee on $${round2(p.grossCharged ?? 0).toFixed(2)} gross`,
      amount: -round2(p.processorFeeAmount ?? 0),
    }));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Expense: Contract Labor (synthetic) ────────────────────────────────
  if (qbAccount === SYNTHETIC_PL_CATEGORIES.CONTRACT_LABOR.qbAccount) {
    const [contractorPayments] = await Promise.all([
      prisma.payment.findMany({
        where: {
          confirmed: true,
          confirmedAt: { gte: start, lte: end },
          writtenOff: false,
          skippedAt: null,
        },
        select: {
          confirmedAt: true,
          occurrence: {
            select: {
              job: {
                select: {
                  property: {
                    select: { client: { select: { displayName: true } } },
                  },
                },
              },
            },
          },
          splits: {
            where: { ownerEarnings: false },
            select: {
              amount: true,
              user: { select: { workerType: true, displayName: true, email: true } },
            },
          },
        },
        orderBy: { confirmedAt: "asc" },
      }),
    ]);
    const rows: PnLDetailRow[] = [];
    for (const p of contractorPayments) {
      for (const sp of p.splits) {
        if (isEmployeeClass(sp.user.workerType)) continue;
        rows.push({
          date: p.confirmedAt ? etFormatDate(p.confirmedAt) : "",
          primary: sp.user.displayName ?? sp.user.email ?? "(unnamed contractor)",
          secondary: p.occurrence?.job?.property?.client?.displayName ?? undefined,
          amount: round2(sp.amount ?? 0),
        });
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Expense: Wages (accrued, synthetic) ─────────────────────────────────
  // Per-payment detail of employee-class PaymentSplit rows confirmed in
  // window. Mirrors the bucket inside buildPnLReport so the drilldown
  // and the top-line total always agree. Owner-earnings flagged splits
  // are excluded (draws, not paychecks) — same filter that gates wages
  // out of Gusto and the Contract Labor synthesis.
  if (qbAccount === ACCOUNT_WAGES_ACCRUED) {
    if (mode === "cash") {
      // Cash-basis drilldown — per-workday wage events anchored on
      // JobOccurrence.completedAt. Matches the workdays CSV export
      // (the Gusto source of truth), so the row list here is what
      // the operator actually keyed into payroll for the pay period
      // this work fell in.
      const events = await loadCashBasisWageEvents(start, end);
      const userIds = Array.from(new Set(events.map((e) => e.userId)));
      const occIds = Array.from(new Set(events.map((e) => e.occurrenceId)));
      const [users, occs, paymentRows] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true, email: true },
        }),
        prisma.jobOccurrence.findMany({
          where: { id: { in: occIds } },
          select: {
            id: true,
            completionSplits: true,
            job: {
              select: {
                property: {
                  select: { displayName: true, client: { select: { displayName: true } } },
                },
              },
            },
          },
        }),
        // paymentConfirmedAt per occurrence — for the display-only
        // "paymentDate" field so cash-mode rows can show BOTH
        // dates side-by-side just like accrual mode.
        prisma.payment.findMany({
          where: { occurrenceId: { in: occIds }, confirmed: true },
          select: { occurrenceId: true, confirmedAt: true },
        }),
      ]);
      const userById = new Map(users.map((u) => [u.id, u]));
      const occById = new Map(occs.map((o) => [o.id, o]));
      const paymentDateByOcc = new Map(
        paymentRows.map((p) => [p.occurrenceId, p.confirmedAt ? etFormatDate(p.confirmedAt) : undefined] as const),
      );
      const rows: PnLDetailRow[] = events.map((e) => {
        const u = userById.get(e.userId);
        const occ = occById.get(e.occurrenceId);
        const property = occ?.job?.property?.displayName;
        const client = occ?.job?.property?.client?.displayName;
        const csRaw = (occ as any)?.completionSplits as
          | Array<{ userId: string; percent: number }>
          | null
          | undefined;
        const pct = Array.isArray(csRaw)
          ? Number(csRaw.find((s) => s.userId === e.userId)?.percent) || undefined
          : undefined;
        const serviceDateStr = etFormatDate(e.completedAt);
        return {
          date: serviceDateStr,
          primary: u?.displayName ?? u?.email ?? "(unknown worker)",
          secondary: [client, property].filter(Boolean).join(" · ") || undefined,
          amount: round2(e.net),
          splitPercent: pct,
          serviceDate: serviceDateStr,
          paymentDate: paymentDateByOcc.get(e.occurrenceId),
          occurrenceId: e.occurrenceId,
        };
      });
      rows.sort((a, b) => a.date.localeCompare(b.date));
      return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
    }
    // Accrual (default) — per-Payment.confirmedAt rows. UNCHANGED from
    // the pre-mode-toggle behavior; every existing caller lands here.
    const payments = await prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
        skippedAt: null,
      },
      select: {
        confirmedAt: true,
        occurrence: {
          select: {
            // Needed by the client so wage rows can link back to the
            // exact occurrence (via the existing "highlight occ" flow
            // Payments uses).
            id: true,
            // startAt anchors the JobsTab date range so the linked
            // occurrence isn't hidden by the default 60-day clamp.
            startAt: true,
            // completedAt drives the serviceDate display column so the
            // operator can see the gap between "work done" and "money
            // in" for each wage row.
            completedAt: true,
            // completionSplits carries the per-worker percent set at
            // completion time. Used to render the split% column on the
            // drill row. Nullable (legacy rows / single-worker jobs).
            completionSplits: true,
            job: {
              select: {
                property: {
                  select: { displayName: true, client: { select: { displayName: true } } },
                },
              },
            },
          },
        },
        splits: {
          where: { ownerEarnings: false },
          select: {
            userId: true,
            amount: true,
            grossAmount: true,
            user: { select: { displayName: true, email: true, workerType: true } },
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
    });
    const rows: PnLDetailRow[] = [];
    for (const p of payments) {
      // Split% source priority:
      //   1. JobOccurrence.completionSplits — the exact percent set at
      //      completion time. Not populated on all historical rows or
      //      on dev seed data.
      //   2. Fallback: derived from PaymentSplit.grossAmount / totalGross.
      //      Every split has grossAmount populated post-migration, so
      //      this always works for rows the reconcile actually renders.
      const csRaw = (p.occurrence as any)?.completionSplits as
        | Array<{ userId: string; percent: number }>
        | null
        | undefined;
      const splitPctById = new Map<string, number>(
        Array.isArray(csRaw)
          ? csRaw.map((s) => [s.userId, Number(s.percent) || 0])
          : [],
      );
      // Compute the derived-percent fallback map. Prefer grossAmount
      // (pre-fee, matches the split% the operator set). On legacy /
      // dev-seed rows where grossAmount is null across the board, fall
      // back to `amount` (post-fee net) — same ratio for same-rate
      // workers, close approximation for mixed rates, and always
      // populated. Decision is per-payment: if ANY split has null
      // grossAmount, use amount for all splits on that payment so the
      // basis is consistent (mixing basis mid-payment would corrupt
      // the ratio).
      const useGrossBasis = p.splits.every((x) => x.grossAmount != null);
      const basisFor = (x: { grossAmount: number | null; amount: number }) =>
        useGrossBasis ? (x.grossAmount ?? 0) : (x.amount ?? 0);
      const totalBasis = p.splits.reduce((s, x) => s + basisFor(x), 0);
      const serviceDateStr = p.occurrence?.completedAt
        ? etFormatDate(p.occurrence.completedAt)
        : undefined;
      const paymentDateStr = p.confirmedAt ? etFormatDate(p.confirmedAt) : undefined;
      for (const sp of p.splits) {
        if (!isEmployeeClass(sp.user.workerType)) continue;
        const workerName = sp.user.displayName ?? sp.user.email ?? "(unknown worker)";
        const property = p.occurrence?.job?.property?.displayName;
        const client = p.occurrence?.job?.property?.client?.displayName;
        const primaryPct = splitPctById.get(sp.userId);
        const basis = basisFor(sp);
        const derivedPct =
          totalBasis > 0 && basis > 0
            ? Math.round(((basis / totalBasis) * 100) * 10) / 10
            : undefined;
        rows.push({
          date: paymentDateStr ?? "",
          primary: workerName,
          secondary: [client, property].filter(Boolean).join(" · ") || undefined,
          amount: round2(sp.amount ?? 0),
          splitPercent: primaryPct != null ? primaryPct : derivedPct,
          serviceDate: serviceDateStr,
          paymentDate: paymentDateStr,
          occurrenceId: p.occurrence?.id,
        });
      }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Expense: Employer payroll taxes (est., synthetic) ───────────────────
  // Detail is the four-component rate breakdown, not a per-row list of
  // tax payments (since these aren't tax payments — they're an
  // accrual estimate). One row per component shows the rate + dollar
  // contribution to make the line label's "9.75% of wages" total
  // legible to anyone reviewing.
  if (qbAccount === ACCOUNT_EMPLOYER_PAYROLL_TAXES) {
    const config = await loadPayrollTaxEstimates(prisma);
    // Recompute the wages base from the same query buildPnLReport
    // uses so the drilldown rows sum to the bucket's reported total
    // exactly (no drift if the setting changed between calls — both
    // requests read the same current config).
    // Drilldown wages base must match the bucket total exactly, which
    // means using the same filters as the buildPnLReport wages query
    // above — include write-offs (business pays those wages via
    // top-up → employer taxes owed), exclude skipped (pretend never
    // happened). Any drift here vs. the main query would leave the
    // drilldown rows not summing to the reported total.
    let wages = 0;
    if (mode === "cash") {
      const events = await loadCashBasisWageEvents(start, end);
      for (const e of events) wages += e.net;
    } else {
      const payments = await prisma.payment.findMany({
        where: {
          confirmed: true,
          confirmedAt: { gte: start, lte: end },
          skippedAt: null,
        },
        select: {
          splits: {
            where: { ownerEarnings: false },
            select: {
              amount: true,
              user: { select: { workerType: true } },
            },
          },
        },
      });
      for (const p of payments) {
        for (const sp of p.splits) {
          if (isEmployeeClass(sp.user.workerType)) wages += sp.amount ?? 0;
        }
      }
    }
    const components = breakdownEmployerTaxes(wages, config);
    const rows: PnLDetailRow[] = components.map((c) => ({
      date: "",
      primary: `${c.label} (${c.ratePct.toFixed(2)}%)`,
      secondary: `Applied to $${round2(wages).toFixed(2)} wages`,
      amount: c.amount,
    }));
    return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
  }

  // ── Default: BusinessExpense rows whose category maps to this account ──
  // A qbAccount can be mapped from multiple categories (rare but possible),
  // so collect every category whose mapping equals this qbAccount.
  const categoryLabels = categories
    .filter((c) => (c.qbAccount ?? "Unmapped") === qbAccount)
    .map((c) => c.label);
  if (categoryLabels.length === 0) {
    return { qbAccount, rows: [], total: 0 };
  }
  const expenses = await prisma.businessExpense.findMany({
    where: {
      type: "EXPENSE",
      category: { in: categoryLabels },
      ...expenseAnchorDateWhere(start, end),
    },
    include: {
      occurrence: { select: { completedAt: true } },
    },
  });
  const fixedAssetMinCost = await loadFixedAssetMinCost();
  const rows: PnLDetailRow[] = [];
  for (const r of expenses) {
    const effDate = effectiveExpenseDate(r);
    // Fixed-asset-eligible rows are capitalized to the balance sheet
    // and don't appear under operating-expense drilldowns. They're
    // surfaced separately via the "Fixed Assets (capitalized)"
    // drilldown branch above.
    if (isFixedAsset({ cost: r.cost, date: effDate }, fixedAssetMinCost)) continue;
    rows.push({
      date: etFormatDate(effDate),
      primary: r.category ?? "(uncategorized)",
      secondary: [r.description, r.vendor].filter(Boolean).join(" · ") || undefined,
      amount: round2(r.cost),
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { qbAccount, rows, total: round2(sum(rows.map((r) => r.amount))) };
}

async function loadEquipmentRentalIncomeAccount(): Promise<string> {
  const row = await prisma.setting.findUnique({
    where: { key: "EQUIPMENT_RENTAL_INCOME_CONFIG" },
  });
  if (!row?.value) return "Equipment Rental Income";
  try {
    const parsed = JSON.parse(row.value);
    if (typeof parsed?.qbAccount === "string" && parsed.qbAccount.trim()) {
      return parsed.qbAccount.trim();
    }
  } catch {
    // Malformed JSON — fall back rather than blow up the report.
  }
  return "Equipment Rental Income";
}
