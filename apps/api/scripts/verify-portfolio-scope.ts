/**
 * Does portfolio scoping actually EXCLUDE another territory's rows?
 *
 * G10 asserts a scopable read carries a filter. G25 asserts the filter asks
 * about the right capability. Neither runs a query — both read source. This
 * script is the missing third thing: it builds a real principal from the
 * database, applies the real `portfolioWhere` fragment, runs the real Prisma
 * query, and compares the rows against the unscoped answer.
 *
 * It lives here rather than in the build gate because the gate is DB-free
 * and finishes in seconds; this needs a seeded database.
 *
 *   npx tsx scripts/verify-portfolio-scope.ts
 *
 * Expects `npm run db:seed` to have run: it needs the Durham / Chapel Hill
 * districts and the District Lead (Durham) fixture, who holds Admin inside
 * Durham and NO company-wide role.
 */
import { PrismaClient } from "@prisma/client";
import { flattenRole, type Entitlement } from "@repo/permissions";
import { portfolioWhere, visiblePortfolioPaths } from "../src/lib/portfolioScope";

const prisma = new PrismaClient();
const LEAD = "seed-district-lead-durham";

/** Build the principal the way services/currentUser.ts does. */
async function principalFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      customRoles: { where: { suspendedAt: null } },
      portfolioAssignments: { where: { suspendedAt: null }, include: { portfolio: true } },
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
      ...user.portfolioAssignments.map((aa) => ({
        roleId: aa.customRoleId,
        name: byId.get(aa.customRoleId)?.name ?? "",
        entitlements: flattenRole(aa.customRoleId, byId as never),
        portfolioPath: aa.portfolio?.path,
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

  const durham = await prisma.portfolio.findFirstOrThrow({ where: { name: "Durham" } });
  const chapel = await prisma.portfolio.findFirstOrThrow({ where: { name: "Chapel Hill" } });
  console.log(`\nDurham      ${durham.path}`);
  console.log(`Chapel Hill ${chapel.path}\n`);

  // ── The fixture itself has to be narrowed, or nothing below means anything.
  const paths = visiblePortfolioPaths(lead as never, "clients.view");
  check(
    "the District Lead is territory-limited (not global)",
    Array.isArray(paths) && paths.length === 1 && paths[0] === durham.path,
    `visiblePortfolioPaths returned ${JSON.stringify(paths)} — null means NO narrowing, which would make every assertion below vacuous.`,
  );
  check(
    "the owner is NOT narrowed",
    visiblePortfolioPaths(owner as never, "clients.view") === null,
    "a company-wide grant must win; if this narrows, global reads are broken.",
  );

  // ── Properties: membership is a join, so `some` is the question.
  const allProps = await prisma.property.count();
  const leadProps = await prisma.property.findMany({
    where: { ...portfolioWhere(lead as never, "clients.view") },
    select: { id: true, city: true, portfolios: { select: { portfolioId: true } } },
  });
  check(
    "Property read excludes the other district",
    leadProps.length > 0 && leadProps.every((p) => p.portfolios.some((m) => m.portfolioId === durham.id)),
    `${leadProps.length}/${allProps} returned; offenders: ${leadProps.filter((p) => !p.portfolios.some((m) => m.portfolioId === durham.id)).map((p) => p.city).join(", ") || "none"}`,
  );
  check(
    "Property read is non-empty (the filter narrows, it does not erase)",
    leadProps.length > 0,
    "zero rows means the fixture has no Durham properties — the test proves nothing.",
  );

  // ── Occurrences: the row the money hangs off.
  const leadOccs = await prisma.jobOccurrence.findMany({
    where: { ...portfolioWhere(lead as never, "schedule.view") },
    select: { id: true, portfolios: { select: { portfolioId: true } } },
  });
  const allOccs = await prisma.jobOccurrence.count();
  check(
    "JobOccurrence read excludes the other district",
    leadOccs.length > 0 && leadOccs.every((o) => o.portfolios.some((m) => m.portfolioId === durham.id)),
    `${leadOccs.length}/${allOccs} returned; ${leadOccs.filter((o) => !o.portfolios.some((m) => m.portfolioId === durham.id)).length} from outside Durham`,
  );

  // ── JOBS NO LONGER CARRY A PORTFOLIO OF THEIR OWN.
  //
  // There was a check here for `Job.defaultAreaId`, the projection default
  // that answered "where do future occurrences land". That field is gone:
  // an open visit follows its property's current memberships directly, so
  // there is no unanswerable case left to default. A job's portfolios are
  // its property's, which the Property check above already proves.

  // ── The prefix rule: a sibling must not leak. This is the bug the
  //    trailing delimiter exists to prevent, so assert it on real rows.
  //
  // COUNTED OVER THE SUBTREE, not the node. This asked for rows attached
  // to Chapel Hill ITSELF, which was the same question only while the tree
  // was one level deep. It stopped being so on 2026-10-29, when Chapel
  // Hill became a district whose properties hang off the zones beneath it
  // — and the negative control started failing while nothing was wrong,
  // which is the better of the two ways for it to break. A lens on a
  // district returns its whole subtree, so that is what has to be
  // non-empty for "excludes the other district" to mean anything.
  const chapelCount = await prisma.property.count({
    where: { portfolios: { some: { portfolio: { path: { startsWith: chapel.path } } } } },
  });
  check(
    "the other district genuinely has rows to leak",
    chapelCount > 0,
    "Chapel Hill's subtree is empty, so 'excludes the other district' is trivially true.",
  );

  // ── And the owner still sees everything.
  const ownerProps = await prisma.property.count({
    where: { ...portfolioWhere(owner as never, "clients.view") },
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
