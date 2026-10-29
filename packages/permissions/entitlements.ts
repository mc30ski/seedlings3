/**
 * THE ENTITLEMENTS — the source of truth.
 *
 * No count in this sentence, deliberately: it said 45 while there were 60,
 * because a number in prose is a second source of truth that nothing checks.
 * Count `ENTITLEMENTS` if you need one.
 *
 * An entitlement gates a ROUTE. It is one of three systems that must all
 * agree before a request succeeds, and they are not interchangeable:
 *
 *   1. entitlements gate the route    — "may you call this endpoint at all"
 *   2. ownership gates the record     — "is this your job / your mileage"
 *   3. redaction trims the payload    — "you may read it, not every field"
 *
 * Three verbs, not two. `contribute` exists because view/manage is too coarse
 * for real jobs: someone who annotates visits or uploads job photos would
 * otherwise need `schedule.manage`, which also grants reschedule and
 * reassign. Adding a note should not let you restructure the week.
 *
 * The copy beside each id is what appears next to its checkbox in the role
 * builder. It is lifted verbatim from docs/features/permissions.md and must
 * stay in sync with it — the matrix is GENERATED from this file (G7), never
 * hand-maintained, which is the mistake `PRIV_DEFAULTS` made in UsersTab.
 *
 * `RoleEntitlement.entitlement` is a String column, not a Prisma enum, so
 * adding an entitlement stays a code change rather than a migration. That is
 * only safe because every write goes through `assertEntitlement` below and a
 * reconciliation check runs on every deploy (G28). Without the boundary, a
 * typo is a grant the role builder displays and `can()` denies, with no error
 * anywhere.
 */

export const ENTITLEMENT_GROUPS = [
  {
    group: "Daily work",
    entitlements: [
      { id: "work.claim", copy: "Pick up and release visits — including pausing and resuming" },
      { id: "work.complete", copy: "Start a visit, finish it, and take payment at the door" },
      { id: "inventory.pull", copy: "Take equipment and supplies out for a job" },
      { id: "materials.charge", copy: "Add billable materials to a visit — charged to the client" },
      { id: "expenses.charge", copy: "Charge the company's own purchases to the business" },
    ],
  },
  {
    group: "Scheduling and customers",
    entitlements: [
      { id: "schedule.view", copy: "See the calendar, jobs and visits" },
      { id: "schedule.view-all", copy: "See every visit, not only the ones you are on" },
      { id: "schedule.contribute", copy: "Add notes, photos and guidance to a visit" },
      { id: "schedule.manage", copy: "Create, move and reschedule visits, and assign who does them" },
      { id: "crews.view", copy: "See crews and who is on them" },
      { id: "crews.manage", copy: "Build and change crews" },
      { id: "routes.plan", copy: "Plan and optimise the driving order for a day" },
      { id: "clients.view", copy: "See customers, properties and contacts" },
      { id: "clients.view-all", copy: "See every customer and property, not only the ones you work" },
      { id: "clients.contribute", copy: "Add photos and notes to a property" },
      { id: "clients.manage", copy: "Add and edit customers, properties and contacts" },
      { id: "estimates.create", copy: "Write and send quotes" },
      { id: "estimates.accept", copy: "Accept or reject a quote on the customer's behalf" },
    ],
  },
  {
    group: "Money",
    entitlements: [
      { id: "money.view", copy: "See what was invoiced and collected" },
      { id: "money.approve", copy: "Approve a payment, reverse one, or write it off" },
      { id: "money.record", copy: "Record a payment that came in — a posted cheque, a transfer" },
      { id: "money.adjust", copy: "Rework how a payment splits between the crew" },
      { id: "pricing.view", copy: "See the price list" },
      { id: "pricing.manage", copy: "Change the price list" },
      { id: "books.view", copy: "See business expenses, the P&L and the reconcile period" },
      { id: "books.manage", copy: "Record and reconcile business expenses" },
      { id: "books.export-tax", copy: "Download the tax exports — income, expenses, capital, workdays, payroll" },
      { id: "payroll.view", copy: "See imported payroll and what each person was paid" },
      { id: "payroll.manage", copy: "Import payroll and manage pay periods" },
    ],
  },
  {
    group: "People and time",
    entitlements: [
      { id: "people.view", copy: "See the team and who is working *(portfolio-scopable)*" },
      { id: "people.manage", copy: "Add people, set pay and worker type" },
      // SEPARATE FROM people.manage, which is "add people, set pay and
      // worker type" — the day-to-day of running a team, and someone with `schedule.manage`'s job.
      // Deciding WHETHER SOMEBODY IS IN THE SYSTEM AT ALL is not that: an
      // approval is the moment an account becomes real, and it cannot be
      // undone by editing a field.
      { id: "people.approve", copy: "Admit a pending sign-up, or decline it" },
      { id: "people.grant-roles", copy: "Put a role on a person — never one you do not hold yourself" },
      { id: "time.view", copy: "See other people's hours and mileage *(portfolio-scopable)*" },
      { id: "time.manage", copy: "Create and edit workday and mileage records" },
      { id: "time.approve", copy: "Approve hours and mileage *(portfolio-scopable)*" },
    ],
  },
  {
    group: "Equipment and supplies",
    entitlements: [
      { id: "equipment.view", copy: "See equipment and vehicles" },
      // SPLIT 2026-10-20. One entitlement spanned two authorities: editing
      // the fleet you already own, and deciding what the fleet IS. The old
      // route comment said it plainly — "bringing new equipment onto the
      // books (or wiping it) is a capital-account decision, not an admin
      // day-to-day" — and bundling both here handed an admin 8 routes that
      // had always been the owner's.
      { id: "equipment.manage", copy: "Edit equipment and vehicles, their photos, instructions and collections" },
      { id: "equipment.capital", copy: "Put equipment and vehicles on the books, retire them, and assign a vehicle to a driver" },
      { id: "supplies.view", copy: "See the supply catalogue" },
      { id: "supplies.manage", copy: "Change the supply catalogue" },
      { id: "supplies.hold", copy: "Reserve supplies against a visit" },
    ],
  },
  {
    group: "Company records",
    entitlements: [
      { id: "compliance.view", copy: "See policies and who has signed them" },
      { id: "compliance.manage", copy: "Write policies and manage signatures" },
      // The company milestone feed. It had NO entitlement of its own: the
      // reads sat on `schedule.view`, which the lowest tier holds, and the
      // writes on `schedule.manage`. One of the two timeline reads returned
      // events the other hid, so any approved caller could reach the hidden
      // ones. `timeline.view` is now the gate, and there is one read.
      { id: "timeline.view", copy: "See the company timeline" },
      { id: "timeline.manage", copy: "Add and edit timeline events, and see hidden ones" },
      { id: "documents.view", copy: "See company documents" },
      { id: "documents.manage", copy: "Upload and organise company documents" },
      { id: "audit.view", copy: "See the audit log of who changed what" },
    ],
  },
  {
    group: "Marketing and content",
    entitlements: [
      { id: "marketing.view", copy: "See promotions, public pages, banners and announcements" },
      // SPLIT 2026-10-20, same shape as `equipment.*`. Announcements and
      // banners are day-to-day notices an admin posts; a promotion or a
      // vanity page is a campaign that goes out under the company's name to
      // its customer list, which was the owner's call and is again. 37 of
      // the 48 campaign routes are writes.
      { id: "marketing.manage", copy: "Post banners and announcements" },
      { id: "marketing.campaigns", copy: "Run promotions and public vanity pages" },
      // NOT the approval queue. This copy used to say "See guides awaiting
      // approval and the media library", and that sentence alone was enough to
      // get the queue re-pointed at this entitlement — which education.md
      // reserves for Super and an e2e spec asserts someone with `schedule.manage` is refused.
      // Entitlement copy is read as policy, so it has to describe what the
      // entitlement actually grants.
      { id: "content.view", copy: "See guide drafts and the media library" },
      { id: "content.manage", copy: "Write education guides and upload their images" },
      // SEPARATE FROM content.manage, on purpose. docs/features/education.md:
      // "Holders of `schedule.manage` cannot publish their own work, deliberately. Content stalls
      // when a caller with `settings.manage` is away; that is the accepted cost of the gate." An
      // author who can also approve is not a review step.
      //
      // It also carries the video authority, which the education doc makes
      // Held back for a different reason — video is a storage cost nobody
      // else should be able to commit the business to.
      { id: "content.approve", copy: "Approve, publish, roll back or archive a guide — and add video" },
      { id: "notify.send", copy: "Send push notifications and emails to the team" },
    ],
  },
  {
    group: "Insight",
    entitlements: [
      // SPLIT 2026-10-23. One entitlement covered two audiences: the TEAM
      // rollup an admin needs to run their crew, and the BUSINESS-wide
      // pulse that is the owner's view. Taking the single entitlement off
      // Admin to hide the latter took the former with it, and Admin's Home
      // collapsed to a personal self-view.
      { id: "reports.view", copy: "See the team rollup — your crew's hours, pay and jobs" },
      { id: "reports.business", copy: "See the business-wide Insights rollup — money, jobs, equipment and clients across the company" },
      { id: "forecasts.view", copy: "See and run the forecasting tool" },
    ],
  },
  {
    // Added 2026-10-12. These five were pinned to one fixed role and hard-gated — not
    // entitlements at all — back when SUPER was a magic role. Once it became
    // an ordinary role they needed real names, because nothing may branch on
    // a role NAME (G8). They are the most dangerous capabilities in the
    // system, which is an argument for naming them, not for hiding them.
    group: "Administration",
    entitlements: [
      // SEEING the catalogue is not EDITING it. `roles.define` and
      // `people.grant-roles` are separate on purpose — "an office manager
      // may well need the second without the first" — but listing the roles
      // was gated on `define`, so a grant-only holder could not see what
      // they were allowed to hand out. The picker could not be built.
      { id: "roles.view", copy: "See the roles that exist and what each one grants" },
      { id: "roles.define", copy: "Create roles and choose what they grant" },
      // SPLIT FROM `manage`, 2026-10-25. The Settings tab was gated on
      // `settings.manage`, so "may open the page" and "may change every
      // number on it" were one grant — and SettingsTab has always had the
      // read-only half built, down to an explainer branch that tells a
      // viewer to raise what looks wrong rather than work around it.
      // Nobody could reach it. Reading costs nothing at the data layer
      // either: `GET /settings` is an OWNERSHIP route, and all three
      // routes on `settings.manage` are writes.
      { id: "settings.view", copy: "See business settings, taxonomies and feature switches" },
      { id: "settings.manage", copy: "Change business settings, taxonomies and feature switches" },
      { id: "displays.manage", copy: "Pair and revoke wall screens" },
      { id: "identity.link", copy: "Connect a login to a client record" },
      // docs/features/client-view-as.md: the actor is "a real Super user with
      // a valid Clerk session. Never anyone" else. It had been gated on
      // `identity.link` — linking a login to a client record — on the theory
      // that it was "the same authority as looking through one". It is not:
      // linking is data entry, and this reads a customer's entire portal as
      // them. The starter script also grants `identity.link` to the baseline
      // Admin role, so every admin
      // could impersonate any client.
      { id: "clients.view-as", copy: "Look at the app as one of your clients sees it" },
      { id: "portfolios.view", copy: "See the portfolio tree and what is in each one" },
      { id: "portfolios.manage", copy: "Create, rename, retire and reorganise portfolios" },
    ],
  },
] as const;

/** Every entitlement id, flattened. Order follows the role builder. */
export const ENTITLEMENTS = ENTITLEMENT_GROUPS.flatMap((g) =>
  g.entitlements.map((e) => e.id),
);

export type Entitlement = (typeof ENTITLEMENT_GROUPS)[number]["entitlements"][number]["id"];

/**
 * id → the human sentence shown in the UI.
 *
 * Exported so a refusal and a permissions screen describe an action with
 * the SAME words. Re-typing "approve a payment" somewhere else is how copy
 * and policy drift apart, which already happened once: `content.view`'s
 * sentence promised the guide approval queue that `content.approve` guards.
 */
export const ENTITLEMENT_COPY: ReadonlyMap<string, string> = new Map(
  ENTITLEMENT_GROUPS.flatMap((g) => g.entitlements.map((e) => [e.id, e.copy] as const)),
);

/**
 * The entitlement's action as a clause, for a refusal: "approve a payment".
 *
 * Built from `ENTITLEMENT_COPY` rather than from a second table of strings,
 * so a refusal, the role builder and the help text describe an action with
 * the same words.
 *
 * Two trims, and no more. An em-dash clause is an aside about scope
 * ("Download the tax exports — income, expenses, capital…"), and a trailing
 * ", and …" is a second action bolted on ("Create, move and reschedule
 * visits, and assign who does them"). Neither reads well mid-sentence.
 *
 * Cutting at the FIRST comma instead was tried and is wrong: a copy that
 * opens with a list of verbs — "Create, rename, retire and reorganise
 * portfolios" — collapses to "You don't have permission to create.", which names
 * no object at all. Four entitlements fail that way.
 *
 * Returns null for an unknown id, so the caller falls back to a generic
 * sentence rather than printing a raw entitlement name at a person.
 */
export function refusalPhrase(entitlement: string): string | null {
  const copy = ENTITLEMENT_COPY.get(entitlement);
  if (!copy) return null;
  const clause = copy
    // The portfolio-scopable marker is documentation for the role builder's
    // reader, not part of the action.
    .replace(/\s*\*\(portfolio-scopable\)\*/g, "")
    .split(" — ")[0]
    .split(", and ")[0]
    .trim();
  if (!clause) return null;
  return clause.charAt(0).toLowerCase() + clause.slice(1);
}

const ENTITLEMENT_SET: ReadonlySet<string> = new Set(ENTITLEMENTS);

/** Narrowing guard. Use at every boundary where a string becomes an
 *  entitlement — request bodies, seed data, migration backfills. */
export function isEntitlement(value: unknown): value is Entitlement {
  return typeof value === "string" && ENTITLEMENT_SET.has(value);
}

/** Throwing form, for write paths. The ONLY way a string may reach
 *  `RoleEntitlement.entitlement`. See G28. */
export function assertEntitlement(value: unknown): Entitlement {
  if (!isEntitlement(value)) {
    throw new Error(
      `Not an entitlement: ${JSON.stringify(value)}. ` +
        `A stored value outside the union is a grant that displays in the ` +
        `role builder and is denied by can(), with no error anywhere.`,
    );
  }
  return value;
}

/**
 * WHAT USED TO BE HERE, AND WHY IT IS NOT.
 *
 * `BaseRole`, `BASE_BUNDLES` and `WORKER_TYPE_DEFAULTS` encoded what each of
 * STAFF / WORKER / ADMIN / SUPER granted, derived from the route guards.
 * They are gone because the roles are gone (decision 40).
 *
 * Nothing is baked in any more. The app ships with no roles at all; a starter
 * script creates them, and another company writes their own.
 *
 * The derivation that produced those bundles is gone too. It lived in
 * `scripts/derive-base-bundles.ts`, which read the route guards to work out
 * what each role granted — useful exactly once, to write the starter ladder
 * honestly from the code rather than from memory. Roles are database rows the
 * operator edits now, so there is nothing left to derive, and a script that
 * recomputed them would be asserting it knows better than they do.
 *
 * `WORKER_TYPE_DEFAULTS` is gone for a second reason: it keyed field
 * capabilities on how someone was PAID, so an office employee picked up
 * `work.complete`. Field clearance is an ordinary role you grant, and a
 * trainee is simply someone who has not been granted it.
 */
