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
import {
  breakdownEmployerTaxes,
  loadPayrollTaxEstimates,
  totalEmployerTaxPct,
} from "./payrollTaxEstimates";

// qbAccount labels for the two synthetic operator-perspective lines.
// Flat (no colon) so they render as their own top-level rows; the
// "(accrued)" / "(est.)" suffixes signal divergence from QB so an
// operator reconciling against QB knows where the gap will be.
const ACCOUNT_WAGES_ACCRUED = "Wages (accrued)";
const ACCOUNT_EMPLOYER_PAYROLL_TAXES = "Employer payroll taxes (est.)";

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
//                Payment.confirmedAt (contractor PaymentSplit) +
//                GuaranteedPayoutAdvance.exportedAt
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

export type PnLRow = { qbAccount: string; total: number };

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
  income: { rows: PnLRow[]; total: number };
  cogs: PnLBucket;
  grossProfit: number;
  expenses: PnLBucket;
  netOperatingIncome: number;
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
 */
export async function buildPnLReport(
  start: Date,
  end: Date,
  options: { fromStr: string; toStr: string },
): Promise<PnLReport> {
  const [
    payments,
    equipmentRentals,
    operatingExpenses,
    feePayments,
    contractorPayments,
    gpAdvances,
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
        processorFeeAmount: { gt: 0 },
      },
      select: { processorFeeAmount: true },
    }),
    // Contract labor synthesized from contractor PaymentSplit rows on
    // confirmed payments. Mirrors the QB Expenses export's filtering:
    // employee-class splits excluded (their wages go through Gusto W-2),
    // GP-flagged splits excluded (those advances are captured separately
    // via GuaranteedPayoutAdvance, just like the export).
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
      },
      select: {
        splits: {
          where: { ownerEarnings: false },
          select: {
            amount: true,
            guaranteedPayoutPaidAt: true,
            user: { select: { workerType: true } },
          },
        },
      },
    }),
    // GP advance disbursements — also Contract Labor (the contractor was
    // paid even though the client payment hasn't been confirmed yet).
    // Anchored on exportedAt so the totals match the QB Expenses export.
    prisma.guaranteedPayoutAdvance.findMany({
      where: { exportedAt: { gte: start, lte: end } },
      select: { amount: true },
    }),
    loadEquipmentRentalIncomeAccount(),
    loadExpenseCategories(),
    loadFixedAssetMinCost(),
  ]);

  // Build the category → (qbAccount, plSection) lookup once.
  const catMeta = new Map<string, { qbAccount: string; plSection: PlSection }>();
  for (const c of categories) {
    catMeta.set(c.label, {
      qbAccount: c.qbAccount ?? "Unmapped",
      plSection: c.plSection,
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
  const byAccount = new Map<string, { total: number; section: PlSection }>();
  const addToAccount = (qbAccount: string, section: PlSection, amount: number) => {
    if (amount === 0) return;
    const existing = byAccount.get(qbAccount);
    if (existing) {
      existing.total += amount;
    } else {
      byAccount.set(qbAccount, { total: amount, section });
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

  // Operating expense rows from BusinessExpense (fixed assets excluded —
  // they're capitalized to balance sheet, never on the P&L).
  for (const r of operatingExpenses) {
    // Capitalization check uses effective date to stay consistent with
    // the QB Expenses CSV's split (see effectiveExpenseDate).
    if (isFixedAsset({ cost: r.cost, date: effectiveExpenseDate(r) }, fixedAssetMinCost)) continue;
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
    addToAccount(qbAccount, section, r.cost);
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
  // Labor (QB-tied; GP-flagged splits routed to GP advances instead, see
  // exports.ts), employees+trainees go to Wages (accrued) — the
  // operator-perspective addition that gives Net Operating Income a
  // meaningful "company kept this" number even before Gusto cuts the
  // payroll check. Owner-earnings splits were filtered out at the query
  // level; they don't belong in either bucket (owner takes draws).
  let contractLaborTotal = 0;
  let wagesAccruedTotal = 0;
  for (const p of contractorPayments) {
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) {
        // W-2 wages base — sp.amount is already netAmount + topUpAmount
        // (the worker's paycheck gross from the payroll-tax-base
        // perspective), which is what payroll taxes apply to.
        wagesAccruedTotal += sp.amount ?? 0;
      } else {
        // 1099 contractors. GP-flagged splits skip here because the
        // matching cash already disbursed via GuaranteedPayoutAdvance.
        if (sp.guaranteedPayoutPaidAt != null) continue;
        contractLaborTotal += sp.amount ?? 0;
      }
    }
  }
  contractLaborTotal += sum(gpAdvances.map((a) => a.amount ?? 0));
  if (contractLaborTotal > 0) {
    addToAccount(
      SYNTHETIC_PL_CATEGORIES.CONTRACT_LABOR.qbAccount,
      SYNTHETIC_PL_CATEGORIES.CONTRACT_LABOR.plSection,
      contractLaborTotal,
    );
  }
  if (wagesAccruedTotal > 0) {
    addToAccount(ACCOUNT_WAGES_ACCRUED, "OPERATING_EXPENSE", wagesAccruedTotal);
  }

  // Synthetic: Employer payroll taxes (est.) — operator-tunable rates
  // applied to the Wages (accrued) base above. Only synthesized when
  // there are W-2 wages to tax, otherwise the line is suppressed
  // entirely (same self-hide behavior as Contract Labor when there are
  // no contractors). The per-component breakdown is attached to the
  // PnLReport so the UI can render the expand-detail without another
  // roundtrip — see PnLReport.employerPayrollTaxes.
  let employerPayrollTaxes: PnLReport["employerPayrollTaxes"] | undefined;
  if (wagesAccruedTotal > 0) {
    const taxConfig = await loadPayrollTaxEstimates(prisma);
    const totalRatePct = totalEmployerTaxPct(taxConfig);
    const components = breakdownEmployerTaxes(wagesAccruedTotal, taxConfig);
    const employerTaxTotal = round2((wagesAccruedTotal * totalRatePct) / 100);
    if (employerTaxTotal > 0) {
      addToAccount(ACCOUNT_EMPLOYER_PAYROLL_TAXES, "OPERATING_EXPENSE", employerTaxTotal);
      employerPayrollTaxes = {
        wages: round2(wagesAccruedTotal),
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
  for (const [qbAccount, { total, section }] of byAccount) {
    const row = { qbAccount, total: round2(total) };
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

  return {
    range: { from: options.fromStr, to: options.toStr },
    income: { rows: incomeRows, total: incomeTotal },
    cogs,
    grossProfit,
    expenses,
    excluded,
    netOperatingIncome,
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
  type AccBucket = { directTotal: number; children: PnLRow[] };
  const buckets = new Map<string, AccBucket>();
  for (const row of rows) {
    const colon = row.qbAccount.indexOf(":");
    if (colon < 0) {
      const bucket = buckets.get(row.qbAccount) ?? { directTotal: 0, children: [] };
      bucket.directTotal += row.total;
      buckets.set(row.qbAccount, bucket);
    } else {
      const parent = row.qbAccount.slice(0, colon).trim();
      const bucket = buckets.get(parent) ?? { directTotal: 0, children: [] };
      bucket.children.push(row);
      buckets.set(parent, bucket);
    }
  }

  const groups: PnLExpenseGroup[] = [];
  const flat: PnLRow[] = [];
  for (const [parent, bucket] of buckets) {
    bucket.children.sort((a, b) => a.qbAccount.localeCompare(b.qbAccount));
    if (bucket.children.length === 0) {
      flat.push({ qbAccount: parent, total: round2(bucket.directTotal) });
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
//   • SYNTHETIC.CONTRACT_LABOR.qbAccount        → non-employee PaymentSplit
//                                                 rows + GP advance rows
// Everything else → BusinessExpense rows whose category maps to that qbAccount.
// ─────────────────────────────────────────────────────────────────────────────

export type PnLDetailRow = {
  date: string;       // YYYY-MM-DD, ET-anchored
  primary: string;    // main description (vendor, client, etc.)
  secondary?: string; // optional second line (category, property, source, etc.)
  amount: number;
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
): Promise<PnLDetail> {
  const [equipRentalAccount, categories] = await Promise.all([
    loadEquipmentRentalIncomeAccount(),
    loadExpenseCategories(),
  ]);

  // ── Income: Services ────────────────────────────────────────────────────
  if (qbAccount === INCOME_ACCOUNT_SERVICES) {
    const payments = await prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
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
    const [contractorPayments, gpAdvances] = await Promise.all([
      prisma.payment.findMany({
        where: {
          confirmed: true,
          confirmedAt: { gte: start, lte: end },
          writtenOff: false,
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
              guaranteedPayoutPaidAt: true,
              user: { select: { workerType: true, displayName: true, email: true } },
            },
          },
        },
        orderBy: { confirmedAt: "asc" },
      }),
      prisma.guaranteedPayoutAdvance.findMany({
        where: { exportedAt: { gte: start, lte: end } },
        include: { user: { select: { displayName: true, email: true } } },
        orderBy: { exportedAt: "asc" },
      }),
    ]);
    const rows: PnLDetailRow[] = [];
    for (const p of contractorPayments) {
      for (const sp of p.splits) {
        if (isEmployeeClass(sp.user.workerType)) continue;
        if (sp.guaranteedPayoutPaidAt != null) continue;
        rows.push({
          date: p.confirmedAt ? etFormatDate(p.confirmedAt) : "",
          primary: sp.user.displayName ?? sp.user.email ?? "(unnamed contractor)",
          secondary: p.occurrence?.job?.property?.client?.displayName ?? undefined,
          amount: round2(sp.amount ?? 0),
        });
      }
    }
    for (const adv of gpAdvances) {
      rows.push({
        date: adv.exportedAt ? etFormatDate(adv.exportedAt) : "",
        primary: adv.user?.displayName ?? adv.user?.email ?? "(unnamed contractor)",
        secondary: "guaranteed-payout advance",
        amount: round2(adv.amount ?? 0),
      });
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
    const payments = await prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
      },
      select: {
        confirmedAt: true,
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
        splits: {
          where: { ownerEarnings: false },
          select: {
            amount: true,
            user: { select: { displayName: true, email: true, workerType: true } },
          },
        },
      },
      orderBy: { confirmedAt: "asc" },
    });
    const rows: PnLDetailRow[] = [];
    for (const p of payments) {
      for (const sp of p.splits) {
        if (!isEmployeeClass(sp.user.workerType)) continue;
        const workerName = sp.user.displayName ?? sp.user.email ?? "(unknown worker)";
        const property = p.occurrence?.job?.property?.displayName;
        const client = p.occurrence?.job?.property?.client?.displayName;
        rows.push({
          date: p.confirmedAt ? etFormatDate(p.confirmedAt) : "",
          primary: workerName,
          secondary: [client, property].filter(Boolean).join(" · ") || undefined,
          amount: round2(sp.amount ?? 0),
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
    const payments = await prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
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
    let wages = 0;
    for (const p of payments) {
      for (const sp of p.splits) {
        if (isEmployeeClass(sp.user.workerType)) wages += sp.amount ?? 0;
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
    // Match the main P&L: fixed-asset rows belong on the balance sheet,
    // never on the P&L. Same effective-date capitalization check used in
    // the totals computation.
    const effDate = effectiveExpenseDate(r);
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
