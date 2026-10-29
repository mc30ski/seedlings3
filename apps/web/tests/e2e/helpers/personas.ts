import path from "path";
import { makePrisma } from "./prisma";
import { USERS, type SeedUserKey } from "./db";

/**
 * WHO TO SEND A REQUEST AS, AND WHAT THEY ACTUALLY HOLD.
 *
 * The capability sets are READ FROM THE DATABASE, flattening role
 * inheritance the same way `services/currentUser.ts` does. They are not
 * hardcoded, because the starter ladder is seed data the operator can edit —
 * "Super" is the name of a role that happens to hold everything, not a tier
 * in the code. A hardcoded expectation here would be asserting a seed fact
 * and would start lying the first time somebody edits a role.
 */

export const STORAGE_STATE = (key: SeedUserKey) =>
  path.resolve(__dirname, `../../../playwright/.auth/${key}.json`);

/** Every persona `auth.setup.ts` signs in, least privileged first. */
export const PERSONAS: SeedUserKey[] = [
  "unpaid",
  "coordinator",
  "bookkeeper",
  "payroll",
  "trainee",
  "contractor",
  "employee",
  "scheduler",
  // Between the narrow personas and the owner because its access is not a
  // tier: it holds Admin's full set, but only inside one portfolio.
  "districtLead",
  "owner",
];

export type PersonaCaps = Record<string, Set<string>>;

let capsCache: PersonaCaps | null = null;

export async function personaCapabilities(): Promise<PersonaCaps> {
  if (capsCache) return capsCache;
  const prisma = makePrisma();
  try {
    const roles = await prisma.customRole.findMany({
      select: {
        id: true,
        inheritsFromId: true,
        entitlements: { select: { entitlement: true } },
      },
    });
    const byId = new Map(roles.map((r) => [r.id, r]));
    const flatten = (id: string, seen = new Set<string>()): string[] => {
      if (seen.has(id)) return []; // a cycle would otherwise hang the suite
      seen.add(id);
      const r = byId.get(id);
      if (!r) return [];
      return [
        ...r.entitlements.map((e) => e.entitlement),
        ...(r.inheritsFromId ? flatten(r.inheritsFromId, seen) : []),
      ];
    };

    const out: PersonaCaps = {};
    for (const key of PERSONAS) {
      let userId: string;
      try {
        userId = USERS[key];
      } catch {
        out[key] = new Set();
        continue;
      }
      // BOTH WAYS A ROLE IS HELD, as `services/currentUser.ts` does it.
      //
      // This read `userCustomRole` alone — company-wide grants — and the
      // moment a persona existed whose access came entirely from an PORTFOLIO
      // ASSIGNMENT, it reported that persona as holding nothing. The sweep
      // then skipped its "every tab they can reach opens" test on the
      // `capabilityTabs.length === 0` guard, so the one persona added to
      // prove portfolio scoping was the one persona the sweep did not drive,
      // and the run still said 19 passed.
      //
      // A portfolio narrows WHICH ROWS you see, not which capabilities you
      // hold, so for "what tabs does this persona get" the two kinds of
      // grant count the same.
      const [grants, portfolioGrants] = await Promise.all([
        prisma.userCustomRole.findMany({
          where: { userId, suspendedAt: null, customRole: { suspendedAt: null } },
          select: { customRoleId: true },
        }),
        prisma.portfolioAssignment.findMany({
          where: { userId, suspendedAt: null, customRole: { suspendedAt: null } },
          select: { customRoleId: true },
        }),
      ]);
      out[key] = new Set(
        [...grants, ...portfolioGrants].flatMap((g) => flatten(g.customRoleId)),
      );
    }
    capsCache = out;
    return out;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The TIGHTEST pair for testing one entitlement.
 *
 * `holder` is the LEAST privileged persona who holds it — if the route admits
 * them, it admits everyone above them, and picking Super for everything would
 * prove only that the top tier works.
 *
 * `nonHolder` is the MOST privileged persona who does NOT, so a refusal is
 * attributable to this entitlement rather than to the caller being broadly
 * powerless. That matters: refusing a persona with zero capabilities proves
 * almost nothing, while refusing someone with `schedule.manage` who merely lacks `books.view`
 * proves the guard is reading the right thing.
 */
export function pickPair(
  caps: PersonaCaps,
  entitlement: string,
): { holder: SeedUserKey | null; nonHolder: SeedUserKey | null } {
  const ordered = PERSONAS.slice().sort(
    (a, b) => (caps[a]?.size ?? 0) - (caps[b]?.size ?? 0),
  );
  const holder = ordered.find((p) => caps[p]?.has(entitlement)) ?? null;
  const nonHolder =
    ordered.slice().reverse().find((p) => !caps[p]?.has(entitlement)) ?? null;
  return { holder, nonHolder };
}
