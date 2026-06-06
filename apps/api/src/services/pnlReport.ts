import { prisma } from "../db/prisma";
import {
  loadExpenseCategories,
  SYNTHETIC_PL_CATEGORIES,
  type PlSection,
} from "./expenseCategories";
import {
  isFixedAsset,
  loadFixedAssetMinCost,
  isEmployeeClass,
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

export type PnLReport = {
  range: { from: string; to: string };
  income: { rows: PnLRow[]; total: number };
  cogs: { rows: PnLRow[]; total: number };
  grossProfit: number;
  expenses: {
    /** Multi-account groups (a parent with children, or a parent with its
     *  own direct expenses and children). Rendered with sub-account
     *  indentation and a "Total for {parent}" subtotal. */
    groups: PnLExpenseGroup[];
    /** Single-account rows with no colon — rendered flat at top level. */
    flat: PnLRow[];
    total: number;
  };
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
    // Operating expenses — BusinessExpense rows of type EXPENSE in window.
    // Fixed assets are filtered out below (capitalized → balance sheet).
    prisma.businessExpense.findMany({
      where: { type: "EXPENSE", date: { gte: start, lte: end } },
      select: { cost: true, category: true, date: true },
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
    if (isFixedAsset(r, fixedAssetMinCost)) continue;
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

  // Split COGS vs OPERATING_EXPENSE.
  const cogsRows: PnLRow[] = [];
  const expenseAccounts: PnLRow[] = [];
  for (const [qbAccount, { total, section }] of byAccount) {
    const row = { qbAccount, total: round2(total) };
    if (section === "COGS") cogsRows.push(row);
    else expenseAccounts.push(row);
  }
  cogsRows.sort((a, b) => a.qbAccount.localeCompare(b.qbAccount));

  // Group operating-expense rows by colon-parsed parent.
  //
  //   "Other business expenses"                       → parent (direct)
  //   "Other business expenses:Payment processing fees" → child of "Other business expenses"
  //   "Insurance"                                     → flat (no colon)
  //
  // A parent group emits only when there's > 1 row sharing the parent
  // (parent direct + 1 child, or two children). A single-row parent stays
  // flat so the report doesn't show useless one-line groups with subtotals.
  type AccBucket = { directTotal: number; children: PnLRow[] };
  const buckets = new Map<string, AccBucket>();
  for (const row of expenseAccounts) {
    const colon = row.qbAccount.indexOf(":");
    if (colon < 0) {
      // No colon — candidate parent. Track as a bucket with no children
      // yet; if a child shows up later, it joins. If not, this becomes a
      // flat row at render time.
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
      // Pure top-level row, no sub-accounts seen.
      flat.push({ qbAccount: parent, total: round2(bucket.directTotal) });
    } else {
      // Parent with children — render as a grouped block.
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

  const cogsTotal = round2(sum(cogsRows.map((r) => r.total)));
  const expensesTotal = round2(
    sum(flat.map((r) => r.total)) + sum(groups.map((g) => g.subtotal)),
  );
  const grossProfit = round2(incomeTotal - cogsTotal);
  const netOperatingIncome = round2(grossProfit - expensesTotal);

  return {
    range: { from: options.fromStr, to: options.toStr },
    income: { rows: incomeRows, total: incomeTotal },
    cogs: { rows: cogsRows, total: cogsTotal },
    grossProfit,
    expenses: { groups, flat, total: expensesTotal },
    netOperatingIncome,
  };
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
