/**
 * Resolve a route's guard identifier to the CAPABILITY it requires.
 *
 * WHY THIS EXISTS
 * Several build gates assert policy by reading the guard off a route
 * registration — "every payroll mutation is gated", "only the books role can
 * write the Ledger", "photo visibility is not an everyday change". That
 * worked while every file declared its own role-named guards and the gate
 * could string-compare the name.
 *
 * IT RESOLVES A GUARD TO ITS ENTITLEMENT, and nothing else. That is both
 * the only thing there is to resolve and the better question. "This route requires `payroll.manage`" is a
 * sharper claim than "someone with `settings.manage` can reach it", and it stays true when an
 * operator grants `payroll.manage` to a bookkeeper without making them a
 * Super — which is the entire point of the model. A gate phrased in roles
 * would have had to be deleted or relaxed the first time somebody did that.
 *
 * Returns null when the identifier cannot be resolved, and callers must treat
 * null as a FAILURE rather than a pass: an unresolvable guard is exactly the
 * case where nobody knows what a route requires.
 */

/** The capability a guard identifier requires, or null if unresolvable. */
export function guardEntitlement(src: string, identifier: string): string | null {
  // The shared factory: `const x = requires("some.entitlement");`
  const viaRequires = new RegExp(
    `\\bconst\\s+${escape(identifier)}\\s*=\\s*requires\\(\\s*"([^"]+)"\\s*\\)`,
  ).exec(src);
  if (viaRequires) return viaRequires[1];

  // Inline at the call site: `app.get("/x", requires("some.entitlement"), ...)`.
  const inline = new RegExp(`requires\\(\\s*"([^"]+)"\\s*\\)`).exec(identifier);
  if (inline) return inline[1];

  return null;
}

/** True when the guard requires exactly this capability. */
export const guardRequires = (src: string, id: string, entitlement: string) =>
  guardEntitlement(src, id) === entitlement;

/** True when the guard requires any one of these capabilities. */
export const guardRequiresAny = (src: string, id: string, entitlements: readonly string[]) => {
  const e = guardEntitlement(src, id);
  return e !== null && entitlements.includes(e);
};

/**
 * True when a route is OWNERSHIP-gated: approved caller, no capability, the
 * handler scopes its own query to them. Distinct from "unresolvable" — this
 * is a deliberate answer, not a missing one.
 */
export const isOwnershipGated = (_src: string, id: string) => id === "approvedUser";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
