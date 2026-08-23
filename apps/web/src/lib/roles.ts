"use client";

// Role resolution — what a signed-in user is allowed to see, given the
// tab they're viewing (`purpose`) and the roles on their account.
//
// Split out of the old `lib.ts`. The additive-scope tab pattern leans on
// `determineRoles`, so it earns a file that says so.

import type { Me, Role } from "@/src/lib/types";

export const hasRole = (roles: Me["roles"] | undefined, role: Role) =>
  !!roles?.includes(role);

export function determineRoles(me: Me | null, purpose: Role) {
  const isWorker = hasRole(me?.roles, "WORKER");
  const isAdmin = hasRole(me?.roles, "ADMIN");
  const isSuper = hasRole(me?.roles, "SUPER");
  return {
    isWorker: isWorker,
    isAdmin: isAdmin,
    isSuper: isSuper,
    isAvail: isAdmin || isWorker,
    // Admin-flavored views — true on either the Admin shell OR the Super
    // shell, since Super always inherits Admin capabilities and the Super
    // tabs lean on the same admin-mode rendering. Tabs that want to
    // further distinguish "Super inner tab" from "Admin inner tab" should
    // gate on `purpose === "SUPER"` directly (e.g. EquipmentTab uses this
    // to expose the act-on-behalf-of-worker buttons in addition to the
    // admin controls).
    forAdmin: (purpose === "ADMIN" && isAdmin) || (purpose === "SUPER" && (isSuper || isAdmin)),
  };
}
