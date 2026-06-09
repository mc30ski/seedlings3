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

export type PnLReport = {
  range: { from: string; to: string };
  income: { rows: PnLRow[]; total: number };
  cogs: PnLBucket;
  grossProfit: number;
  expenses: PnLBucket;
  netOperatingIncome: number;
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
  const incomeRows: PnLRow[] = [];
  if (servicesTotal > 0) incomeRows.push({ qbAccount: INCOME_ACCOUNT_SERVICES, total: servicesTotal });
  if (equipmentRentalTotal > 0) incomeRows.push({ qbAccount: rentalIncomeConfig, total: equipmentRentalTotal });
  // Alphabetical sort — matches QB's P&L row ordering. Same pattern applies
  // to COGS and Expenses (sorted further down).
  incomeRows.sort((a, b) => a.qbAccount.localeCompare(b.qbAccount));
  const incomeTotal = round2(servicesTotal + equipmentRentalTotal);

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

  // Operating expense rows from BusinessExpense (fixed assets excluded —
  // they're capitalized to balance sheet, never on the P&L).
  for (const r of operatingExpenses) {
    // Capitalization check uses effective date to stay consistent with
    // the QB Expenses CSV's split (see effectiveExpenseDate).
    if (isFixedAsset({ cost: r.cost, date: effectiveExpenseDate(r) }, fixedAssetMinCost)) continue;
    const meta = catMeta.get(r.category ?? "Other");
    // Categories explicitly marked EXCLUDE_FROM_PNL (or any category not
    // in the taxonomy at all — the loader default) silently drop out of
    // the P&L. Forces the operator to opt in via Settings before a
    // category contributes to the report.
    const section = meta?.plSection ?? "EXCLUDE_FROM_PNL";
    if (section === "EXCLUDE_FROM_PNL") continue;
    const qbAccount = meta?.qbAccount ?? "Unmapped";
    addToAccount(qbAccount, section, r.cost);
  }

  // Synthetic: Payment Processing Fees.
  const processorFeesTotal = sum(feePayments.map((p) => p.processorFeeAmount ?? 0));
  if (processorFeesTotal > 0) {
    addToAccount(
      SYNTHETIC_PL_CATEGORIES.PROCESSOR_FEES.qbAccount,
      SYNTHETIC_PL_CATEGORIES.PROCESSOR_FEES.plSection,
      processorFeesTotal,
    );
  }

  // Synthetic: Contract Labor — non-employee, non-GP-flagged splits +
  // GP advance disbursements (exportedAt-anchored). Same filter the QB
  // Expenses export uses to count Contract Labor.
  let contractLaborTotal = 0;
  for (const p of contractorPayments) {
    for (const sp of p.splits) {
      if (isEmployeeClass(sp.user.workerType)) continue;
      if (sp.guaranteedPayoutPaidAt != null) continue;
      contractLaborTotal += sp.amount ?? 0;
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

  const grossProfit = round2(incomeTotal - cogs.total);
  const netOperatingIncome = round2(grossProfit - expenses.total);

  return {
    range: { from: options.fromStr, to: options.toStr },
    income: { rows: incomeRows, total: incomeTotal },
    cogs,
    grossProfit,
    expenses,
    netOperatingIncome,
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

  // ── Expense: Payment Processing Fees (synthetic) ───────────────────────
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
      amount: round2(p.processorFeeAmount ?? 0),
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
