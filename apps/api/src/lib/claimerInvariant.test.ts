import { describe, it, expect } from "vitest";
import { planClaimerRepair, type ClaimerAssigneeRow } from "./claimerInvariant";

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
