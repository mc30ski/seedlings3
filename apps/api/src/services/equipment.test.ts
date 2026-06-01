// ─────────────────────────────────────────────────────────────────────────────
// Equipment rental-cost invariant tests.
//
// PURPOSE
// Lock down `computeRentalCost`, which decides:
//   • whether to charge a checkout at all (contractors only)
//   • how many distinct Eastern-Time calendar days the rental spanned
//   • the dollar cost (days × dailyRate)
//
// This is its own test file because equipment rentals live on a separate
// data path from Payment / PaymentSplit (Checkout.rentalCost is computed
// at release time, not at payment approval). They show up on the
// Payments tab as a separate Equipment Charges section, but the math
// doesn't intersect with computeBreakdown / reconcileApproval — those
// are covered by payments.test.ts.
//
// Rules locked in here:
//   1. Only CONTRACTOR is charged. EMPLOYEE / TRAINEE / null → null.
//   2. Missing checkedOutAt (reservation that was never picked up) → null.
//   3. Missing/zero/negative rate → null (no zero-dollar charges
//      stored).
//   4. Day counting is inclusive in Eastern Time:
//        • same ET day (any duration) = 1 day
//        • crosses one ET midnight = 2 days
//        • crosses N ET midnights = N+1 days
//   5. Released-before-checkout (clock weirdness / manual data fix) is
//      clamped to a minimum of 1 day so we never bill a negative amount.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { computeRentalCost } from "./equipment";

// Test dates. Eastern Time is UTC−5 (standard) or UTC−4 (DST). We pick
// dates in winter so the offset is always −5 — keeps the test fixtures
// stable across DST boundaries.
const T = (utcIso: string) => new Date(utcIso);

describe("computeRentalCost — who pays", () => {
  it("charges CONTRACTOR at the dailyRate", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r).toEqual({ rentalDays: 1, rentalCost: 30 });
  });

  it.each(["EMPLOYEE", "TRAINEE"] as const)(
    "does NOT charge %s (free internal use)",
    (workerType) => {
      const r = computeRentalCost(
        T("2026-01-10T14:00:00.000Z"),
        T("2026-01-10T18:00:00.000Z"),
        workerType,
        30,
      );
      expect(r).toBeNull();
    },
  );

  it("does NOT charge a null workerType (mid-onboarding / unclassified)", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      null,
      30,
    );
    expect(r).toBeNull();
  });
});

describe("computeRentalCost — guards", () => {
  it("returns null when checkedOutAt is missing (reservation never picked up)", () => {
    const r = computeRentalCost(
      null,
      T("2026-01-10T18:00:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r).toBeNull();
  });

  it("returns null when rate is null (equipment has no dailyRate set)", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      "CONTRACTOR",
      null,
    );
    expect(r).toBeNull();
  });

  it("returns null when rate is 0", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      "CONTRACTOR",
      0,
    );
    expect(r).toBeNull();
  });

  it("returns null when rate is negative (defensive)", () => {
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"),
      T("2026-01-10T18:00:00.000Z"),
      "CONTRACTOR",
      -5,
    );
    expect(r).toBeNull();
  });
});

describe("computeRentalCost — day counting (ET, inclusive)", () => {
  it("same ET day, any duration = 1 day", () => {
    // 9am to 5pm ET on the same day → 1 day
    const r = computeRentalCost(
      T("2026-01-10T14:00:00.000Z"), // 9am ET
      T("2026-01-10T22:00:00.000Z"), // 5pm ET
      "CONTRACTOR",
      30,
    );
    expect(r?.rentalDays).toBe(1);
    expect(r?.rentalCost).toBe(30);
  });

  it("crosses ONE ET midnight = 2 days", () => {
    // Out 3pm ET Jan 10, returned 10am ET Jan 11
    const r = computeRentalCost(
      T("2026-01-10T20:00:00.000Z"),
      T("2026-01-11T15:00:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r?.rentalDays).toBe(2);
    expect(r?.rentalCost).toBe(60);
  });

  it("crosses 6 ET midnights = 7 days", () => {
    // Out Jan 10, back Jan 16 — that's 7 distinct ET days.
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-16T15:00:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r?.rentalDays).toBe(7);
    expect(r?.rentalCost).toBe(210);
  });

  it("late-night ET checkout that flips to next ET day is still 1 ET day if returned before midnight ET", () => {
    // 11:30pm ET Jan 10 (= 04:30 UTC Jan 11) → 11:45pm ET Jan 10 (= 04:45 UTC Jan 11)
    // Same ET day, even though UTC date is Jan 11.
    const r = computeRentalCost(
      T("2026-01-11T04:30:00.000Z"),
      T("2026-01-11T04:45:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r?.rentalDays).toBe(1);
  });

  it("UTC-aligned timestamps that span midnight UTC but not midnight ET stay at 1 day", () => {
    // 8pm ET Jan 10 (= 01:00 UTC Jan 11) → 10pm ET Jan 10 (= 03:00 UTC Jan 11)
    // ET calendar day: both are Jan 10. Should still be 1 day.
    const r = computeRentalCost(
      T("2026-01-11T01:00:00.000Z"),
      T("2026-01-11T03:00:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r?.rentalDays).toBe(1);
  });
});

describe("computeRentalCost — defensive edge cases", () => {
  it("releasedAt before checkedOutAt clamps to 1 day (still charges, never negative)", () => {
    // Bad data — release earlier than checkout. Should still produce
    // a positive 1-day charge so we never accidentally store a
    // negative rentalDays or rentalCost.
    const r = computeRentalCost(
      T("2026-01-10T18:00:00.000Z"),
      T("2026-01-10T17:00:00.000Z"),
      "CONTRACTOR",
      30,
    );
    expect(r?.rentalDays).toBe(1);
    expect(r?.rentalCost).toBe(30);
  });

  it("never produces a rentalCost ≤ 0 for any contractor input", () => {
    // Property-style spot check across a few realistic configurations.
    const cases: Array<{ checked: string; released: string; rate: number }> = [
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-10T22:00:00.000Z", rate: 1 },
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-12T22:00:00.000Z", rate: 5 },
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-25T22:00:00.000Z", rate: 100 },
      { checked: "2026-01-10T14:00:00.000Z", released: "2026-01-10T14:00:00.000Z", rate: 0.01 },
    ];
    for (const c of cases) {
      const r = computeRentalCost(T(c.checked), T(c.released), "CONTRACTOR", c.rate);
      expect(r).not.toBeNull();
      expect(r!.rentalCost).toBeGreaterThan(0);
      expect(r!.rentalDays).toBeGreaterThanOrEqual(1);
    }
  });

  it("cost = days × rate exactly (no compounded rounding)", () => {
    // 5 days × $33.33 should be exactly $166.65 (not 166.6499999…).
    // The function does a single multiply — no per-day accumulation — so
    // this should hold without explicit rounding. The test pins it so a
    // future refactor that introduces per-day accumulation breaks here.
    const r = computeRentalCost(
      T("2026-01-10T15:00:00.000Z"),
      T("2026-01-14T15:00:00.000Z"),
      "CONTRACTOR",
      33.33,
    );
    expect(r?.rentalDays).toBe(5);
    expect(r?.rentalCost).toBe(5 * 33.33);
  });
});
