import type { Entitlement } from "@repo/permissions";

/**
 * THE ONE Scope TYPE.
 *
 * `scope` is what a tab is told about the signed-in person. Capabilities are
 * ADDITIVE as you climb: someone with `settings.manage` is also someone with `schedule.manage` and also a worker, so a tab
 * reads the flag for the surface it is about to render rather than switching
 * on a single "role".
 *
 * WHY THIS FILE EXISTS
 * Seventeen files each declared this shape inline:
 *
 *     scope?: { …three role booleans… };
 *
 * TypeScript matches structurally, so seventeen identical literals are
 * seventeen interchangeable types — harmless while the shape never changes.
 * The permissions work changes it (a `can` function, later `portfolios`), and that
 * is where it bites: add a field here and the files still on the old literal
 * KEEP COMPILING. There is no error and nothing in the diff to notice,
 * because a tab accepting three fields is valid code. It silently keeps its
 * old authorisation logic while everything around it moved on.
 *
 * One exported type means adding a field is one edit and the compiler names
 * every file that has to follow. `permissions-build-gate` G1 fails the build
 * if the shape is declared inline again.
 *
 * FAIL CLOSED. Where `scope` is optional, a missing one must grant nothing:
 * `scope?.can("x") === true`, or a `{ can: () => false }` default. Never a
 * default object that answers yes. G2 covers the defaults.
 */
export type Scope = {
  /**
   * Does the signed-in person hold this capability?
   *
   * THE ONLY FIELD. This type carried three role booleans alongside it,
   * standing for `schedule.view`,
   * `schedule.manage` and `settings.manage`. They were the last place the
   * three deleted roles survived: every tab read them, so every tab sorted
   * people into three buckets and a custom role got whichever bucket it
   * fell nearest. A bookkeeper was handed a field worker's Payments screen
   * that way.
   *
   * Asking for the capability a control actually needs is the whole model.
   * `money.view` is a different question from `settings.manage`, and the
   * three flags could not tell them apart.
   *
   * Uses the SAME `can()` the server's route guard uses, from
   * `@repo/permissions`, against the capabilities `/api/me` resolved — which
   * are narrowed by any active perspective, so a perspective narrows every tab's
   * contents and not just the tab list.
   */
  can: (capability: Entitlement) => boolean;
};


/**
 * Is this person cleared to do field work — claim a visit, start or complete
 * one, pull inventory?
 *
 * WHY THIS IS NOT A WORKER-TYPE COMPARISON, which is what every callsite
 * used to ask. Clearance was once a value of the worker-type enum — a
 * payroll fact standing in for a permission. People holding it were paid
 * exactly like employees, so the value carried no tax meaning of its own;
 * it existed only to withhold field access. That made "how is this person paid" and "what may they do" the same
 * field, and neither could change without the other.
 *
 * Clearance is now a CAPABILITY — `work.claim` — resolved by the server from
 * the person's roles, and a trainee is simply an EMPLOYEE who holds the
 * Trainee role rather than Worker. (`resolvePrivileges` and the
 * `canPullInventory` column are both deleted; the `privileges` field on the
 * `/api/me` payload keeps the old NAME as its wire contract while carrying
 * the capability's value.) Reading it here from the SAME resolved value the
 * server used is what stops the two from disagreeing.
 *
 * This line said `inventory.pull` while the code below read `work.claim` —
 * a doc comment contradicting its own function, which is how the same
 * mistake got copied into three call sites.
 *
 * FAILS CLOSED: no `me`, or no privileges block, means not cleared.
 */
export function isFieldCleared(
  me: { capabilities?: string[] | null } | null | undefined,
): boolean {
  // `work.claim`, NOT `inventory.pull`.
  //
  // This read `privileges.canPullInventory` — a different capability
  // entirely — and got away with it because the starter Field Clearance
  // role grants claim, complete and pull together, so the two always
  // travelled as one. Adding a grantable "May pull inventory" role broke
  // that coupling on purpose: it exists for the office person who fetches
  // supplies and never runs a visit. They would have been shown the claim
  // control, and `POST /occurrences/:id/claim` would have refused them.
  //
  // Clearance to do FIELD WORK is the authority to pick work up, so that
  // is what it asks.
  return !!me?.capabilities?.includes("work.claim");
}
