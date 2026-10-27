"use client";

// Capability helpers for components that were handed `me` but never a
// `scope` prop.
//
// This file used to answer "which SURFACE is this person shown, given the
// tab they are viewing (`purpose`)". Both that question and `purpose` are
// gone: there is one tab per feature, `TAB_REQUIREMENTS` decides which
// tabs exist, and `scope.can(capability)` decides what is on them. What
// is left here is `holds()` and `scopeFromMe()`.

import { can, isEntitlement, type Entitlement } from "@repo/permissions";
import type { Scope } from "@/src/lib/scope";
import type { Me } from "@/src/lib/types";

// THE THREE SURFACE FLAGS ARE GONE.
//
// Three booleans used to map staff onto `schedule.view`,
// `schedule.manage` and `settings.manage`, and a helper handed them out.
// The intent was narrow — "which layout am I rendering" —
// but nothing held it there: the flags were read ~500 times to decide
// whether a control should EXIST, which is a different question, and the
// only one `scope.can(capability)` can answer honestly. A bookkeeper holds
// none of the three, so every one of those reads sorted them into the
// nearest bucket and showed them a field worker's screen.
//
// There is one staff tab list now and `TAB_REQUIREMENTS` decides what is on
// it, so no caller needs a layout flag either.
/** Does this person hold the capability, per the set `/api/me` resolved? */
export const holds = (me: Me | null | undefined, capability: Entitlement) =>
  !!me?.capabilities?.includes(capability);

/**
 * @deprecated There are no roles to ask about. Kept only so a stale import
 * fails loudly at the callsite rather than silently returning false, which
 * is how someone with `schedule.manage` would quietly lose their whole surface.
 */
export const hasRole = (_roles: unknown, _role: string): never => {
  throw new Error(
    "hasRole() is gone — the Role enum no longer exists. Ask `holds(me, capability)` " +
      "for a surface flag, or `scope.can(capability)` for an authorization decision.",
  );
};

/**
 * A `Scope`-shaped answer built from `me`, for components that were given
 * `me` but never a `scope` prop.
 *
 * Exists so help copy and buttons in those components can ask a CAPABILITY
 * question without threading a new prop through every call site. The `can`
 * it returns is the same `can()` the route guard runs, over the capability
 * set `/api/me` resolved — so it cannot disagree with a 403.
 *
 * Takes no `purpose`. It used to narrow the flags by which shell was
 * rendering, which is the duplicate-tab bug in miniature — the same person
 * got a different answer about what they could do depending on how they
 * navigated there.
 */
export function scopeFromMe(me: Me | null | undefined): Scope {
  const caps = (me?.capabilities ?? []).filter(isEntitlement);
  return {
    can: (capability: Entitlement) =>
      can(
        {
          kind: "user",
          // The server already applied the payroll gate and any active
          // perspective, so this asks about the set it was GIVEN rather
          // than re-deriving one — re-deriving is what lets them disagree.
          workerType: me?.workerType ?? null,
          roles: [{ roleId: "__me__", name: "me", entitlements: caps }],
          perspective: null,
        },
        capability,
      ),
  };
}
