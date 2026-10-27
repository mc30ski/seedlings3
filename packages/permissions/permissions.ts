/**
 * can() — THE ONLY PLACE A PERMISSION DECISION IS MADE.
 *
 * A PURE FUNCTION. It imports no database client and no cache, and it never
 * will. Two reasons, and the second is the one that bites:
 *
 *   1. Resolution happens ONCE, inside the single auth read, so a request
 *      cannot pay for N lookups.
 *   2. A function that can reach the database is a function someone will hand
 *      a user id. A fresh read by id bypasses the active perspective and
 *      hands someone their real powers back — silently, with every page
 *      rendering normally. That class of bug has shipped three times here.
 *
 * Being pure is also what lets the WEB APP use this same function. The server
 * decides whether a route may run; the browser decides whether to draw the
 * button that calls it. One implementation means those two cannot disagree.
 *
 * WHAT DOES NOT HAPPEN HERE
 *   - Suspension. A suspended role or grant must never reach the principal;
 *     filtering happens where the principal is built.
 *   - Inheritance. A role's entitlements arrive already flattened through its
 *     parents, by `flattenRole` below, called at the same place.
 *   Both keep this a pure set operation.
 */
import type { Entitlement } from "./entitlements";

/**
 * How a person is paid. NOT a permission — a tax and employment fact.
 *
 * RE-EXPORTED from @repo/money, which owns the vocabulary, rather than
 * declared again here. The duplicate declaration compiled perfectly and was
 * structurally identical, so nothing complained — until a component importing
 * `WorkerType` from this package handed the value to one that imported it
 * from money, and the two were no longer interchangeable.
 */
export type { WorkerType } from "@repo/money";
import type { WorkerType } from "@repo/money";

/**
 * A role the person holds, with its entitlements already flattened through
 * inheritance.
 *
 * `areaPath` present means the role is held WITHIN that subtree rather than
 * company-wide.
 */
export type RoleGrant = {
  roleId: string;
  name: string;
  entitlements: readonly Entitlement[];
  /** Materialized path of area IDS, delimited and terminated: "/ck3/ck7/". */
  areaPath?: string;
};

/**
 * Everything a permission decision may depend on, resolved once per request.
 *
 * `kind: "system"` is the named non-human caller — cron, pay links, display
 * tokens, chain rollover. Deliberately not `null`: a blank actor in the audit
 * log is indistinguishable from a bug.
 */
export type Principal =
  | { kind: "system"; name: string }
  | {
      kind: "user";
      /**
       * NULL MEANS NOTHING RESOLVES. Being in the system is not being cleared
       * to act in it: until someone decides how this person is paid, they
       * hold no entitlements however many roles are attached. This is the
       * gate, and it is checked before anything else.
       */
      workerType: WorkerType | null;
      /** Live roles only — suspended ones are filtered out upstream. */
      roles: readonly RoleGrant[];
      /**
       * The perspective being viewed through, if any.
       *
       * A perspective is a named SUBSET of what this person holds, chosen so
       * they can see the app as someone with less access would. It can only
       * ever narrow. `null` means "show me everything I hold".
       */
      perspective?: { roleId: string; entitlements: readonly Entitlement[] } | null;
      /**
       * The area the viewer has CHOSEN to look at, as a materialized path.
       *
       * A LENS, NOT A GRANT, and the distinction is the whole safety story:
       * grants decide what you are ALLOWED to see and only ever widen; the
       * lens decides what you are CURRENTLY LOOKING AT and only ever
       * narrows. It is intersected with the granted subtrees in
       * `visibleAreaPaths`, so a lens pointing somewhere the grants do not
       * reach yields NOTHING — never that territory's rows.
       *
       * Deliberately NOT consulted by `can()`. A lens must never turn into a
       * 403: someone looking at Durham who opens a Chapel Hill visit by its
       * link can still act on it. Only list/report QUERIES narrow.
       */
      lensPath?: string | null;
    };

/**
 * Entitlements that are NEVER narrowed by area.
 *
 * Exported because areaScope must honour the same set. A second hand-written
 * copy there would mean adding a field capability to one file and not the
 * other, and the resulting bug — "I can claim it but the card is not on my
 * list" — looks like a data problem, not a permissions one.
 *
 * Visibility is scoped; capability is not. Someone promoted to look after
 * Raleigh must still pick up a job in Durham, because people cover for each
 * other. Narrowing these would mean promotion shrinks where you can work.
 */
export const NEVER_AREA_SCOPED: ReadonlySet<Entitlement> = new Set<Entitlement>([
  "work.claim",
  "work.complete",
]);

export type CanOptions = {
  /** The area this request concerns, as a materialized path. A grant on an
   *  ANCESTOR covers it: holding Triangle covers Raleigh beneath it. */
  areaPath?: string;
};

/**
 * Does this principal hold this capability?
 *
 * UNION, NEVER INTERSECTION. Authority is every role's entitlements added
 * together. An area assignment can only ever add places you can see; it can
 * never cage someone who holds something company-wide.
 */
export function can(
  principal: Principal,
  capability: Entitlement,
  options: CanOptions = {},
): boolean {
  if (principal.kind === "system") return true;

  // ── THE PAYROLL GATE, BEFORE ANYTHING ELSE ───────────────────────────
  //
  // Being in the system is not being cleared to act in it. A null
  // `workerType` resolves to NOTHING, whatever roles are granted.
  //
  // THIS IS ALSO WHAT KEEPS CUSTOMERS OUT OF THE STAFF APP. A client
  // contact's login is an ordinary `User` row with no worker type, so it
  // lands here and leaves with the empty set. There is no "client" kind of
  // capability and no client branch anywhere in authorization — a customer
  // is simply someone this line stops. Their portal is gated on
  // `isClientContact` (an ACTIVE ClientContact for their Clerk id), which
  // never consults roles.
  //
  // A customer who also works for you is a real case and it works: give
  // them a worker type and grant them roles, and they pass this gate like
  // anyone else. What must never happen is the reverse order — a grant
  // landing on a customer who has no worker type yet. It looks harmless,
  // because this line makes it resolve to nothing today, but it is DORMANT
  // rather than void: set a worker type on that account later and every
  // grant on it activates at once, with nothing in between. The database
  // refuses that state outright (migration
  // 20261020140000_client_grants_require_a_worker_type), so the two halves
  // cannot be assembled by accident.
  //
  // G31 asserts this check stays BEFORE the role walk below. A gate placed
  // after it can be skipped by a lucky early return.
  if (principal.workerType === null) return false;

  // A perspective replaces the held set with its own subset. The subset
  // property is enforced where the perspective is built, not here — if it
  // were violated, a "downgrade" could grant, which is the one thing it must
  // never do.
  if (principal.perspective) {
    const within = principal.perspective.entitlements.includes(capability);
    if (!within) return false;
  }

  const roles = principal.roles;
  const ignoreArea = !options.areaPath || NEVER_AREA_SCOPED.has(capability);

  for (const role of roles) {
    if (!role.entitlements.includes(capability)) continue;
    // Held company-wide: nothing to narrow.
    if (!role.areaPath) return true;
    if (ignoreArea) return true;
    if (coversArea(role.areaPath, options.areaPath!)) return true;
  }
  return false;
}

/**
 * Does a grant on `grantPath` cover `targetPath`?
 *
 * True when the target IS the granted area or sits beneath it. Both paths are
 * id segments delimited and terminated by "/", which is what makes this a
 * plain prefix test: "/a/b/" is a prefix of "/a/b/c/" but NOT of "/a/bb/",
 * because the trailing delimiter forces a segment boundary. Dropping that
 * delimiter is the classic bug here.
 */
export function coversArea(grantPath: string, targetPath: string): boolean {
  if (!grantPath.endsWith("/") || !targetPath.endsWith("/")) {
    throw new Error(
      `Area paths must be delimited and terminated with "/": ` +
        `got grant=${JSON.stringify(grantPath)} target=${JSON.stringify(targetPath)}. ` +
        `Without the trailing delimiter a prefix test matches sibling areas ` +
        `whose id merely starts with the same characters.`,
    );
  }
  return targetPath === grantPath || targetPath.startsWith(grantPath);
}

/**
 * Every capability this principal holds, ignoring area.
 *
 * For the "your access" surface and the provenance view. NOT for gating — a
 * gate asks about one capability and may carry an area, and answering through
 * this would silently drop it.
 */
export function heldCapabilities(principal: Principal): Entitlement[] {
  if (principal.kind === "system") return [];
  if (principal.workerType === null) return [];
  const out = new Set<Entitlement>();
  for (const role of principal.roles) {
    for (const e of role.entitlements) out.add(e);
  }
  if (principal.perspective) {
    const within = new Set(principal.perspective.entitlements);
    return [...out].filter((e) => within.has(e)).sort();
  }
  return [...out].sort();
}

/** A role as stored, before inheritance is resolved. */
export type RoleDefinition = {
  id: string;
  name: string;
  /** Immutable identifier for roles a starter script owns. User-created
   *  roles have none. Rebuilding by key preserves ids, and therefore every
   *  assignment pointing at them. */
  key?: string | null;
  inheritsFromId?: string | null;
  entitlements: readonly Entitlement[];
};

/**
 * Resolve a role's full entitlement set through its inheritance chain.
 *
 * Inheritance is the point: adding a capability to a base role must reach
 * everything built on it, or an operator maintains duplicated sets by hand
 * and they drift. The cost is that editing a base changes its descendants,
 * which is why the UI must show that impact before saving.
 *
 * Throws on a cycle rather than looping. A cycle is a data error someone
 * introduced; resolving it to a partial set would grant a silently wrong
 * answer forever.
 */
export function flattenRole(
  roleId: string,
  byId: ReadonlyMap<string, RoleDefinition>,
): Entitlement[] {
  const out = new Set<Entitlement>();
  const seen = new Set<string>();
  let current: string | null | undefined = roleId;

  while (current) {
    if (seen.has(current)) {
      throw new Error(
        `Role inheritance cycle at ${current}: ${[...seen, current].join(" -> ")}. ` +
          `A cycle cannot be resolved to a correct set, and resolving it to a ` +
          `partial one would grant the wrong answer silently.`,
      );
    }
    seen.add(current);
    const role = byId.get(current);
    if (!role) break;
    for (const e of role.entitlements) out.add(e);
    current = role.inheritsFromId;
  }
  return [...out].sort();
}

/**
 * Is `candidate` a usable perspective for this principal?
 *
 * A perspective may only ever NARROW. If it would grant something the person
 * does not hold, it is not a downgrade and must be refused — the entire value
 * of the dropdown is that looking at the app as someone with less access is
 * safe.
 */
export function isValidPerspective(
  principal: Principal,
  candidate: readonly Entitlement[],
): boolean {
  if (principal.kind === "system") return false;
  const held = new Set(heldCapabilities({ ...principal, perspective: null }));
  return candidate.every((e) => held.has(e));
}
