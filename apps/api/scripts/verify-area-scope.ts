/**
 * Does area scoping actually EXCLUDE another territory's rows?
 *
 * G10 asserts a scopable read carries a filter. G25 asserts the filter asks
 * about the right capability. Neither runs a query — both read source. This
 * script is the missing third thing: it builds a real principal from the
 * database, applies the real `areaWhere` fragment, runs the real Prisma
 * query, and compares the rows against the unscoped answer.
 *
 * It lives here rather than in the build gate because the gate is DB-free
 * and finishes in seconds; this needs a seeded database.
 *
 *   npx tsx scripts/verify-area-scope.ts
 *
 * Expects `npm run db:seed` to have run: it needs the Durham / Chapel Hill
 * districts and the District Lead (Durham) fixture, who holds Admin inside
 * Durham and NO company-wide role.
 */
import { PrismaClient } from "@prisma/client";
import { flattenRole, type Entitlement } from "@repo/permissions";
import { areaWhere, areaWhereOn, visibleAreaPaths } from "../src/lib/areaScope";

const prisma = new PrismaClient();
const LEAD = "seed-district-lead-durham";

/** Build the principal the way services/currentUser.ts does. */
async function principalFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      customRoles: { where: { suspendedAt: null } },
      areaAssignments: { where: { suspendedAt: null }, include: { area: true } },
    },
  });
  if (!user) throw new Error(`no such user: ${userId}`);
  const roles = await prisma.customRole.findMany({ include: { entitlements: true } });
  const byId = new Map(
    roles.map((r) => [r.id, {
      id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
      entitlements: r.entitlements.map((e) => e.entitlement as Entitlement),
    }]),
  );
  return {
    kind: "user" as const,
    userId: user.id,
    workerType: user.workerType,
    roles: [
      ...user.customRoles.map((ucr) => ({
        roleId: ucr.customRoleId,
        name: byId.get(ucr.customRoleId)?.name ?? "",
        entitlements: flattenRole(ucr.customRoleId, byId as never),
      })),
      ...user.areaAssignments.map((aa) => ({
        roleId: aa.customRoleId,
        name: byId.get(aa.customRoleId)?.name ?? "",
        entitlements: flattenRole(aa.customRoleId, byId as never),
        areaPath: aa.area?.path,
      })),
    ],
    perspective: null,
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
  if (!ok) { console.log(`      ${detail}`); failures++; }
}

(async () => {
  const lead = await principalFor(LEAD);
  const owner = await principalFor(
    (await prisma.user.findFirstOrThrow({
      where: { customRoles: { some: { customRole: { key: "seedlings.super" } } } },
      select: { id: true },
    })).id,
  );

  const durham = await prisma.area.findFirstOrThrow({ where: { name: "Durham" } });
  const chapel = await prisma.area.findFirstOrThrow({ where: { name: "Chapel Hill" } });
  console.log(`\nDurham      ${durham.path}`);
  console.log(`Chapel Hill ${chapel.path}\n`);

  // ── The fixture itself has to be narrowed, or nothing below means anything.
  const paths = visibleAreaPaths(lead as never, "clients.view");
  check(
    "the District Lead is territory-limited (not global)",
    Array.isArray(paths) && paths.length === 1 && paths[0] === durham.path,
    `visibleAreaPaths returned ${JSON.stringify(paths)} — null means NO narrowing, which would make every assertion below vacuous.`,
  );
  check(
    "the owner is NOT narrowed",
    visibleAreaPaths(owner as never, "clients.view") === null,
    "a company-wide grant must win; if this narrows, global reads are broken.",
  );

  // ── Properties: the model carries areaId directly.
  const allProps = await prisma.property.count();
  const leadProps = await prisma.property.findMany({
    where: { ...areaWhere(lead as never, "clients.view") },
    select: { id: true, city: true, areaId: true },
  });
  check(
    "Property read excludes the other district",
    leadProps.length > 0 && leadProps.every((p) => p.areaId === durham.id),
    `${leadProps.length}/${allProps} returned; offenders: ${leadProps.filter((p) => p.areaId !== durham.id).map((p) => p.city).join(", ") || "none"}`,
  );
  check(
    "Property read is non-empty (the filter narrows, it does not erase)",
    leadProps.length > 0,
    "zero rows means the fixture has no Durham properties — the test proves nothing.",
  );

  // ── Occurrences: the row the money hangs off.
  const leadOccs = await prisma.jobOccurrence.findMany({
    where: { ...areaWhere(lead as never, "schedule.view") },
    select: { id: true, areaId: true },
  });
  const allOccs = await prisma.jobOccurrence.count();
  check(
    "JobOccurrence read excludes the other district",
    leadOccs.length > 0 && leadOccs.every((o) => o.areaId === durham.id),
    `${leadOccs.length}/${allOccs} returned; ${leadOccs.filter((o) => o.areaId !== durham.id).length} from outside Durham`,
  );

  // ── Job reaches its area through `defaultArea`, not `area`.
  const leadJobs = await prisma.job.findMany({
    where: { ...areaWhereOn(lead as never, "schedule.view", "defaultArea") },
    select: { id: true, defaultAreaId: true },
  });
  check(
    "Job read (via defaultArea) excludes the other district",
    leadJobs.length > 0 && leadJobs.every((j) => j.defaultAreaId === durham.id),
    `${leadJobs.length} returned; ${leadJobs.filter((j) => j.defaultAreaId !== durham.id).length} from outside Durham`,
  );

  // ── The prefix rule: a sibling must not leak. This is the bug the
  //    trailing delimiter exists to prevent, so assert it on real rows.
  const chapelCount = await prisma.property.count({ where: { areaId: chapel.id } });
  check(
    "the other district genuinely has rows to leak",
    chapelCount > 0,
    "Chapel Hill is empty, so 'excludes the other district' is trivially true.",
  );

  // ── And the owner still sees everything.
  const ownerProps = await prisma.property.count({
    where: { ...areaWhere(owner as never, "clients.view") },
  });
  check(
    "a global reader still sees every row",
    ownerProps === allProps,
    `owner saw ${ownerProps} of ${allProps} — a global grant must not be narrowed.`,
  );

  console.log(failures === 0
    ? "\nArea scoping verified against real rows.\n"
    : `\n${failures} check(s) FAILED.\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
})();
