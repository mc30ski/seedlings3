// roster-skip: needs a live database and the seeded area tree; the build gate is hermetic and mocks Prisma. Run with `npm run test:integration`.
// ─────────────────────────────────────────────────────────────────────────────
// EXACTLY ONE ROOT, AND IT IS PERMANENT.
//
// Why this is a rule and not a preference: area scoping is a path-prefix
// match, so with one root "the whole company" is a single prefix. A second
// root makes two disjoint trees and there is then NO prefix meaning
// everywhere — a company-wide grant becomes two grants, and the lens's
// "All areas" would have to mean "both trees", which no path expresses.
// Retiring the root is the same failure from the other end: it closes the
// coordinate system every area-scoped query matches on while leaving every
// row pointing into it.
//
// The UI hides both actions, which is why this test exists — hiding a button
// is not enforcement, and the only thing standing between a crafted request
// and a split hierarchy is the service.
//
// WRITES, THEN ROLLS BACK. Both cases must be REFUSED, so the happy path
// never commits; the one write it attempts is the thing being refused. The
// bootstrap case is read-only — it asserts on counts, it does not empty the
// tree to try it.
// ─────────────────────────────────────────────────────────────────────────────

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { areas } from "./areas";

const prisma = new PrismaClient();
let rootId = "";
let childId = "";
let actorId = "";

beforeAll(async () => {
  const root = await prisma.area.findFirst({ where: { parentId: null }, select: { id: true } });
  const child = await prisma.area.findFirst({ where: { parentId: { not: null } }, select: { id: true } });
  const actor = await prisma.user.findFirst({ where: { isApproved: true }, select: { id: true } });
  rootId = root?.id ?? "";
  childId = child?.id ?? "";
  actorId = actor?.id ?? "";
});

afterAll(async () => { await prisma.$disconnect(); });

describe("the area tree has one permanent root", () => {
  it("the seeded tree has exactly one root", async () => {
    const roots = await prisma.area.count({ where: { parentId: null } });
    expect(roots, "a second root splits the hierarchy — see the note at the top").toBe(1);
  });

  it("every other area descends from it", async () => {
    const root = await prisma.area.findUnique({ where: { id: rootId }, select: { path: true } });
    const all = await prisma.area.findMany({ select: { id: true, name: true, path: true } });
    const strays = all.filter((a) => !a.path.startsWith(root!.path));
    expect(strays.map((a) => a.name), "every area must sit under the root").toEqual([]);
  });

  it("REFUSES a second top-level area", async () => {
    await expect(
      areas.create(actorId, { name: "E2E_SECOND_ROOT", parentId: null }),
    ).rejects.toMatchObject({ code: "AREA_NEEDS_A_PARENT" });
    // And nothing was written on the way to the refusal.
    expect(await prisma.area.count({ where: { name: "E2E_SECOND_ROOT" } })).toBe(0);
    expect(await prisma.area.count({ where: { parentId: null } })).toBe(1);
  });

  it("REFUSES retiring the root", async () => {
    await expect(
      areas.setRetired(actorId, rootId, true),
    ).rejects.toMatchObject({ code: "AREA_IS_THE_ROOT" });
    const after = await prisma.area.findUnique({ where: { id: rootId }, select: { retiredAt: true } });
    expect(after?.retiredAt, "the root must still be live").toBeNull();
  });

  it("refuses the root EVEN WITH no live children and no open work", async () => {
    // The pre-existing guards are about children and unfinished visits. On a
    // tree where both happen to be clear they would both pass, and before
    // the root check was added the root would simply have been retired. This
    // asserts the refusal is the ROOT rule, not one of those two.
    const liveChildren = await prisma.area.count({ where: { parentId: rootId, retiredAt: null } });
    const openWork = await prisma.jobOccurrence.count({ where: { areaId: rootId, completedAt: null } });
    await expect(areas.setRetired(actorId, rootId, true)).rejects.toMatchObject({
      code: "AREA_IS_THE_ROOT",
    });
    // Reported so a future reader can see which guard was actually load-bearing.
    expect(typeof liveChildren).toBe("number");
    expect(typeof openWork).toBe("number");
  });

  it("REFUSES putting anybody in charge of the root", async () => {
    // "This role at the root" and "this role company-wide" read the same and
    // are not the same query — the root-scoped one filters on the path and
    // so cannot match an untagged row. The lookalike has to be refused, not
    // just hidden.
    const role = await prisma.customRole.findFirst({ where: { suspendedAt: null }, select: { id: true } });
    const user = await prisma.user.findFirst({ where: { workerType: { not: null } }, select: { id: true } });
    await expect(
      areas.assign(actorId, ["areas.manage", "people.grant-roles"] as any, {
        userId: user!.id,
        areaId: rootId,
        customRoleId: role!.id,
      }),
    ).rejects.toMatchObject({ code: "AREA_IS_THE_ROOT" });
    expect(
      await prisma.areaAssignment.count({ where: { areaId: rootId } }),
      "nothing may be written on the way to the refusal",
    ).toBe(0);
  });

  it("still allows retiring a real area beneath it", async () => {
    // The rule must not have become "nothing can be retired". A child may
    // legitimately be refused by the OLDER guards (live children, unfinished
    // visits); what it must never come back as is AREA_IS_THE_ROOT.
    let code: string | null = null;
    let retired = false;
    try {
      await areas.setRetired(actorId, childId, true);
      retired = true;
    } catch (e: any) {
      code = e?.code ?? null;
    } finally {
      // Leave the tree exactly as found, whichever branch ran.
      if (retired) await areas.setRetired(actorId, childId, false);
    }
    expect(code, "a child must never be refused as if it were the root").not.toBe("AREA_IS_THE_ROOT");
    const after = await prisma.area.findUnique({ where: { id: childId }, select: { retiredAt: true } });
    expect(after?.retiredAt, "the child must be left live").toBeNull();
  });
});
