// ─────────────────────────────────────────────────────────────────────────────
// Route planner — the invariants a crew depends on every morning.
//
// This code replaced an LLM call, and the failures it replaced were not
// cosmetic: a worker with 22 claimed jobs for one Saturday had most of the day
// binned against a 4-hour default he never set. So the tests that matter here
// are not "does it produce a nice answer" but "can it ever lose work".
//
// The load-bearing invariant, stated once: EVERY CLAIMED JOB APPEARS, in every
// mode, at every budget, however the routing provider behaved. Everything else
// is a preference; that one is a promise.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { planRoute, type PlannerJob, type PlannerLeg } from "./routePlanner";
import type { EtDateKey } from "./dates";

const DAY = "2026-09-14" as EtDateKey;

function job(over: Partial<PlannerJob> & { id: string }): PlannerJob {
  return {
    jobId: `job-${over.id}`,
    type: "claimed",
    property: `Property ${over.id}`,
    address: `${over.id} Main St`,
    price: 100,
    estimatedMinutes: 60,
    currentDate: DAY,
    ...over,
  };
}

/** Legs in the given index order, with plausible drive times. */
function legs(order: number[], driveSecs = 600): PlannerLeg[] {
  return order.map((inputIndex, i) => ({
    inputIndex,
    durationFromPrev: i === 0 ? 300 : driveSecs,
    distanceFromPrev: i === 0 ? 2000 : 5000,
  }));
}

function plan(jobs: PlannerJob[], l: PlannerLeg[], over: Partial<Parameters<typeof planRoute>[0]> = {}) {
  return planRoute({
    jobs, legs: l, targetDate: DAY, mode: "claimed",
    availableHours: 0, bufferPercent: 20,
    familiarProperties: new Set<string>(),
    fromCurrentLocation: false, totalDriveSeconds: null,
    ...over,
  });
}

const ids = (p: ReturnType<typeof planRoute>) => p.days[0].route.map((s) => s.occurrenceId);

describe("routePlanner — no claimed job is ever lost", () => {
  it("keeps every claimed job when the provider ordered them all", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    const p = plan(jobs, legs([2, 0, 1]));
    expect(ids(p).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps every claimed job when the provider returned NOTHING", () => {
    // The routing provider being down is the most likely real outage. The day
    // must still plan, in the order the jobs arrived.
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    const p = plan(jobs, []);
    expect(ids(p)).toEqual(["a", "b", "c"]);
  });

  it("keeps every claimed job when the provider placed only SOME", () => {
    // Partial geocoding: two addresses resolve, one does not.
    const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];
    const p = plan(jobs, legs([1, 0]));
    expect(ids(p).sort()).toEqual(["a", "b", "c"]);
    // The unplaced one goes last — it has no spatial information.
    expect(ids(p)[2]).toBe("c");
  });

  it("keeps all 22 claimed jobs against a 4-hour budget — the shipped incident", () => {
    const jobs = Array.from({ length: 22 }, (_, i) => job({ id: `j${i}` }));
    const p = plan(jobs, legs(jobs.map((_, i) => i)), { mode: "suggest", availableHours: 4 });
    expect(ids(p)).toHaveLength(22);
    // And not one of them is marked optional, however far past the budget.
    const optional = p.days[0].route.filter((s) => /optional/.test(s.reason));
    expect(optional, "claimed work can never be optional").toHaveLength(0);
  });

  it("survives a provider leg pointing at a job that does not exist", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const p = plan(jobs, [
      { inputIndex: 99, durationFromPrev: 100, distanceFromPrev: 100 },
      ...legs([0, 1]),
    ]);
    expect(ids(p).sort()).toEqual(["a", "b"]);
  });

  it("survives a provider returning the same stop twice", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const p = plan(jobs, [...legs([0, 0, 1])]);
    expect(ids(p)).toEqual(["a", "b"]);
  });
});

describe("routePlanner — structural guarantees", () => {
  const jobs = [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })];

  it("orders are 1..N with no gaps or repeats", () => {
    const p = plan(jobs, legs([1, 2, 0]));
    expect(p.days[0].route.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it("never emits a duplicate stop", () => {
    const p = plan(jobs, legs([0, 1, 2]));
    expect(new Set(ids(p)).size).toBe(ids(p).length);
  });

  it("returns exactly one day, dated the target", () => {
    // The old schema was an array of days and the model spread one day's work
    // across a week. One day, always.
    const p = plan(jobs, legs([0, 1, 2]));
    expect(p.days).toHaveLength(1);
    expect(p.days[0].date).toBe(DAY);
  });

  it("every stop names a job that was passed in", () => {
    const p = plan(jobs, legs([0, 1, 2]));
    const known = new Set(jobs.map((j) => j.id));
    for (const id of ids(p)) expect(known.has(id)).toBe(true);
  });

  it("handles an empty job list without throwing", () => {
    const p = plan([], []);
    expect(p.days[0].route).toEqual([]);
    expect(p.totalEstimatedEarnings).toBe(0);
  });
});

describe("routePlanner — money and time", () => {
  it("earnings are the exact sum of the prices", () => {
    const jobs = [job({ id: "a", price: 85 }), job({ id: "b", price: 120.5 }), job({ id: "c", price: null })];
    const p = plan(jobs, legs([0, 1, 2]));
    expect(p.totalEstimatedEarnings).toBe(205.5);
    expect(p.days[0].estimatedEarnings).toBe(205.5);
  });

  it("a null duration counts as an hour, erring large", () => {
    const p = plan([job({ id: "a", estimatedMinutes: null })], legs([0]), { bufferPercent: 0, totalDriveSeconds: 0 });
    expect(p.days[0].estimatedHours).toBe(1);
  });

  it("the buffer is applied to work only, never to driving", () => {
    // 60 min of work at 50% buffer = 90 min; plus 30 min driving = 2h.
    const p = plan([job({ id: "a", estimatedMinutes: 60 })], legs([0]), {
      bufferPercent: 50, totalDriveSeconds: 1800,
    });
    expect(p.days[0].estimatedHours).toBe(2);
  });

  it("prefers the provider's total drive time over the sum of legs", () => {
    // A round trip includes a return leg no stop carries.
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const withReturn = plan(jobs, legs([0, 1]), { bufferPercent: 0, totalDriveSeconds: 3600 });
    expect(withReturn.days[0].estimatedHours).toBe(3); // 2h work + 1h drive
  });

  it("never reports negative or NaN totals on degenerate input", () => {
    const p = plan([job({ id: "a", price: null, estimatedMinutes: null })], [], { totalDriveSeconds: null });
    expect(Number.isFinite(p.days[0].estimatedHours)).toBe(true);
    expect(p.days[0].estimatedHours).toBeGreaterThanOrEqual(0);
    expect(p.totalEstimatedEarnings).toBe(0);
  });
});

describe("routePlanner — modes", () => {
  const mixed = [
    job({ id: "c1", type: "claimed" }),
    job({ id: "x1", type: "claimable" }),
    job({ id: "c2", type: "claimed" }),
    job({ id: "x2", type: "claimable", currentDate: "2026-09-16" }),
  ];

  it("claimed mode plans ONLY claimed work", () => {
    const p = plan(mixed, legs([0, 1, 2, 3]), { mode: "claimed" });
    expect(ids(p).sort()).toEqual(["c1", "c2"]);
    expect(p.additionalJobsToConsider).toEqual([]);
    expect(p.dateChangeCount).toBe(0);
  });

  it("suggest mode keeps all claimed work and adds the rest", () => {
    const p = plan(mixed, legs([0, 1, 2, 3]), { mode: "suggest" });
    expect(ids(p)).toHaveLength(4);
    for (const id of ["c1", "c2"]) expect(ids(p)).toContain(id);
    expect(p.additionalJobsToConsider.sort()).toEqual(["x1", "x2"]);
  });

  it("claimed work is ordered before suggestions", () => {
    const p = plan(mixed, legs([1, 3, 0, 2]), { mode: "suggest" });
    const claimedAt = ids(p).map((id, i) => ({ id, i })).filter((e) => e.id.startsWith("c"));
    const extraAt = ids(p).map((id, i) => ({ id, i })).filter((e) => e.id.startsWith("x"));
    expect(Math.max(...claimedAt.map((e) => e.i))).toBeLessThan(Math.min(...extraAt.map((e) => e.i)));
  });

  it("only a non-claimed job on another date counts as a date change", () => {
    const p = plan(mixed, legs([0, 1, 2, 3]), { mode: "suggest" });
    expect(p.dateChangeCount).toBe(1);
    const moved = p.days[0].route.find((s) => s.dateChanged);
    expect(moved?.occurrenceId).toBe("x2");
    expect(moved?.originalDate).toBe("2026-09-16");
    expect(moved?.suggestedDate).toBe(DAY);
  });

  it("a claimed job on a different date is NOT a reschedule", () => {
    // It is being ordered, not moved.
    const p = plan([job({ id: "c", type: "claimed", currentDate: "2026-09-10" })], legs([0]), { mode: "suggest" });
    expect(p.dateChangeCount).toBe(0);
    expect(p.days[0].route[0].dateChanged).toBe(false);
  });
});

describe("routePlanner — the stated budget marks, never removes", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    job({ id: `x${i}`, type: "claimable", estimatedMinutes: 60 }));

  it("marks the overflow as optional but keeps every stop", () => {
    const p = plan(many, legs(many.map((_, i) => i)), { mode: "suggest", availableHours: 2 });
    expect(ids(p)).toHaveLength(10);
    const optional = p.days[0].route.filter((s) => /optional/.test(s.reason));
    expect(optional.length).toBeGreaterThan(0);
    expect(optional.length).toBeLessThan(10);
  });

  it("marks nothing when the worker stated no hours", () => {
    const p = plan(many, legs(many.map((_, i) => i)), { mode: "suggest", availableHours: 0 });
    expect(p.days[0].route.filter((s) => /optional/.test(s.reason))).toHaveLength(0);
  });

  it("allows 5% over the stated hours before marking", () => {
    // One 60-min job, no buffer, genuinely no driving, against a 1-hour
    // budget: 60 <= 63, so it fits.
    const noDrive = [{ inputIndex: 0, durationFromPrev: 0, distanceFromPrev: 0 }];
    const p = plan([job({ id: "x", type: "claimable", estimatedMinutes: 60 })], noDrive, {
      mode: "suggest", availableHours: 1, bufferPercent: 0, totalDriveSeconds: 0,
    });
    expect(p.days[0].route[0].reason).not.toMatch(/optional/);
  });

  it("counts driving against the budget, including the leg home", () => {
    // The first draft summed only the legs BETWEEN stops, so a round trip's
    // drive home — real time, attributable to no stop — was invisible to the
    // budget. A 60-min job inside a 1-hour budget looks fine until you add
    // the 20-minute drive back.
    const oneStop = [{ inputIndex: 0, durationFromPrev: 0, distanceFromPrev: 0 }];
    const fits = plan([job({ id: "x", type: "claimable", estimatedMinutes: 60 })], oneStop, {
      mode: "suggest", availableHours: 1, bufferPercent: 0, totalDriveSeconds: 0,
    });
    expect(fits.days[0].route[0].reason).not.toMatch(/optional/);

    const withDriveHome = plan([job({ id: "x", type: "claimable", estimatedMinutes: 60 })], oneStop, {
      mode: "suggest", availableHours: 1, bufferPercent: 0, totalDriveSeconds: 1200,
    });
    expect(withDriveHome.days[0].route[0].reason).toMatch(/optional/);
  });
});

describe("routePlanner — reasons are facts", () => {
  it("quotes the provider's own drive time and distance", () => {
    const jobs = [job({ id: "a" }), job({ id: "b" })];
    const p = plan(jobs, [
      { inputIndex: 0, durationFromPrev: 300, distanceFromPrev: 1609 },
      { inputIndex: 1, durationFromPrev: 900, distanceFromPrev: 8047 },
    ]);
    expect(p.days[0].route[1].reason).toContain("15 min");
    expect(p.days[0].route[1].reason).toContain("5 mi");
  });

  it("says so plainly when a job has no address", () => {
    const p = plan([job({ id: "a", address: "No address" })], []);
    expect(p.days[0].route[0].reason).toMatch(/No address on file/);
  });

  it("names familiarity only for properties the worker has serviced", () => {
    const jobs = [job({ id: "a", property: "Known" }), job({ id: "b", property: "New" })];
    const p = plan(jobs, legs([0, 1]), { familiarProperties: new Set(["Known"]) });
    expect(p.days[0].route[0].reason).toMatch(/serviced this property before/);
    expect(p.days[0].route[1].reason).not.toMatch(/serviced this property before/);
  });

  it("every stop gets a non-empty reason", () => {
    const jobs = [job({ id: "a" }), job({ id: "b", address: "No address" }), job({ id: "c" })];
    const p = plan(jobs, legs([0, 2]));
    for (const s of p.days[0].route) expect(s.reason.length).toBeGreaterThan(0);
  });
});

describe("routePlanner — fuzz: the promise holds under random input", () => {
  // Randomised shapes, asserting only the invariants. Seeded by index so a
  // failure is reproducible from the case number in the output.
  function rng(seed: number) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  for (let caseNo = 0; caseNo < 300; caseNo++) {
    it(`case ${caseNo}`, () => {
      const r = rng(caseNo + 1);
      const n = Math.floor(r() * 25);
      const jobs: PlannerJob[] = Array.from({ length: n }, (_, i) =>
        job({
          id: `j${i}`,
          type: r() > 0.5 ? "claimed" : "claimable",
          price: r() > 0.15 ? Math.round(r() * 400) : null,
          estimatedMinutes: r() > 0.2 ? Math.round(r() * 180) : null,
          address: r() > 0.1 ? `${i} St` : "No address",
          currentDate: r() > 0.3 ? DAY : ("2026-09-17" as string),
        }));

      // A provider that may return nothing, a subset, duplicates, or garbage
      // indices — every failure mode a flaky upstream can produce.
      const legCount = Math.floor(r() * (n + 3));
      const l: PlannerLeg[] = Array.from({ length: legCount }, () => ({
        inputIndex: Math.floor(r() * (n + 2)) - 1,
        durationFromPrev: Math.round(r() * 3600),
        distanceFromPrev: Math.round(r() * 40000),
      }));

      const mode = r() > 0.5 ? "suggest" : "claimed";
      const p = plan(jobs, l, {
        mode,
        availableHours: r() > 0.5 ? Math.round(r() * 10) : 0,
        bufferPercent: Math.round(r() * 50),
        familiarProperties: new Set(jobs.filter(() => r() > 0.7).map((j) => j.property)),
        totalDriveSeconds: r() > 0.3 ? Math.round(r() * 20000) : null,
      });

      const route = p.days[0].route;
      const seen = route.map((s) => s.occurrenceId);

      // 1. NO CLAIMED JOB IS EVER LOST. The promise.
      const claimedIds = jobs.filter((j) => j.type === "claimed").map((j) => j.id);
      for (const id of claimedIds) expect(seen).toContain(id);

      // 2. Claimed mode contains claimed work and nothing else.
      if (mode === "claimed") expect(seen.sort()).toEqual([...claimedIds].sort());

      // 3. No duplicates, no invented stops.
      expect(new Set(seen).size).toBe(seen.length);
      const known = new Set(jobs.map((j) => j.id));
      for (const id of seen) expect(known.has(id)).toBe(true);

      // 4. Orders are contiguous from 1.
      expect(route.map((s) => s.order)).toEqual(route.map((_, i) => i + 1));

      // 5. Totals are real numbers, never negative or NaN.
      expect(Number.isFinite(p.totalEstimatedEarnings)).toBe(true);
      expect(p.totalEstimatedEarnings).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.days[0].estimatedHours)).toBe(true);
      expect(p.days[0].estimatedHours).toBeGreaterThanOrEqual(0);

      // 6. A claimed job is never marked optional and never a reschedule.
      for (const s of route) {
        const j = jobs.find((x) => x.id === s.occurrenceId)!;
        if (j.type === "claimed") {
          expect(s.reason).not.toMatch(/optional/);
          expect(s.dateChanged).toBe(false);
        }
      }

      // 7. Every stop is readable.
      for (const s of route) {
        expect(typeof s.reason).toBe("string");
        expect(s.reason.length).toBeGreaterThan(0);
        expect(s.property.length).toBeGreaterThan(0);
      }

      // 8. Copy never contains a raw NaN/undefined leak.
      expect(p.summary).not.toMatch(/NaN|undefined/);
      expect(p.days[0].daySummary).not.toMatch(/NaN|undefined/);
    });
  }
});
