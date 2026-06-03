// ─────────────────────────────────────────────────────────────────────────────
// Equipment rental-cost invariant tests.
//
// PURPOSE
// Lock down `computeRentalCost`, which decides:
//   • the dollar cost of a finished checkout under one of two billing models
//   • how many distinct Eastern-Time calendar days the rental spanned
//   • the per-day breakdown that drives receipts + audit metadata
//
// `computeRentalCost` deliberately does NOT gate on workerType. Returning
// the notional cost is the right level of abstraction — the splitter (for
// group rentals) and the release() caller (for solo rentals) decide who
// actually pays. Employee/trainee billing is enforced in those callers, not
// here. See feature_per_job_equipment_billing.md for the policy.
//
// Two billing models coexist (selected per Equipment.equivalentJobs):
//   • NULL  → flat daily, rentalCost = rentalDays × dailyRate (legacy).
//   • N > 0 → per-job with per-day cap. perJob = dailyRate / N.
//             daySubtotal = min(jobsOnThisDay × perJob, dailyRate).
//             rentalCost = Σ daySubtotal.
//
// Rules locked in here:
//   1. Missing checkedOutAt (reservation that was never picked up) → null.
//   2. Missing/zero/negative dailyRate → null (no zero-dollar charges
//      stored).
//   3. Day counting is inclusive in Eastern Time:
//        • same ET day (any duration) = 1 day
//        • crosses one ET midnight = 2 days
//        • crosses N ET midnights = N+1 days
//   4. Released-before-checkout (clock weirdness / manual data fix) is
//      clamped to a minimum of 1 day so we never bill a negative amount.
//   5. Per-job mode: a day with 0 jobs contributes $0 to the total.
//   6. Per-job mode: a day where jobsOnDay × perJob ≥ dailyRate is capped
//      at exactly dailyRate (no overshoot).
//   7. Breakdown lines line up 1:1 with the calendar days in the window.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { computeRentalCost, calculateContractorSplits } from "./equipment";

// Test dates. Eastern Time is UTC−5 (standard) or UTC−4 (DST). We pick
// dates in winter so the offset is always −5 — keeps the test fixtures
// stable across DST boundaries.
const T = (utcIso: string) => new Date(utcIso);

describe("computeRentalCost — flat-daily mode (equivalentJobs = null)", () => {
  it("returns a positive cost regardless of worker type — gating happens elsewhere", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      30,
      null,
      null,
    );
    expect(r).toEqual({
      rentalDays: 1,
      rentalCost: 30,
      breakdown: [{ day: "2026-01-10", jobs: null, subtotal: 30, capped: true }],
    });
  });
});

describe("computeRentalCost — guards (both modes)", () => {
  it("returns null when checkedOutAt is missing (reservation never picked up)", () => {
    const r = computeRentalCost(null, T("2026-01-10T18:00:00.000Z"), 30, null, null);
    expect(r).toBeNull();
  });

  it("returns null when dailyRate is null (equipment has no rate set)", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      null,
      null,
      null,
    );
    expect(r).toBeNull();
  });

  it("returns null when dailyRate is 0", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      0,
      null,
      null,
    );
    expect(r).toBeNull();
  });

  it("returns null when dailyRate is negative (defensive)", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      -5,
      null,
      null,
    );
    expect(r).toBeNull();
  });
});

describe("computeRentalCost — day counting (ET, inclusive)", () => {
  it("same ET day, any duration = 1 day", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"), // 9am ET
      T("2026-01-10T22:00:00.000Z"), // 5pm ET
      30,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(1);
    expect(r?.rentalCost).toBe(30);
  });

  it("crosses ONE ET midnight = 2 days", () => {
    const r = computeRentalCost(
      T("2026-01-10T20:00:00.000Z"),
      T("2026-01-11T15:00:00.000Z"),
      30,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(2);
    expect(r?.rentalCost).toBe(60);
  });

  it("crosses 6 ET midnights = 7 days", () => {
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-16T15:00:00.000Z"),
      30,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(7);
    expect(r?.rentalCost).toBe(210);
  });

  it("late-night ET checkout that flips to next ET day is still 1 ET day if returned before midnight ET", () => {
    // 11:30pm ET Jan 10 (= 04:30 UTC Jan 11) → 11:45pm ET Jan 10
    const r = computeRentalCost(
      T("2026-01-11T04:30:00.000Z"),
      T("2026-01-11T04:45:00.000Z"),
      30,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(1);
  });

  it("UTC-aligned timestamps that span midnight UTC but not midnight ET stay at 1 day", () => {
    const r = computeRentalCost(
      T("2026-01-11T01:00:00.000Z"),
      T("2026-01-11T03:00:00.000Z"),
      30,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(1);
  });
});

describe("computeRentalCost — defensive edge cases", () => {
  it("releasedAt before checkedOutAt clamps to 1 day (still charges, never negative)", () => {
    const r = computeRentalCost(
      T("2026-01-10T18:00:00.000Z"),
      T("2026-01-10T17:00:00.000Z"),
      30,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(1);
    expect(r?.rentalCost).toBe(30);
  });

  it("never produces a rentalCost < 0 in flat-daily mode", () => {
    const cases: Array<{ checked: string; released: string; rate: number }> = [
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-10T22:00:00.000Z", rate: 1 },
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-12T22:00:00.000Z", rate: 5 },
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-25T22:00:00.000Z", rate: 100 },
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-10T14:00:00.000Z", rate: 0.01 },
    ];
    for (const c of cases) {
      const r = computeRentalCost(T(c.checked), T(c.released), c.rate, null, null);
      expect(r).not.toBeNull();
      expect(r!.rentalCost).toBeGreaterThan(0);
      expect(r!.rentalDays).toBeGreaterThanOrEqual(1);
    }
  });

  it("flat-daily cost rounds to two decimals", () => {
    // 5 days × $33.33 should be exactly $166.65.
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-14T15:00:00.000Z"),
      33.33,
      null,
      null,
    );
    expect(r?.rentalDays).toBe(5);
    expect(r?.rentalCost).toBe(166.65);
  });
});

describe("computeRentalCost — per-job mode (equivalentJobs set)", () => {
  // Standard test piece: $10/day mower with 10 equivalent jobs → perJob = $1.
  const dailyRate = 10;
  const equivalentJobs = 10;

  it("single day, jobs below cap: charges per-job", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T22:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      { "2026-01-10": 4 },
    );
    expect(r?.rentalDays).toBe(1);
    expect(r?.rentalCost).toBe(4);
    expect(r?.breakdown).toEqual([{ day: "2026-01-10", jobs: 4, subtotal: 4, capped: false }]);
  });

  it("single day, jobs at exactly equivalentJobs: hits cap, capped=true", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T22:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      { "2026-01-10": 10 },
    );
    expect(r?.rentalCost).toBe(10);
    expect(r?.breakdown[0]).toEqual({ day: "2026-01-10", jobs: 10, subtotal: 10, capped: true });
  });

  it("single day, jobs above equivalentJobs: capped at dailyRate (no overshoot)", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T22:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      { "2026-01-10": 25 },
    );
    expect(r?.rentalCost).toBe(10);
    expect(r?.breakdown[0]).toEqual({ day: "2026-01-10", jobs: 25, subtotal: 10, capped: true });
  });

  it("single day, zero jobs: charges $0", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T22:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      {},
    );
    expect(r?.rentalDays).toBe(1);
    expect(r?.rentalCost).toBe(0);
    expect(r?.breakdown[0]).toEqual({ day: "2026-01-10", jobs: 0, subtotal: 0, capped: false });
  });

  it("multi-day rental, mixed busy / idle days (the user's worked example)", () => {
    // 2-day rental, $10 cap, 10 equivalent jobs (= $1/job).
    // Day 1: 12 jobs → capped at $10.
    // Day 2: 5 jobs → $5 (below cap).
    // Total: $15.
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-11T15:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      { "2026-01-10": 12, "2026-01-11": 5 },
    );
    expect(r?.rentalDays).toBe(2);
    expect(r?.rentalCost).toBe(15);
    expect(r?.breakdown).toEqual([
      { day: "2026-01-10", jobs: 12, subtotal: 10, capped: true },
      { day: "2026-01-11", jobs: 5, subtotal: 5, capped: false },
    ]);
  });

  it("multi-day rental, idle day in the middle: still emits a breakdown line for it", () => {
    // 3-day rental, day 2 = 0 jobs (e.g., rainy day).
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-12T15:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      { "2026-01-10": 6, "2026-01-12": 3 },
    );
    expect(r?.rentalDays).toBe(3);
    expect(r?.rentalCost).toBe(9);
    expect(r?.breakdown).toEqual([
      { day: "2026-01-10", jobs: 6, subtotal: 6, capped: false },
      { day: "2026-01-11", jobs: 0, subtotal: 0, capped: false },
      { day: "2026-01-12", jobs: 3, subtotal: 3, capped: false },
    ]);
  });

  it("rental with NO jobs at all charges $0 across every day", () => {
    // Contractor takes equipment home for 3 days but does no jobs → free.
    // (Per design — issue #1 from the per-job feature memo.)
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-12T15:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      {},
    );
    expect(r?.rentalDays).toBe(3);
    expect(r?.rentalCost).toBe(0);
    for (const line of r!.breakdown) {
      expect(line.subtotal).toBe(0);
      expect(line.jobs).toBe(0);
      expect(line.capped).toBe(false);
    }
  });

  it("breakdown length matches rentalDays exactly", () => {
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-16T15:00:00.000Z"),
      dailyRate,
      equivalentJobs,
      { "2026-01-12": 5 },
    );
    expect(r?.rentalDays).toBe(7);
    expect(r?.breakdown.length).toBe(7);
  });

  it("fractional perJob rate rounds the subtotal to 2 decimals", () => {
    // $10/day, 7 equivalent jobs → perJob = $1.4285714…
    // 3 jobs → 3 × 1.4285714 = $4.2857142… → rounds to $4.29.
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T22:00:00.000Z"),
      10,
      7,
      { "2026-01-10": 3 },
    );
    expect(r?.rentalCost).toBe(4.29);
  });

  it("equivalentJobs <= 0 falls back to flat-daily (defensive guard)", () => {
    // Should never happen in practice (admin UI restricts to positive ints
    // or unset), but if a bad value slips through, fall back to the safer
    // legacy model rather than divide by zero.
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T22:00:00.000Z"),
      30,
      0,
      { "2026-01-10": 5 },
    );
    expect(r?.rentalCost).toBe(30);
    expect(r?.breakdown[0]).toEqual({ day: "2026-01-10", jobs: null, subtotal: 30, capped: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateContractorSplits — mixed-crew billing policy invariants.
//
// PURPOSE
// Lock down who actually pays when a group rental's CheckoutSplit rows
// are materialized. The policy:
//   • Only CONTRACTOR and null-workerType members are billable.
//   • EMPLOYEE / TRAINEE members get amount=0 but keep their row (audit
//     trail intact).
//   • Unbilled shares are NOT redistributed to remaining contractors —
//     the W-2 / trainee equipment usage is already covered by the higher
//     business margin charged on their jobs.
//
// These tests pin the policy fix for the two mixed-crew bugs that existed
// before:
//   A) Employee inside a contractor-claimed crew was being billed.
//   B) Employee-claimed crew = whole crew (incl. contractor members)
//      got free equipment.
// Both contradicted the solo-rule "only contractors pay" policy. The new
// rule fixes both because gating happens at the splitter, not at the
// computeRentalCost gate.
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateContractorSplits — even-split (no custom percents)", () => {
  it("all-contractor crew: each pays equal share, contractorTotal = rentalCost", () => {
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: null, workerType: "CONTRACTOR" },
      ],
      10,
    );
    expect(splits).toEqual([
      { userId: "c1", percent: 50, amount: 5 },
      { userId: "c2", percent: 50, amount: 5 },
    ]);
    expect(contractorTotal).toBe(10);
  });

  it("mixed crew (1 contractor + 1 employee): employee billed $0, contractor billed full share, total reduced", () => {
    // Scenario A from the design discussion. Even-split percentages would
    // give each $5; the employee's $5 is zeroed (covered by margin), so
    // contractorTotal = $5 (NOT redistributed to the contractor).
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" },
        { userId: "e1", equipmentCostPercent: null, workerType: "EMPLOYEE" },
      ],
      10,
    );
    expect(splits).toEqual([
      { userId: "c1", percent: 50, amount: 5 },
      { userId: "e1", percent: 50, amount: 0 },
    ]);
    expect(contractorTotal).toBe(5);
  });

  it("mixed crew (1 contractor + 1 trainee): trainee billed $0, contractor billed half", () => {
    // TRAINEE treated the same as EMPLOYEE — usage covered by margin.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" },
        { userId: "t1", equipmentCostPercent: null, workerType: "TRAINEE" },
      ],
      10,
    );
    expect(splits[1].amount).toBe(0);
    expect(splits[0].amount).toBe(5);
    expect(contractorTotal).toBe(5);
  });

  it("all-employee crew: everyone billed $0, contractorTotal = $0", () => {
    // Equipment is functionally free since no contractor's there to be
    // billed. The rows still exist for the audit trail.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "e1", equipmentCostPercent: null, workerType: "EMPLOYEE" },
        { userId: "e2", equipmentCostPercent: null, workerType: "EMPLOYEE" },
      ],
      10,
    );
    expect(splits.every((s) => s.amount === 0)).toBe(true);
    expect(contractorTotal).toBe(0);
  });

  it("Scenario B fix: employee-claimer + 2 contractor members — contractors still pay their share, employee=0", () => {
    // Pre-fix: computeRentalCost gated on the holder's workerType, so an
    // employee claimer produced null rental → no splits → contractors got
    // free equipment. Post-fix: splitter is the gate. Employee row gets
    // $0 (covered by margin); both contractors pay their even-split share.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        // Claimer is the employee (first in the list).
        { userId: "e1", equipmentCostPercent: null, workerType: "EMPLOYEE" },
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: null, workerType: "CONTRACTOR" },
      ],
      9,
    );
    const byUser = Object.fromEntries(splits.map((s) => [s.userId, s]));
    expect(byUser.e1.amount).toBe(0);
    expect(byUser.c1.amount).toBe(3);
    expect(byUser.c2.amount).toBe(3);
    expect(contractorTotal).toBe(6); // not $9 — employee's share absorbed
  });

  it("null workerType (unclassified) is treated as billable (historical-compat)", () => {
    // Pre-fix policy in writeCheckoutSplits also billed unclassified
    // workers (they fell through the workerType !== CONTRACTOR check).
    // We preserve that since unclassified usually means "mid-onboarding
    // contractor, type not yet entered." Admin should classify them as
    // EMPLOYEE if free usage is intended.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" },
        { userId: "u1", equipmentCostPercent: null, workerType: null },
      ],
      10,
    );
    expect(splits[1].amount).toBe(5);
    expect(contractorTotal).toBe(10);
  });
});

describe("calculateContractorSplits — custom equipmentCostPercent", () => {
  it("custom percents (all set, sum=100) drive the allocation", () => {
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: 70, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: 30, workerType: "CONTRACTOR" },
      ],
      100,
    );
    expect(splits).toEqual([
      { userId: "c1", percent: 70, amount: 70 },
      { userId: "c2", percent: 30, amount: 30 },
    ]);
    expect(contractorTotal).toBe(100);
  });

  it("custom percents with mixed crew: employee's percentage allocation is zeroed", () => {
    // Contractor 60% + Contractor 25% + Employee 15%. Employee's $15
    // slice gets zeroed; contractors keep their literal percent amounts.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: 60, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: 25, workerType: "CONTRACTOR" },
        { userId: "e1", equipmentCostPercent: 15, workerType: "EMPLOYEE" },
      ],
      100,
    );
    const byUser = Object.fromEntries(splits.map((s) => [s.userId, s]));
    expect(byUser.c1.amount).toBe(60);
    expect(byUser.c2.amount).toBe(25);
    expect(byUser.e1.amount).toBe(0);
    expect(contractorTotal).toBe(85);
  });

  it("partial percent coverage (not every worker has one) falls back to even-split", () => {
    // Invariant: customSet must include EVERY worker AND sum to 100.
    // Otherwise the splitter falls back to even-split.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: 60, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: null, workerType: "CONTRACTOR" }, // missing
      ],
      10,
    );
    // Falls back to 50/50.
    expect(splits[0].amount).toBe(5);
    expect(splits[1].amount).toBe(5);
    expect(contractorTotal).toBe(10);
  });

  it("percents that don't sum to 100 fall back to even-split (defensive)", () => {
    const { splits } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: 60, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: 30, workerType: "CONTRACTOR" }, // 90 total
      ],
      10,
    );
    // Even-split, not 60/30 of $10.
    expect(splits[0].amount).toBe(5);
    expect(splits[1].amount).toBe(5);
  });
});

describe("calculateContractorSplits — edge cases", () => {
  it("empty workers list returns no splits and contractorTotal = 0", () => {
    const { splits, contractorTotal } = calculateContractorSplits([], 100);
    expect(splits).toEqual([]);
    expect(contractorTotal).toBe(0);
  });

  it("rental cost of $0 produces all-zero splits but still emits rows", () => {
    // Zero-jobs-day under per-job billing produces $0 rental. Splits are
    // still computed (audit trail) — they just all have amount=0.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" },
        { userId: "c2", equipmentCostPercent: null, workerType: "CONTRACTOR" },
      ],
      0,
    );
    expect(splits.length).toBe(2);
    expect(splits.every((s) => s.amount === 0)).toBe(true);
    expect(contractorTotal).toBe(0);
  });

  it("dedupes when claimer appears in the members list (defensive)", () => {
    // Group invariants shouldn't allow this, but if it slips through we
    // must not double-bill the claimer.
    const { splits, contractorTotal } = calculateContractorSplits(
      [
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" }, // claimer
        { userId: "c1", equipmentCostPercent: null, workerType: "CONTRACTOR" }, // duplicate
        { userId: "c2", equipmentCostPercent: null, workerType: "CONTRACTOR" },
      ],
      9,
    );
    // After dedup we have 2 unique workers. But the percent was computed
    // BEFORE dedup so each was 33% — that's a documented quirk of the
    // dedup-after-percent design. Total billed is 6 (2 × 3) of the $9.
    // The remaining $3 is effectively lost; if this turns out to matter in
    // practice we should normalize percents post-dedup.
    expect(splits.length).toBe(2);
    expect(contractorTotal).toBe(6);
  });
});
