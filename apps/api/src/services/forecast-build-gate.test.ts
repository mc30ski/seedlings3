// ─────────────────────────────────────────────────────────────────────────────
// Build gate — Super forecasting tool (Money → Forecast)
//
// The tool's output changes what real people get paid, so the invariants that
// keep it honest are mechanical, not conventions:
//
//   A. The simulator owns NO payout arithmetic. It calls computeBreakdown —
//      the same function that writes real PaymentSplit rows.
//   B. A forecast is ADVISORY. It never writes a Setting, Payment, or payroll
//      row, no matter what a future edit is tempted to add.
//   C. The payroll ↔ estimate firewall holds: forecasting is an estimate
//      surface and must not read imported Gusto actuals.
//   D. Cost behavior actually behaves — fixed costs don't scale, variable ones
//      do. This is the whole basis of the scale argument.
//   E. Employer burden lands only where it legally lands.
//   F. Pricing levers never invent revenue that didn't exist.
//   G. Guardrails fire. A scenario that underpays someone has to say so.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  simulate,
  backtest,
  defaultAssumptions,
  assumptionsDiffer,
  describePayShape,
  migrateAssumptions,
  stableStringify,
  type ForecastBaseline,
  type Assumptions,
} from "@repo/money";
import { payPeriodKeys } from "./forecast";
import type { EtDateKey } from "../lib/dates";

const REPO_ROOT = join(__dirname, "../../../..");
const MODEL_SRC = readFileSync(join(REPO_ROOT, "packages/money/forecastModel.ts"), "utf8");
const SERVICE_PATH = join(REPO_ROOT, "apps/api/src/services/forecast.ts");
const ROUTES_PATH = join(REPO_ROOT, "apps/api/src/routes/forecast.ts");

// ── Fixture: a miniature season with the shapes that matter ──────────────────
function baseline(over: Partial<ForecastBaseline> = {}): ForecastBaseline {
  return {
    window: { from: "2026-06-01", to: "2026-06-28" },
    // Four weekly periods, which is the index space every worker's
    // `periodHours` below is aligned to.
    payPeriods: {
      cadence: "WEEKLY" as const,
      keys: ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"],
    },
    jobs: [
      // solo employee job
      { id: "j1", paid: 60, invoicePrice: 60, materials: 0, minutes: 30, dateKey: "2026-06-01",
        crew: [{ userId: "emp", splitPercent: 100 }] },
      // two-person crew
      { id: "j2", paid: 100, invoicePrice: 100, materials: 10, minutes: 40, dateKey: "2026-06-02",
        crew: [{ userId: "emp", splitPercent: 50 }, { userId: "con", splitPercent: 50 }] },
      // completed but never collected
      { id: "j3", paid: 0, invoicePrice: 55, materials: 0, minutes: 50, dateKey: "2026-06-03",
        crew: [{ userId: "emp", splitPercent: 100 }] },
      // cheap job, the repricing target
      { id: "j4", paid: 20, invoicePrice: 20, materials: 0, minutes: 45, dateKey: "2026-06-04",
        crew: [{ userId: "con", splitPercent: 100 }] },
    ],
    workers: [
      // Emp works three of the four weeks, Con only the first — the shape a
      // per-period guarantee exists to price.
      { userId: "emp", name: "Emp", workerType: "EMPLOYEE", isOwner: false, clockedHours: 10, periodHours: [4, 3, 3, 0], actualPay: 90 },
      { userId: "con", name: "Con", workerType: "CONTRACTOR", isOwner: false, clockedHours: 5, periodHours: [5, 0, 0, 0], actualPay: 60 },
      { userId: "own", name: "Own", workerType: "EMPLOYEE", isOwner: true, clockedHours: 4, periodHours: [1, 1, 1, 1], actualPay: 80 },
    ],
    expenses: [
      { category: "Insurance", behavior: "FIXED", amount: 100, fixedAssetAmount: 0 },
      { category: "Fuel", behavior: "VARIABLE", amount: 50, fixedAssetAmount: 0 },
      { category: "Supplies", behavior: "PER_JOB", amount: 40, fixedAssetAmount: 0 },
      // A $30 category of which $25 is a capital purchase — the shape the
      // fixed-asset toggle exists for.
      { category: "Tools", behavior: "ONE_TIME", amount: 30, fixedAssetAmount: 25 },
      { category: "Advertising", behavior: "DISCRETIONARY", amount: 20, fixedAssetAmount: 0 },
    ],
    processorFees: 5,
    rates: { employeeMarginPercent: 35, contractorFeePercent: 25 },
    employerTaxPercent: 8.25,
    workersCompPercent: 17.6,
    actual: {
      revenue: 180, crewWages: 150, w2Wages: 90, contractLabor: 60,
      fixedAssetPurchases: 25, jobMaterialsInLedger: 0,
      ownerEarnings: 80, profitBeforeOwnerLabor: 0,
    },
    ...over,
  };
}
const A = (over: Partial<Assumptions> = {}): Assumptions => ({
  ...defaultAssumptions(baseline()),
  ...over,
});

// ── A. No private copy of the split math ────────────────────────────────────
describe("[build-gate] the simulator does not reimplement payout math", () => {
  it("imports computeBreakdown rather than deriving splits itself", () => {
    expect(MODEL_SRC).toMatch(/import\s*\{[^}]*computeBreakdown[^}]*\}\s*from\s*["']\.\/payoutMath["']/);
  });

  it("contains no fee/margin arithmetic of its own on a per-job basis", () => {
    // The overlay may scale by a rate (hourly bases, burden), but it must never
    // recompute a worker's share of a JOB. Those are the two spellings that
    // would mean someone had inlined computeBreakdown's body.
    expect(MODEL_SRC).not.toMatch(/gross\s*\*\s*\(?\s*ratePercent/);
    expect(MODEL_SRC).not.toMatch(/splitPercent\s*\/\s*100\s*\)\s*\*\s*\(?\s*1\s*-/);
  });

  it("uses the shared package, so production and the simulator cannot diverge", () => {
    const shim = readFileSync(join(REPO_ROOT, "apps/api/src/lib/payoutMath.ts"), "utf8");
    expect(shim).toMatch(/@repo\/money/);
  });
});

// ── B/C. Advisory, and behind the payroll firewall ──────────────────────────
describe("[build-gate] a forecast is advisory and firewalled", () => {
  const sources = () =>
    [SERVICE_PATH, ROUTES_PATH].filter(existsSync).map((p) => [p, readFileSync(p, "utf8")] as const);

  it("never writes a Setting, Payment, PaymentSplit, or payroll row", () => {
    for (const [path, src] of sources()) {
      for (const forbidden of [
        /\bsetting\.(create|update|upsert|delete|createMany|updateMany)/i,
        /\bpayment\.(create|update|upsert|delete)/i,
        /\bpaymentSplit\.(create|update|upsert|delete)/i,
        /\bpayrollEntry\.(create|update|upsert|delete)/i,
        /\bpayrollPeriod\.(create|update|upsert|delete)/i,
      ]) {
        expect(src, `${path} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("never reads imported Gusto actuals — employer tax comes from the estimator", () => {
    // Same reasoning as the payroll build gate: if a forecast silently changes
    // meaning depending on whether a payroll period happened to be uploaded,
    // every number it produces becomes unanswerable after the fact.
    for (const [path, src] of sources()) {
      expect(src, `${path} must not read PayrollEntry`).not.toMatch(/payrollEntry\.(find|aggregate|groupBy|count)/i);
      expect(src, `${path} must not read PayrollPeriod`).not.toMatch(/payrollPeriod\.(find|aggregate|groupBy|count)/i);
      expect(src, `${path} must not import payroll services`).not.toMatch(
        /from\s+["'][^"']*payroll(Import)?["']/,
      );
    }
  });
});

// ── D. Cost behavior behaves ────────────────────────────────────────────────
describe("[build-gate] cost behavior drives the scale argument", () => {
  it("fixed costs do not grow with volume; per-job costs do", () => {
    const b = baseline();
    const one = simulate(b, A({ volumeMultiplier: 1, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } }));
    const two = simulate(b, A({ volumeMultiplier: 2, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } }));
    const fixedOf = (r: typeof one) =>
      r.costs.filter((c) => c.behavior === "FIXED").reduce((s, c) => s + c.amount, 0);
    const perJobOf = (r: typeof one) =>
      r.costs.filter((c) => c.behavior === "PER_JOB").reduce((s, c) => s + c.amount, 0);

    expect(fixedOf(two)).toBeCloseTo(fixedOf(one), 2);
    expect(perJobOf(two)).toBeCloseTo(perJobOf(one) * 2, 2);
  });

  it("doubling volume therefore improves margin — the whole point of the lever", () => {
    const b = baseline();
    const one = simulate(b, A({ volumeMultiplier: 1, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } }));
    const two = simulate(b, A({ volumeMultiplier: 2, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } }));
    expect(two.marginPercent).toBeGreaterThan(one.marginPercent);
  });

  it("discretionary spend is held flat unless the operator opts in", () => {
    const b = baseline();
    const held = simulate(b, A({ volumeMultiplier: 3, scaleDiscretionary: false, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } }));
    const scaled = simulate(b, A({ volumeMultiplier: 3, scaleDiscretionary: true, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } }));
    const adv = (r: typeof held) => r.costs.find((c) => c.category === "Advertising")!.amount;
    expect(adv(held)).toBeCloseTo(20, 2);
    expect(adv(scaled)).toBeGreaterThan(20);
  });

  it("one-time costs can be dropped from a forward projection", () => {
    const b = baseline();
    expect(simulate(b, A({ includeOneTime: false, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } })).costs.some((c) => c.category === "Tools")).toBe(false);
    expect(simulate(b, A({ includeOneTime: true, behaviorOverrides: { Insurance: "FIXED", Fuel: "VARIABLE", Supplies: "PER_JOB", Tools: "ONE_TIME", Advertising: "DISCRETIONARY" } })).costs.some((c) => c.category === "Tools")).toBe(true);
  });
});

// ── E. Employer burden lands only where it legally lands ────────────────────
describe("[build-gate] employer burden", () => {
  it("is charged on W-2 workers and never on contractors", () => {
    const r = simulate(baseline(), A());
    const emp = r.workers.find((w) => w.userId === "emp")!;
    const con = r.workers.find((w) => w.userId === "con")!;
    expect(emp.employerBurden).toBeGreaterThan(0);
    expect(con.employerBurden).toBe(0);
  });

  it("is never charged on the owner, who takes a draw rather than a paycheck", () => {
    const r = simulate(baseline(), A());
    expect(r.workers.find((w) => w.userId === "own")!.employerBurden).toBe(0);
  });

  it("reclassifying an employee to contractor removes the burden", () => {
    const asEmployee = simulate(baseline(), A());
    const asContractor = simulate(
      baseline(),
      A({ workerOverrides: { emp: { workerType: "CONTRACTOR" } } }),
    );
    expect(asContractor.employerBurden).toBeLessThan(asEmployee.employerBurden);
  });
});

// ── F. Pricing levers never invent revenue ──────────────────────────────────
describe("[build-gate] pricing levers", () => {
  it("a minimum invoice never resurrects a job that collected nothing", () => {
    const r = simulate(baseline(), A({ minimumInvoice: 50 }));
    // j3 collected $0 and must stay $0: uncollected work is a collection
    // problem, and pricing it away would hide a real loss.
    // j1 60 + j2 100 + j3 0 + j4 lifted 20 -> 50
    expect(r.revenue).toBeCloseTo(60 + 100 + 0 + 50, 2);
  });

  it("a price increase raises revenue proportionally on collected jobs only", () => {
    const flat = simulate(baseline(), A());
    const up = simulate(baseline(), A({ priceIncreasePercent: 10 }));
    expect(up.revenue).toBeCloseTo(flat.revenue * 1.1, 2);
  });

  it("under a rate card the business keeps the whole price increase", () => {
    // A PURE rate card is now spelled "business keeps 100%", which zeroes the
    // share, plus a per-job amount.
    const base = A({ employeeMarginPercent: 100, contractorFeePercent: 100, rateCardPerJob: 25 });
    const flat = simulate(baseline(), base);
    const up = simulate(baseline(), { ...base, priceIncreasePercent: 15 });
    expect(up.crewPay).toBeCloseTo(flat.crewPay, 2);
    expect(up.profitBeforeOwnerLabor).toBeGreaterThan(flat.profitBeforeOwnerLabor);
  });

  it("under a share model the crew automatically takes part of the increase", () => {
    const flat = simulate(baseline(), A());
    const up = simulate(baseline(), A({ priceIncreasePercent: 15 }));
    expect(up.crewPay).toBeGreaterThan(flat.crewPay);
  });
});

// ── G. Guardrails ───────────────────────────────────────────────────────────
describe("[build-gate] guardrails speak up", () => {
  it("flags a worker below the federal minimum as critical", () => {
    // A punishing margin drives the share toward nothing against real hours.
    const r = simulate(baseline(), A({ employeeMarginPercent: 99, contractorFeePercent: 99 }));
    expect(r.warnings.some((w) => w.level === "critical" && /federal minimum/.test(w.message))).toBe(true);
  });

  it("names the people who lose more than 15% per hour", () => {
    const r = simulate(baseline(), A({ employeeMarginPercent: 90 }));
    expect(r.warnings.some((w) => /Emp/.test(w.message))).toBe(true);
  });

  it("says out loud when a scenario assumes demand that isn't in the data", () => {
    const r = simulate(baseline(), A({ volumeMultiplier: 2 }));
    expect(r.warnings.some((w) => /demand/.test(w.message))).toBe(true);
  });

  it("labels an added-capacity hire as assumed rather than observed", () => {
    const r = simulate(
      baseline(),
      A({
        hypotheticalWorkers: [
          { id: "hyp-1", name: "New", workerType: "CONTRACTOR", hours: 20,
            mode: "ADDED_CAPACITY", revenuePerHour: 60 },
        ],
      }),
    );
    expect(r.warnings.some((w) => /assumed rather than observed/.test(w.message))).toBe(true);
    expect(r.workers.find((w) => w.userId === "hyp-1")!.hypothetical).toBe(true);
  });

  it("warns on a sample too small to read as a trend", () => {
    const r = simulate(baseline(), A());
    expect(r.warnings.some((w) => /too few to read as a trend/.test(w.message))).toBe(true);
  });
});

// ── Substitution vs added capacity are genuinely different ──────────────────
describe("[build-gate] a hire's capacity mode changes the economics", () => {
  it("substitution leaves revenue untouched; added capacity raises it", () => {
    const flat = simulate(baseline(), A());
    const sub = simulate(
      baseline(),
      A({
        hypotheticalWorkers: [
          { id: "hyp-1", name: "Sub", workerType: "CONTRACTOR", hours: 10,
            mode: "SUBSTITUTION", revenuePerHour: 0, substituteForUserId: "emp" },
        ],
      }),
    );
    const added = simulate(
      baseline(),
      A({
        hypotheticalWorkers: [
          { id: "hyp-1", name: "Add", workerType: "CONTRACTOR", hours: 10,
            mode: "ADDED_CAPACITY", revenuePerHour: 60 },
        ],
      }),
    );
    expect(sub.revenue).toBeCloseTo(flat.revenue, 2);
    expect(added.revenue).toBeCloseTo(flat.revenue + 600, 2);
  });
});

// ── Backtest ────────────────────────────────────────────────────────────────
describe("[build-gate] backtest", () => {
  it("reports the gap between the model and the books as a percent of revenue", () => {
    const bt = backtest(baseline());
    expect(bt).toHaveProperty("modelled");
    expect(bt).toHaveProperty("actual");
    expect(bt.differencePercent).toBeGreaterThanOrEqual(0);
  });

  it("is computed from the UNCHANGED settings, not from whatever is on screen", () => {
    // If the backtest used the operator's current sliders it would always
    // agree with itself and prove nothing.
    expect(MODEL_SRC).toMatch(/simulate\(baseline,\s*defaultAssumptions\(baseline\)\)/);
  });
});

// ── Assumption comparison survives a database round trip ───────────────────
describe("[build-gate] assumption comparison is key-order independent", () => {
  it("treats the same assumptions with reordered keys as unchanged", () => {
    // Prisma Json becomes Postgres jsonb, which does NOT preserve key order.
    // A naive JSON.stringify comparison therefore reported "changed" on every
    // round trip — surfacing a stale-assessment warning on assessments that
    // had just been generated, which is precisely the warning an operator
    // learns to ignore.
    const a = A({ employeeMarginPercent: 50, hourlyBase: 15 });
    const reordered = Object.fromEntries(
      Object.entries(a).sort(([x], [y]) => y.localeCompare(x)),
    );
    expect(assumptionsDiffer(a, reordered)).toBe(false);
  });

  it("still detects a real change", () => {
    const a = A({ employeeMarginPercent: 50 });
    expect(assumptionsDiffer(a, { ...a, employeeMarginPercent: 51 })).toBe(true);
  });

  it("sorts nested object keys too, and preserves array order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    // Array order is meaningful (crew order, hypothetical worker order) and
    // must NOT be sorted away.
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("distinguishes worker overrides that actually differ", () => {
    const base = A({ workerOverrides: { emp: { workerType: "CONTRACTOR" } } });
    const same = A({ workerOverrides: { emp: { workerType: "CONTRACTOR" } } });
    const diff = A({ workerOverrides: { emp: { workerType: "EMPLOYEE" } } });
    expect(assumptionsDiffer(base, same)).toBe(false);
    expect(assumptionsDiffer(base, diff)).toBe(true);
  });
});

// ── Costs follow work, and inflation is its own lever ──────────────────────
describe("[build-gate] cost inflation and variable-cost driver", () => {
  it("a price increase does NOT inflate variable costs", () => {
    // Raising prices on identical routes cannot raise the fuel bill. This was
    // wrong: VARIABLE scaled by the revenue ratio, so +15% prices added 15%
    // to fuel and vehicle maintenance for driving the same miles.
    const flat = simulate(baseline(), A());
    const priced = simulate(baseline(), A({ priceIncreasePercent: 15 }));
    const fuelOf = (r: typeof flat) => r.costs.find((c) => c.category === "Fuel")!.amount;
    expect(fuelOf(priced)).toBeCloseTo(fuelOf(flat), 2);
    expect(priced.revenue).toBeGreaterThan(flat.revenue);
  });

  it("variable costs DO follow job volume", () => {
    const tag = { behaviorOverrides: { Fuel: "VARIABLE" as const } };
    const one = simulate(baseline(), A({ volumeMultiplier: 1, ...tag }));
    const two = simulate(baseline(), A({ volumeMultiplier: 2, ...tag }));
    const fuelOf = (r: typeof one) => r.costs.find((c) => c.category === "Fuel")!.amount;
    expect(fuelOf(two)).toBeCloseTo(fuelOf(one) * 2, 2);
  });

  it("inflation raises every cost line and nothing else", () => {
    const flat = simulate(baseline(), A());
    const infl = simulate(baseline(), A({ costInflationPercent: 10 }));
    expect(infl.costsTotal).toBeCloseTo(flat.costsTotal * 1.1, 2);
    // Wages are NOT inflated here — share pay already moves with prices and
    // the hourly base is set directly, so doing it here would double-count.
    expect(infl.crewPay).toBeCloseTo(flat.crewPay, 2);
    expect(infl.revenue).toBeCloseTo(flat.revenue, 2);
  });

  it("inflation compounds with volume rather than replacing it", () => {
    const both = simulate(baseline(), A({ volumeMultiplier: 2, costInflationPercent: 10 }));
    const volOnly = simulate(baseline(), A({ volumeMultiplier: 2 }));
    expect(both.costsTotal).toBeCloseTo(volOnly.costsTotal * 1.1, 2);
  });
});

// ── A compared scenario is computed from its OWN window ────────────────────
describe("[build-gate] side-by-side comparison uses the right data", () => {
  const TAB = readFileSync(
    join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8",
  );
  const block = TAB.slice(TAB.indexOf("const comparison"), TAB.indexOf("// ── Saving"));

  it("selects a baseline per scenario window rather than always the loaded one", () => {
    // The bug this replaces: every saved scenario was simulated against
    // whatever window happened to be loaded, while each row was LABELLED with
    // its own stored window. Spring's label above summer's numbers — and the
    // seasonality comparison is the whole reason the feature exists.
    expect(block).toMatch(/windowFrom\}\|\$\{s\.windowTo/);
    expect(block).toMatch(/otherBaselines\[/);
  });

  it("never simulates a saved scenario against the loaded baseline unconditionally", () => {
    expect(block).not.toMatch(/simulate\(\s*data\.baseline,\s*s\.assumptions\s*\)/);
  });

  it("skips a row whose window has not loaded instead of substituting one", () => {
    // Rendering the wrong window's numbers is worse than rendering nothing.
    expect(block).toMatch(/if\s*\(!src\)\s*return\s*\[\]/);
  });
});

// ── The LLC owner's share is its own line, never hidden ───────────────────
describe("[build-gate] LLC Owner share is neither a cost nor silent profit", () => {
  // The shared fixture's owner clocks hours but works no jobs, so they accrue
  // nothing. These assertions need an owner who actually earns.
  const withOwnerJob = () => {
    const b = baseline();
    b.jobs = [
      ...b.jobs,
      { id: "j5", paid: 120, invoicePrice: 120, materials: 0, minutes: 60, dateKey: "2026-06-05",
        crew: [{ userId: "own", splitPercent: 100 }] },
    ];
    return b;
  };
  const A2 = () => defaultAssumptions(withOwnerJob());

  it("is always deducted to reach the retained figure", () => {
    // It used to sit behind a `payOwner` boolean defaulting to OFF, so an
    // owner-worked job looked far more profitable than the identical job
    // worked by an employee — breaking the one comparison the tool most
    // needs to get right: "should I hire someone to do my hours?"
    const r = simulate(withOwnerJob(), A2());
    expect(r.ownerPay).toBeGreaterThan(0);
    expect(r.profitAfterOwnerLabor).toBeCloseTo(r.profitBeforeOwnerLabor - r.ownerPay, 2);
  });

  it("no assumption can hide it", () => {
    expect(Object.keys(defaultAssumptions(baseline()))).not.toContain("payOwner");
  });

  it("counts toward labor, because it is labor", () => {
    const r = simulate(withOwnerJob(), A2());
    const byHand = ((r.crewPay + r.ownerPay + r.employerBurden) / r.revenue) * 100;
    expect(r.laborPercentOfRevenue).toBeCloseTo(byHand, 1);
  });

  it("is excluded from crew pay, so hiring shows up as a real trade", () => {
    // Replacing the owner's hours moves money from ownerPay into crewPay.
    // If the two were pooled, that swap would be invisible.
    const r = simulate(withOwnerJob(), A2());
    const ownerRow = r.workers.find((w) => w.isOwner)!;
    expect(ownerRow.totalPay).toBeGreaterThan(0);
    expect(r.ownerPay).toBeCloseTo(ownerRow.totalPay, 2);
    // The owner's pay must NOT be inside crewPay, or swapping their hours for
    // a hire would be invisible in the numbers.
    const crewSum = r.workers.filter((w) => !w.isOwner).reduce((t, w) => t + w.totalPay, 0);
    expect(r.crewPay).toBeCloseTo(crewSum, 2);
  });
});

// ── Retagging a cost is scenario-local, never a Settings write ────────────
describe("[build-gate] cost-behavior overrides stay advisory", () => {
  it("an override changes the multiplier for this scenario only", () => {
    const b = baseline();
    const at2x = A({ volumeMultiplier: 2 });
    const asVariable = simulate(b, { ...at2x, behaviorOverrides: { Fuel: "VARIABLE" } });
    const asFixed = simulate(b, { ...at2x, behaviorOverrides: { Fuel: "FIXED" } });
    const fuel = (r: typeof asVariable) => r.costs.find((c) => c.category === "Fuel")!;
    expect(fuel(asVariable).amount).toBeCloseTo(100, 2);  // 50 x 2
    expect(fuel(asFixed).amount).toBeCloseTo(50, 2);      // pinned
    expect(fuel(asFixed).behavior).toBe("FIXED");
  });

  it("every category starts AS_IS — the tool asserts nothing until you tag it", () => {
    // Baseline is reality, the same as every other lever: margin starts at
    // the real setting, volume at 1x, price at 0%. A cost starts at what was
    // actually spent and does not move until told to.
    const r = simulate(baseline(), A({ volumeMultiplier: 3 }));
    for (const c of r.costs) expect(c.behavior).toBe("AS_IS");
    const flat = simulate(baseline(), A({ volumeMultiplier: 1 }));
    expect(r.costsTotal).toBeCloseTo(flat.costsTotal, 2);
  });

  it("warns when volume moved but categories are still untagged", () => {
    // Silence here would overstate scale — the mirror of the bug the AS_IS
    // default replaced.
    const r = simulate(baseline(), A({ volumeMultiplier: 2 }));
    expect(r.warnings.some((w) => /still "as is"/.test(w.message))).toBe(true);
  });

  it("the tab writes no Setting when retagging", () => {
    // The Forecast tab is advisory. Retagging must ride along with the saved
    // scenario, not quietly rewrite EXPENSE_COST_BEHAVIOR for the whole app.
    const tab = readFileSync(join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8");
    expect(tab).toMatch(/onRetag=\{\(category, behavior\) =>/);
    expect(tab).toMatch(/set\("behaviorOverrides"/);
    expect(tab).not.toMatch(/EXPENSE_COST_BEHAVIOR/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-period pay guarantee
//
// "Every worker is guaranteed N hours of pay per pay period regardless."
//
// The word that carries the cost is REGARDLESS. Paying the guarantee only in
// periods someone clocked into is a different, much cheaper promise — over the
// real 2026 season, 56 top-up hours instead of 231. The tests below pin the
// expensive reading, because it is the one the operator asked for.
// ─────────────────────────────────────────────────────────────────────────────

const GUAR = (over: Partial<Assumptions> = {}): Assumptions =>
  A({ hourlyBase: 20, guaranteedHoursPerPeriod: 5, ...over });

describe("forecast — the per-period guarantee covers periods with NO hours", () => {
  it("tops a worker up in the week they didn't work at all", () => {
    const r = simulate(baseline(), GUAR());
    const emp = r.workers.find((w) => w.userId === "emp")!;
    // [4,3,3,0] against a 5-hour floor -> 1 + 2 + 2 + 5 = 10 hours.
    // The 5 is the whole point: it comes from a week with no workday rows.
    expect(emp.guaranteedTopUpHours).toBe(10);
    expect(emp.guaranteedTopUpPay).toBe(200);
  });

  it("does not quietly skip empty periods", () => {
    // The failure mode: derive periods from the workday rows, and Con — who
    // worked exactly one of four weeks — costs 0 instead of 15 hours.
    const r = simulate(baseline(), GUAR({ guaranteeContractors: true }));
    const con = r.workers.find((w) => w.userId === "con")!;
    expect(con.guaranteedTopUpHours).toBe(15);
  });

  it("a worker already over the floor every period costs nothing", () => {
    const r = simulate(baseline(), GUAR({ guaranteedHoursPerPeriod: 1 }));
    expect(r.workers.find((w) => w.userId === "own")!.guaranteedTopUpHours).toBe(0);
  });
});

describe("forecast — who the guarantee applies to", () => {
  it("skips contractors unless explicitly opted in", () => {
    const off = simulate(baseline(), GUAR());
    expect(off.workers.find((w) => w.userId === "con")!.guaranteedTopUpHours).toBe(0);
    const on = simulate(baseline(), GUAR({ guaranteeContractors: true }));
    expect(on.workers.find((w) => w.userId === "con")!.guaranteedTopUpHours).toBeGreaterThan(0);
  });

  it("warns loudly when it IS extended to a contractor", () => {
    // A guaranteed minimum to a 1099 worker is a classification factor. The
    // tool may model it; it must not let it pass silently.
    const r = simulate(baseline(), GUAR({ guaranteeContractors: true }));
    const w = r.warnings.find((x) => /1099 worker look like an employee/.test(x.message));
    expect(w?.level).toBe("critical");
  });

  it("never applies to the owner — a draw is not a paycheck", () => {
    const r = simulate(baseline(), GUAR({ guaranteedHoursPerPeriod: 40 }));
    expect(r.workers.find((w) => w.userId === "own")!.guaranteedTopUpHours).toBe(0);
  });
});

describe("forecast — the guarantee is priced, not free", () => {
  it("the top-up reaches take-home pay and the P&L", () => {
    const off = simulate(baseline(), GUAR({ guaranteedHoursPerPeriod: 0 }));
    const on = simulate(baseline(), GUAR());
    const empOff = off.workers.find((w) => w.userId === "emp")!;
    const empOn = r_(on, "emp");
    expect(empOn.totalPay).toBe(round2(empOff.totalPay + 200));
    expect(on.crewPay).toBeGreaterThan(off.crewPay);
    expect(on.profitAfterOwnerLabor).toBeLessThan(off.profitAfterOwnerLabor);
  });

  it("carries employer tax and workers comp, because it is W-2 wages", () => {
    const off = simulate(baseline(), GUAR({ guaranteedHoursPerPeriod: 0 }));
    const on = simulate(baseline(), GUAR());
    expect(r_(on, "emp").employerBurden).toBeGreaterThan(
      off.workers.find((w) => w.userId === "emp")!.employerBurden,
    );
  });

  it("is reported separately from hours actually worked", () => {
    // Buried inside hourlyPay, the guarantee's cost is invisible — the operator
    // can't tell a slow season from an expensive promise.
    const emp = r_(simulate(baseline(), GUAR()), "emp");
    expect(emp.hourlyPay).toBe(round2(10 * 20 + emp.guaranteedTopUpPay));
  });

  it("pays the plain base, not the crew-lead premium", () => {
    // Nobody leads a crew in a week nobody worked.
    const emp = r_(simulate(baseline(), GUAR({ leadHourlyBonus: 10, leadUserIds: ["emp"] })), "emp");
    expect(emp.guaranteedTopUpPay).toBe(200);
  });
});

describe("forecast — the guarantee scales with the other levers", () => {
  it("volume moves the hours it is measured against", () => {
    // At 2x volume Emp works [8,6,6,0]; only the empty week is still short.
    const emp = r_(simulate(baseline(), GUAR({ volumeMultiplier: 2 })), "emp");
    expect(emp.guaranteedTopUpHours).toBe(5);
  });

  it("re-houring a worker moves their per-period shape with them", () => {
    // Halving Emp's hours gives [2,1.5,1.5,0] -> 3 + 3.5 + 3.5 + 5 = 15.
    const emp = r_(
      simulate(baseline(), GUAR({ workerOverrides: { emp: { clockedHours: 5 } } })),
      "emp",
    );
    expect(emp.guaranteedTopUpHours).toBe(15);
  });

  it("an excluded worker costs nothing", () => {
    const r = simulate(baseline(), GUAR({ workerOverrides: { emp: { excluded: true } } }));
    expect(r.workers.some((w) => w.userId === "emp")).toBe(false);
  });
});

describe("forecast — the guarantee says so when it is inert", () => {
  it("warns when the hourly base is still $0", () => {
    // The defect the crew-lead premium shipped with: a slider that moves and
    // changes nothing.
    const r = simulate(baseline(), GUAR({ hourlyBase: 0 }));
    expect(r.warnings.some((w) => /costs nothing because the hourly base is \$0/.test(w.message)))
      .toBe(true);
  });

  it("names the cost and the number of periods when it IS live", () => {
    const r = simulate(baseline(), GUAR());
    const w = r.warnings.find((x) => /hours nobody worked/.test(x.message));
    expect(w?.message).toMatch(/4 weekly periods/);
  });

  it("off by default", () => {
    expect(defaultAssumptions(baseline()).guaranteedHoursPerPeriod).toBe(0);
    expect(defaultAssumptions(baseline()).guaranteeContractors).toBe(false);
  });
});

const r_ = (res: ReturnType<typeof simulate>, id: string) =>
  res.workers.find((w) => w.userId === id)!;
const round2 = (n: number) => Math.round(n * 100) / 100;

describe("forecast — the pay-period calendar the guarantee is priced against", () => {
  const K = (from: string, to: string, c: "WEEKLY" | "BIWEEKLY" | "MONTHLY" = "WEEKLY") =>
    payPeriodKeys(from as EtDateKey, to as EtDateKey, c);

  it("starts at the Monday ON OR BEFORE the window, not the window edge", () => {
    // A window opening mid-week sits inside a real pay period. Starting at the
    // window edge would leave a partial period looking like a short one that
    // the guarantee has to top up.
    expect(K("2026-06-03", "2026-06-21")[0]).toBe("2026-06-01");
  });

  it("counts weekly periods inclusively at both ends", () => {
    expect(K("2026-06-01", "2026-06-28")).toEqual([
      "2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22",
    ]);
    // The 29th opens a fifth period, partial but real.
    expect(K("2026-06-01", "2026-06-29")).toHaveLength(5);
  });

  it("steps biweekly in 14s", () => {
    expect(K("2026-06-01", "2026-06-28", "BIWEEKLY")).toEqual(["2026-06-01", "2026-06-15"]);
  });

  it("uses calendar months when the cadence is monthly", () => {
    expect(K("2026-06-15", "2026-08-02", "MONTHLY")).toEqual([
      "2026-06-01", "2026-07-01", "2026-08-01",
    ]);
  });

  it("rolls the year on a monthly window that crosses December", () => {
    expect(K("2026-11-10", "2027-01-05", "MONTHLY")).toEqual([
      "2026-11-01", "2026-12-01", "2027-01-01",
    ]);
  });

  it("crosses a DST boundary without dropping or duplicating a week", () => {
    // DST ends 2026-11-01. A naive +7*86400000 step lands on Sunday here.
    const keys = K("2026-10-26", "2026-11-15");
    expect(keys).toEqual(["2026-10-26", "2026-11-02", "2026-11-09"]);
  });

  it("a single-day window is still one whole period", () => {
    // Not zero: you cannot be in no pay period.
    expect(K("2026-06-03", "2026-06-03")).toEqual(["2026-06-01"]);
  });
});

describe("forecast — the guarantee reads CONFIG, never imported payroll", () => {
  it("the cadence comes from a Setting", () => {
    const src = readFileSync(SERVICE_PATH, "utf8");
    expect(src).toMatch(/PAYROLL_PERIOD_CADENCE/);
    expect(src).toMatch(/prisma\.setting\.findUnique/);
  });

  it("the service reads no PayrollPeriod or PayrollEntry row", () => {
    // The other half of the estimate/actual firewall. Bucketing hours by real
    // Gusto periods would be more accurate and would make every forecast
    // number's meaning depend on whether an export happened to be uploaded.
    const src = readFileSync(SERVICE_PATH, "utf8");
    expect(src).not.toMatch(/payrollEntry\.|payrollPeriod\.|PayrollEntry|PayrollPeriod/);
  });

  it("every worker's periodHours is aligned to the shared period list", () => {
    const src = readFileSync(SERVICE_PATH, "utf8");
    // Pre-filled with zeros for EVERY period. Building the array from workday
    // rows would omit exactly the periods the guarantee exists to pay for.
    expect(src).toMatch(/new Array\(periodKeys\.length\)\.fill\(0\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pay structure is ADDITIVE — there is no pay model
//
// The old dropdown (SHARE / HOURLY_PLUS_SHARE / RATE_CARD) greyed out whichever
// levers its mode didn't use. Two of the three modes were just "set a lever to
// zero", and the cage forbade combinations that are perfectly reasonable — most
// importantly PURE HOURLY, which is what an ordinary W-2 lawn crew job looks
// like. The levers are free now and add up.
//
// The one lever whose meaning genuinely changed is the rate card: it used to
// SUPPRESS the share, and now rides on top of it. That is what
// migrateAssumptions exists for, and the test below pins it to the penny.
// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the pay model dropdown is gone for good", () => {
  it("no payModel lever survives anywhere", () => {
    // Reintroducing a mode would re-disable controls and silently re-forbid
    // the combinations this change exists to allow.
    expect(MODEL_SRC).not.toMatch(/a\.payModel/);
    expect(defaultAssumptions(baseline())).not.toHaveProperty("payModel");
    const tab = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8",
    );
    expect(tab).not.toMatch(/set\("payModel"/);
  });

  it("the margin levers reach 100, which is how the share gets zeroed", () => {
    // Capped at 90 they did before, "pure hourly" and "pure rate card" are
    // both unreachable and the whole design collapses.
    const tab = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8",
    );
    const levers = tab.match(/max=\{100\} suffix="%"/g) ?? [];
    expect(levers.length).toBeGreaterThanOrEqual(2);
  });
});

describe("[build-gate] every pay lever is live at once", () => {
  it("a rate card ADDS to the share instead of replacing it", () => {
    const share = simulate(baseline(), A());
    const both = simulate(baseline(), A({ rateCardPerJob: 25 }));
    // 4 jobs × $25, on top of every share already being paid.
    expect(both.crewPay + both.ownerPay).toBeCloseTo(share.crewPay + share.ownerPay + 100, 2);
  });

  it("business-keeps 100% zeroes the share, leaving only what else is set", () => {
    const r = simulate(baseline(), A({
      employeeMarginPercent: 100, contractorFeePercent: 100, rateCardPerJob: 25,
    }));
    expect(r.crewPay + r.ownerPay).toBeCloseTo(100, 2);
  });

  it("PURE HOURLY is expressible — the structure the dropdown forbade", () => {
    // Share off, no rate card, an hourly wage. There was no way to say this.
    const r = simulate(baseline(), A({
      employeeMarginPercent: 100, contractorFeePercent: 100, hourlyBase: 18,
    }));
    const emp = r.workers.find((w) => w.userId === "emp")!;
    expect(emp.sharePay).toBe(0);
    expect(emp.totalPay).toBeCloseTo(10 * 18, 2);
    expect(emp.effectiveHourly).toBeCloseTo(18, 2);
  });

  it("hourly and a rate card and a share can all run together", () => {
    const r = simulate(baseline(), A({ hourlyBase: 10, rateCardPerJob: 5 }));
    const emp = r.workers.find((w) => w.userId === "emp")!;
    // Share (j1 + j2 half + j3) + rate card (j1 + half j2 + j3) + 10h × $10.
    expect(emp.hourlyPay).toBeCloseTo(100, 2);
    expect(emp.sharePay).toBeGreaterThan(0);
    expect(emp.totalPay).toBeCloseTo(emp.sharePay + emp.hourlyPay, 2);
  });

  it("the guarantee no longer needs a mode — only an hourly base", () => {
    const r = simulate(baseline(), A({ hourlyBase: 20, guaranteedHoursPerPeriod: 5 }));
    expect(r.workers.find((w) => w.userId === "emp")!.guaranteedTopUpHours).toBe(10);
  });
});

describe("[build-gate] a scenario saved under the old dropdown still means the same thing", () => {
  const legacy = (payModel: string, over: Record<string, unknown> = {}) =>
    ({ ...A(), payModel, ...over }) as unknown as Record<string, unknown>;

  it("RATE_CARD becomes business-keeps-100, paying the card and NOT the share", () => {
    // Without the rewrite the additive rules pay both, overstating crew cost on
    // a scenario the operator never touched.
    const m = migrateAssumptions(legacy("RATE_CARD", { rateCardPerJob: 25 })) as any;
    expect(m.payModel).toBeUndefined();
    expect(m.employeeMarginPercent).toBe(100);
    expect(m.contractorFeePercent).toBe(100);
    const r = simulate(baseline(), m);
    expect(r.crewPay + r.ownerPay).toBeCloseTo(100, 2);
  });

  it("SHARE drops the hourly block it had disabled", () => {
    const m = migrateAssumptions(
      legacy("SHARE", { hourlyBase: 20, guaranteedHoursPerPeriod: 8, rateCardPerJob: 40 }),
    ) as any;
    expect(m.hourlyBase).toBe(0);
    expect(m.guaranteedHoursPerPeriod).toBe(0);
    expect(m.rateCardPerJob).toBe(0);
    // Identical to a plain share scenario, which is what it displayed as.
    expect(simulate(baseline(), m).crewPay).toBeCloseTo(simulate(baseline(), A()).crewPay, 2);
  });

  it("HOURLY_PLUS_SHARE keeps the hourly and drops the rate card", () => {
    const m = migrateAssumptions(legacy("HOURLY_PLUS_SHARE", { hourlyBase: 12, rateCardPerJob: 40 })) as any;
    expect(m.hourlyBase).toBe(12);
    expect(m.rateCardPerJob).toBe(0);
  });

  it("a scenario saved AFTER the change passes through untouched", () => {
    const a = A({ hourlyBase: 7, rateCardPerJob: 3 });
    expect(migrateAssumptions(a as unknown as Record<string, unknown>)).toEqual(a);
  });
});

describe("[build-gate] substitution re-rates the share but not the rate card", () => {
  it("rate-card money moves at face value between worker types", () => {
    // A rate card is priced per JOB. Running it through the share's
    // employee/contractor rate translation would invent a rate difference that
    // the structure explicitly does not have.
    const opts = {
      employeeMarginPercent: 100, contractorFeePercent: 100, rateCardPerJob: 25,
      hypotheticalWorkers: [{
        id: "hyp-1", name: "Sub", workerType: "CONTRACTOR" as const, hours: 10,
        mode: "SUBSTITUTION" as const, revenuePerHour: 0, substituteForUserId: "emp",
      }],
    };
    const r = simulate(baseline(), A(opts));
    const before = simulate(baseline(), A({
      employeeMarginPercent: 100, contractorFeePercent: 100, rateCardPerJob: 25,
    }));
    // Swapping who does the work moves the money but doesn't change its total.
    expect(r.crewPay + r.ownerPay).toBeCloseTo(before.crewPay + before.ownerPay, 2);
    expect(r.workers.find((w) => w.userId === "hyp-1")!.totalPay).toBeGreaterThan(0);
  });
});

describe("[build-gate] describePayShape names the corner, or admits it can't", () => {
  const shape = (over: Partial<Assumptions> = {}) => describePayShape(A(over));

  it("names each structure that has a name", () => {
    expect(shape().name).toBe("Share only");
    expect(shape({ hourlyBase: 15 }).name).toBe("Hourly + share");
    expect(shape({ employeeMarginPercent: 100, contractorFeePercent: 100, hourlyBase: 15 }).name)
      .toBe("Hourly only");
    expect(shape({ employeeMarginPercent: 100, contractorFeePercent: 100, rateCardPerJob: 40 }).name)
      .toBe("Rate card");
  });

  it("returns null for a blend rather than mislabelling it", () => {
    // The honest answer. Calling share + rate card "Rate card" would tell the
    // operator their price increases stop reaching the crew, when they don't.
    expect(shape({ rateCardPerJob: 40 }).name).toBeNull();
    expect(shape({ hourlyBase: 15, rateCardPerJob: 40 }).name).toBeNull();
  });

  it("spells out what a worker actually receives", () => {
    const s = shape({ hourlyBase: 15, guaranteedHoursPerPeriod: 5 });
    expect(s.detail).toMatch(/65% of each job to employees/);
    expect(s.detail).toMatch(/\$15\/hr for every clocked hour/);
    expect(s.detail).toMatch(/floor of 5h per pay period/);
  });

  it("says so when every pay lever is at zero", () => {
    const s = shape({ employeeMarginPercent: 100, contractorFeePercent: 100 });
    expect(s.name).toBe("Unpaid");
    expect(s.detail).toMatch(/every pay lever is at zero/);
  });
});

describe("[build-gate] an adjusted lever shows which way it moved", () => {
  const TAB = readFileSync(join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8");

  it("the current value goes green when raised and red when lowered", () => {
    expect(TAB).toMatch(/color=\{changed \? \(delta > 0 \? "green\.fg" : "red\.fg"\) : "fg\.muted"\}/);
  });

  it("colour is not the only cue", () => {
    // Red/green alone is invisible to a red-green colourblind operator, and
    // this is the tool used to decide what people get paid.
    expect(TAB).toMatch(/delta > 0 \? "▲" : "▼"/);
  });

  it("the direction is measured against the lever's own baseline", () => {
    // Against anything else — the previous value, say — dragging a slider back
    // and forth would leave the colour lying about where it sits now.
    expect(TAB).toMatch(/const delta = baseline === undefined \? 0 : value - baseline;/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Employer burden lands where it legally lands — on BOTH sides
//
// The simulation always classified correctly. The `actual` half of the
// baseline did not: it split owner vs everyone-else and charged the whole
// remainder, so a 1099 contractor was carrying payroll tax and workers comp.
// That figure is the reference the backtest measures the model against, so a
// wrong reference makes a correct model look broken.
//
// And workers comp was synthesized on top of the premiums already booked as
// Insurance — the double-count that payrollTaxEstimates.ts documents and
// pnlReport.ts avoids. It stays available, because comp is the one labor cost
// that scales with payroll, but it now requires saying what to remove first.
// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] the actuals side classifies wages like the P&L does", () => {
  const SERVICE = readFileSync(SERVICE_PATH, "utf8");

  it("contractors are separated from W-2 wages before burden is applied", () => {
    expect(SERVICE).toMatch(/else if \(u\?\.workerType === "CONTRACTOR"\) contractLabor \+= amt;/);
  });

  it("employer tax multiplies W-2 wages only", () => {
    expect(SERVICE).toMatch(/const burden = crewWages \* \(employerTaxPercent \/ 100\);/);
  });

  it("workers comp is NOT synthesized into the actuals", () => {
    // pnlReport.ts reports the premiums actually booked and adds no synthetic
    // comp. The forecast's "Today" column has to reconcile with it.
    expect(SERVICE).not.toMatch(/employerTaxPercent \+ wcPercent/);
  });

  it("contractor pay is still subtracted from profit", () => {
    // The narrow miss when fixing this: exclude contractors from the burden
    // base and accidentally exclude their PAY from the P&L too.
    expect(SERVICE).toMatch(/crewWages - contractLabor - burden/);
  });
});

describe("[build-gate] workers comp is not counted twice", () => {
  it("the synthetic rate is OFF in the default scenario", () => {
    // The default has to reconcile with the P&L, which synthesizes no comp.
    expect(defaultAssumptions(baseline()).workersCompPercent).toBe(0);
    expect(defaultAssumptions(baseline()).workersCompInExpenses).toBe(0);
  });

  it("the configured rate still reaches the baseline for the UI to suggest", () => {
    // Defaulting the assumption to 0 must not throw away the operator's rate.
    expect(baseline().workersCompPercent).toBe(17.6);
  });

  it("a rate with nothing removed is flagged CRITICAL", () => {
    const r = simulate(baseline(), A({ workersCompPercent: 12 }));
    const w = r.warnings.find((x) => /counted twice/.test(x.message));
    expect(w?.level).toBe("critical");
  });

  it("removing the premium shows up as its own visible cost line", () => {
    // Netted silently into Insurance, an operator reconciling against their
    // ledger can't see where the money went.
    const r = simulate(baseline(), A({ workersCompPercent: 12, workersCompInExpenses: 100 }));
    const line = r.costs.find((c) => /Workers comp premium/.test(c.category));
    expect(line?.amount).toBe(-100);
    expect(r.warnings.some((x) => /counted twice/.test(x.message))).toBe(false);
  });

  it("the removal nets out of the cost total", () => {
    const off = simulate(baseline(), A());
    const on = simulate(baseline(), A({ workersCompPercent: 12, workersCompInExpenses: 100 }));
    expect(on.costsTotal).toBeCloseTo(off.costsTotal - 100, 2);
  });

  it("re-modelled comp scales with payroll, which is the whole point", () => {
    const opts = { workersCompPercent: 12, workersCompInExpenses: 100 };
    const flat = simulate(baseline(), A(opts));
    const grown = simulate(baseline(), A({ ...opts, volumeMultiplier: 2 }));
    // A flat Insurance line wouldn't move at all; that understates growing.
    expect(grown.employerBurden).toBeGreaterThan(flat.employerBurden * 1.5);
  });

  it("removing a premium with no rate to replace it is flagged", () => {
    const r = simulate(baseline(), A({ workersCompInExpenses: 100 }));
    expect(r.warnings.some((x) => /no rate replaces it/.test(x.message))).toBe(true);
  });

  it("comp never lands on a contractor or the owner", () => {
    const r = simulate(baseline(), A({ workersCompPercent: 12, workersCompInExpenses: 100 }));
    expect(r.workers.find((w) => w.userId === "con")!.employerBurden).toBe(0);
    expect(r.workers.find((w) => w.userId === "own")!.employerBurden).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capital purchases, and the job-material double count
//
// Two ways the forecast disagreed with the P&L on the SAME window:
//
//   1. A $7,943 mower was charged to the quarter as an operating cost. The
//      P&L capitalizes anything at or above FIXED_ASSET_MIN_COST and reports
//      it outside Net Operating Income. One purchase read as 46% of revenue
//      and turned a roughly breakeven quarter into a 59% loss.
//   2. Every per-job Expense carries a PAIRED BusinessExpense — workers buy on
//      the company card. The forecast subtracted those as `materials` AND left
//      them in the category totals, charging the same mulch twice.
// ─────────────────────────────────────────────────────────────────────────────

describe("[build-gate] capital purchases are not running costs", () => {
  it("excluded by default, because that is what the P&L does", () => {
    expect(defaultAssumptions(baseline()).excludeFixedAssets).toBe(true);
  });

  it("the capital slice comes out of its category", () => {
    // Tools is $30 of which $25 is capital.
    const on = simulate(baseline(), A());
    expect(on.costs.find((c) => c.category === "Tools")?.amount).toBe(5);
    const off = simulate(baseline(), A({ excludeFixedAssets: false }));
    expect(off.costs.find((c) => c.category === "Tools")?.amount).toBe(30);
  });

  it("it comes off BEFORE behavior scaling — a mower doesn't multiply", () => {
    // The subtle miss: scale line.amount instead of the adjusted base and the
    // exclusion silently comes back the moment a category is tagged.
    const r = simulate(baseline(), A({
      behaviorOverrides: { Tools: "VARIABLE" }, volumeMultiplier: 2,
    }));
    expect(r.costs.find((c) => c.category === "Tools")?.amount).toBe(10); // 5 × 2, not 60
  });

  it("the backtest reference excludes them too, so it compares like with like", () => {
    const svc = readFileSync(SERVICE_PATH, "utf8");
    expect(svc).toMatch(/\(opex - fixedAssetPurchases\)/);
  });

  it("the amount is still reported — the money did leave the bank", () => {
    expect(baseline().actual.fixedAssetPurchases).toBe(25);
    const parts = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.parts.tsx"), "utf8",
    );
    expect(parts).toMatch(/Equipment bought this window/);
    expect(parts).toMatch(/cashAfterCapEx/);
  });
});

describe("[build-gate] job materials are counted once", () => {
  it("the ledger row paired to a job Expense is skipped", () => {
    // `expense` is the 1:1 back-link. Its presence means this ledger row IS a
    // job material, already subtracted as `materials`.
    const svc = readFileSync(SERVICE_PATH, "utf8");
    expect(svc).toMatch(/if \(e\.expense\) \{ jobMaterialsInLedger \+= e\.cost; continue; \}/);
  });

  it("the query selects the link, or the check above is always false", () => {
    const svc = readFileSync(SERVICE_PATH, "utf8");
    expect(svc).toMatch(/expense: \{ select: \{ id: true \} \}/);
  });

  it("the deduplicated total is reported rather than silently dropped", () => {
    expect(baseline().actual).toHaveProperty("jobMaterialsInLedger");
  });
});

describe("[build-gate] the Costs table can actually render every behavior", () => {
  it("the render order covers all six, AS_IS included", () => {
    // AS_IS is the default for every untagged category. Leaving it out of the
    // order list emptied the entire table — the rows existed, grouped under a
    // key the renderer never looked for.
    const parts = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.parts.tsx"), "utf8",
    );
    const m = parts.match(/const order = \[([^\]]+)\]/);
    const rendered = (m?.[1] ?? "").match(/"([A-Z_]+)"/g)?.map((x) => x.replace(/"/g, "")) ?? [];
    const behaviors = ["AS_IS", "FIXED", "VARIABLE", "PER_JOB", "ONE_TIME", "DISCRETIONARY"];
    for (const b of behaviors) expect(rendered, `${b} must be renderable`).toContain(b);
  });

  it("a default scenario produces rows the table will draw", () => {
    const r = simulate(baseline(), A());
    expect(r.costs.length).toBeGreaterThan(0);
  });
});

describe("[build-gate] the money flow is visible without expanding anything", () => {
  it("MoneyFlow renders outside a SectionExpander", () => {
    // It lived only inside the collapsible P&L comparison, which remembers
    // being closed — so the tab had no plain answer to "where did it go".
    const tab = readFileSync(join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8");
    const before = tab.slice(0, tab.indexOf("<MoneyFlow"));
    const opens = (before.match(/<SectionExpander/g) ?? []).length;
    const closes = (before.match(/<\/SectionExpander>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("it carries every line of the flow, capital purchases included", () => {
    const parts = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.parts.tsx"), "utf8",
    );
    const fn = parts.slice(parts.indexOf("export function MoneyFlow"), parts.indexOf("// ── Waterfall"));
    for (const line of [
      "Revenue collected", "Job materials", "Processor fees", "Crew pay",
      "Employer payroll tax", "Operating costs", "Operating profit",
      "Your own share", "Retained in the business", "Equipment bought",
    ]) expect(fn, `missing "${line}"`).toContain(line);
  });
});

describe("[build-gate] every Forecast section gets the emphasized header", () => {
  it("no section is left with the plain treatment", () => {
    // A page built entirely out of collapsibles reads as a list of rows unless
    // the headers carry weight; one plain header among eight reads as broken.
    const tab = readFileSync(join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.tsx"), "utf8");
    const all = (tab.match(/<SectionExpander/g) ?? []).length;
    const emphasized = (tab.match(/<SectionExpander emphasis/g) ?? []).length;
    expect(emphasized).toBe(all);
  });

  it("emphasis is opt-in, so the Routes tab is untouched", () => {
    const parts = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/PreviewRoutesTab.parts.tsx"), "utf8",
    );
    expect(parts).toMatch(/emphasis = false/);
    const routes = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/tabs/PreviewRoutesTab.tsx"), "utf8",
    );
    expect(routes).not.toMatch(/<SectionExpander emphasis/);
  });
});

describe("[build-gate] every headline number can explain itself", () => {
  const PARTS = readFileSync(
    join(REPO_ROOT, "apps/web/src/ui/tabs/ForecastTab.parts.tsx"), "utf8",
  );
  const keysOf = (name: string) => {
    const block = PARTS.slice(PARTS.indexOf(`const ${name}: Record<string, string> = {`));
    return (block.slice(0, block.indexOf("\n};")).match(/^  "([^"]+)":/gm) ?? [])
      .map((x) => x.replace(/^ +"|":$/g, ""));
  };

  it("all four stat cards have an explanation", () => {
    // The cards are the first thing read and the least self-evident —
    // "Retained after owner share" means nothing until someone says what the
    // owner share is and why it's deducted.
    const cards = ["Retained after owner share", "Margin", "Labor % of revenue", "LLC Owner share"];
    for (const c of cards) expect(keysOf("STAT_INFO"), `${c} needs info copy`).toContain(c);
  });

  it("every money-flow line has an explanation", () => {
    const lines = [
      "Revenue collected", "Job materials", "Processor fees", "Crew pay",
      "Employer payroll tax", "Operating costs", "Operating profit",
      "Your own share", "Retained in the business", "Equipment bought",
      "Cash after equipment",
    ];
    for (const l of lines) expect(keysOf("FLOW_INFO"), `${l} needs info copy`).toContain(l);
  });

  it("the labels the components render match the copy keys exactly", () => {
    // A renamed label silently loses its (i) — the lookup just misses.
    const flow = PARTS.slice(PARTS.indexOf("export function MoneyFlow"), PARTS.indexOf("// ── Waterfall"));
    for (const label of (flow.match(/label: "([^"]+)"/g) ?? []).map((x) => x.slice(8, -1))) {
      expect(keysOf("FLOW_INFO"), `rendered line "${label}" has no info copy`).toContain(label);
    }
  });

  it("the affordance is a toggle, not a hover tooltip", () => {
    // Mobile-first tab: hover doesn't exist, and these explanations are far
    // too long for a tooltip anyway.
    expect(PARTS).toMatch(/function InfoDot/);
    expect(PARTS).toMatch(/aria-expanded=\{open\}/);
  });
});
