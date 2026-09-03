// ─────────────────────────────────────────────────────────────────────────────
// Forecast model — the pure simulator behind Super → Money → Forecast.
//
// ADVISORY. Nothing here writes a Setting, a Payment, or a payroll row. It
// answers one question: if the pay structure, prices, volume or crew had been
// different over a window that already happened, what would the books have
// looked like?
//
// THE ONE RULE: payouts are computed by `computeBreakdown` from ./payoutMath —
// the same function that writes real PaymentSplit rows. This module owns the
// OVERLAY (hourly bases, rate cards, hypothetical hires, cost scaling) and
// none of the split arithmetic. A simulator with its own copy of the split
// math drifts from production the first time a rate rule changes, and it
// drifts silently while still looking authoritative.
// ─────────────────────────────────────────────────────────────────────────────

import { computeBreakdown, type Rates, type WorkerInput, type WorkerType } from "./payoutMath";

export const FORECAST_MODEL_VERSION = 1;

/** Mirrors CostBehavior in apps/api/src/services/expenseCategories.ts. Declared
 *  here too so this package stays dependency-free; the API passes its own
 *  union straight in. */
/** How a cost category responds to volume.
 *
 *  AS_IS is the default and means exactly what it says: the category holds
 *  the amount actually spent, whatever you do to the other levers. Every
 *  other adjustment in this tool baselines on reality — margin starts at the
 *  real setting, volume at 1x, price at 0% — and this now does too. The tool
 *  asserts nothing about how a cost behaves until you tell it. */
export type CostBehavior =
  | "AS_IS" | "VARIABLE" | "FIXED" | "PER_JOB" | "ONE_TIME" | "DISCRETIONARY";

// ── Baseline: what actually happened, as data ────────────────────────────────

export type ForecastJob = {
  id: string;
  /** Cash actually collected. Zero for completed-but-unpaid work, which is
   *  kept in the sample on purpose — see `collectionRatePercent`. */
  paid: number;
  /** What the client was invoiced. Diverges from `paid` on underpayment. */
  invoicePrice: number | null;
  /** Job-linked materials (mulch, chemicals) — deducted before the split. */
  materials: number;
  /** On-site duration. Null when the occurrence was never clock-started. */
  minutes: number | null;
  /** ET date key of completion, for windowing and weekly rollups. */
  dateKey: string | null;
  crew: Array<{ userId: string; splitPercent: number }>;
};

export type ForecastWorker = {
  userId: string;
  name: string;
  workerType: WorkerType | null;
  isOwner: boolean;
  /** Portal-to-portal hours from WorkerWorkday. Drive time and rain delays
   *  are in here, which is why an hourly base costs real money. */
  clockedHours: number;
  /** What this person actually took home over the window. Kept on the baseline
   *  so every scenario can answer "is this person better or worse off than they
   *  really were?" — the aggregate labor percentage hides that entirely. */
  actualPay: number;
};

export type ForecastExpenseLine = {
  category: string;
  behavior: CostBehavior;
  amount: number;
};

/** The local market wage band the fairness view compares against, with enough
 *  provenance for the UI to say where it came from. Optional so a caller that
 *  hasn't looked one up still type-checks. */
export type MarketRateInfo = {
  low: number;
  high: number;
  source: "bls" | "override" | "fallback";
  areaName: string | null;
  areaCode: string | null;
  year: string | null;
  occupation: string | null;
  percentiles: [number, number];
  fetchedAt: string | null;
  note: string | null;
};

export type ForecastBaseline = {
  window: { from: string; to: string };
  marketRate?: MarketRateInfo;
  jobs: ForecastJob[];
  workers: ForecastWorker[];
  expenses: ForecastExpenseLine[];
  /** Processor fees, which the business always absorbs (FINANCIAL_SYSTEM §5). */
  processorFees: number;
  /** The live settings, so a scenario can start from "no change". */
  rates: Rates;
  /** Employer payroll tax as a percent of W-2 wages. Comes from the app's
   *  ESTIMATOR, never from imported Gusto rows — see the payroll build gate:
   *  entangling the two makes every P&L number's meaning depend on whether a
   *  payroll period happened to be uploaded. */
  employerTaxPercent: number;
  /** Workers comp as a percent of W-2 wages. An estimate the operator tunes;
   *  the real premium is a quote, not a rate we can derive. */
  workersCompPercent: number;
  /** What the app's own books say for this window, so the UI can show whether
   *  the model reproduces reality before anyone trusts a projection. */
  actual: {
    revenue: number;
    crewWages: number;
    ownerEarnings: number;
    profitBeforeOwnerLabor: number;
  };
};

// ── A worker who doesn't exist yet ───────────────────────────────────────────

/**
 * Adding a person has two completely different economics, and conflating them
 * is the single easiest way to make this tool lie:
 *
 *   ADDED_CAPACITY — they bring NEW work. Revenue goes up, and the projection
 *     is only as good as the assumption that you can actually sell those
 *     hours. Optimistic by construction.
 *   SUBSTITUTION   — they take hours off someone who already works them.
 *     Revenue is unchanged; only the cost of producing it moves. This is the
 *     honest way to model "should this crew be W-2 or 1099".
 *
 * The tool makes you pick, and labels which one a scenario used.
 */
export type CapacityMode = "ADDED_CAPACITY" | "SUBSTITUTION";

export type HypotheticalWorker = {
  /** Local id, e.g. "hyp-1". Never a real User id. */
  id: string;
  name: string;
  workerType: WorkerType;
  hours: number;
  mode: CapacityMode;
  /** ADDED_CAPACITY only: revenue they generate per clocked hour. Defaults in
   *  the UI to the existing crew's average, which is the neutral assumption. */
  revenuePerHour: number;
  /** SUBSTITUTION only: whose hours they take. */
  substituteForUserId?: string | null;
};

// ── The levers ───────────────────────────────────────────────────────────────

export type PayModel =
  /** Worker share of each job, as today. */
  | "SHARE"
  /** Guaranteed hourly floor plus a smaller share. */
  | "HOURLY_PLUS_SHARE"
  /** Fixed dollars per job, decoupled from what the client pays — so a price
   *  increase reaches the business instead of being split 65/35 on the way in. */
  | "RATE_CARD";

export type Assumptions = {
  payModel: PayModel;
  /** Percent of each job the BUSINESS keeps. Named to match the live settings
   *  (EMPLOYEE_BUSINESS_MARGIN_PERCENT / CONTRACTOR_PLATFORM_FEE_PERCENT) so a
   *  scenario translates directly into a settings change. */
  employeeMarginPercent: number;
  contractorFeePercent: number;

  /** HOURLY_PLUS_SHARE: guaranteed base for every clocked hour. */
  hourlyBase: number;
  /** Extra per hour for the crew lead, so a productivity premium is explicit
   *  rather than an artifact of who got assigned the expensive jobs. */
  leadHourlyBonus: number;
  leadUserIds: string[];

  /** RATE_CARD: dollars per job, split across the crew by their split percent. */
  rateCardPerJob: number;

  /** Applied to every collected amount. */
  priceIncreasePercent: number;
  /** Lifts any job below this to the floor. Never applied to $0 jobs — work
   *  that collected nothing is a collection problem, not a pricing one, and
   *  quietly converting it to revenue would fake away the real loss. */
  minimumInvoice: number;
  /** Scales the whole book. Fixed costs deliberately do NOT follow. */
  volumeMultiplier: number;

  /** Costs rise this much over the projected period — the ordinary "things
   *  get more expensive" lever. Applied to every cost line after its volume
   *  scaling. Deliberately one number rather than a rate per category: this
   *  is a small business forecast, not a CPI model.
   *
   *  NOT applied to labor. Share-based pay already rises with prices on its
   *  own, and the hourly base is a number the operator sets directly — so
   *  inflating wages here would double-count. */
  costInflationPercent: number;

  employerTaxPercent: number;
  workersCompPercent: number;
  /** Replace the fixed-cost base, for modelling an insurance change or a
   *  software cull. Null = use the window's actual fixed costs. */
  fixedCostOverride: number | null;
  includeOneTime: boolean;
  /** Discretionary spend (advertising, meals) held flat by default: scaling it
   *  with revenue asserts a causal link the data can't support. */
  scaleDiscretionary: boolean;

  /** Retag a cost category for this scenario only — "what if insurance
   *  behaved like a variable cost?". Scenario-local on purpose: the Forecast
   *  tab is advisory and writes no Settings, so the real EXPENSE_COST_BEHAVIOR
   *  stays the baseline and this rides along with the saved forecast. */
  behaviorOverrides: Record<string, CostBehavior>;

  /** Per-worker changes: reclassify, re-hour, or remove. */
  workerOverrides: Record<
    string,
    { workerType?: WorkerType | null; clockedHours?: number; excluded?: boolean }
  >;
  hypotheticalWorkers: HypotheticalWorker[];

};

export function defaultAssumptions(b: ForecastBaseline): Assumptions {
  return {
    payModel: "SHARE",
    employeeMarginPercent: b.rates.employeeMarginPercent,
    contractorFeePercent: b.rates.contractorFeePercent,
    hourlyBase: 0,
    leadHourlyBonus: 0,
    leadUserIds: [],
    rateCardPerJob: 0,
    priceIncreasePercent: 0,
    minimumInvoice: 0,
    volumeMultiplier: 1,
    costInflationPercent: 0,
    employerTaxPercent: b.employerTaxPercent,
    workersCompPercent: b.workersCompPercent,
    fixedCostOverride: null,
    includeOneTime: true,
    scaleDiscretionary: false,
    behaviorOverrides: {},
    workerOverrides: {},
    hypotheticalWorkers: [],
  };
}

// ── Results ──────────────────────────────────────────────────────────────────

export type WorkerOutcome = {
  userId: string;
  name: string;
  workerType: WorkerType | null;
  isOwner: boolean;
  hypothetical: boolean;
  clockedHours: number;
  /** Share of job revenue. */
  sharePay: number;
  /** Guaranteed hourly, if the model has one. */
  hourlyPay: number;
  totalPay: number;
  /** What they take home per hour they actually clocked — the number that
   *  decides whether a scenario is fair to a real person. */
  effectiveHourly: number;
  /** Employer tax + workers comp. Zero for contractors and the owner. */
  employerBurden: number;
};

export type CostLine = { category: string; behavior: CostBehavior; amount: number };

export type ForecastWarning = {
  level: "critical" | "caution";
  message: string;
};

export type ForecastResult = {
  revenue: number;
  materials: number;
  processorFees: number;
  crewPay: number;
  ownerPay: number;
  employerBurden: number;
  costs: CostLine[];
  costsTotal: number;
  fixedCosts: number;
  /** What the business earns before the LLC owner's share of the work is
   *  accounted for. NOT the bottom line — the owner's share is real labor
   *  that someone would have to be paid to replace. */
  profitBeforeOwnerLabor: number;
  /** What actually stays in the business after the owner's share. This is
   *  the apples-to-apples line for "should I hire someone to do my hours" —
   *  hiring converts owner share into crew pay, and only this number lets
   *  you compare the two honestly. */
  profitAfterOwnerLabor: number;
  marginPercent: number;
  laborPercentOfRevenue: number;
  workers: WorkerOutcome[];
  jobCount: number;
  totalClockedHours: number;
  revenuePerClockedHour: number;
  warnings: ForecastWarning[];
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const isW2 = (t: WorkerType | null) => t === "EMPLOYEE" || t === "TRAINEE";

/** Price a single job under the pricing levers. */
function adjustedPaid(job: ForecastJob, a: Assumptions): number {
  if (job.paid <= 0) return 0; // uncollected stays uncollected — see minimumInvoice
  const raised = job.paid * (1 + a.priceIncreasePercent / 100);
  return round2(Math.max(raised, a.minimumInvoice));
}

/**
 * Run a scenario.
 *
 * Pure and cheap enough to call on every slider tick — a few hundred jobs and
 * a handful of workers. That is deliberate: the alternative is a round trip
 * per drag, which makes the tool feel broken.
 */
export function simulate(baseline: ForecastBaseline, a: Assumptions): ForecastResult {
  const rates: Rates = {
    employeeMarginPercent: a.employeeMarginPercent,
    contractorFeePercent: a.contractorFeePercent,
  };

  // Effective roster: real workers with overrides applied, minus exclusions.
  const roster = new Map<string, ForecastWorker>();
  for (const w of baseline.workers) {
    const o = a.workerOverrides[w.userId];
    if (o?.excluded) continue;
    roster.set(w.userId, {
      ...w,
      workerType: o?.workerType !== undefined ? o.workerType : w.workerType,
      clockedHours: o?.clockedHours ?? w.clockedHours,
    });
  }

  const sharePay = new Map<string, number>();
  const add = (id: string, n: number) => sharePay.set(id, (sharePay.get(id) ?? 0) + n);

  let revenue = 0;
  let materials = 0;
  let jobCount = 0;

  for (const job of baseline.jobs) {
    const crew = job.crew.filter((c) => roster.has(c.userId));
    // Every crew member excluded — the job can't be produced in this scenario,
    // so its revenue doesn't exist either. Dropping the revenue but keeping the
    // job would silently flatter the margin.
    if (crew.length === 0) continue;

    const paid = adjustedPaid(job, a);
    revenue += paid;
    materials += job.materials;
    jobCount += 1;

    if (a.payModel === "RATE_CARD") {
      const totalPct = crew.reduce((s, c) => s + c.splitPercent, 0) || 100;
      for (const c of crew) add(c.userId, (a.rateCardPerJob * c.splitPercent) / totalPct);
      continue;
    }

    // SHARE and HOURLY_PLUS_SHARE both split the job; they differ only in the
    // margin percent the operator sets alongside the hourly base.
    const workers: WorkerInput[] = crew.map((c) => ({
      userId: c.userId,
      splitPercent: c.splitPercent,
      workerType: roster.get(c.userId)!.workerType,
    }));
    for (const row of computeBreakdown(paid, job.materials, workers, rates)) {
      add(row.userId, row.net);
    }
  }

  // ── Hypothetical hires ────────────────────────────────────────────────────
  //
  // ADDED_CAPACITY brings its own revenue at a stated productivity.
  // SUBSTITUTION moves hours (and the pay attached to them) off an existing
  // worker, leaving revenue untouched.
  const hypothetical: ForecastWorker[] = [];
  for (const h of a.hypotheticalWorkers) {
    if (h.hours <= 0) continue;
    hypothetical.push({
      userId: h.id,
      name: h.name,
      workerType: h.workerType,
      isOwner: false,
      clockedHours: h.hours,
      // No history to compare against — a person who doesn't exist has no
      // "before". The fairness regression check skips hypothetical workers
      // for exactly this reason.
      actualPay: 0,
    });

    if (h.mode === "ADDED_CAPACITY") {
      const newRevenue = h.hours * h.revenuePerHour;
      revenue += newRevenue;
      // New work arrives as jobs at the book's average price. Derived from the
      // baseline rather than from the running total, which would be circular.
      const paidJobs = baseline.jobs.filter((j) => j.paid > 0);
      const avgJob = paidJobs.length
        ? paidJobs.reduce((s, j) => s + j.paid, 0) / paidJobs.length
        : 0;
      jobCount += avgJob > 0 ? Math.round(newRevenue / avgJob) : 0;
      if (a.payModel === "RATE_CARD") {
        add(h.id, avgJob > 0 ? (newRevenue / avgJob) * a.rateCardPerJob : 0);
      } else {
        const rate = isW2(h.workerType) ? a.employeeMarginPercent : a.contractorFeePercent;
        add(h.id, newRevenue * (1 - rate / 100));
      }
    } else {
      const from = h.substituteForUserId ? roster.get(h.substituteForUserId) : undefined;
      if (from && from.clockedHours > 0) {
        const fraction = Math.min(1, h.hours / from.clockedHours);
        const moved = (sharePay.get(from.userId) ?? 0) * fraction;
        add(from.userId, -moved);
        from.clockedHours = round2(from.clockedHours - h.hours * fraction);
        // The displaced worker's share is re-earned by the substitute at the
        // substitute's own rate — that rate difference IS the question being
        // asked when you compare a W-2 crew against a 1099 one.
        if (a.payModel !== "RATE_CARD") {
          const fromRate = isW2(from.workerType) ? a.employeeMarginPercent : a.contractorFeePercent;
          const toRate = isW2(h.workerType) ? a.employeeMarginPercent : a.contractorFeePercent;
          const grossMoved = fromRate >= 100 ? 0 : moved / (1 - fromRate / 100);
          add(h.id, grossMoved * (1 - toRate / 100));
        } else {
          add(h.id, moved);
        }
      }
    }
  }

  const allWorkers = [...roster.values(), ...hypothetical];

  // ── Volume ────────────────────────────────────────────────────────────────
  // Linear in everything except fixed costs, which is the entire point of the
  // lever: it shows how much of today's problem is scale rather than structure.
  const vm = Math.max(0, a.volumeMultiplier);
  revenue = revenue * vm;
  materials = materials * vm;
  jobCount = Math.round(jobCount * vm);
  const processorFees = baseline.processorFees * vm;

  // ── Pay per worker ────────────────────────────────────────────────────────
  const outcomes: WorkerOutcome[] = allWorkers.map((w) => {
    const hours = w.clockedHours * vm;
    const share = (sharePay.get(w.userId) ?? 0) * vm;
    const base =
      a.payModel === "HOURLY_PLUS_SHARE"
        ? hours * (a.hourlyBase + (a.leadUserIds.includes(w.userId) ? a.leadHourlyBonus : 0))
        : 0;
    const total = round2(share + base);
    // Employer burden lands on W-2 workers only, and never on the owner —
    // owner earnings are a draw, not a paycheck (FINANCIAL_SYSTEM §8).
    const burden =
      isW2(w.workerType) && !w.isOwner
        ? round2(total * ((a.employerTaxPercent + a.workersCompPercent) / 100))
        : 0;
    return {
      userId: w.userId,
      name: w.name,
      workerType: w.workerType,
      isOwner: w.isOwner,
      hypothetical: w.userId.startsWith("hyp-"),
      clockedHours: round2(hours),
      sharePay: round2(share),
      hourlyPay: round2(base),
      totalPay: total,
      effectiveHourly: hours > 0 ? round2(total / hours) : 0,
      employerBurden: burden,
    };
  });

  const ownerPay = outcomes.filter((o) => o.isOwner).reduce((s, o) => s + o.totalPay, 0);
  const crewPay = outcomes.filter((o) => !o.isOwner).reduce((s, o) => s + o.totalPay, 0);
  const employerBurden = outcomes.reduce((s, o) => s + o.employerBurden, 0);

  // ── Costs by behavior ─────────────────────────────────────────────────────
  const revenueRatio = baseline.actual.revenue > 0 ? revenue / baseline.actual.revenue : vm;
  const inflation = 1 + (a.costInflationPercent || 0) / 100;
  const costs: CostLine[] = [];
  for (const line of baseline.expenses) {
    // The scenario's own tag wins over the configured one.
    const behavior = a.behaviorOverrides?.[line.category] ?? "AS_IS";
    let amount = line.amount;
    switch (behavior) {
      case "AS_IS":
      case "FIXED":
        // Both hold the actual amount. They differ in intent, not arithmetic:
        // AS_IS is "I haven't said", FIXED is "I've said this doesn't scale".
        // Keeping them apart is what lets the UI warn about the untagged ones.
        break;
      case "VARIABLE":
        // Follows WORK DONE, not money billed. This used to scale by the
        // revenue ratio, which meant raising prices on identical routes
        // added 15% to the fuel bill — you didn't drive any further.
        //
        // That makes VARIABLE and PER_JOB behave identically while volume is
        // a single flat multiplier. Both tags are kept because they mean
        // different things and would diverge the moment job COUNT and job
        // SIZE become separate levers; today the distinction is descriptive.
        amount = line.amount * vm;
        break;
      case "PER_JOB":
        amount = line.amount * vm;
        break;
      case "ONE_TIME":
        amount = a.includeOneTime ? line.amount : 0;
        break;
      case "DISCRETIONARY":
        amount = a.scaleDiscretionary ? line.amount * revenueRatio : line.amount;
        break;
    }
    // Inflation lands on every cost line, after volume scaling.
    amount = amount * inflation;
    if (amount !== 0) costs.push({ category: line.category, behavior, amount: round2(amount) });
  }
  const naturalFixed = costs
    .filter((c) => c.behavior === "FIXED")
    .reduce((s, c) => s + c.amount, 0);
  if (a.fixedCostOverride != null) {
    const delta = a.fixedCostOverride - naturalFixed;
    costs.push({ category: "Fixed-cost adjustment", behavior: "FIXED", amount: round2(delta) });
  }
  const costsTotal = costs.reduce((s, c) => s + c.amount, 0);
  const fixedCosts = a.fixedCostOverride ?? naturalFixed;

  const profitBeforeOwnerLabor =
    revenue - materials - processorFees - crewPay - employerBurden - costsTotal;
  // The owner's share always comes off. It used to be behind a boolean that
  // defaulted to OFF, which made an owner-worked job look far more profitable
  // than the identical job worked by an employee — and quietly broke the one
  // comparison the tool most needs to get right.
  const profitAfterOwnerLabor = profitBeforeOwnerLabor - ownerPay;
  const headlineProfit = profitAfterOwnerLabor;

  const totalClockedHours = outcomes.reduce((s, o) => s + o.clockedHours, 0);

  return {
    revenue: round2(revenue),
    materials: round2(materials),
    processorFees: round2(processorFees),
    crewPay: round2(crewPay),
    ownerPay: round2(ownerPay),
    employerBurden: round2(employerBurden),
    costs,
    costsTotal: round2(costsTotal),
    fixedCosts: round2(fixedCosts),
    profitBeforeOwnerLabor: round2(profitBeforeOwnerLabor),
    profitAfterOwnerLabor: round2(profitAfterOwnerLabor),
    marginPercent: revenue > 0 ? round2((headlineProfit / revenue) * 100) : 0,
    // Includes the owner's share — it is labor, whoever performs it.
    laborPercentOfRevenue:
      revenue > 0 ? round2(((crewPay + ownerPay + employerBurden) / revenue) * 100) : 0,
    workers: outcomes.sort((x, y) => y.clockedHours - x.clockedHours),
    jobCount,
    totalClockedHours: round2(totalClockedHours),
    revenuePerClockedHour: totalClockedHours > 0 ? round2(revenue / totalClockedHours) : 0,
    warnings: buildWarnings(baseline, a, outcomes),
  };
}

/**
 * Guardrails. A forecast that only reports a margin is a machine for cutting
 * labor with the people abstracted out, so the scenario has to say out loud
 * when it has done something to a real person.
 */
export function buildWarnings(
  baseline: ForecastBaseline,
  a: Assumptions,
  outcomes: WorkerOutcome[],
  // Defaults only apply when no rate has been looked up. The real floor comes
  // from the baseline's BLS band, so the retention warning fires against the
  // actual local market rather than a number someone once guessed.
  marketFloorFallback = 15,
  federalMinimum = 7.25,
): ForecastWarning[] {
  const marketFloor = baseline.marketRate?.low ?? marketFloorFallback;
  const out: ForecastWarning[] = [];

  for (const o of outcomes) {
    if (o.clockedHours <= 0 || o.isOwner) continue;
    if (o.effectiveHourly < federalMinimum) {
      out.push({
        level: "critical",
        message: `${o.name} averages $${o.effectiveHourly.toFixed(2)}/hr — below the $${federalMinimum} federal minimum. A piece-rate structure must clear it every workweek, not on average across the window.`,
      });
    } else if (o.effectiveHourly < marketFloor) {
      out.push({
        level: "caution",
        message: `${o.name} averages $${o.effectiveHourly.toFixed(2)}/hr, under the $${marketFloor}/hr local market floor. Expect retention problems.`,
      });
    }
  }

  // Who got worse while others got better. A single aggregate labor number
  // hides this completely, and it is exactly the thing that makes a pay change
  // feel arbitrary to the person on the receiving end.
  const baseByUser = new Map(baseline.workers.map((w) => [w.userId, w]));
  const deltas = outcomes
    .filter((o) => !o.isOwner && !o.hypothetical && o.clockedHours > 0)
    .map((o) => {
      const b = baseByUser.get(o.userId);
      if (!b || b.clockedHours <= 0) return null;
      const was = b.actualPay / b.clockedHours;
      return { name: o.name, was, now: o.effectiveHourly, ratio: was > 0 ? o.effectiveHourly / was : 1 };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  const losers = deltas.filter((d) => d.ratio < 0.85);
  const winners = deltas.filter((d) => d.ratio > 1.05);
  if (losers.length && winners.length) {
    out.push({
      level: "caution",
      message: `${losers.map((d) => d.name).join(", ")} lose more than 15% per hour while ${winners.map((d) => d.name).join(", ")} gain. Uneven outcomes are harder to explain than an across-the-board change.`,
    });
  } else if (losers.length) {
    out.push({
      level: "caution",
      message: `${losers.map((d) => `${d.name} $${d.was.toFixed(0)}→$${d.now.toFixed(0)}/hr`).join(", ")} — a cut of more than 15% per hour.`,
    });
  }

  if (a.volumeMultiplier > 1.5) {
    out.push({
      level: "caution",
      message: `This assumes ${a.volumeMultiplier.toFixed(1)}× the work. Nothing in the sample says that demand exists — treat the margin as conditional on selling it.`,
    });
  }
  if (a.hypotheticalWorkers.some((h) => h.mode === "ADDED_CAPACITY")) {
    out.push({
      level: "caution",
      message: `Includes a hire modelled as added capacity, so its revenue is assumed rather than observed.`,
    });
  }
  // Volume was moved but most costs are still untagged, so they didn't move
  // with it. Silence here would overstate the benefit of scale — the mirror
  // of the bug this default replaced.
  if (a.volumeMultiplier !== 1) {
    const untagged = baseline.expenses.filter(
      (e) => (a.behaviorOverrides?.[e.category] ?? "AS_IS") === "AS_IS",
    );
    if (untagged.length) {
      const held = untagged.reduce((t, e) => t + e.amount, 0);
      out.push({
        level: "caution",
        message: `${untagged.length} of ${baseline.expenses.length} cost categories are still "as is" ($${held.toFixed(0)}), so changing volume doesn't move them. Tag the ones that actually scale — ${untagged.slice(0, 3).map((e) => e.category).join(", ")}${untagged.length > 3 ? "…" : ""}.`,
      });
    }
  }

  if (baseline.jobs.length < 30) {
    out.push({
      level: "caution",
      message: `Only ${baseline.jobs.length} jobs in this window — too few to read as a trend. Widen the date range.`,
    });
  }
  return out;
}

/**
 * How closely the model reproduces the books at today's settings.
 *
 * Not a precision claim — the app is a close estimate and QuickBooks, Gusto
 * and the bank are the source of truth, so some drift is expected and fine.
 * This exists to catch a BROKEN model: if a formula changes and this jumps
 * from 2% to 40%, the operator finds out before forecasting off it.
 */
export function backtest(baseline: ForecastBaseline): {
  modelled: number;
  actual: number;
  differencePercent: number;
} {
  const result = simulate(baseline, defaultAssumptions(baseline));
  const actual = baseline.actual.profitBeforeOwnerLabor;
  const modelled = result.profitBeforeOwnerLabor;
  const denom = Math.abs(baseline.actual.revenue) || 1;
  return {
    modelled: round2(modelled),
    actual: round2(actual),
    differencePercent: round2((Math.abs(modelled - actual) / denom) * 100),
  };
}

/**
 * Key-order-independent JSON comparison for assumption sets.
 *
 * `Forecast.assumptions` is a Prisma Json column, which Postgres stores as
 * jsonb — and jsonb does NOT preserve key order. So a plain
 * JSON.stringify(a) === JSON.stringify(b) between an in-memory object and the
 * same object after a database round trip reports "different" every time,
 * even when nothing changed.
 *
 * Observed as a stale-assessment banner appearing on assessments that had
 * just been generated, which is exactly the warning the operator would learn
 * to ignore.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** True when two assumption sets differ in substance, ignoring key order. */
export function assumptionsDiffer(a: unknown, b: unknown): boolean {
  return stableStringify(a) !== stableStringify(b);
}
