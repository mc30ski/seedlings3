// ─────────────────────────────────────────────────────────────────────────────
// Area scoping — narrowing WHAT YOU SEE, never what you may do.
//
// PURPOSE
// A person assigned "District Manager" in Raleigh sees Raleigh's work and
// Raleigh's money. Someone with the same capability globally sees everything.
// This module turns that into a Prisma `where` fragment.
//
// MODELLED ON businessStartCutoff, deliberately — same shape, same
// invariants, same threading. That filter is already woven through 19 files
// with a build gate catching unfiltered queries, and it works. Copying a
// proven pattern beats inventing a second one.
//
// SAFETY INVARIANTS (do not violate when extending this module)
//   1. GLOBAL AUTHORITY MEANS NO FILTER. If the principal holds the
//      capability globally — from a base role bundle or a global custom role
//      — every helper returns an EMPTY object so the query is byte-identical
//      to its pre-feature shape. Off-state must always === pre-feature
//      behaviour. An area assignment is a FILTER, never a CAGE: it can only
//      ever add places you can see, never subtract.
//
//      THE ONE EXCEPTION IS A LENS THE VIEWER CHOSE THEMSELVES
//      (`principal.lensPath`). "Show me only Durham" is a request, not a
//      restriction, so it narrows even a global reader — that is what the
//      viewer asked for. It is intersected with the granted subtrees, so it
//      can only ever subtract; it can never reach a territory the grants do
//      not already cover. Absent a lens this invariant holds unchanged, so
//      the off-state is still byte-identical to pre-feature.
//   2. ANY FAILURE PATH RETURNS NO FILTER. A missing principal, an
//      unresolvable path, an empty grant list for someone who holds the
//      capability globally — all mean "do not narrow". Accidentally hiding a
//      territory's money looks identical to that territory earning nothing,
//      which is the silent failure this whole design is trying to avoid.
//   3. CAPABILITY IS NOT SCOPED, ONLY VISIBILITY. `work.claim` and
//      `work.complete` are never narrowed (G11): a worker promoted to look
//      after Raleigh must still be able to pick up a job in Durham, because
//      people cover for each other. Those live in NEVER_AREA_SCOPED in
//      @repo/permissions, and `can()` already ignores area for them — this
//      module must never re-introduce a restriction can() declined to make.
//
//      A chosen LENS does still narrow the LIST for these, because a viewer
//      asking to look at Durham means the list too. That is safe precisely
//      because it is only a `where` fragment: `can()` never reads the lens,
//      so reaching that Chapel Hill visit by its link still works. The rule
//      is "a lens may hide a row, and may never refuse an action".
//   4. RETIRED AREAS STAY IN REPORTING. Retirement hides an area from
//      PICKERS, not from history (G13). Nothing here filters on retiredAt.
//
// WHEN ADDING A NEW AREA-SCOPABLE MODEL
//   - If it has its own `areaId`, use `areaWhere()`.
//   - If it reaches an area through a relation, use `areaWhereVia()`.
//   - Add the route to the scope integration test (G25), which drives EVERY
//     scopable route as a Raleigh-only principal and asserts no Durham row
//     comes back. A static gate cannot catch `areaScope(wrongUser)` or a
//     subtly wrong prefix; only output can.
// ─────────────────────────────────────────────────────────────────────────────

import {
  can,
  NEVER_AREA_SCOPED,
  type Entitlement,
  type Principal,
} from "@repo/permissions";

/** An empty `where` fragment: the query is unchanged. */
const NO_FILTER = {} as const;

/**
 * The area subtrees this principal may see for this capability, or `null`
 * meaning "no restriction".
 *
 * `null` and `[]` are NOT the same thing and must never be conflated:
 *   null → global authority, see everything
 *   []   → holds the capability nowhere, see nothing
 */
export function visibleAreaPaths(
  principal: Principal | undefined,
  capability: Entitlement,
): string[] | null {
  // Invariant 2: no principal means no narrowing. A route that should not
  // have answered at all is the guard's problem, not the filter's.
  if (!principal) return null;

  // The SYSTEM principal (cron, pay links, display tokens, chain rollover)
  // bypasses entitlements and is not territorial.
  if (principal.kind === "system") return null;

  // Not on payroll — nothing resolves, so there is nothing to scope. The
  // guard will already have refused; returning [] keeps it refused if not.
  if (principal.workerType === null) return [];

  // Invariant 3, and it has to be checked HERE rather than inferred from
  // can(). can() is asked without an areaPath below, so it answers "yes, held
  // somewhere" for a field capability held only inside one area — and the
  // area-grant walk after it would then narrow exactly the thing that must
  // never be narrowed. A worker assigned to Raleigh would stop seeing the
  // Durham visit they are still allowed to claim.
  if (NEVER_AREA_SCOPED.has(capability)) {
    return applyLens(can(principal, capability) ? null : [], principal.lensPath);
  }

  if (!can(principal, capability)) return [];

  // Invariant 1: held company-wide by ANY role means no narrowing. A role
  // without an areaPath is global, and an area assignment can only ever add
  // places you can see — never cage someone who already holds it everywhere.
  const global = principal.roles.some(
    (r) => !r.areaPath && r.entitlements.includes(capability),
  );
  if (global) return applyLens(null, principal.lensPath);

  return applyLens(
    principal.roles
      .filter((r) => r.areaPath && r.entitlements.includes(capability))
      .map((r) => r.areaPath!),
    principal.lensPath,
  );
}

/**
 * Intersect the subtrees someone is GRANTED with the one they have CHOSEN
 * to look at.
 *
 * Grants widen, the lens narrows, and this is the only place the two meet.
 * The intersection of two subtrees of a tree is one of them or nothing:
 *
 *   lens inside grant  → the lens  (a global reader asking for Durham)
 *   grant inside lens  → the grant (a Durham lead asking for the region)
 *   neither contains the other → EMPTY, and that is the correct answer
 *
 * That last line is the security property. A Durham-only lead who sends a
 * Chapel Hill lens gets nothing back, never Chapel Hill's rows — so the
 * header cannot be used to reach a territory the grants do not cover, and
 * no validation of the header's value is load-bearing.
 *
 * `null` in means global authority; `null` out means still unfiltered,
 * which is what no lens must produce so the off-state stays byte-identical
 * to pre-feature behaviour.
 */
function applyLens(granted: string[] | null, lensPath: string | null | undefined): string[] | null {
  if (!lensPath) return granted;
  if (granted === null) return [lensPath];
  const out: string[] = [];
  for (const g of granted) {
    if (lensPath.startsWith(g)) out.push(lensPath);
    else if (g.startsWith(lensPath)) out.push(g);
  }
  return out;
}

/**
 * `where` fragment for a model carrying its own `areaId`.
 *
 * Subtree membership is a PREFIX test on the materialized path, which is why
 * both the stored path and the grant path are delimited and terminated:
 * "/a/b/" prefixes "/a/b/c/" but not "/a/bb/". Without the trailing
 * delimiter a grant leaks into any sibling whose id starts the same way.
 */
export function areaWhere(
  principal: Principal | undefined,
  capability: Entitlement,
): Record<string, unknown> {
  const paths = visibleAreaPaths(principal, capability);
  if (paths === null) return NO_FILTER;
  if (paths.length === 0) {
    // Holds it nowhere. An impossible condition rather than a silent
    // unfiltered read — the guard should already have refused this request.
    return { areaId: { in: [] as string[] } };
  }
  return {
    area: { OR: paths.map((p) => ({ path: { startsWith: p } })) },
  };
}

/**
 * Same, for a model that reaches its area through a relation.
 *
 * `relation` is the path to the area-carrying model, e.g. "job" when
 * filtering something hanging off JobOccurrence.
 */
export function areaWhereVia(
  principal: Principal | undefined,
  capability: Entitlement,
  relation: string,
): Record<string, unknown> {
  const inner = areaWhere(principal, capability);
  if (Object.keys(inner).length === 0) return NO_FILTER;
  return { [relation]: inner };
}

/** True when this principal's view of this capability is territorially
 *  limited. For deciding whether to SHOW an area filter, never for gating. */
export function isAreaLimited(
  principal: Principal | undefined,
  capability: Entitlement,
): boolean {
  return visibleAreaPaths(principal, capability) !== null;
}

/**
 * Merge an area filter into a `where` without colliding with what is there.
 *
 * Always via `AND`. Spreading the fragment in at the top level looks tidier
 * and silently loses one of the two whenever a caller already uses the same
 * key — and both `areaWhere` shapes (`area` and `areaId`) are keys a query
 * may well already use. `AND` composes under every shape.
 *
 * An empty fragment (global authority) returns the `where` untouched, so a
 * threaded callsite costs a global reader nothing.
 */
export function withArea<T extends Record<string, any>>(
  where: T,
  fragment: Record<string, unknown>,
): T {
  if (!fragment || Object.keys(fragment).length === 0) return where;
  const existing = (where as any).AND;
  const and = Array.isArray(existing) ? existing : existing ? [existing] : [];
  return { ...where, AND: [...and, fragment] } as T;
}

/**
 * `where` fragment for a model whose area relation is NOT called `area`.
 *
 * `Job` reaches territory through `defaultArea`, not `area`, so neither
 * `areaWhere` (which assumes `area`/`areaId`) nor `areaWhereVia` (which
 * would nest `{ defaultArea: { area: … } }`) fits. Rather than hand-rolling
 * the prefix test at that callsite — where getting the trailing delimiter
 * wrong silently leaks a sibling subtree — the rule lives here once.
 */
export function areaWhereOn(
  principal: Principal | undefined,
  capability: Entitlement,
  areaRelation: string,
): Record<string, unknown> {
  const paths = visibleAreaPaths(principal, capability);
  if (paths === null) return NO_FILTER;
  if (paths.length === 0) return { [areaRelation]: { id: { in: [] as string[] } } };
  return { [areaRelation]: { OR: paths.map((p) => ({ path: { startsWith: p } })) } };
}
