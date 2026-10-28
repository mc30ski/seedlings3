// Which inner tabs a person sees, decided by what they can do.
//
// WHY THIS TABLE EXISTS, WHEN NOTHING ELSE IN THE UI IS A TABLE.
// Every other authorization question in the web app is asked directly:
// a button calls `scope.can("money.approve")`, the same capability the
// route guard checks, so the two cannot drift. "Which tabs exist" has no
// server counterpart to agree with — there is no endpoint for it — so it
// needs exactly one place to look. This is that place, and it stops here:
// it decides VISIBILITY of a tab and nothing else. A second mapping from
// capabilities to UI would be a copy of policy in a different vocabulary —
// the same mistake as two parallel endpoints for one resource, where the URL
// chose the caller's privilege level instead of their capability.
//
// WHAT IT REPLACED. Two hardcoded lists — a worker list and the list —
// picked by which SHELL you were in. A custom role that is neither (a
// bookkeeper holding `books.*` and `payroll.*` but not `schedule.manage`)
// had no list to appear on and therefore no app. That is not hypothetical:
// four real accounts hold zero capabilities today.
//
// THE RULE IS ANY-OF, AND IT HAS A COROLLARY. Holding one of a tab's
// entitlements shows the tab, so the tab must contain something that
// entitlement can actually do. Sections inside gate themselves; if they all
// hide, the tab is a door into an empty room and the entry below is wrong.
// `tab-requirements.test.ts` holds the line on both halves.
//
// Each row was derived from the routes that tab's component actually calls,
// resolved against docs/features/permissions-ROUTE-MAP.md, not from which
// shell used to render it.

import type { Entitlement } from "@repo/permissions";

/**
 * Tabs that carry no capability requirement because none distinguishes
 * them: your own profile, a read of the guides written for you, an offline
 * calculator. Approval is the gate, and `index.tsx` has already applied it.
 *
 * Spelled as a word rather than an empty array on purpose — `[]` reads as
 * "requires nothing", which is also how you would write "reachable by
 * nobody", and those must not look alike.
 */
export const ALWAYS = "always" as const;

export type TabRequirement = typeof ALWAYS | readonly Entitlement[];

export const TAB_REQUIREMENTS = {
  // ── Daily work ──────────────────────────────────────────────────────
  home: ["schedule.view"],
  jobs: ["schedule.view"],
  // ANY-OF, and the row is the UNION of what lights at least one card in
  // the tab — see the corollary at the top of this file. `books.view` is
  // here because the two export shortcuts are guarded on it and nothing
  // else: a bookkeeper holds it, holds no `schedule.*`, and so had no door
  // to the only two actions in the app that are theirs. The tab is not an
  // empty room for them — it renders both exports and hides the rest.
  tasks: ["schedule.view", "schedule.contribute", "books.view"],
  // A caller with `schedule.manage`-side job DEFINITIONS tab (recurrence, pricing, assignment
  // defaults), distinct from `jobs`, which is the visit list.
  services: ["schedule.manage"],
  routes: ["routes.plan"],

  // ── Equipment ───────────────────────────────────────────────────────
  equipment: ["equipment.view"],
  collections: ["equipment.view"],
  vehicles: ["equipment.view"],
  supplies: ["supplies.view"],

  // ── Directory ───────────────────────────────────────────────────────
  clients: ["clients.view"],
  properties: ["clients.view"],
  users: ["people.view"],
  groups: ["crews.view"],

  // ── Money ───────────────────────────────────────────────────────────
  // Payments' `self` tier is reached by OWNERSHIP, not a capability —
  // same shape as `payroll` below. PaymentsTab renders three entirely
  // different screens: approvals (`money.approve`), oversight
  // (`money.view`) and a worker's OWN payments, which reads
  // `/payments/mine` — an ownership route that returns only the caller's
  // rows. `["money.view"]` here hid that third screen from everyone who
  // IS paid but does not oversee the money, which is every field worker,
  // and left `WorkerPayments` as unreachable code.
  payments: ALWAYS,
  ledger: ["books.view"],
  reconcile: ["books.view"],
  pricing: ["pricing.view"],
  forecast: ["forecasts.view"],
  // The team rollup — Insights → Statistics. `reports.view`, the same
  // capability GET /statistics is guarded on, so the tab and its endpoint
  // cannot disagree. The numbers narrow by area for an area-limited holder,
  // and the page says so when they do.
  statistics: ["reports.view"],

  // ── Time ────────────────────────────────────────────────────────────
  // NOT `time.approve`, though the first version listed it.
  //
  // The reasoning was "an approver needs the screen". They do not: this tab
  // reads `/workdays/by-date` and `/mileage/by-date`, both `time.view`, and
  // approving happens somewhere else entirely — `/occurrences/unapproved-hours`
  // and `/approve-hours` are `time.approve` and are surfaced in the Tasks
  // overlay. Listing the third capability here opened a tab whose every
  // fetch then refused, which the persona sweep caught as two 403s for a
  // coordinator. An any-of row is only honest when each entitlement in it
  // can actually drive the page.
  workdays: ["time.view", "time.manage"],

  // ── Records ─────────────────────────────────────────────────────────
  compliance: ["compliance.view"],
  timeline: ["timeline.view"],
  documents: ["documents.view"],
  // "Engagement" — client activity feed, reading /activity.
  activity: ["audit.view"],
  // Reads /audit and /users. `audit.view` ONLY — listing `people.view` as an
  // alternative was wrong twice over: the substance of the tab is the audit
  // log, and `people.view` is held by the baseline Trainee, so every worker
  // got a History tab whose contents would 403. It reads /users to put names
  // on the rows, which is a detail of rendering, not a reason to open it.
  history: ["audit.view"],
  // The system-audit TOOL (`POST /system-audit`), not the audit LOG.
  // It is gated on `settings.manage` because it runs checks against
  // configuration, which is why it does not sit on `audit.view`.
  audit: ["settings.manage"],

  // ── Marketing ───────────────────────────────────────────────────────
  // Both read and write CAMPAIGN routes, which split out of
  // `marketing.manage` on 2026-10-20 — every `/promotions/*` and
  // `/vanity/*` guard is `marketing.campaigns` now. `marketing.manage` is
  // the banners-and-announcements half and opens neither of these tabs; a
  // tab gated on it would have offered 48 routes its holder is refused.
  promotions: ["marketing.campaigns"],
  vanity: ["marketing.campaigns"],
  notify: ["notify.send"],

  // ── Administration ──────────────────────────────────────────────────
  // ANY-OF: `settings.view` opens the page, `settings.manage` gates every
  // control on it. They were one grant, so a holder of `people.manage` who
  // needed to CHECK a rate had to be handed the ability to change it.
  // `settings.manage` is listed too — a custom role may hold the write
  // without the read, and it must not lose its own tab.
  settings: ["settings.view", "settings.manage"],
  displays: ["displays.manage"],
  roles: ["roles.view"],
  // `areas.view`, NOT `areas.manage` — and only the one, because the rule is
  // that a tab names the capability of the endpoint it calls. Listing both
  // would reopen the tab for a manage-only holder whose `GET /areas` then
  // 403s behind it, which is the silent-refusal shape this table exists to
  // prevent. Everyone who holds `areas.manage` also holds `areas.view`
  // through Admin; see install-starter-roles.ts.
  areas: ["areas.view"],

  // ── No capability distinguishes these ───────────────────────────────
  // Guides reads `/me/guides`, which is an OWNERSHIP route: the guides
  // written for you. Authoring and approving are gated INSIDE the tab on
  // `content.manage` / `content.approve`.
  guides: ALWAYS,
  // Payroll's `self` tier is reached by OWNERSHIP, not a capability
  // (docs/features/payroll.md): the tab reads `/me/payroll` and renders
  // somebody's own stub, their pending-match notice and their empty state.
  // `["payroll.view"]` here hid all three from everyone who is paid but
  // does not administer payroll — which is every worker.
  payroll: ALWAYS,
  profile: ALWAYS,
  "tools-mowing": ALWAYS,
  "tools-mulch": ALWAYS,
} as const satisfies Record<string, TabRequirement>;

export type TabId = keyof typeof TAB_REQUIREMENTS;

/**
 * May this person see this tab?
 *
 * `can` is `scope.can` — the same predicate a button inside the tab will
 * ask. An id with no row returns false rather than true: a tab added
 * without a row should disappear and be noticed, not appear for everybody.
 * The gate makes that case a build failure, so it should never be reached.
 */
export function canSeeTab(
  tabId: string,
  can: (capability: Entitlement) => boolean,
): boolean {
  const need = (TAB_REQUIREMENTS as Record<string, TabRequirement | undefined>)[tabId];
  if (need === undefined) return false;
  if (need === ALWAYS) return true;
  return need.some((entitlement) => can(entitlement));
}

/**
 * Does this person hold a capability that opens any tab?
 *
 * False is the "no access" state: an approved account that has been granted
 * nothing. Four real accounts are in exactly that position, and before this
 * they landed on an empty frame that read as a broken deploy.
 *
 * ALWAYS rows are excluded ON PURPOSE. Profile and Guides are reachable by
 * everybody, so counting them would make this permanently true and the
 * no-access state unreachable — the exact bug this function exists to catch.
 * The no-access screen still offers Profile, because a new hire with no role
 * yet must be able to sign their policies.
 *
 * Deliberately asks the same question the tab list asks, rather than testing
 * `capabilities.length`: somebody could hold capabilities that open no tab,
 * and they would see the same empty frame.
 */
export function hasCapabilityTab(
  can: (capability: Entitlement) => boolean,
): boolean {
  return Object.entries(TAB_REQUIREMENTS).some(
    ([id, need]) => need !== ALWAYS && canSeeTab(id, can),
  );
}
