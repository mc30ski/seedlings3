/**
 * THE CUSTOMER / STAFF BOUNDARY, IN ONE PLACE.
 *
 * A customer's login is an ordinary `User` row. Nothing about the row says
 * "customer" except this: they have no `workerType`, and there is an ACTIVE
 * `ClientContact` carrying their Clerk id. That is the payroll gate, the
 * same question `can()` asks before it walks anybody's roles, and it is the
 * only honest test.
 *
 * WHAT THIS REPLACES, AND WHY IT MATTERS
 * `UsersTab` decided it by ROLE ABSENCE:
 *
 *     const isClientUser = (u) => u.isApproved && !holdsAnyRole(u);
 *
 * which reads as "if they hold nothing, they must be a customer". A new hire
 * holds nothing on their first day. They were therefore filed under Clients,
 * and the tab hides the role-granting controls for a client — so the one
 * screen that grants a first role refused to grant it to exactly the people
 * who needed one. Four accounts in production sat in that state.
 *
 * The inverse matters too: A CUSTOMER MAY ALSO WORK FOR YOU. Give them a
 * worker type and they are staff here, customer badge and all. The rule is
 * not "customers hold no roles" and must never be written as one.
 *
 * Why `roleGrants` is NOT part of the test: a grant on a login with no
 * worker type is the dormant state the database refuses outright (migration
 * `20261020140000`, G45), so "customer contact who somehow holds a role"
 * cannot exist. Testing for it would only add a branch nobody can reach.
 */

export type PersonLike = {
  /** EMPLOYEE / CONTRACTOR / UNPAID, or null for someone not on payroll. */
  workerType?: string | null;
  /** An ACTIVE ClientContact for this login's Clerk id — from GET /users. */
  isClientContact?: boolean | null;
};

/**
 * A login that belongs to a customer and to nobody else — no worker type,
 * so the staff app is closed to them and their portal is gated on being a
 * contact, which never consults roles.
 */
export function isCustomerOnly(u: PersonLike): boolean {
  return !!u.isClientContact && !u.workerType;
}
