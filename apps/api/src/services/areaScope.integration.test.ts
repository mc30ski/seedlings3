// roster-skip: needs a live database and the seeded area fixture; the build gate is hermetic and mocks Prisma. Run with `npm run test:integration`.
// ─────────────────────────────────────────────────────────────────────────────
// Area scoping, against real rows and a real principal.
//
// WHAT WAS MISSING. `areaScope.test.ts` has 25 cases and every one of them
// feeds the filter a hand-built principal. That proves the path arithmetic
// — prefix matching, the trailing delimiter that stops "/a/b/" leaking into
// "/a/bb/" — and proves nothing about whether a real person, assembled from
// real rows, actually sees less. Until 2026-10-22 the note on this work read
// "the seed creates ZERO AreaAssignment rows, so scoping has never run
// against real data". The seed now builds the fixture; this is the test that
// uses it.
//
// NOT THE SAME CLAIM AS AN E2E PERSONA. Signing in as the District Lead and
// driving the UI needs a Clerk account that does not exist yet, so this stops
// one layer below: it builds the principal exactly as `services/currentUser`
// does — flattening inheritance, carrying `areaPath` off the assignment —
// and runs a genuine Prisma query through `areaWhere`. If the UI later shows
// that person too much, it will not be because this layer was untested.
//
// READ-ONLY. It writes nothing and depends only on what `npm run db:seed`
// produces, so it is safe to run repeatedly and safe against any database
// that has the fixture.
// ─────────────────────────────────────────────────────────────────────────────

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { flattenRole, isEntitlement, type Entitlement, type Principal } from "@repo/permissions";
import { areaWhere, visibleAreaPaths, isAreaLimited } from "../lib/areaScope";

const prisma = new PrismaClient();
const FIXTURE_EMAIL = "admin+districtlead@seedlingslawncare.com";

let districtLead: Principal;
let companyWideAdmin: Principal;
let durhamPath = "";

/** The same assembly `services/currentUser.ts` performs, kept in step with it. */
async function principalFor(email: string): Promise<Principal> {
  const user = await prisma.user.findFirst({
    where: { email },
    select: {
      workerType: true,
      customRoles: { where: { suspendedAt: null }, select: { customRoleId: true } },
      areaAssignments: {
        where: { suspendedAt: null },
        select: { customRoleId: true, area: { select: { path: true } } },
      },
    },
  });
  if (!user) throw new Error(`fixture missing: ${email} — run npm run db:seed`);

  const allRoles = await prisma.customRole.findMany({
    select: {
      id: true, name: true, key: true, inheritsFromId: true,
      entitlements: { select: { entitlement: true } },
    },
  });
  const byId = new Map(
    allRoles.map((r) => [r.id, {
      id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
      entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement),
    }]),
  );
  return {
    kind: "user",
    workerType: user.workerType,
    roles: [
      ...user.customRoles.map((g) => ({
        roleId: g.customRoleId,
        name: byId.get(g.customRoleId)?.name ?? "",
        entitlements: flattenRole(g.customRoleId, byId as never) as Entitlement[],
      })),
      ...user.areaAssignments.map((aa) => ({
        roleId: aa.customRoleId,
        name: byId.get(aa.customRoleId)?.name ?? "",
        entitlements: flattenRole(aa.customRoleId, byId as never) as Entitlement[],
        areaPath: aa.area?.path,
      })),
    ],
  };
}

beforeAll(async () => {
  districtLead = await principalFor(FIXTURE_EMAIL);
  // Somebody holding the same role company-wide, as the contrast. Without
  // one, "sees 9 properties" could just mean the database has 9.
  const owner = await prisma.user.findFirst({
    where: { customRoles: { some: { customRole: { key: "seedlings.super" } } } },
    select: { email: true },
  });
  if (!owner?.email) throw new Error("no company-wide Super to contrast against");
  companyWideAdmin = await principalFor(owner.email);
  durhamPath = (await prisma.area.findFirstOrThrow({
    where: { name: "Durham" }, select: { path: true },
  })).path;
});

afterAll(async () => { await prisma.$disconnect(); });

describe("area scoping — a real assigned principal, real rows", () => {
  it("the fixture is what it claims: one area, no company-wide grant", async () => {
    const u = districtLead as Extract<Principal, { kind: "user" }>;
    // A company-wide grant would defeat the whole fixture, and the failure
    // mode is silent — the scoped read legitimately returns everything.
    expect(u.roles.filter((r) => !r.areaPath), "district lead must hold NO company-wide role").toEqual([]);
    expect(u.roles.filter((r) => r.areaPath)).toHaveLength(1);
    expect(u.roles[0].areaPath).toBe(durhamPath);
    expect(u.workerType, "a null worker type means nothing resolves at all").not.toBeNull();
  });

  it("narrows a real property query to the assigned subtree", async () => {
    const scoped = await prisma.property.count({
      where: areaWhere(districtLead, "clients.view") as any,
    });
    const all = await prisma.property.count();
    expect(all, "fixture too thin to prove narrowing").toBeGreaterThan(scoped);
    expect(scoped, "an assigned principal that sees nothing is a broken fixture").toBeGreaterThan(0);

    // And it is the RIGHT subset, not merely a smaller one.
    const inDurham = await prisma.property.count({
      where: { area: { path: { startsWith: durhamPath } } },
    });
    expect(scoped).toBe(inDurham);
  });

  it("a company-wide holder of the same capability is not narrowed", async () => {
    expect(visibleAreaPaths(companyWideAdmin, "clients.view")).toBeNull();
    expect(areaWhere(companyWideAdmin, "clients.view")).toEqual({});
    const scoped = await prisma.property.count({
      where: areaWhere(companyWideAdmin, "clients.view") as any,
    });
    expect(scoped).toBe(await prisma.property.count());
  });

  it("holding the capability NOWHERE reads as nothing, never as everything", async () => {
    // The dangerous confusion in this filter is [] vs null. [] must produce
    // an impossible condition; null must produce no filter at all.
    const nobody: Principal = { kind: "user", workerType: "EMPLOYEE", roles: [] };
    expect(visibleAreaPaths(nobody, "clients.view")).toEqual([]);
    const scoped = await prisma.property.count({
      where: areaWhere(nobody, "clients.view") as any,
    });
    expect(scoped).toBe(0);
  });

  it("reports the district lead as territorially limited", () => {
    expect(isAreaLimited(districtLead, "clients.view")).toBe(true);
  });
});
