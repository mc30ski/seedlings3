// roster-skip: needs a live database; the build gate is hermetic and mocks Prisma. Run with `npm run test:integration`.
// ─────────────────────────────────────────────────────────────────────────────
// `moveWithinChain` — behavioural, against a real database.
//
// WHY THIS IS NOT IN THE BUILD GATE. The gate is hermetic and finishes in
// ~3s; every test in it mocks Prisma. This one cannot: the whole point of
// the function is resolving an inheritance chain across real rows, and a
// mocked chain would only assert that the mock returns what the mock was
// told to return. It runs via `npm run test:integration` against dev.
//
// WHAT IT PROTECTS. `moveLadderRung` assumed the app had exactly one
// hierarchy — it refused any target without `isLadderRung`, and found the
// role to move FROM with `where: { customRole: { isLadderRung: true } }`,
// a query with one possible answer. Generalising it to any chain is a
// change to authorization-adjacent code: it decides which role gets
// REVOKED when somebody moves. A mistake here silently strips a grant.
// The build gate only asserts the source no longer mentions the flag,
// which is a long way from proving the right row is deleted.
//
// Every row it creates is prefixed E2E_ and removed in `afterAll`, so it
// never touches seeded data and can run repeatedly.
// ─────────────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ENTITLEMENTS } from "@repo/permissions";
import { customRoles } from "./customRoles";

const prisma = new PrismaClient();
const TAG = `E2E_move_${Date.now()}`;
const ALL = ENTITLEMENTS as any;

let userId = "";
let actorId = "";
/** A chain the installer knows nothing about: Base <- Middle <- Top. */
let baseId = "";
let middleId = "";
let topId = "";
/** Hangs off Base beside Middle — a sibling OF MIDDLE, not a chain-mate
 *  of it. Note it IS a chain-mate of Base, which is its parent: the first
 *  draft of this test granted Sibling to somebody holding Base and the
 *  service correctly refused with SAME_ROLE_CHAIN. "Sibling" is a claim
 *  about a pair of roles, not a property of one. */
let siblingId = "";

beforeAll(async () => {
  const mk = async (name: string, parent: string | null, ent: string[]) =>
    (
      await prisma.customRole.create({
        data: {
          name: `${TAG}_${name}`,
          inheritsFromId: parent,
          isSystem: false,
          entitlements: { create: ent.map((entitlement) => ({ entitlement: entitlement as any })) },
        },
        select: { id: true },
      })
    ).id;

  baseId = await mk("Base", null, ["schedule.view"]);
  middleId = await mk("Middle", baseId, ["clients.view"]);
  topId = await mk("Top", middleId, ["people.view"]);
  siblingId = await mk("Sibling", baseId, ["equipment.view"]);

  const mkUser = async (suffix: string) =>
    (
      await prisma.user.create({
        data: {
          email: `${TAG}_${suffix}@example.invalid`,
          clerkUserId: `${TAG}_${suffix}`,
          workerType: "EMPLOYEE",
          isApproved: true,
        },
        select: { id: true },
      })
    ).id;
  userId = await mkUser("subject");
  actorId = await mkUser("actor");
});

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: [actorId, userId] } } });
  await prisma.userCustomRole.deleteMany({ where: { userId: { in: [userId, actorId] } } });
  await prisma.roleEntitlement.deleteMany({
    where: { customRole: { name: { startsWith: TAG } } },
  });
  // Children first — `inheritsFromId` is a real FK.
  for (const id of [siblingId, topId, middleId, baseId]) {
    if (id) await prisma.customRole.deleteMany({ where: { id } });
  }
  await prisma.user.deleteMany({ where: { id: { in: [userId, actorId] } } });
  await prisma.$disconnect();
});

const held = async () =>
  (
    await prisma.userCustomRole.findMany({
      where: { userId },
      select: { customRole: { select: { name: true } } },
    })
  )
    .map((g) => g.customRole.name.replace(`${TAG}_`, ""))
    .sort();

describe("moveWithinChain — a hierarchy the installer never flagged", () => {
  it("moves along a chain with no isLadderRung anywhere in it", async () => {
    await customRoles.assign(actorId, ALL, userId, middleId);
    expect(await held()).toEqual(["Middle"]);

    // The old code refused this outright: NOT_A_LADDER_RUNG, 400.
    const res = await customRoles.moveWithinChain(actorId, ALL, userId, topId);
    expect(res.moved).toBe(true);
    expect(res.from).toBe(`${TAG}_Middle`);
    expect(await held()).toEqual(["Top"]);
  });

  it("moves DOWN the chain as well as up, revoking the descendant", async () => {
    const res = await customRoles.moveWithinChain(actorId, ALL, userId, baseId);
    expect(res.moved).toBe(true);
    expect(res.from).toBe(`${TAG}_Top`);
    expect(await held()).toEqual(["Base"]);
  });

  it("refuses to stack a role onto its own ancestor", async () => {
    // They hold Base, and Sibling inherits Base — so Sibling already
    // contains everything Base grants. This is `assign()`'s job, asserted
    // here because the move grouping in the UI is built on the same
    // relation: anything this refuses must be offered as a MOVE, never as
    // a plain grant.
    await expect(customRoles.assign(actorId, ALL, userId, siblingId)).rejects.toMatchObject({
      code: "SAME_ROLE_CHAIN",
    });
    expect(await held()).toEqual(["Base"]);
  });

  it("leaves a true sibling alone — neither contains the other", async () => {
    // Middle and Sibling both hang off Base and neither is an ancestor of
    // the other, so holding both is legal. This is the combination the
    // tree-wide reading would have broken: Coordinator and Worker in the
    // real data.
    await customRoles.moveWithinChain(actorId, ALL, userId, middleId);
    await customRoles.assign(actorId, ALL, userId, siblingId);
    expect(await held()).toEqual(["Middle", "Sibling"]);

    // Moving Middle -> Top must revoke Middle and keep Sibling.
    await customRoles.moveWithinChain(actorId, ALL, userId, topId);
    expect(await held()).toEqual(["Sibling", "Top"]);
  });

  it("writes ONE audit row naming both ends, not a revoke plus a grant", async () => {
    const before = await prisma.auditEvent.count({ where: { actorUserId: actorId } });
    await customRoles.moveWithinChain(actorId, ALL, userId, middleId);
    const rows = await prisma.auditEvent.findMany({
      where: { actorUserId: actorId },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { scope: true, verb: true, metadata: true },
    });
    expect(await prisma.auditEvent.count({ where: { actorUserId: actorId } })).toBe(before + 1);
    expect(rows[0].scope).toBe("ROLE");
    expect(rows[0].verb).toBe("ROLE_ASSIGNED");
    const m = rows[0].metadata as any;
    expect(m.roleName).toBe(`${TAG}_Middle`);
    // Both halves in one row: a promotion must not read as a demotion.
    expect(m.movedFromRoleName).toBe(`${TAG}_Top`);
  });

  it("is a no-op when they already hold the target", async () => {
    const res = await customRoles.moveWithinChain(actorId, ALL, userId, middleId);
    expect(res.moved).toBe(false);
    expect(await held()).toEqual(["Middle", "Sibling"]);
  });
});
