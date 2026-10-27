import { flattenRole, type Entitlement, type RoleDefinition } from "@repo/permissions";

/**
 * WHICH PERSPECTIVES MAY THIS PERSON LOOK THROUGH?
 *
 * A perspective lets someone see the app as a person with less access does —
 * the downgrade IS the feature, and it is how an operator checks what their
 * own people actually see.
 *
 * THE RULE: you are offered a perspective only if you hold its role, or hold
 * a role that INHERITS it. Walking UP the inheritance chain is the whole
 * mechanism — Super inherits Admin inherits Worker inherits Trainee, so
 * holding Super offers all four, and holding only Trainee offers Trainee.
 *
 * That single rule is also the security property. Every perspective on the list is,
 * by construction, a SUBSET of what the person already holds, so there is no
 * value of the perspective header that can grant anything. It is why an
 * unpaid observer is never offered someone with `schedule.manage` perspective, and why no separate
 * "may they?" check is needed at the point of switching.
 *
 * Shared by the auth read (which builds the principal) and `/me` (which
 * renders the dropdown) so the two can never disagree about what is on offer.
 */
export type AvailablePerspective = {
  roleId: string;
  key: string | null;
  name: string;
  /** A `PERSPECTIVE_ICONS` key, or null for none. */
  icon: string | null;
  order: number;
  entitlements: Entitlement[];
};

type PerspectiveRole = RoleDefinition & {
  isPerspective: boolean;
  perspectiveOrder: number | null;
  /** REQUIRED, not optional. It was optional for one commit and the two
   *  callers that build this map both forgot to copy it — the column was
   *  selected, dropped in the mapping, and every perspective came back
   *  with no icon while the type checker said nothing. */
  perspectiveIcon: string | null;
};

export function availablePerspectives(
  heldRoleIds: Iterable<string>,
  byId: ReadonlyMap<string, PerspectiveRole>,
): AvailablePerspective[] {
  // Every role reachable by walking up from something they hold.
  const reachable = new Set<string>();
  for (const start of heldRoleIds) {
    let cur: string | null | undefined = start;
    const seen = new Set<string>();
    // `seen` guards a cycle. flattenRole throws on one; here we simply stop,
    // because a broken pointer must not take the whole dropdown down with it.
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      reachable.add(cur);
      cur = byId.get(cur)?.inheritsFromId ?? null;
    }
  }

  return [...byId.values()]
    .filter((r) => r.isPerspective && reachable.has(r.id))
    .sort((a, b) => (a.perspectiveOrder ?? 0) - (b.perspectiveOrder ?? 0))
    .map((r) => ({
      roleId: r.id,
      key: r.key ?? null,
      name: r.name,
      icon: r.perspectiveIcon ?? null,
      order: r.perspectiveOrder ?? 0,
      entitlements: flattenRole(r.id, byId),
    }));
}
