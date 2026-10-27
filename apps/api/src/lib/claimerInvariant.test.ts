import { describe, it, expect } from "vitest";
import {
  planClaimerRepair,
  planObserverOnlyDemotions,
  canHoldPaidSeat,
  type ClaimerAssigneeRow,
} from "./claimerInvariant";

const T0 = new Date("2026-09-01T12:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

function row(p: Partial<ClaimerAssigneeRow> & { id: string; userId: string }): ClaimerAssigneeRow {
  return { assignedById: p.userId, role: null, assignedAt: T0, ...p };
}

describe("planClaimerRepair", () => {
  it("leaves a healthy solo claimer alone", () => {
    const plan = planClaimerRepair([row({ id: "r1", userId: "u1" })]);
    expect(plan).toEqual({ claimerUserId: "u1", updates: [] });
  });

  it("leaves a healthy team alone", () => {
    const plan = planClaimerRepair([
      row({ id: "r1", userId: "u1", assignedById: "u1", assignedAt: at(0) }),
      row({ id: "r2", userId: "u2", assignedById: "u1", assignedAt: at(5) }),
    ]);
    expect(plan.claimerUserId).toBe("u1");
    expect(plan.updates).toEqual([]);
  });

  it("treats no assignees as UNCLAIMED, not as a violation", () => {
    expect(planClaimerRepair([])).toEqual({ claimerUserId: null, updates: [] });
  });

  it("treats an observer-only occurrence as unclaimed and never promotes an observer", () => {
    const plan = planClaimerRepair([
      row({ id: "r1", userId: "obs", role: "observer", assignedById: null }),
    ]);
    expect(plan).toEqual({ claimerUserId: null, updates: [] });
  });

  // THE SHIPPED BUG. setOccurrenceAssignees removed the claimer and could not
  // promote the survivor, because createMany({skipDuplicates}) cannot UPDATE.
  // The survivor kept assignedById pointing at the person who just left, and
  // nobody below admin could start the visit.
  it("promotes the survivor when the claimer's row was deleted", () => {
    const plan = planClaimerRepair([
      row({ id: "r2", userId: "u2", assignedById: "u1_gone", assignedAt: at(5) }),
    ]);
    expect(plan.claimerUserId).toBe("u2");
    expect(plan.updates).toEqual([{ id: "r2", userId: "u2", assignedById: "u2" }]);
  });

  it("promotes by seniority and repoints everyone else at the new claimer", () => {
    const plan = planClaimerRepair([
      row({ id: "rb", userId: "newer", assignedById: "gone", assignedAt: at(10) }),
      row({ id: "ra", userId: "older", assignedById: "gone", assignedAt: at(2) }),
    ]);
    expect(plan.claimerUserId).toBe("older");
    expect(plan.updates).toEqual([
      { id: "ra", userId: "older", assignedById: "older" },
      { id: "rb", userId: "newer", assignedById: "older" },
    ]);
  });

  it("collapses two self-assigned rows down to one claimer", () => {
    const plan = planClaimerRepair([
      row({ id: "r1", userId: "u1", assignedById: "u1", assignedAt: at(0) }),
      row({ id: "r2", userId: "u2", assignedById: "u2", assignedAt: at(5) }),
    ]);
    expect(plan.claimerUserId).toBe("u1");
    expect(plan.updates).toEqual([{ id: "r2", userId: "u2", assignedById: "u1" }]);
  });

  it("repairs a NULL assignedById — the onDelete: SetNull route to a leaderless visit", () => {
    const plan = planClaimerRepair([row({ id: "r1", userId: "u1", assignedById: null })]);
    expect(plan.claimerUserId).toBe("u1");
    expect(plan.updates).toEqual([{ id: "r1", userId: "u1", assignedById: "u1" }]);
  });

  it("never touches observer rows while repairing the workers around them", () => {
    const plan = planClaimerRepair([
      row({ id: "obs", userId: "o", role: "observer", assignedById: null, assignedAt: at(0) }),
      row({ id: "r1", userId: "u1", assignedById: "gone", assignedAt: at(1) }),
    ]);
    expect(plan.claimerUserId).toBe("u1");
    expect(plan.updates.map((u) => u.id)).toEqual(["r1"]);
  });

  it("picks a worker as claimer even when an observer is the most senior row", () => {
    const plan = planClaimerRepair([
      row({ id: "obs", userId: "o", role: "observer", assignedById: null, assignedAt: at(0) }),
      row({ id: "r1", userId: "u1", assignedById: "gone", assignedAt: at(9) }),
      row({ id: "r2", userId: "u2", assignedById: "gone", assignedAt: at(3) }),
    ]);
    expect(plan.claimerUserId).toBe("u2");
  });

  it("is idempotent — re-running over its own output changes nothing", () => {
    const rows = [
      row({ id: "ra", userId: "u1", assignedById: "gone", assignedAt: at(0) }),
      row({ id: "rb", userId: "u2", assignedById: null, assignedAt: at(5) }),
    ];
    const first = planClaimerRepair(rows);
    const applied = rows.map((r) => {
      const u = first.updates.find((x) => x.id === r.id);
      return u ? { ...r, assignedById: u.assignedById } : r;
    });
    expect(planClaimerRepair(applied).updates).toEqual([]);
  });

  it("breaks assignedAt ties deterministically by row id", () => {
    const a = planClaimerRepair([
      row({ id: "bbb", userId: "ub", assignedById: "gone" }),
      row({ id: "aaa", userId: "ua", assignedById: "gone" }),
    ]);
    const b = planClaimerRepair([
      row({ id: "aaa", userId: "ua", assignedById: "gone" }),
      row({ id: "bbb", userId: "ub", assignedById: "gone" }),
    ]);
    expect(a.claimerUserId).toBe("ua");
    expect(b.claimerUserId).toBe("ua");
  });
});

describe("planObserverOnlyDemotions — only a paid person takes a paid seat", () => {
  it("leaves a crew of paid people alone", () => {
    expect(
      planObserverOnlyDemotions([
        row({ id: "r1", userId: "emp", workerType: "EMPLOYEE" }),
        row({ id: "r2", userId: "con", workerType: "CONTRACTOR" }),
      ]),
    ).toEqual([]);
  });

  it("demotes an UNPAID person out of a paid seat", () => {
    // The case this exists for: an unpaid family member added to a visit.
    // Priced, computeBreakdown would refuse the whole completion.
    expect(
      planObserverOnlyDemotions([
        row({ id: "r1", userId: "emp", workerType: "EMPLOYEE" }),
        row({ id: "r2", userId: "wife", workerType: "UNPAID" }),
      ]),
    ).toEqual([{ id: "r2", userId: "wife", workerType: "UNPAID" }]);
  });

  it("demotes someone whose worker type was never set", () => {
    // Nobody can be paid before it is decided how they are paid.
    expect(
      planObserverOnlyDemotions([row({ id: "r1", userId: "new", workerType: null })]),
    ).toEqual([{ id: "r1", userId: "new", workerType: null }]);
  });

  it("leaves an UNPAID person who is already an observer alone", () => {
    // That is the seat they are supposed to hold — no churn.
    expect(
      planObserverOnlyDemotions([
        row({ id: "r1", userId: "wife", role: "observer", assignedById: null, workerType: "UNPAID" }),
      ]),
    ).toEqual([]);
  });

  it("does NOT demote when workerType was not loaded", () => {
    // The dangerous direction. Reading an absent join as "not on payroll"
    // would demote an entire team the moment someone forgot a `select`, and
    // the claimer repair would then hand the visit to nobody. A missed
    // demotion is recoverable; a silent mass-demotion is not.
    const rows = [row({ id: "r1", userId: "emp" }), row({ id: "r2", userId: "con" })];
    expect(rows.every((r) => r.workerType === undefined)).toBe(true);
    expect(planObserverOnlyDemotions(rows)).toEqual([]);
  });

  it("hands the claim to a paid worker when the claimer is demoted", () => {
    // The two invariants interacting, which is why they live together and
    // why the demotion runs first: an UNPAID claimer leaves the visit with
    // workers and no claimer — the exact unstartable state.
    const rows: ClaimerAssigneeRow[] = [
      row({ id: "r1", userId: "wife", assignedById: "wife", assignedAt: at(0), workerType: "UNPAID" }),
      row({ id: "r2", userId: "emp", assignedById: "wife", assignedAt: at(5), workerType: "EMPLOYEE" }),
    ];
    const demotions = planObserverOnlyDemotions(rows);
    expect(demotions.map((d) => d.userId)).toEqual(["wife"]);

    // Apply them the way enforceAssigneeInvariants does, then repair.
    const demoted = new Set(demotions.map((d) => d.id));
    const after = rows.map((r) =>
      demoted.has(r.id) ? { ...r, role: "observer", assignedById: null } : r,
    );
    const plan = planClaimerRepair(after);
    expect(plan.claimerUserId).toBe("emp");
    expect(plan.updates).toEqual([{ id: "r2", userId: "emp", assignedById: "emp" }]);
  });

  it("leaves an occurrence unclaimed when every paid seat was demoted", () => {
    const rows: ClaimerAssigneeRow[] = [
      row({ id: "r1", userId: "wife", assignedById: "wife", workerType: "UNPAID" }),
    ];
    const demoted = new Set(planObserverOnlyDemotions(rows).map((d) => d.id));
    const after = rows.map((r) =>
      demoted.has(r.id) ? { ...r, role: "observer", assignedById: null } : r,
    );
    // Unclaimed is a legal state — an open visit on the board, not a bug.
    expect(planClaimerRepair(after)).toEqual({ claimerUserId: null, updates: [] });
  });
});

describe("canHoldPaidSeat", () => {
  it("is true for the two paid classes and false for everything else", () => {
    expect(canHoldPaidSeat("EMPLOYEE")).toBe(true);
    expect(canHoldPaidSeat("CONTRACTOR")).toBe(true);
    expect(canHoldPaidSeat("UNPAID")).toBe(false);
    expect(canHoldPaidSeat(null)).toBe(false);
    expect(canHoldPaidSeat(undefined)).toBe(false);
  });
});
