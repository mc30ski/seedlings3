# Permissions — UI build plan

Companion to [`permissions-BUILD.md`](permissions-BUILD.md), which covers the
backend. That document's four steps are the server: schema, `can()`, route
guards, areas. This one is the browser.

It is a **build artifact**, like its sibling: it changes as code lands, and it
is not the design. The design — what the role builder looks like, what
"effective permissions with provenance" means, why "manager" never appears in
UI copy — is [`permissions.md`](permissions.md) §UI. Read that first; this is
the list of work.

> **Status: BUILT, 2026-10-17.** The plan below was executed, and then
> extended past what it covered — it never stated the one-tab-per-feature
> rule, so the first pass left a per-role tab list in place. What shipped:
> one `StaffTabs` list and two shells (`client`, `staff`), `TAB_REQUIREMENTS`
> deciding which tabs exist, `Scope` reduced to `{ can }`, the surface-flag
> factory and its capability map deleted, `RoleChip` as the perspective picker, and
> the role + area builders.
>
> **Counts in this document are from 2026-10-14 and describe the BEFORE
> state.** They are kept because the reasoning depends on them; do not read
> them as current. A grep for the role flags now finds only comments.

---

## The two questions this phase answers

Everything below is one of these, and conflating them is what produced most of
the backend's bugs:

| Question | Answered by | Changes when |
|---|---|---|
| **Which layout am I rendering?** | the three surface flags, derived once from a capability map | the person switches tabs |
| **May this person do it?** | `scope.can(capability)` | never, except by a grant or a lens |

`scope.can` runs the **same `can()`** the server's route guard runs, against
the capabilities `/api/me` resolved. One implementation is what makes a hidden
button and a refused route agree by construction rather than by review.

---

## 0. BLOCKING — the omitted-pay-field crash

Do this before re-mounting `StatisticsTab`, and before adding any new consumer
of `/statistics` or `/operations`.

`/statistics` and `/operations` now **omit** the per-worker money columns
unless the caller holds `payroll.view`: `totalEarnings`, `netEarnings`,
`totalExpenses`, and on `/operations` also `wageGross` and `avgHourlyRate`.
They were readable by the baseline Trainee role, which is why they moved.

`StatisticsTab.tsx` renders them unguarded — `w.netEarnings.toFixed(2)` at
~327, `w.totalEarnings.toFixed(2)` at ~341, and a `reduce` over
`w.netEarnings` at ~162. With the field absent that is a **TypeError**, not a
blank, plus a NaN team average.

It is not live: that tab is commented out of both the worker and the shell (`pages/index.tsx` ~65-71, ~1067, ~1765), and `/operations`'s
`workerStats` has no web consumer at all. So this is a trap rather than a bug
— and it will present as a UI crash rather than as a contract change.

- [x] ~~Gate the money StatBoxes~~ **DONE 2026-10-16.** The real fix was at the
      TYPE: `totalEarnings` / `totalExpenses` / `netEarnings` are now optional
      on `WorkerStat`, which turned every unguarded read into a compile error
      — and found **four more** than this section listed (a chart series, a
      chart-data map and a sort comparator). A row whose pay the caller may
      not read is dropped from a chart rather than plotted at zero.
- [x] ~~**Do not** make the server send `0`~~ — unchanged, and the same rule is
      now applied client-side: an absent figure is `null`, never `0`. A zero reads as
      "this person earned nothing", which is a lie about someone's pay.
- [x] ~~Add the same guard to any new consumer~~ — the optional type enforces
      it now; a new consumer cannot read the field without handling absence.

---

## 1. What happens when the API refuses

**The API always checks.** The UI hiding a control is cosmetic; every guarded
route independently calls `can()` and fails closed — no principal means
refusal, so a route reachable without the rbac plugin having run gets the
narrow answer, not the wide one.

```
HTTP 403
{"code":"HTTP_ERROR","message":"NOT_AUTHORIZED"}
```

**The UI does nothing with it.** There is no `NOT_AUTHORIZED` handler anywhere
in `apps/web`. The 403 falls through `api.ts`'s generic path into a thrown
`Error` carrying `.status` / `.code` / `.details`, and the 414 call sites in
108 files that use `getErrorMessage()`
([`InlineMessage.tsx:286`](../../apps/web/src/ui/components/InlineMessage.tsx))
render it as:

> **Update failed: Not authorized or not approved. NOT_AUTHORIZED**

Said twice: a sentence that cannot distinguish a missing capability from an
unapproved account, then the machine word. One formatter is reached by all 414
call sites, so the repair does not touch any of them.

### What to build

- [x] ~~**Return the capability in `details`.**~~ **DONE 2026-10-16.** The guard knows which
      entitlement it refused; today it is thrown away. `{ code:
      "NOT_AUTHORIZED", details: { entitlement: "money.approve" } }` costs one
      line in `routeGuards.ts` — the `app.httpErrors.forbidden("NOT_AUTHORIZED")`
      at line 63 has no channel for detail, so it becomes the `ServiceError`
      shape the compliance gate already uses
      (`ServiceError(code, message, 403, details)`), which `errorMapper`
      passes through untouched.
- [x] ~~**Map it to copy that already exists.**~~ **DONE** — `refusalPhrase()`
      in `packages/permissions`, locked by a test over every entitlement. An
      earlier rule cut at the first comma and turned four of them into
      "You don't have permission to create." All 60 entitlements carry a
      human sentence in `packages/permissions/entitlements.ts` — `money.approve`
      is *"Approve a payment, reverse one, or write it off"*. A refusal should
      read **"You don't have permission to approve a payment"**, built from the
      vocabulary rather than from new strings that can drift from it.
- [x] ~~**Treat a 403 as a BUG SIGNAL.**~~ **DONE** — logged once centrally in
      `api.ts`, in development only. Wiring it at the 414 call sites would mean
      the ones that forgot are the ones that need it. If the UI is
      gating correctly the user can never reach a refused action, so a 403 in
      production means the UI and the API disagree. Make it loud in
      development — console error naming the entitlement and the route — and
      quiet but clear for the user.

**Decided 2026-10-16: quiet.** An inline message carrying the human sentence —
no dialog. A refusal the user can reach is a UI bug, and a modal does not help
them act on it; the compliance gate keeps its dialog because there the user
*can* act. The development-side console error stays loud.

### The model to copy

`POLICIES_REQUIRED` already does this properly: the server returns
`{ pendingPolicyIds }` in `details`, `api.ts` broadcasts a global event, and a
`PolicyGateInterceptor` mounted at the app root opens the signing wizard. A
capability refusal should follow the same shape — server says what is missing,
one interceptor decides what the user sees.

---

## 2. Perspective and surface are different things

`topTab` currently does both jobs:

```ts
const [topTab] = usePersistedState<"client"|"worker"|"admin"|"super">(...)
const scopeIsStaff = (topTab === "admin" || topTab === "super") && staffFlag;
```

That conflation is why "someone with `settings.manage` browsing the Worker tab" was ambiguous about
whether they still held Super powers. They are now separate:

- **Perspective** — what you *hold*. Narrowed server-side from the
  `X-Perspective` header, can only ever narrow, and `/api/me` already returns
  `perspectives` (ordered, non-empty exactly when there is something to switch
  to) and `activePerspectiveRoleId`.
- **Surface** — which layout is on screen. Pure presentation.

- [x] ~~Header picker renders from `me.perspectives`~~ **DONE 2026-10-16.** The web
      was still sending `X-Impersonate-As` with the deleted role literals while the
      API reads `x-perspective` with a role id — so no lens had worked since the
      enum came out. Picker, banner and the confirm-dialog warning all rebuilt
      off `me.perspectives` / `me.activePerspectiveRoleId` (the SERVER decides
      which lens ran, not localStorage).
- [x] ~~Tab visibility becomes capability-driven~~ **DONE 2026-10-16** — see §3.
      A bookkeeper holding `books.*` and `payroll.*` but not `schedule.manage`
      is today neither worker, admin nor super and has no `topTab` to land on.
      **No longer hypothetical (2026-10-13):** `coordinator`, `bookkeeper`,
      `payroll` and `unpaid` are real accounts that authenticate and hold
      **zero** capabilities, so the factory returns all three surface
      flags false and there is no surface to land on. Needs a legible "no
      access yet" state, not an empty shell.
- [x] ~~**Seed dependency.**~~ **DONE 2026-10-17.** The Clerk accounts were
      never the blocker — they were made 2026-10-12 and have authenticated
      since. What was missing: coordinator / bookkeeper / payroll were
      PENDING with no worker type and no role, so signing in as one reached
      "awaiting approval" rather than any surface. `seed.ts` now approves and
      types them and grants three EXAMPLE CUSTOM roles (Coordinator,
      Bookkeeper, Payroll) — not starter roles, because each exists for a
      shape the ladder cannot express. `unpaid` stays at zero on purpose: it
      is the no-access page's only live subject.
      Three of those four personas were not
      in `apps/api/prisma/seed.ts` at all (only `unpaid` is, deliberately, with
      `roleKey: null`). Until they carry grants, the office-staff /
      books-without-payroll / payroll-without-books surfaces cannot be
      exercised by the UI or by a test.

---

## 3. One client-side table, and only one

- [x] ~~`TAB_REQUIREMENTS`~~ **DONE 2026-10-16.** 35 rows, not ~20, in
      `apps/web/src/lib/tabRequirements.ts`. Each row was derived from the routes
      that tab's component actually calls, resolved against the route map — not
      from which shell used to render it. Wired into all three shells.

Deliberately **not** a general entitlement→UI mapping, and deliberately **not**
sent by the server. Buttons ask `scope.can("money.approve")` inline. A second
mapping would be a copy of policy in a different vocabulary, and two
parallel endpoints for one resource showed exactly how that ends: two
expressions of one rule, drifted, and the drift was a hole.

It earns its place only because "which tabs exist" has no server equivalent and
the alternative is twenty inline conditions.

- [x] ~~Gate it~~ **DONE — G44**, `tab-requirements-build-gate.test.ts`. Four
      checks (real entitlements, a row per tab, no orphan rows, no empty rows)
      plus negative controls that feed the parsers synthetic input, so the
      detection is proven on every build rather than once by hand.

### The two cases the table does not solve by itself

**Nobody home.** Four real accounts hold no capability at all. Today they
authenticate, land on the app, and match nothing — an empty frame that reads as
a broken deploy. **Decided 2026-10-16: show a "no access" page.** The account is
active, no access has been granted yet, and the page names who to ask. Signing
them out instead was considered and rejected: a person who cannot get in cannot
be told why.

This is the *zero* case only. Somebody who holds one capability sees the one tab
it earns them — that is the table working, not a degraded state, and it is the
whole reason a bookkeeper no longer needs a bookkeeper shell to exist.

- [x] ~~A "no access" page~~ **DONE 2026-10-16.** `NoRoleNotice` already
      existed and had NEVER RENDERED: it was gated on `topTab !== "client"`,
      and the redirect pushes a person with no surface to the client shell —
      so the one population it exists for was always excluded. Needed a new
      `isClientContact` field on `/api/me` to tell a customer from an
      ungranted staff account; both arrived with an empty capability set.

**Doors into empty rooms.** A tab qualifies on any one of its entitlements, but
every section inside is separately gated — so a tab can open onto nothing. The
rule is that visible means you can do at least one thing here, which holds only
if sections hide themselves rather than rendering disabled. Otherwise the table
manufactures exactly the dead end it was built to remove.

- [ ] Gate it: for each tab, something inside it is reachable with each
      entitlement that makes it visible. **STILL OPEN** — G44 covers the table,
      not the rooms behind the doors.

---

## 4. Already broken, found during the backend work

- [x] ~~**Role granting in `UsersTab` sends names where the server wants ids.**~~
      **DONE 2026-10-16** — replaced with a picker off `GET /roles`, per-role
      revoke badges and a role-agnostic confirm. The role FILTER is
      catalogue-driven too, keyed on the stable role key, with a guard that
      drops a persisted value the catalogue no longer knows.
      It posts `{ role: "ADMIN" }` and deletes `/users/:id/roles/ADMIN`; the
      routes read `body.customRoleId` and `:roleId`. Both endpoints exist and
      are gated on `people.grant-roles` — the UI is simply speaking the old
      enum. Replace with a role picker fed by `GET /roles`. As of 2026-10-13
      these two functions are typed `LegacyRoleName` rather than the surface
      type, so the breakage is visible at the callsite instead of looking like
      ordinary working code.
      **Unblocked 2026-10-15:** `GET /roles` was gated on `roles.define`, so
      a `people.grant-roles` holder could not list what they were allowed to
      grant. There is now a `roles.view` entitlement (Admin and above) that
      gates reading the catalogue; defining still needs `roles.define`. The
      picker can be built.
- [x] ~~**`UsersTab`'s Permissions section is reported, not editable.**~~
      **RESOLVED 2026-10-16** — correct as it stands, and the gap it left is
      closed by the two grantable exception roles above. The badges are the
      report; the picker beside them is the edit. The
      per-person privilege toggles were converted to read-only badges when the
      columns and `PATCH /users/:id/privileges` were deleted. A per-person tick
      is what the model forbids (G20); the replacement is granting a role that
      carries the capability, through `people.grant-roles`.
      **Decided 2026-10-16:** add two grantable single-capability roles —
      "Can pull inventory" (`inventory.pull`) and "Can charge business
      expenses" (`expenses.charge`) — to `install-starter-roles.ts`, beside
      the existing `seedlings.field-clearance`. They restore the one-off
      exception someone with `schedule.manage` used to make with a tick-box, without a per-person
      column: a real role, inheritable, auditable. Those two only — they are
      the exceptions that existed as ticks. Anything further is a
      conversation, not another row.

Empty shells moved to §3, where the tab table creates the problem and the
gate for it lives.

---

## 5. New surfaces

From [`permissions.md`](permissions.md) §UI — the design is written, none of it
is built.

**Where they live is not a separate question.** These are rows in the §3
`TAB_REQUIREMENTS` table like every other tab: Roles appears for a holder of
`roles.define`, Areas for `areas.manage`. Naming a destination by shell
("under Super") reintroduces the role vocabulary this whole phase removes —
and `Super` is only a starter row the install script creates, renameable and
deletable, which nothing in the code branches on. Per-person effective
permissions is not a tab at all: it is a section on the person's row in
`UsersTab`, gated on `people.manage` beside the other sections there.

- [x] ~~**Role builder**~~ **DONE 2026-10-16** — `RolesTab`. Copy-from warns
      at the moment of copying that it is a snapshot, not a link. Copying a base role's entitlements is a
      starting point, not a link, and the copy must warn at the moment it
      happens.
- [x] ~~**Entitlement matrix**~~ **DONE 2026-10-16** — a view inside `RolesTab`,
      generated from `GET /entitlements` and each role's resolved `effective`
      set. Distinguishes a tick the role writes from one it inherits.
- [x] ~~**Effective permissions per person, with provenance**~~ — **the API
      exists as of 2026-10-15**: `GET /users/:id/effective-permissions`
      (`people.manage`). Per capability it returns the human copy, `scope`
      (`global` | `area`), an `overriddenByGlobal` flag, and `via[]` naming
      both the role HELD and the role the entitlement is WRITTEN ON — so
      `schedule.view` on someone with `schedule.manage` reads "via Admin, written on Trainee",
      which is the difference between fixing the right role and the wrong
      one. The screen itself is still to build.
      **Caveat:** the area and `overriddenByGlobal` paths are unexercised —
      there are zero `AreaAssignment` rows, so nobody is area-scoped yet.
- [x] ~~**Who holds a role**~~ — `GET /roles/:id/holders` (`roles.view`)
      returns company-wide and area grants in one list, each labelled with
      its `scope`, because a reader who cannot tell them apart will misread
      a territorial grant as absolute.
- [x] ~~**Area tree and assignment**~~ **DONE 2026-10-16** — `AreasTab`, a row
      in the same `TAB_REQUIREMENTS` table as everything else (`areas.manage`).
      No reparent control, deliberately: G14.

---

## 6. Where the UI is now stricter than the API

These are widenings on the server, so nothing is broken — but a UI gate that
is tighter than its route's guard is exactly the drift G15 exists to catch,
and it means somebody has a capability they cannot use.

- [x] ~~**Guides approval queue** — move the `TasksPage` gate to
      `content.view`.~~ **WITHDRAWN 2026-10-13, and it was wrong.** I had moved
      `GET /guides/pending-approvals{,/count}` from `content.approve`
      (`content.approve`) to `content.view` because `content.view`'s copy
      said "see guides awaiting approval", then wrote this item to make the UI
      match. Both were mistakes: `education.md`'s capability table gives
      Approve / publish / send back to Super ALONE, and
      `scheduler-guides.spec.ts` asserts someone with `schedule.manage` receives 403 from those exact
      paths — which is how it was caught, in the full e2e run. The guards are
      reverted and the entitlement COPY is fixed, because the copy was the
      actual defect.
      **The top-role gate in `TasksPage.tsx` is correct. Leave it.**
- [x] ~~**Marketing reads.**~~ **REVERTED 2026-10-16 — no UI work needed.**
      Six pure content reads had moved `marketing.manage` → `marketing.view`
      (`/promotions`, `/promotions/:id`, `/promotions/allowed-domains`,
      `/vanity`, `/vanity/:id`, `/vanity/animation-settings`), and
      `marketing.view` is held by baseline Trainee. A read-only
      promotions/vanity view for the whole crew is a surface nobody asked
      for, so the six are back on `marketing.manage` — reading and running
      campaigns are the same job here. `marketing.view` keeps `GET /banners`,
      the team-facing announcement read it always gated. The PII reads
      (`/promotions/contacts`, `…/deliveries`, `…/landing`,
      `…/invoice-photos`) never moved.
- [x] ~~**Don't offer what the row forbids.**~~ **DONE** — the handoff now asks
      `isClaimer || isActiveAssignee || can("money.record") || can("schedule.manage")`,
      the same question the route asks, instead of the tab-scope layout flag. `GET
      /occurrences/:id/comms-handoff` now requires you to be ON the visit or
      to hold `money.record` / `schedule.manage`, because it returns client
      contact details and mints a public payment token. Claimers and holders of `schedule.manage`
      both qualify, so nothing breaks — but the UI should stop offering the
      handoff to a worker who is not on the visit, rather than letting them
      press it and get a 403.
- [ ] **Redacting reads: hide the column, don't print `undefined`.**
      `GET /users` and `/users/:id` keep `people.view` but drop `hourlyWage`,
      `email`, `phone`, `homeBaseAddress` (and on the list `roleGrants` +
      `capabilities`) without `people.manage`. Every current consumer
      (`UsersTab`, `HistoryTab`, `PreviewRoutesTab`) is the surface that
      holds it, so this is pre-emptive: if one is ever mounted for a worker,
      gate the columns rather than rendering blanks.
- [x] ~~**`/users/:id/earnings-summary`**~~ **DONE** — `ProfileTab` checks
      `payroll.view` before mounting instead of swallowing the 403.
      `ProfileTab`'s `EarningsSection` swallows the error and renders nothing,
      which is graceful but accidental. Make it an explicit capability check.

---

## 7. New API vocabulary to speak

- [x] ~~**`REFERENCED_RECORD_NOT_FOUND` (404)**~~ **VERIFIED 2026-10-16, no code
      needed.** The mapper's message is already human and already says to refresh;
      `getErrorMessage` passes it through unprefixed. A global auto-refresh event
      was considered and rejected — this codebase already has one dispatcher with
      no listeners, and a second would be worse than none. — new, from mapping Prisma
      P2003. It fires when something the request referred to is gone: pin or
      like a visit archived while it was still on screen, dismiss a deleted
      banner. Nine routes used to return a bare 500 here. The message is
      already human, so `getErrorMessage()` shows something usable — but the
      right response is to REFRESH THE LIST, because the row the user is
      looking at no longer exists.
- [x] ~~**`/occurrences/:occurrenceId/mark-paid`**~~ **VERIFIED** — no stale
      callers outside gate comments. Renamed from
      `admin-mark-paid` (no route path carries a role name any more; G41).
      The single caller is updated; no action unless new callers appear.

---

## 8. In-app help copy ("i" icon) names roles that no longer exist

**39 `<TabExplainer>` mounts across ~34 tab files, with role language in at
least 20 of them** — heaviest in PaymentsTab (14 hits), InventoryTab (9),
PayrollTab (8), CrewsTab (7), HomeTab (6).

It is wrong for two separate reasons, and they need different fixes:

1. **"Admin" and "Super" are names of editable rows.** A `CustomRole` can be
   renamed, redefined, or replaced by "Office Manager". Copy that says
   "Holders of `schedule.manage` can…" is describing today's seed data as though it were the
   product.
2. **Copy that apportions is making an authorization claim the guard
   actually decides.** "Holders of `settings.manage` can write it off" and `requires("money.approve")`
   are two expressions of one rule, and when they drift the copy lies. That
   is exactly what two parallel endpoints for one resource did.

### The three rules, in the order that removes the most text

- [x] ~~**Rule 1 — say what the tab is FOR, not who may use it.**~~ **DONE
      2026-10-16.** Every clause naming a rank deleted across 10 tabs. Most of this
      language exists to explain a missing button. Once the UI hides what you
      cannot do (§3) and a refusal explains itself (§1), the explainer does
      not need to apportion anything. This deletes the majority of it.
- [x] ~~**Rule 2 — gate the sentence on the capability.**~~ **DONE.**
      `RoleSection` (prop: a role NAME, 31 uses in 21 files) is replaced by
      `CapabilitySection`, which gates on the capability and labels itself
      from it ("Because you can approve a payment:"). The old export throws,
      so a stale import fails at the callsite. Not "Holders of `schedule.manage` approve payments; Holders of `settings.manage`
      write them off", but a line rendered only when
      `scope.can("money.approve")`. It is never wrong, it never names a role,
      and it is driven by the SAME capability the route guard reads — so help
      text and enforcement agree by construction rather than by review. That
      is G15's property, extended to prose.
- [x] ~~**Rule 3 — use the entitlement's own words.**~~ **DONE** — the same
      `refusalPhrase()` a 403 uses, so help text and refusal are one phrasebook. All of them carry a human sentence: `money.approve` is *"Approve a
      payment, reverse one, or write it off"*. Write "This needs **Approve a
      payment**", never a rank. It stays true when roles are renamed,
      and it is the same vocabulary §1 uses for a 403 — one phrasebook for
      "what this action is", used by the help text and the refusal alike.

### Two constraints found while surveying this

- [x] ~~**The dismissal key is surface-keyed.**~~ **NOT A BUG — checked
      2026-10-16.** `explainerId` stopped keying storage when open/closed
      became one shared preference (`HELP_OPEN_KEY`); the surface suffix is
      now the mounted panel's identity, which is what makes three different
      screens three different panels. Left alone. Explainers persist as
      `seedlings:<tab>Tab:guideOpen:${roleFlag ? "super" : "admin"}`. Keying
      LAYOUT on a surface flag is legitimate, but once the copy varies by
      capability, a person who gains one keeps a dismissed explainer that no
      longer matches what they see. Key dismissal on something stable — tab
      plus a copy version — not on who they are.
- [x] ~~**A gate already gnaws at this file.**~~ **UPDATED.** Six assertions
      in `job-materials-build-gate` REQUIRED the phrase "super-only" in the
      copy. Four of those claims were false — they named actions as
      restricted that `schedule.manage` / `equipment.manage` grant, which
      every admin holds. Replaced by one rule, **no explainer names a role**,
      scanning every tab explainer (not just the seven Money ones) with a
      floor on how many files it read, so a wrong path fails loudly. `job-materials-build-gate.test.ts`
      asserts every tab HAS an explainer, that the trigger is unconditional,
      and that `index.tsx` never names a storage key. Those are structural and
      survive a rewrite — but several of its own comments described management
      guard names and were corrected on 2026-10-13, so re-read the assertions
      around them when the copy moves.

### Order
Do this AFTER §3 (tab visibility) and §1 (the 403 path). Rewriting the copy
first means writing sentences about a UI that still gates on surface flags,
and they would have to be written twice.

---

## Gates

- [x] ~~**G15**~~ **BUILT 2026-10-16**, `ui-capability-build-gate.test.ts`, in
      a weaker form than this line imagined and stated honestly in the file:
      the condition on a BUTTON is not statically decidable (the handler sits
      far from the JSX, behind a callback, in an 11k-line file), so it asks
      whether a file that calls a guarded mutation NAMES that entitlement
      anywhere. **71 files do not**, listed in a shrink-only `PENDING`. That is
      a drift surface rather than a hole — the server checks every request and
      fails closed — but move one of those components and its gate does not
      travel with it. The one
      backend gate still unbuilt, and the reason this phase can regress
      silently. Mechanisable from
      [`permissions-ROUTE-MAP.md`](permissions-ROUTE-MAP.md) for the common
      shape: an `apiPost("/api/x")` inside a conditional.
- [x] ~~**G36**~~ **DONE 2026-10-16**, inside the tab gate. Uniqueness of the
      vocabulary is already asserted at the source; what can regress is the
      role builder or the matrix growing a local copy of the list, so the gate
      checks they render from `GET /entitlements` and contain no hardcoded
      entitlement id beyond the two they gate themselves on.
- [x] ~~**G1/G2 hold the line first.**~~ **ALREADY LIVE** — `[G1-G2] the web
      Scope object` in `permissions-build-gate.test.ts`, and green throughout
      this phase, including after `Scope` gained new consumers. The additive scope object is the riskiest
      change here, and the standing rule is that the top-extras flag must
      **not** fall back to the tab-scope one. That footgun widens with more inputs and it
      fails silently. Gate the scope object's shape before touching any tab.

---

## Order

0. §0 the omitted-pay-field guard — only if `StatisticsTab` is being
   re-mounted. Otherwise it is a trap to remember, not a task to start with.
1. §2 perspective/surface split — everything else sits on it.
2. §3 tab table + its gate.
3. §1 the 403 path — small, and it turns every later mistake into a legible
   message instead of `NOT_AUTHORIZED`.
4. §4 repairs.
5. §6 the stricter-than-the-API gates — small, and each one is somebody
   holding a capability they cannot currently use.
6. §5 new surfaces, and §7 alongside whatever touches error handling.
7. G15 alongside, not after. Written after the fact it becomes an audit of
   work already shipped, which is how the three view-as bugs happened.

---

## 9. ONE TAB PER FEATURE — the part the plan left out

**This section exists because the plan did not.** Sections 1–8 made which
TABS you see capability-driven, and left what is INSIDE them decided by
which shell you are in. That was never a decision; it was an omission. The
rule was agreed in conversation and written into no document, so when the
plan was drafted from the documents it had a hole, and the hole was
executed faithfully.

### The rule

**One tab per feature. The tab assembles what it shows from the viewer's
entitlements. There is no worker build, admin build or super build.**

A consequence that is already true and worth stating: `/api/me` sends the
PERSPECTIVE-NARROWED capability set, so a tab that reads entitlements
automatically shows less under a perspective, and a tab whose entitlements
you lack disappears entirely. That half works today (§3). What does not is
the tab's own content.

### What it costs

Measured 2026-10-17 — not estimated.

| Tab | surface-flag refs | capability checks |
|---|---|---|
| `JobsTab.tsx` | 234 | 3 |
| `InventoryTab.tsx` | 80 | 0 |
| `PayrollTab.tsx` | 63 | 0 |
| `ClientsTab.tsx` | 52 | 0 |
| `GuidesTab.tsx` | 52 | 0 |
| `PaymentsTab.tsx` | 50 | 0 |
| `ServicesTab.tsx` | 41 | 0 |
| `PropertiesTab.tsx` | 31 | 0 |
| `SuppliesTab.tsx` | 31 | 0 |
| `CollectionsTab.tsx` | 28 | 0 |
| `UsersTab.tsx` | 25 | 0 |
| `VehiclesTab.tsx` | 24 | 0 |
| `SettingsTab.tsx` | 22 | 0 |
| `ProfileTab.tsx` | 21 | 0 |
| `PricingTab.tsx` | 19 | 0 |
| `DocumentsTab.tsx` | 13 | 0 |
| `HomeTab.tsx` | 12 | 1 |
| `TimelineTab.tsx` | 11 | 0 |
| `PreviewRoutesTab.tsx` | 10 | 0 |
| `JobsTab.parts.tsx` | 9 | 0 |
| `TasksTab.tsx` | 5 | 0 |
| `CrewsTab.tsx` | 4 | 0 |
| `NotifyTab.tsx` | 2 | 0 |
| `PreviewRoutesTab.parts.tsx` | 2 | 0 |
| `HomeTab.parts.tsx` | 1 | 0 |
| `ReconcileTab.tsx` | 1 | 1 |

**843 surface-flag references. 5 capability checks.** `purpose`,
the five role flags.
`JobsTab` alone is 234 of them and is ~11k lines.

### The method, per site

A surface flag guarding a control is replaced by **the capability that
control's route requires** — look it up in
[`permissions-ROUTE-MAP.md`](permissions-ROUTE-MAP.md), do not guess. Three
shapes recur:

1. **Guarding an action** → `scope.can("<the route's entitlement>")`.
2. **Guarding a READ-ONLY section** → the view capability for that data
   (`money.view`, `books.view`), not the manage one.
3. **Choosing between two whole renders** (`staffExtras ? <Staff/> :
   <Worker/>`) → the hard case. The two renders merge into one that shows
   each piece on its own capability. This is where the work is, and where
   a wrong call silently removes a control somebody needs.

The tab-scope flag is the worst of them — 106 uses in JobsTab — because it means
"admin-flavoured rendering" and not any single authority. Each site has to
be read.

### Order

Smallest first, to establish the pattern on tabs where a mistake is cheap,
and because the gate below can then hold the line while the big ones are
done.

`ReconcileTab` → `NotifyTab` → `CrewsTab` → `TasksTab` →
`HomeTab.parts` → `PreviewRoutesTab*` → `TimelineTab` → `DocumentsTab` →
`HomeTab` → `PricingTab` → `ProfileTab` → `SettingsTab` → `VehiclesTab` →
`UsersTab` → `CollectionsTab` → `SuppliesTab` → `PropertiesTab` →
`ServicesTab` → `PaymentsTab` → `GuidesTab` → `ClientsTab` →
`PayrollTab` → `InventoryTab` → `JobsTab`.

### The gate

- [ ] **G45 — the surface-flag budget only shrinks.** A per-file count,
      seeded at today's numbers, that fails if any file grows. Same
      shrink-only shape as G15, and the reason is the same: a backlog
      nothing enforces grows.
- [ ] **Delete `purpose` from `TabPropsType`** when the last tab stops
      reading it. Until then it is the marker for what remains.

### What must NOT happen

- **Do not collapse a variant by deleting the smaller one.** A caller with `schedule.manage`
  build of a tab frequently has controls the worker build lacks AND omits
  ones it has. Merging means reading both.
- **Do not replace a flag with a different flag.** Swapping one role
  boolean for another is not progress.
- **Do not guess a capability from the control's label.** The route map is
  the source; `content.view`'s copy once promised a queue that
  `content.approve` guarded, and that mistake shipped.
