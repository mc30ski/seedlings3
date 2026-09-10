// ─────────────────────────────────────────────────────────────────────────────
// Forecast service — Super → Money → Forecast
//
// Two jobs:
//   1. Assemble a BASELINE for a date window: what actually happened, shaped
//      so the pure simulator in @repo/money can replay it under different
//      assumptions.
//   2. Save / edit / duplicate / archive named scenarios.
//
// ADVISORY BY CONSTRUCTION. Nothing in this file writes a Setting, a Payment,
// a PaymentSplit, or a payroll row, and forecast-build-gate.test.ts fails the
// build if that ever changes. A scenario is a saved question, not an executed
// decision.
//
// FIREWALL. Employer payroll tax comes from the ESTIMATOR
// (payrollTaxEstimates.ts), never from imported Gusto rows. Wiring the two
// together would make every forecast's meaning depend on whether a payroll
// period happened to be uploaded — the same reasoning as the payroll build
// gate. The app is a close estimate; QuickBooks, Gusto and the bank are the
// source of truth. This tool is for trends, not for filing.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { etMidnight, etEndOfDay, etFormatDate, etAddDays, etDaysBetween, etWeekStart, type EtDateKey } from "../lib/dates";
import { loadRates } from "./payments";
import { getMarketRate } from "./marketRate";
import { loadPayrollTaxEstimates, totalEmployerTaxPct } from "./payrollTaxEstimates";
import { loadFixedAssetMinCost, isFixedAsset } from "./exports";
import { loadStatutoryCategoryLabels } from "./expenseCategories";
import {
  simulate,
  backtest,
  defaultAssumptions,
  assumptionsDiffer,
  type ForecastBaseline,
  type ForecastJob,
  type ForecastWorker,
  type PayPeriodCadence,
  type ForecastExpenseLine,
  type Assumptions,
} from "@repo/money";

/** Workers-comp rate as a percent of W-2 wages. A quote, not something the
 *  app can derive, so it lives in Settings with a conservative default. The
 *  operator tunes it in the tool; this is only the starting position. */
const WORKERS_COMP_SETTING = "WORKERS_COMP_PERCENT_OF_WAGES";
const WORKERS_COMP_DEFAULT = 12;

async function loadWorkersCompPercent(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: WORKERS_COMP_SETTING } });
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : WORKERS_COMP_DEFAULT;
}

// ── Pay periods ─────────────────────────────────────────────────────────────
//
// FIREWALL-SAFE. The cadence is read from a Setting — operator configuration,
// the same kind of value as a tax percent. Nothing here reads an IMPORTED
// payroll row, so no forecast number's meaning depends on whether a Gusto
// export happened to be uploaded. The payroll build gate holds the other
// direction; forecast-build-gate.test.ts holds this one — including by
// scanning this file for the model names, so don't spell them here either.

const CADENCE_SETTING = "PAYROLL_PERIOD_CADENCE";

async function loadCadence(): Promise<PayPeriodCadence> {
  const row = await prisma.setting.findUnique({ where: { key: CADENCE_SETTING } });
  const v = row?.value;
  return v === "BIWEEKLY" || v === "MONTHLY" ? v : "WEEKLY";
}

/** Add one calendar month to a YYYY-MM-01 key. String arithmetic on purpose:
 *  no Date, so there is no month-overflow behavior to get wrong. */
function nextMonthStart(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

/**
 * Every pay period the window touches, as ordered START keys.
 *
 * The FIRST period starts on or BEFORE `from` — a window opening mid-week sits
 * inside a real pay period, and pretending it starts on the window boundary
 * would leave a partial period looking like a short one the guarantee has to
 * top up.
 *
 * BIWEEKLY anchors on the window's own first week rather than on a real Gusto
 * period boundary, which this file deliberately cannot see. That makes it
 * stable for a given window but arbitrary in absolute terms; it matters only
 * for period COUNT, which is off by at most one.
 */
export function payPeriodKeys(
  from: EtDateKey,
  to: EtDateKey,
  cadence: PayPeriodCadence,
): string[] {
  const keys: string[] = [];
  if (cadence === "MONTHLY") {
    let k = `${String(from).slice(0, 7)}-01`;
    while (k <= String(to)) {
      keys.push(k);
      k = nextMonthStart(k);
    }
    return keys;
  }
  const step = cadence === "BIWEEKLY" ? 14 : 7;
  let k: string = etWeekStart(from);
  while (k <= String(to)) {
    keys.push(k);
    k = etAddDays(k as EtDateKey, step);
  }
  return keys;
}

/** Index of the period a date key falls in: the last start on or before it.
 *  YYYY-MM-DD sorts lexicographically, so plain string compare is correct. */
function periodIndexOf(dateKey: string, keys: string[]): number {
  let idx = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] <= dateKey) idx = i;
    else break;
  }
  return idx;
}

// ── Baseline ────────────────────────────────────────────────────────────────

// ─── Amortizing recurring costs ──────────────────────────────────────────────
//
// A cost that recurs on a cycle BUYS a period of coverage. An annual workers
// comp premium paid in August covers the twelve months after August, so a
// three-month window should carry a quarter of it — not all of it because the
// invoice happens to fall inside, and not none of it because the invoice
// happens to fall outside.
//
// Both of those were happening. A Jun-Aug window carried the whole $928
// premium against three months of revenue; a Sep-Nov window carried zero. Two
// windows over the same steady-state business disagreed by the full premium,
// so comparing seasons measured when the bill arrived rather than how the
// season went.
//
// This applies to the EXPENSE side only. Forecast revenue is still cash
// collected — deliberately, because the collection rate is a real fact the
// operator wants to see rather than smooth away. The copy says so; it must
// not claim to be accrual accounting generally.
// Coverage length in WHOLE ET CALENDAR DAYS. Whole days, and date-key
// arithmetic throughout, so the share never depends on a DST boundary or on
// which month the invoice happened to land in.
const COVERAGE_DAYS: Record<string, number> = {
  WEEKLY: 7,
  MONTHLY: 30,
  QUARTERLY: 91,
  ANNUALLY: 365,
};

/** The longest coverage any recurrence can have. The expense query reads back
 *  this far so a still-covering premium bought before the window is visible. */
const COVERAGE_LOOKBACK_DAYS = 366;

/**
 * How much of one ledger row belongs to [startKey, endKey].
 *
 * No recurrence → a point cost: the whole amount if its date is in the
 * window, nothing otherwise. That is the pre-existing behaviour and it is
 * right for fuel, a repair, a bag of mulch.
 *
 * With a recurrence → the row covers `COVERAGE_DAYS` from its date, and the
 * window gets the overlapping fraction. Coverage running past the window's
 * end is not counted, nor is coverage that ended before it began.
 *
 * A refund (negative cost) is amortized on the same terms. That is not
 * obviously right — a mid-term cancellation refunds coverage that was never
 * consumed rather than spreading it evenly — but the ledger has no link from
 * a refund to what it refunds, so there is nothing better available. The
 * honest consequence is that a cancel-and-rewrite reads oddly until both rows
 * fall inside the same window.
 */
export function amortizedShare(
  row: { cost: number; date: Date; recurrence: string | null },
  startKey: EtDateKey,
  endKey: EtDateKey,
): number {
  const rowKey = etFormatDate(row.date) as EtDateKey;
  const days = row.recurrence ? COVERAGE_DAYS[row.recurrence] : undefined;
  // No recurrence, or one this build does not recognise. An unknown value
  // must not silently vanish from the books, so it falls back to the
  // point-cost rule rather than to zero.
  if (!days) {
    return rowKey >= startKey && rowKey <= endKey ? row.cost : 0;
  }
  // Coverage is [rowKey, rowKey + days - 1] inclusive.
  const coverEndKey = etAddDays(rowKey, days - 1);
  const overlapFrom = rowKey > startKey ? rowKey : startKey;
  const overlapTo = coverEndKey < endKey ? coverEndKey : endKey;
  if (overlapFrom > overlapTo) return 0;
  const overlapDays = etDaysBetween(overlapFrom, overlapTo) + 1;
  return row.cost * Math.min(1, overlapDays / days);
}

export async function buildBaseline(from: EtDateKey, to: EtDateKey): Promise<ForecastBaseline> {
  const start = etMidnight(from);
  const end = etEndOfDay(to);

  const [payments, workdays, users, expenses, rates, taxCfg, wcPercent, marketRate, cadence, fixedAssetMinCost, compCategoryLabels] =
    await Promise.all([
      prisma.payment.findMany({
        where: { confirmed: true, createdAt: { gte: start, lte: end } },
        select: {
          id: true,
          amountPaid: true,
          processorFeeAmount: true,
          occurrence: {
            select: {
              id: true,
              price: true,
              startedAt: true,
              completedAt: true,
              completionSplits: true,
              // Recurrence, for reporting only. The occurrence's own frequency
              // wins over the job's — an occurrence can be re-cadenced.
              workflow: true,
              frequencyDays: true,
              job: { select: { frequencyDays: true } },
              invoiceCharges: { select: { cost: true } },
              // Assignees, to identify the CLAIMER and the crew size. The
              // claimer is the self-assigned, non-observer entry — same rule
              // the job card and every claimer guard use
              // (assignedById === userId). Crew size counts working
              // assignees; an observer is watching, not being led.
              assignees: { select: { userId: true, assignedById: true, role: true } },
            },
          },
          splits: { select: { userId: true, amount: true, grossAmount: true } },
        },
      }),
      prisma.workerWorkday.findMany({
        where: { endedAt: { not: null }, workdayDate: { gte: from, lte: to } },
        select: {
          userId: true, workdayDate: true,
          startedAt: true, endedAt: true, totalPausedMs: true,
        },
      }),
      prisma.user.findMany({
        where: { workerType: { not: null } },
        select: { id: true, displayName: true, email: true, workerType: true, isOwner: true },
      }),
      prisma.businessExpense.findMany({
        // LOOK BACK, don't just read the window.
        //
        // A premium paid once a year covers the twelve months after it, so a
        // window in November has to see the policy bought in August or it
        // reports no insurance at all. `COVERAGE_LOOKBACK_DAYS` is the longest
        // coverage any recurrence can have, so this is the smallest read that
        // can still find every row with coverage reaching into the window.
        //
        // Rows outside the window contribute ONLY their overlapping share —
        // see amortizedShare below. A row with no recurrence is a point cost
        // and is dropped unless its own date is inside the window, which is
        // exactly the behaviour this replaced.
        where: {
          type: "EXPENSE",
          date: { gte: etMidnight(etAddDays(from, -COVERAGE_LOOKBACK_DAYS)), lte: end },
        },
        // `expense` is the 1:1 back-link to a per-job Expense row. Its presence
        // means this ledger entry IS a job material, which the forecast already
        // subtracts separately — see the dedupe below.
        select: {
          category: true, cost: true, date: true, recurrence: true,
          invoiceCharges: { select: { id: true } },
        },
      }),
      loadRates(prisma),
      loadPayrollTaxEstimates(prisma),
      loadWorkersCompPercent(),
      getMarketRate(),
      loadCadence(),
      loadFixedAssetMinCost(),
      // Which expense categories carry workers comp premium. Tagged in
      // Settings (EXPENSE_CATEGORIES → Statutory), because Schedule C line 15
      // lumps comp in with general liability and commercial auto and the
      // ledger has nothing else to tell them apart.
      loadStatutoryCategoryLabels("WORKERS_COMP"),
    ]);

  const userById = new Map(users.map((u) => [u.id, u]));

  // ── Clocked hours, and what each person was actually paid ────────────────
  const periodKeys = payPeriodKeys(from, to, cadence);
  const clocked = new Map<string, number>();
  // Every worker gets a slot for EVERY period, pre-filled with zeros. Building
  // this from the workday rows instead would silently omit the periods someone
  // didn't work — which are precisely the periods a guarantee has to pay for.
  const perPeriod = new Map<string, number[]>();
  const slots = (id: string) => {
    let a = perPeriod.get(id);
    if (!a) { a = new Array(periodKeys.length).fill(0); perPeriod.set(id, a); }
    return a;
  };
  for (const w of workdays) {
    if (!w.endedAt) continue;
    const hrs = (w.endedAt.getTime() - w.startedAt.getTime()) / 3_600_000 - w.totalPausedMs / 3_600_000;
    if (hrs <= 0) continue;
    clocked.set(w.userId, (clocked.get(w.userId) ?? 0) + hrs);
    const i = periodIndexOf(w.workdayDate, periodKeys);
    if (i >= 0) slots(w.userId)[i] += hrs;
  }
  const actualPay = new Map<string, number>();
  for (const p of payments) {
    for (const s of p.splits) actualPay.set(s.userId, (actualPay.get(s.userId) ?? 0) + s.amount);
  }

  // ── Jobs ─────────────────────────────────────────────────────────────────
  const jobs: ForecastJob[] = payments.map((p) => {
    const occ = p.occurrence;
    const materials = occ?.invoiceCharges.reduce((s: number, e: { cost: number }) => s + e.cost, 0) ?? 0;

    // Crew percentages, in order of trustworthiness: the allocation the
    // claimer locked in at completion, then the realised gross split, then an
    // even split. The gross fallback matters for historical rows written
    // before completionSplits existed.
    let crew: Array<{ userId: string; splitPercent: number }> = [];
    const locked = occ?.completionSplits as Array<{ userId: string; percent: number }> | null;
    if (Array.isArray(locked) && locked.length) {
      crew = locked
        .filter((c) => c?.userId)
        .map((c) => ({ userId: c.userId, splitPercent: Number(c.percent) || 0 }));
    } else if (p.splits.length) {
      const totalGross = p.splits.reduce((s, x) => s + (x.grossAmount ?? 0), 0);
      crew = p.splits.map((s) => ({
        userId: s.userId,
        splitPercent: totalGross > 0 ? ((s.grossAmount ?? 0) / totalGross) * 100 : 100 / p.splits.length,
      }));
    }

    const minutes =
      occ?.startedAt && occ?.completedAt
        ? (occ.completedAt.getTime() - occ.startedAt.getTime()) / 60_000
        : null;

    // Who led this job, and did they actually lead anyone.
    //
    // A claimer working alone is not leading a crew — that is the operator's
    // rule and it is the whole point of the premium, so a solo job resolves
    // to no claimer here rather than being filtered downstream.
    const working = (occ?.assignees ?? []).filter((x: any) => x.role !== "observer");
    const claimer = working.find((x: any) => x.assignedById === x.userId) ?? null;
    const claimerUserId = claimer && working.length > 1 ? claimer.userId : null;

    return {
      id: p.id,
      paid: p.amountPaid,
      claimerUserId,
      crewSize: working.length,
      invoicePrice: occ?.price ?? null,
      materials,
      // Guard against a clock left running overnight — an implausible duration
      // would otherwise distort every per-hour figure downstream.
      minutes: minutes != null && minutes > 0 && minutes < 600 ? minutes : null,
      dateKey: occ?.completedAt ? (etFormatDate(occ.completedAt) as string) : null,
      crew,
      // A ONE_OFF workflow is explicit; otherwise a job with no cadence at all
      // is effectively one-off however it was filed.
      recurring:
        occ?.workflow !== "ONE_OFF" &&
        ((occ?.frequencyDays ?? occ?.job?.frequencyDays ?? 0) > 0),
    };
  });

  // ── Workers ──────────────────────────────────────────────────────────────
  // Anyone who clocked time OR earned a split in the window. Someone who did
  // neither isn't part of this window's economics.
  const active = new Set<string>([...clocked.keys(), ...actualPay.keys()]);
  const workers: ForecastWorker[] = [...active]
    .map((id) => {
      const u = userById.get(id);
      return {
        userId: id,
        name: u?.displayName ?? u?.email ?? "Unknown",
        workerType: u?.workerType ?? null,
        isOwner: u?.isOwner ?? false,
        clockedHours: round2(clocked.get(id) ?? 0),
        periodHours: (perPeriod.get(id) ?? new Array(periodKeys.length).fill(0)).map(round2),
        actualPay: round2(actualPay.get(id) ?? 0),
      };
    })
    .sort((a, b) => b.clockedHours - a.clockedHours);

  // ── Expenses, grouped by category and tagged with how they scale ─────────
  //
  // TWO THINGS ARE SEPARATED OUT HERE.
  //
  // 1. JOB MATERIALS. Every per-job Expense gets a paired BusinessExpense —
  //    workers buy on the company card, so job spend IS ledger spend. The
  //    forecast already subtracts those as `materials` (they also come off the
  //    pool before the split, which is why the payout math needs them), so
  //    leaving them in the category totals charged the same mulch twice.
  //
  // 2. CAPITAL PURCHASES. A $7,943 mower is not a running cost. pnlReport.ts
  //    capitalizes anything at or above FIXED_ASSET_MIN_COST and reports it
  //    outside Net Operating Income; without the same treatment the forecast
  //    read a single equipment purchase as 46% of revenue and called the
  //    quarter a disaster. Tracked per category so the scenario can put it
  //    back — the toggle is the operator's, not ours.
  const byCategory = new Map<string, number>();
  const fixedByCategory = new Map<string, number>();
  // A ledger row that a job line points at is STILL A REAL EXPENSE, and it is
  // counted here like any other.
  //
  // It used to be skipped, on the reasoning that the old dual-write had
  // already counted that money against the job. That reasoning is dead: a job
  // charge is what the CLIENT is billed and creates no deduction, so the
  // ledger row is the only place that money is recorded. Skipping it dropped
  // real costs out of the forecast — silently, and by more every time an
  // operator linked a receipt to a job, which the app actively invites.
  //
  // `jobMaterialsInLedger` is kept as a REPORTED figure only: how much of the
  // expense side is traceable to a job. It is no longer subtracted from
  // anything.
  let jobMaterialsInLedger = 0;
  for (const e of expenses) {
    const label = e.category ?? "Uncategorized";
    const inWindow = e.date >= start && e.date <= end;
    // The amortized slice is what the window is charged. For a row with no
    // recurrence this is the full cost when it falls inside and zero when it
    // does not, so nothing about a one-off changes.
    const share = amortizedShare(e, from, to);
    if (share !== 0) byCategory.set(label, (byCategory.get(label) ?? 0) + share);

    // The two figures below describe events, not coverage, so they stay
    // anchored to rows that actually landed IN the window. A premium bought
    // in August is not a capital purchase made in November, and a look-back
    // row is not a job material this window bought.
    if (!inWindow) continue;
    if (e.invoiceCharges.length) jobMaterialsInLedger += e.cost;
    // A ROW WITH A RECURRENCE IS NEVER A CAPITAL PURCHASE.
    //
    // `isFixedAsset` is cost-only by design — anything at or above the
    // threshold, dated on or after the capitalization start date. That is the
    // right rule for the QB export, and it is the wrong rule here the moment
    // costs are amortized: a $928 ANNUAL workers comp premium clears the $500
    // threshold, so the whole $928 was recorded as this category's capital
    // slice while `amount` held only the months of coverage the window
    // contains. Subtracting the full ticket from a partial share (which is
    // what `excludeFixedAssets` does, and it is ON by default) reported
    // Insurance as a large NEGATIVE cost. Production carries exactly that
    // row.
    //
    // Scoped to the forecast on purpose. The P&L and the QB fixed-asset
    // export are tax artifacts and keep the policy they have; this is the one
    // surface that amortizes, so it is the one surface where the units stop
    // lining up. A cost you re-buy every period is a running cost by
    // definition — nothing you renew annually is a depreciable asset.
    const recurring = e.recurrence != null;
    if (!recurring && isFixedAsset({ cost: e.cost, date: e.date }, fixedAssetMinCost)) {
      fixedByCategory.set(label, (fixedByCategory.get(label) ?? 0) + e.cost);
    }
  }
  const expenseLines: ForecastExpenseLine[] = [...byCategory.entries()]
    .map(([category, amount]) => ({
      category,
      /** The slice of this category that is a capital purchase, not a running
       *  cost. Zero for almost every category. */
      fixedAssetAmount: round2(fixedByCategory.get(category) ?? 0),
      // Every category starts AS_IS — holding what this window is charged.
      // The scenario's own behaviorOverrides are the only thing that changes
      // it, the same way every other lever baselines on reality.
      //
      // "What this window is charged" is not always "what was paid in this
      // window": a recurring row contributes its overlapping coverage. See
      // amortizedShare. Both this array AND the `actual` figures below are
      // built from it, so the model and the books it is checked against move
      // together and the fidelity line keeps its meaning.
      behavior: "AS_IS" as const,
      amount: round2(amount),
    }))
    .sort((a, b) => b.amount - a.amount);

  // How much of this window's booked cost is workers comp premium — the
  // figure a scenario has to remove before it can re-derive comp from wages,
  // or the same cost is counted twice.
  //
  // Read off the AMORTIZED line totals, not off the raw rows, so an annual
  // policy contributes the slice this window is charged rather than the whole
  // invoice. That is the number the operator used to have to work out by hand
  // and type in, and the arithmetic ("a three-month window carries about a
  // quarter of it") was exactly the mental math they said they shouldn't have
  // to do.
  //
  // Zero means NOTHING IS TAGGED, which is not the same as "there is no
  // comp". The model treats it as unknown and warns; it never silently
  // models a business with no premium.
  const workersCompCategories = [...compCategoryLabels].sort();
  const workersCompBooked = expenseLines
    .filter((l) => compCategoryLabels.has(l.category))
    .reduce((s, l) => s + l.amount, 0);

  // ── What the books say, for the backtest line ───────────────────────────
  const revenue = jobs.reduce((s, j) => s + j.paid, 0);
  const processorFees = payments.reduce((s, p) => s + (p.processorFeeAmount ?? 0), 0);
  const materialsTotal = jobs.reduce((s, j) => s + j.materials, 0);
  // Employer burden lands on W-2 WAGES ONLY. Splitting owner-vs-everyone-else
  // and charging the whole remainder was wrong twice over: a 1099 contractor
  // carries neither payroll tax nor workers comp, and this figure is the
  // "actual" half of the backtest — the check that tells the operator whether
  // the model reproduces the books. A miscounted reference makes the model
  // look wrong when it is right. pnlReport.ts has always split Wages from
  // Contract Labor; this now matches it.
  let crewWages = 0;      // W-2 (employee + trainee), non-owner
  let contractLabor = 0;  // 1099
  let ownerEarnings = 0;
  for (const [userId, amt] of actualPay) {
    const u = userById.get(userId);
    if (u?.isOwner) ownerEarnings += amt;
    else if (u?.workerType === "CONTRACTOR") contractLabor += amt;
    else crewWages += amt;
  }
  const employerTaxPercent = totalEmployerTaxPct(taxCfg);
  // Payroll tax only. Workers comp is NOT synthesized here: the real premium
  // is already sitting in the Insurance expense rows below, and adding a
  // percentage of wages on top of it is the double-count that
  // payrollTaxEstimates.ts documents and pnlReport.ts avoids. A scenario can
  // opt into modelling comp as a wage-scaling cost, which is the only way it
  // responds to hiring — see `workersCompPercent`, which takes
  // `workersCompBooked` back out first so nothing is counted twice.
  const burden = crewWages * (employerTaxPercent / 100);
  const opex = expenseLines.reduce((s, l) => s + l.amount, 0);
  // Capital purchases, held out of the operating figure the way the P&L holds
  // them out of Net Operating Income. The default scenario excludes them too,
  // so the backtest keeps comparing like with like.
  const fixedAssetPurchases = expenseLines.reduce((s, l) => s + l.fixedAssetAmount, 0);

  return {
    window: { from, to },
    marketRate,
    jobs,
    payPeriods: { cadence, keys: periodKeys },
    workers,
    expenses: expenseLines,
    processorFees: round2(processorFees),
    rates,
    employerTaxPercent,
    workersCompPercent: wcPercent,
    workersCompBooked: round2(workersCompBooked),
    workersCompCategories,
    actual: {
      revenue: round2(revenue),
      // Everything paid to the crew, W-2 and 1099 alike. Kept whole because
      // this is the "what did labor cost" figure the UI reports; the split
      // below exists so the employer burden lands only where it legally does.
      crewWages: round2(crewWages + contractLabor),
      w2Wages: round2(crewWages),
      contractLabor: round2(contractLabor),
      ownerEarnings: round2(ownerEarnings),
      /** Equipment and vehicles bought in the window, at or above
       *  FIXED_ASSET_MIN_COST. Reported, not buried — the money did leave. */
      fixedAssetPurchases: round2(fixedAssetPurchases),
      jobMaterialsInLedger: round2(jobMaterialsInLedger),
      profitBeforeOwnerLabor: round2(
        revenue - processorFees - materialsTotal - crewWages - contractLabor - burden
          - (opex - fixedAssetPurchases),
      ),
    },
  };
}

/** Baseline plus the two derived things every consumer wants. */
export async function buildBaselineWithBacktest(from: EtDateKey, to: EtDateKey) {
  const base = await buildBaseline(from, to);
  return {
    baseline: base,
    backtest: backtest(base),
    statusQuo: simulate(base, defaultAssumptions(base)),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Saved scenarios ─────────────────────────────────────────────────────────

export type ForecastInput = {
  name: string;
  notes?: string | null;
  windowFrom: EtDateKey;
  windowTo: EtDateKey;
  compareFrom?: EtDateKey | null;
  compareTo?: EtDateKey | null;
  assumptions: Assumptions;
};

function assertWindow(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new ServiceError("INVALID_WINDOW", "Forecast window must be two YYYY-MM-DD dates.", 400);
  }
  if (from > to) {
    throw new ServiceError("INVALID_WINDOW", "Forecast window starts after it ends.", 400);
  }
}

export async function listForecasts(includeArchived = false) {
  return prisma.forecast.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, name: true, notes: true,
      windowFrom: true, windowTo: true, compareFrom: true, compareTo: true,
      // `assumptions` IS included: the tab replays every saved scenario
      // against the currently-loaded window to draw the side-by-side
      // comparison, so it needs them for the whole list, not just the open
      // one. It's a small flat object.
      assumptions: true,
      // `assessment` is NOT — it's a multi-paragraph blob per row and only
      // the opened scenario ever displays one. Fetched by getForecast.
      assessedAt: true, archivedAt: true, createdAt: true, updatedAt: true,
      createdBy: { select: { id: true, displayName: true } },
    },
  });
}

export async function getForecast(id: string) {
  const f = await prisma.forecast.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, displayName: true } } },
  });
  if (!f) throw new ServiceError("NOT_FOUND", "Forecast not found.", 404);
  return f;
}

export async function createForecast(input: ForecastInput, actorUserId: string) {
  assertWindow(input.windowFrom, input.windowTo);
  if (!input.name?.trim()) throw new ServiceError("NAME_REQUIRED", "Give the forecast a name.", 400);

  const baseline = await buildBaseline(input.windowFrom, input.windowTo);
  return prisma.$transaction(async (tx) => {
    const row = await tx.forecast.create({
      data: {
        name: input.name.trim(),
        notes: input.notes ?? null,
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        compareFrom: input.compareFrom ?? null,
        compareTo: input.compareTo ?? null,
        assumptions: input.assumptions as any,
        // Snapshot so a scenario reopened months from now can show what the
        // ground looked like when it was saved. Late-confirmed payments and
        // back-dated expenses both move a historical window after the fact.
        baselineSnapshot: baseline as any,
        baselineCapturedAt: new Date(),
        createdById: actorUserId,
      },
    });
    await writeAudit(tx, AUDIT.FORECAST.CREATED, actorUserId, {
      forecastId: row.id,
      name: row.name,
      window: `${input.windowFrom}..${input.windowTo}`,
    });
    return row;
  });
}

export async function updateForecast(
  id: string,
  input: Partial<ForecastInput>,
  actorUserId: string,
) {
  const existing = await getForecast(id);
  if (input.windowFrom || input.windowTo) {
    assertWindow(input.windowFrom ?? existing.windowFrom, input.windowTo ?? existing.windowTo);
  }

  // An assessment of superseded numbers is worse than no assessment, so any
  // change to the assumptions or the window clears it rather than leaving
  // stale advice sitting next to fresh figures.
  // Key-order-independent — `existing.assumptions` came back from jsonb, which
  // does not preserve key order, so a plain stringify comparison would report
  // a change on every save and clear assessments that were still valid.
  const assumptionsChanged =
    input.assumptions !== undefined &&
    assumptionsDiffer(input.assumptions, existing.assumptions);
  const windowChanged =
    (input.windowFrom && input.windowFrom !== existing.windowFrom) ||
    (input.windowTo && input.windowTo !== existing.windowTo);
  const clearAssessment = assumptionsChanged || windowChanged;

  return prisma.$transaction(async (tx) => {
    const row = await tx.forecast.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.windowFrom !== undefined ? { windowFrom: input.windowFrom } : {}),
        ...(input.windowTo !== undefined ? { windowTo: input.windowTo } : {}),
        ...(input.compareFrom !== undefined ? { compareFrom: input.compareFrom } : {}),
        ...(input.compareTo !== undefined ? { compareTo: input.compareTo } : {}),
        ...(input.assumptions !== undefined ? { assumptions: input.assumptions as any } : {}),
        ...(clearAssessment ? { assessment: Prisma.DbNull, assessedAt: null } : {}),
      },
    });
    await writeAudit(tx, AUDIT.FORECAST.UPDATED, actorUserId, {
      forecastId: id,
      name: row.name,
      assumptionsChanged,
      windowChanged: !!windowChanged,
      assessmentCleared: clearAssessment,
    });
    return row;
  });
}

export async function duplicateForecast(id: string, actorUserId: string) {
  const src = await getForecast(id);
  return prisma.$transaction(async (tx) => {
    const row = await tx.forecast.create({
      data: {
        name: `${src.name} (copy)`,
        notes: src.notes,
        windowFrom: src.windowFrom,
        windowTo: src.windowTo,
        compareFrom: src.compareFrom,
        compareTo: src.compareTo,
        assumptions: src.assumptions as any,
        baselineSnapshot: src.baselineSnapshot as any,
        baselineCapturedAt: src.baselineCapturedAt,
        // Deliberately NOT copied: an assessment was written about the
        // original and shouldn't follow a copy that is about to diverge.
        createdById: actorUserId,
      },
    });
    await writeAudit(tx, AUDIT.FORECAST.DUPLICATED, actorUserId, {
      forecastId: row.id,
      sourceForecastId: id,
      name: row.name,
    });
    return row;
  });
}

/** Soft delete, matching the archivedAt convention used across the schema. */
export async function archiveForecast(id: string, archived: boolean, actorUserId: string) {
  const existing = await getForecast(id);
  return prisma.$transaction(async (tx) => {
    const row = await tx.forecast.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await writeAudit(
      tx,
      archived ? AUDIT.FORECAST.ARCHIVED : AUDIT.FORECAST.UNARCHIVED,
      actorUserId,
      { forecastId: id, name: existing.name },
    );
    return row;
  });
}

export async function deleteForecast(id: string, actorUserId: string) {
  const existing = await getForecast(id);
  return prisma.$transaction(async (tx) => {
    // Snapshot what's being destroyed BEFORE deleting it — a forecast is the
    // document a pay decision gets argued from, and "it used to say something
    // different" is unanswerable without this.
    await writeAudit(tx, AUDIT.FORECAST.DELETED, actorUserId, {
      forecastId: id,
      name: existing.name,
      window: `${existing.windowFrom}..${existing.windowTo}`,
      assumptions: existing.assumptions,
      notes: existing.notes,
    });
    await tx.forecast.delete({ where: { id } });
    return { ok: true as const };
  });
}

/**
 * Persist an AI assessment against a scenario.
 *
 * Lives here rather than in the route so the write and its audit row commit in
 * one transaction — the same rule every other mutation in this codebase
 * follows. The stored blob carries the assumptions it was written about, so a
 * cached assessment can never be rendered beside numbers it never saw.
 */
export async function saveAssessment(id: string, assessment: unknown, actorUserId: string) {
  const existing = await getForecast(id);
  return prisma.$transaction(async (tx) => {
    await tx.forecast.update({
      where: { id },
      data: { assessment: assessment as any, assessedAt: new Date() },
    });
    await writeAudit(tx, AUDIT.FORECAST.ASSESSED, actorUserId, {
      forecastId: id,
      name: existing.name,
    });
    return { ok: true as const };
  });
}
