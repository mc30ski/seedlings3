import type { Prisma, PrismaClient } from "@prisma/client";
import {
  flattenRole,
  isEntitlement,
  type Entitlement,
  type RoleDefinition,
} from "@repo/permissions";

/**
 * What can SOMEBODY ELSE do?
 *
 * `callerCan` answers it for the person making the request, off the principal
 * the auth read already resolved. This is for the other case: deciding what
 * to show about a colleague, or whether a target user may hold a paid seat —
 * `/workers` reporting each person's field clearance, for instance.
 *
 * DO NOT USE THIS FOR THE CALLER. A fresh read by id ignores the active
 * perspective and returns the person's real powers, which is precisely the
 * view-as bypass this repo has shipped three times. `callerCan(req, …)` is
 * the only correct way to ask about the caller.
 *
 * Suspension is filtered in the query, never afterwards: a suspended grant or
 * a suspended role must not reach the set at all. Inheritance is flattened
 * here so callers stay simple set membership tests.
 *
 * THE PAYROLL GATE IS APPLIED HERE TOO, and it has to be. `can()` returns
 * false for anyone whose `workerType` is null (G31) — being in the system is
 * not being cleared to act in it. This function did not check it, so the two
 * answered the same question differently: an unclassified person resolved to
 * their full role set here and to nothing at all through `can()`. A UI badge
 * drawn from one and a 403 from the other is precisely the mismatch the
 * single-implementation rule exists to prevent.
 */
export async function capabilitiesForUsers(
  db: PrismaClient | Prisma.TransactionClient,
  userIds: readonly string[],
): Promise<Map<string, Set<Entitlement>>> {
  const out = new Map<string, Set<Entitlement>>(userIds.map((id) => [id, new Set()]));
  if (userIds.length === 0) return out;

  const [allRoles, grants, portfolioGrants, people] = await Promise.all([
    db.customRole.findMany({
      select: {
        id: true, name: true, key: true, inheritsFromId: true,
        entitlements: { select: { entitlement: true } },
      },
    }),
    // BOTH WAYS A ROLE IS HELD. This read `userCustomRole` alone, so
    // anybody whose access comes from an PORTFOLIO ASSIGNMENT resolved to the
    // empty set — they looked capability-less to every caller of this
    // function while `can()` (which walks `principal.roles`, built from
    // both) said otherwise. That is exactly the UI-badge-vs-403 mismatch
    // the note above says this function exists to prevent.
    //
    // Portfolio narrows WHICH ROWS, not which capabilities, so for "what may
    // this person do at all" the two grant kinds count the same. A caller
    // needing the territorial part asks `portfolioScope` with the path.
    db.userCustomRole.findMany({
      where: {
        userId: { in: [...userIds] },
        suspendedAt: null,
        customRole: { suspendedAt: null },
      },
      select: { userId: true, customRoleId: true },
    }),
    db.portfolioAssignment.findMany({
      where: {
        userId: { in: [...userIds] },
        suspendedAt: null,
        customRole: { suspendedAt: null },
      },
      select: { userId: true, customRoleId: true },
    }),
    db.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, workerType: true },
    }),
  ]);

  // Nobody whose pay class is undecided holds anything, whatever is granted
  // to them. Fails closed for an id that resolves to no row at all.
  //
  // This is the same line that keeps CUSTOMERS out of staff surfaces: a
  // client contact's login has no worker type, so it leaves here with the
  // empty set. See the long note on the payroll gate in
  // `packages/permissions/permissions.ts` — the two must agree, and this
  // function is the half that once did not.
  //
  // A customer who also works for you passes, by design. The order is what
  // is protected: a grant may not land on a customer who has no worker type
  // yet, because it would sit dormant and activate the day one is set. The
  // database refuses that (20261020140000_client_grants_require_a_worker_type),
  // so this code never has to decide whether a dormant grant is safe.
  const cleared = new Set(people.filter((p) => p.workerType !== null).map((p) => p.id));

  const byId = new Map<string, RoleDefinition>(
    allRoles.map((r) => [
      r.id,
      {
        id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
        entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement),
      },
    ]),
  );

  for (const g of [...grants, ...portfolioGrants]) {
    if (!cleared.has(g.userId)) continue;
    const set = out.get(g.userId);
    if (!set) continue;
    for (const e of flattenRole(g.customRoleId, byId)) set.add(e);
  }
  return out;
}

/** Convenience for one user and one capability. */
export async function userCan(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  entitlement: Entitlement,
): Promise<boolean> {
  const map = await capabilitiesForUsers(db, [userId]);
  return map.get(userId)?.has(entitlement) ?? false;
}
