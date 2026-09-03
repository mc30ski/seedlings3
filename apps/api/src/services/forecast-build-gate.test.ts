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
  stableStringify,
  type ForecastBaseline,
  type Assumptions,
} from "@repo/money";

const REPO_ROOT = join(__dirname, "../../../..");
const MODEL_SRC = readFileSync(join(REPO_ROOT, "packages/money/forecastModel.ts"), "utf8");
const SERVICE_PATH = join(REPO_ROOT, "apps/api/src/services/forecast.ts");
const ROUTES_PATH = join(REPO_ROOT, "apps/api/src/routes/forecast.ts");

// ── Fixture: a miniature season with the shapes that matter ──────────────────
function baseline(over: Partial<ForecastBaseline> = {}): ForecastBaseline {
  return {
    window: { from: "2026-05-11", to: "2026-09-01" },
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
      { userId: "emp", name: "Emp", workerType: "EMPLOYEE", isOwner: false, clockedHours: 10, actualPay: 90 },
      { userId: "con", name: "Con", workerType: "CONTRACTOR", isOwner: false, clockedHours: 5, actualPay: 60 },
      { userId: "own", name: "Own", workerType: "EMPLOYEE", isOwner: true, clockedHours: 4, actualPay: 80 },
    ],
    expenses: [
      { category: "Insurance", behavior: "FIXED", amount: 100 },
      { category: "Fuel", behavior: "VARIABLE", amount: 50 },
      { category: "Supplies", behavior: "PER_JOB", amount: 40 },
      { category: "Tools", behavior: "ONE_TIME", amount: 30 },
      { category: "Advertising", behavior: "DISCRETIONARY", amount: 20 },
    ],
    processorFees: 5,
    rates: { employeeMarginPercent: 35, contractorFeePercent: 25 },
    employerTaxPercent: 8.25,
    workersCompPercent: 17.6,
    actual: { revenue: 180, crewWages: 150, ownerEarnings: 80, profitBeforeOwnerLabor: 0 },
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
    const base = A({ payModel: "RATE_CARD", rateCardPerJob: 25 });
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
