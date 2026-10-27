import type { Entitlement, Principal } from "@repo/permissions";
import { can } from "@repo/permissions";

/**
 * Does the CALLER hold this capability?
 *
 * For in-handler decisions, not route guards. A guard answers "may this
 * request run at all"; this answers "how much of it applies to me" — whether
 * to escape an ownership filter, show another person's figures, or act on
 * somebody else's behalf.
 *
 * WHY IT IS ONE HELPER AND NOT FORTY INLINE CHECKS
 * Forty-odd handlers each computed their own answer by hand. Three problems,
 * in increasing order of severity:
 *
 *   1. They asked about a ROLE. Roles do not authorize anything, so each of
 *      them read `undefined` off a relation that no longer exists
 *      and quietly evaluated false — every admin silently demoted to seeing
 *      only their own work, with no error anywhere.
 *   2. It is one question standing in for many. "Is someone with `schedule.manage`" meant
 *      "may see the whole schedule" in one handler and "may see another
 *      person's pay" in the next. Collapsing those loses the distinction the
 *      entitlement model exists to express, and it is why an operator could
 *      not delegate one without the other.
 *   3. Several fetched the user AGAIN to get `roles`, which is the
 *      bug that has shipped three times here: a fresh read by id bypasses
 *      the active perspective and hands someone their real powers back. This
 *      reads `req.principal`, resolved once by the rbac plugin, which already
 *      has suspension filtered, inheritance flattened and the perspective
 *      applied.
 *
 * FAILS CLOSED. No principal means no capability — a route reachable without
 * the rbac plugin having run gets the narrow answer, not the wide one.
 */
export function callerCan(req: unknown, entitlement: Entitlement): boolean {
  const principal = (req as { principal?: Principal }).principal;
  if (!principal) return false;
  return can(principal, entitlement);
}

/**
 * THE CALLER'S CAPABILITY TEST, AS A VALUE A SERVICE CAN HOLD.
 *
 * WHY THIS EXISTS
 * `callerCan(req, …)` needs a request. Services do not have one: they take
 * `currentUserId: string`. So when a service needed to know what the CALLER
 * may do — "is this person allowed to unclaim somebody else's visit?" — the
 * only tool available was `userCan(db, currentUserId, …)`, a fresh read by
 * id. That is the forbidden one: it returns the person's REAL grants and
 * ignores any active perspective, so someone with `settings.manage` looking through the Trainee
 * perspective kept every power they were pretending not to have.
 *
 * Thirteen call sites had taken that route, in jobs, supplies, equipment,
 * invoiceCharges and payroll. None of them was careless — the principal
 * simply could not reach them. This is the missing channel: the route
 * resolves the test once, from the already-narrowed principal, and hands it
 * down as an ordinary argument.
 *
 * It is a FUNCTION, not a capability set, so a service cannot accidentally
 * widen it: there is nothing to spread, merge or re-read.
 */
export type CallerCan = (entitlement: Entitlement) => boolean;

/** Bind the caller's test to a request. Call once, at the route boundary. */
export function callerCanFn(req: unknown): CallerCan {
  return (entitlement) => callerCan(req, entitlement);
}

/**
 * For callers that are NOT a person: cron, chain rollover, pay links.
 *
 * Deliberately named rather than `() => true` inline, so a grep finds every
 * place a non-human actor is claiming authority — and deliberately not
 * `() => false`, because these paths must do the work no user is present to
 * authorize. `Principal` has the same `kind: "system"` concept and `can()`
 * returns true for it; this keeps the two consistent.
 */
export const SYSTEM_CALLER_CAN: CallerCan = () => true;
