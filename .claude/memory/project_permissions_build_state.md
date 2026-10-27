---
name: project_permissions_build_state
description: "Permissions/entitlements/areas build — the backend is DONE and green; the UI is the whole remaining phase"
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-13T00:00:00.000Z
---

**Started 2026-10-11. Backend complete as of 2026-10-13. Nothing committed,
nothing deployed** — the user commits; see
[[feedback_never_push_without_permission]].

**There is no feature flag.** `ENTITLEMENTS_ENABLED` is DELETED, and so is the
legacy branch it switched: `requires(entitlement)` asks `can()` and nothing
else. G24a fails the build if a readable flag or a `requireRole(` call comes
back. Any note claiming "flag OFF so behaviour is unchanged" is describing
2026-10-11, not the code.

Full detail lives in `docs/features/permissions.md` (design),
`permissions-BUILD.md` (backend steps + gates) and
`permissions-UI-BUILD.md` (the remaining phase). `permissions-ROUTE-MAP.md` is
maintained BY HAND (639 rows) — **there is no committed generator script**, and
two ad-hoc reconcile scripts destroyed it in the past by rewriting rows they
did not understand. **G5 fails the build whenever it and the guards disagree**,
which is what actually keeps it correct. Read those, not this.

## Verified numbers (2026-10-13 — re-verify, they move)
- **60 entitlements** in `packages/permissions/entitlements.ts`, each with a
  human sentence the UI can render.
- **639 routes** total; **496** carry a `requires(...)` guard. The rest are
  `approvedUser` ownership routes (~95 endpoints) and public/webhook paths.
- **34 route files**, **36 build-gate files**, **43 G-numbered assertions**.
- Build gate: **58 files / 2037 tests green**. `tsc` clean in both apps.
- Starter ladder, by INHERITANCE: Trainee 13 → Worker 16 → Admin 37 → Super 60.

## What the backend now looks like
- **The route layer is split by RESOURCE** — 19 files
  (occurrences, jobs, customers, money, books, people, time, equipment,
  supplies, policies, documents, crews, timeline, vehicles, displays, reports,
  settings, weather, calendarFeeds) plus `_shared.ts`. `client.ts` KEPT — the
  client portal is its own dedicated path, not mixed with custom roles, and the
  user confirmed that twice.
- **No role name survives in a URL or in a guard name** (G24b, and now G41 for
  role names ANYWHERE in a path). `HEAD` has **431** role-prefixed route
  declarations across **354** distinct paths; the working tree has **0**. Of
  those, **33** verb+suffix combinations already had a bare `/X` twin and had
  to be merged first, and **9** existed under both an `admin` and a `super`
  prefix — same handler, same entitlement, differing only in whether
  hidden rows came back, so the client chose its own privilege level by
  picking a URL. Two parallel endpoints for one resource is the worked
  example of why: two expressions of one rule, drifted, and the drift was a
  hole.
- **`approvedUser` is not an entitlement** — a check every person passes is not
  a check. It marks the ownership routes, which then scope their own query.
  G24c treats `approvedUser` on a route the map does not call ownership as
  privilege escalation.
- **The `CallerCan` channel** — services take a `callerCan` function parameter
  instead of re-reading the caller from the DB. 13 fresh reads closed. A fresh
  read restores real powers through an active lens, and that bug shipped three
  times; see [[feedback_role_resolution_from_req_user]].
- **Scripts 44 → 17**, and `scripts/` is in `tsconfig.json` `include` so they
  typecheck. The two purge scripts memory called "kept as the record" are
  records, not code — they live at `docs/history/*.txt`.
- `supplies.hold` is the ONLY entitlement checked purely in-handler rather than
  at a route guard.

## Entitlement probe
`apps/api/scripts/_entitlement-probe.ts` registers the real route modules,
stubs only `requireApproved`, and drives all **496** guarded endpoints both
ways: **496 refused without the entitlement, 496 allowed with it, 0 failures.**

**Its honest limit:** it reads each route's required entitlement from the same
guard it is testing, so it proves the guard FIRES and fails closed — it cannot
prove the guard requires the RIGHT entitlement. That question is G5's (guard vs
route map). Not yet a permanent gate; making it one is an open option.

## Deep audit 2026-10-13 — fixed, and still open

**Fixed this pass (all gated so they cannot regress):**
- **`areas.assign()` was a G6 bypass.** It granted a role inside an area with
  NO `assertMayGrant`, so `areas.manage` alone let its holder assign a role
  holding every entitlement to anyone. Unreachable only because
  `areas.manage` sat in one starter role — a seed fact, not a check. Now
  takes `actorCapabilities` and runs the same flattened check
  `customRoles.assign` does; the G6 gate was scoped to `customRoles.*` by
  FILE, so it is now extended to the `assign()` method in `areas.ts`
  (negative-controlled).
- **Two bugs in one read in `GET /occurrences`** (`effectiveNotCleared`).
  Both are fixed; the code comment at the site is the long version.
  1. **Wrong entitlement.** Field clearance read `inventory.pull`; it is
     `work.claim`. The starter Field Clearance role grants claim, complete
     and pull together, so the two travelled as one and the wrong read never
     showed — until a grantable "May pull inventory" role broke the coupling
     on purpose, for the office person who fetches supplies and never runs a
     visit. That person was then treated as field-cleared and handed the
     uncleared-redaction BYPASS: other workers' splits, promised payouts and
     processor fees. **Third copy of this mistake**; the canonical answer is
     `isFieldCleared()` in `apps/web/src/lib/scope.ts`.
  2. **Perspective bypass.** The read was an unconditional
     `userCan(prisma, uid, …)`, correct for view-as and wrong for the
     ordinary case: with no `?viewAsUserId`, `uid === callerUid`, so it
     fetched the caller's REAL grant and ignored any active perspective.
     It now uses the same `uid === callerUid ? callerCan(req, …) : await
     userCan(prisma, uid, …)` shape as `effectiveCanManageSchedule`
     immediately above it. **G39 missed it because its `CALLER_ID` regex
     listed variable names and `uid` was not one of them** — now widened to
     `uid` and `user.id`.
- **`DELETE /photos/:id` had no ownership check.** The cross-job gallery
  delete ran on `schedule.contribute`, which **baseline Trainee holds and
  every role inherits**, so the least-privileged account could hard-delete
  any worker's proof-of-work photo plus its R2 object. Its per-occurrence
  sibling always enforced "your own photos only" on the SAME guard. Now
  requires ownership or `schedule.manage`.
- **`admin-mark-paid` → `mark-paid`.** A role-named URL survived the whole
  rename because the path gate only compared path SEGMENT 1 against exactly
  "admin"/"super" — it never checked `worker`/`staff` at all, nor a role word
  used as an action qualifier. New **G41** bans a role name anywhere in a
  path; `worker` as a domain noun (`/workers`, `worker-type`) stays legal.

**Entitlement narrowings APPLIED 2026-10-13** (the user said do them). Each
is proved functionally, not just by a gate — `apps/api/scripts/_verify-redaction.ts`
drives the real handlers with chosen principals and asserts on the RESPONSE
BODY, because "a guard fired" and "this field is absent" are different claims
and only the gate proves the first:

- **`GET /users` + `GET /users/:id`** — guard STAYS on `people.view` (seeing
  who is on the team is genuinely roster information); `hourlyWage`, `email`,
  `phone`, `homeBaseAddress` — and on the list, `roleGrants` + `capabilities`
  — now require `people.manage`. The list was the worse leak: `users.list`
  queries with `include` and no `select`, so EVERY User scalar shipped.
- **`/workers/earnings-today`, `/users/:id/earnings-summary`** —
  `people.view` → **`payroll.view`** (Admin+). Self-service equivalents are
  separate routes on `approvedUser`, so nothing a worker needs moved.
- **`/statistics`, `/operations`** — guard STAYS on `reports.view` because
  both feed the main dashboard for everyone; the per-worker MONEY columns
  (`totalEarnings`, `netEarnings`, `totalExpenses`, plus `wageGross` and
  `avgHourlyRate` on `/operations`) now require `payroll.view`. Moving the
  guard would have broken the worker dashboard.
- **`/occurrences/unapproved-hours{,-count}`** — `schedule.view` →
  **`time.approve`** (Admin+), matching the sibling WRITE. **NOT `time.view`,
  which the audit suggested: `time.view` sits at the top of the starter ladder,
  so it would have broken hours approval for holders of `schedule.manage` — the people who do it.**
  Always check the ladder before narrowing.
- **`/occurrences/:id/comms-handoff`** — still `schedule.view`, but the
  handler now requires you to be ON the visit, or to hold `money.record` /
  `schedule.manage`. It returns client phone/email AND mints a public payment
  token as a side effect of a GET; its POST twin was already stricter.
- **Marketing over-restriction fixed** — `marketing.view` gated exactly ONE
  route while every other marketing read sat on the write verb. Six pure
  content reads moved to it (`/promotions`, `/promotions/:id`,
  `/promotions/allowed-domains`, `/vanity`, `/vanity/:id`,
  `/vanity/animation-settings`). Deliberately NOT moved: anything carrying
  client PII or editor payloads (`/promotions/contacts`, `…/deliveries`,
  `…/landing`, `…/invoice-photos`).
- **Guides approval queue** — `content.approve` →
  `content.view` (Admin+), which is what `content.view`'s own copy promises.

**Cron now fails CLOSED** (`G42`, negative-controlled). All four `/cron/*`
routes carried `if (secret && header !== …)` — which ALLOWS the request when
`CRON_SECRET` is unset, because `&&` short-circuits. Nothing stood behind it:
`plugins/auth.ts` does not reject unauthenticated requests, it sets
`req.auth = {}` and continues. One shared `cronAuthorized` helper now refuses
in production when no secret is configured (503) and compares the bearer
timing-safely. Non-production with no secret still allows, deliberately —
that is how the jobs are exercised locally and dev has no `CRON_SECRET`.

**The route map now has a GENERATOR**, `apps/api/scripts/build-route-map.ts`
(`npm run routemap`, `routemap:check`). **I corrupted the map a third time
before writing it**, in exactly the way the previous two ad-hoc scripts did: a
regex matching only `## entitlement.name (n)` headers, which silently merged
the OWNERSHIP / PUBLIC / CLIENT-PORTAL / SYSTEM sections into whichever
entitlement group preceded them — 639 rows still present, ~143 in the wrong
bucket, G5 green, G18 and G24c red. **Never hand-reconcile this file; run the
generator.** It preserves everything above the first group header (the prose
findings) and derives the body from the guards.

**Still open (not policy calls — unverified or unowned):**
- `confirmPdfUpload` (`services/policies.ts`) writes a compliance PDF's R2
  key and digest with no audit, and already takes an unused `currentUserId`.
- ~~`Property.areaId` never set on create.~~ **FIXED 2026-10-14**, and it was
  real — verified directly, not taken from the audit. `properties.create` now
  accepts an optional `areaId` and, when absent, INHERITS from the client's
  other properties if they all agree, leaving null only when the client spans
  districts and any guess would invent data. The audit event records `areaId`
  and `areaResolvedBy` (`caller` | `inherited-from-client` | `unassigned`):
  "unassigned" is a legal state with a real consequence, so it belongs in the
  trail rather than being inferable from an absence.
- `customRoles.remove` returns 500 rather than 409 when other roles inherit
  from the target (FK is correctly `Restrict`; the error mapper handles only
  P2002/P2025), and its pre-delete snapshot omits `areaGrants`. **Unverified.**
- An orphan `CustomRole` "May charge business expenses" (keyless, held by a
  seed user) that no script reconciles. **Unverified.**
- A redundant second index on `CustomRole.key`. **Unverified.**
- ~21 dead `prisma.user.findUnique({ where: { id: uid }, })` reads with an
  empty second argument — leftovers from stripping `include: { roles }`.
- The audit gate's `MUTATION` regex omits `$executeRaw`, and `SCAN_DIRS`
  skips `lib/` and `plugins/` (16 Prisma writes live there).
- The view-as gate only checks that the STRING `viewAsUserId` appears, never
  that a capability gates it. Four payroll routes carry a bare
  `void req.query?.viewAsUserId;` to satisfy it; those four are correctly
  gated, but the same line would launder an ungated route.
- `apps/web/src/lib/types.ts` still exports `type Role = "SUPER"|"ADMIN"|
  "WORKER"` as the type of `TabPropsType.purpose`. It is the SURFACE
  selector, which is permitted — but it is named for the deleted concept.

## Remaining
- **The UI is the whole phase.** Plan at `docs/features/permissions-UI-BUILD.md`
  — perspective/surface split first, then `TAB_REQUIREMENTS`, then the 403
  path, then the known-broken repairs, then the new surfaces. **All of this
  shipped** (2026-10-16/17): a refusal now runs through `refusalPhrase()` in
  `InlineMessage` instead of printing `NOT_AUTHORIZED`, and **G15 IS built**
  in `ui-capability-build-gate.test.ts`.
- **Stage 10 — IN PROGRESS, 2026-10-14.** Area scoping was far less wired up
  than these notes said: **3 call sites, all in `money.ts`**, while 16 other
  route files imported the helper and never called it. (An earlier count of
  "40 call sites across 17 files" was wrong — it counted import lines.)
  - `apps/api/scripts/_area-scope-probe.ts` (`npm run areas:check`) is the
    OUTPUT test that was missing. It drives every area-scopable GET as a
    principal holding the capability ONLY inside Durham and asserts no Chapel
    Hill id appears anywhere in the response — shape-agnostic, so it needs no
    knowledge of each route's payload.
  - **10 reads were returning another district's rows. Now 0.** Threaded:
    `/properties`, `/clients` (plus its nested property preview — the client
    row was scoped and the rows inside it were not), `/occurrences`,
    `/occurrences/available`, the ghost projection, `/change-requests`,
    `/photos`, `/occurrences/unapproved-hours`, `/operations`.
  - It also proves filters NARROW rather than empty: 10 routes come back
    clean AND still carrying Durham's own rows. A filter returning nothing
    would otherwise read as a pass.
  - `THREADED` grown 1 → 6. Binding it surfaced 32 more routes with no
    filter. **All 32 are now resolved and `PENDING_AREA_THREADING` is
    EMPTY** (2026-10-15), split three ways:
    - **13 threaded** — `/jobs`, `/jobs/archived`, `/board`, and the four
      counts (`/change-requests/pending-count`,
      `/occurrences/unapproved-hours-count`, `/ghost-expiry-counts`,
      `/stream-pauses/reminders/count`). A count that disagrees with the
      list it summarises is worse than either being wrong alone.
    - **8 annotated as caller-scoped or non-territorial** —
      `/occurrences/mine|pinned|liked`, `/reminders` (personal rows; area
      would narrow "my jobs" to "my jobs in my district" and hide cover
      work), plus the contact lookups and weather.
    - **17 annotated as BY-ID READS**, under one rule worth remembering:
      **lists narrow, records reached by id do not.** `work.claim` and
      `work.complete` are deliberately never area-scoped so people can cover
      another district — area-filtering the by-id reads would block a
      covering worker from the photos, site hints and comments they need to
      do the visit. Discovery is territorial; doing the work is not. You
      also cannot reach these without already holding the id, and every list
      that hands ids out IS filtered.
  - Gotcha: a long `area-scope-allow` comment on
    `/occurrences/:id/invoice-preview` pushed its `callerCan(req,
    "money.view")` outside the fixed window the job-materials gate matches
    on, breaking an unrelated test. Comments have load-bearing positions
    here; keep annotations short near window-matched assertions.
  - New in `lib/areaScope.ts`: `withArea()` (merges via `AND`; spreading at
    the top level silently loses one side when a query already uses
    `area`/`areaId`) and `areaWhereOn()` (for `Job`, relation `defaultArea`).
  - Gotcha that bit twice: passing an object literal through a generic helper
    loses the contextual typing that checked enum fields, so
    `workflow: { in: [...] }` widens to `string[]`. Pass the Prisma
    `WhereInput` type argument explicitly.
- **G25** — BUILT 2026-10-18, but not as originally planned. It asserts every
  area filter narrows by the capability its route is GUARDED on, which is the
  wrong-filter half G10 cannot see: a wider capability held company-wide
  returns `{}` and stops narrowing entirely, while a filter is still present.
  19 call sites, all matching.
  **What it still does NOT do** is drive a route as a Raleigh-only principal
  and assert no Durham row appears. That needs a territory-limited persona and
  the seed creates ZERO AreaAssignment rows — see [[project-deferred-work]].
- **The full Playwright suite has never completed cleanly in isolation.** Three
  runs were contaminated by my own doing — source edited mid-run twice, and two
  suites run concurrently once. Until one run finishes alone, "e2e is green" is
  not a claim anyone can make.

## Blocked on decisions (not on code)
- ~~`books.*` / `payroll.*`: territorial or global-only?~~ **DECIDED
  2026-10-14: GLOBAL, never territorial.** The company's books are the
  owner's; there is no district P&L. The Money heading in
  `docs/features/permissions.md` said *(area-scopable)* while resolved
  question C said the opposite — corrected, and a gate now fails if any money
  capability joins `SETTLED_SCOPABLE`, so it cannot drift back. `money.view`
  IS filtered on the payment reads, which is not a contradiction: it narrows
  which VISITS' money you see, not the books.
  **Also decided:** `/operations` IS territorial (threaded); the AUDIT LOG is
  not, because most audit events belong to no area and a filter would hide
  some with no rule a reader could state.
- ~~Dev R2 image buckets are EMPTY.~~ **MOSTLY RESOLVED** — listed read-only
  2026-10-13: property-photos 53, equipment-photos 3, guide-media 11, docs 251,
  promotion-images 12, receipts 1. **Only the default `photos` bucket is still
  0**, so job/visit photo fetches are the remaining known-bad surface, not
  every media fetch.
- ~~Three Clerk accounts needed for the coordinator / bookkeeper / payroll
  personas.~~ **RESOLVED** — verified 2026-10-13: `auth.setup.ts` mints a real
  Clerk sign-in ticket for each of the 10 personas by hardcoded `clerkUserId`
  and all 10 authenticate, and its "resolve seed user ids" step confirms a
  `User` row for each. There is no skip path, so a green auth-setup IS the
  proof. (The seed still cannot CREATE users — it resolves by email and throws
  if absent.)
- `install-starter-roles.ts` is UNTRACKED in git. It is the only path to the
  baseline roles; it needs committing.

## The lesson worth carrying
**Verify the thing, not the thing next to it.** Every bad call this build came
from that: I grepped `impersonatedContact` and missed `effectiveClerkUserId`,
so any employee forging a header got client data; I checked the working tree
instead of the git index and missed a staged rename; I checked for API restarts
instead of concurrent suites and called a contaminated e2e run clean.

And **three gates were green for the wrong reason** — G4 compared import
positions, G21 fired on an unrelated Zod `path: ["slug"]`, G26 checked a string
the seed happened to contain. All three only surfaced from deliberately trying
to break them. A passing gate is not evidence until someone has tried to make
it fail; every gate added since has a negative control.

See also [[reference_capabilities_model]], [[reference_build_gates_roster]],
[[project_area_hierarchy_design]], [[reference_view_as_endpoints]],
[[feedback_never_ship_a_red_spec]].
