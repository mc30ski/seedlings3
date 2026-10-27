# Permissions / Roles / Areas — BUILD FILE

**TEMPORARY WORKING FILE. The BACKEND work has landed (2026-10-13); this is
kept for the gate assertions and the audit findings, not as a to-do list.**

> Read the step text as a RECORD of what was done. Two things in it describe
> approaches that were abandoned rather than shipped: there is no
> `requireRole` guard left to build "beside" (the enum is deleted), and there
> is **no env flag deciding which path runs** — the flag was removed, not
> flipped. Anything still outstanding is listed in
> [`permissions-UI-BUILD.md`](permissions-UI-BUILD.md). **Every numbered gate
> is now built** — G13 and G25 landed 2026-10-18 and
> `permissions-build-gate.test.ts` has no `it.todo` entries left. What is
> still missing is not a gate but a live-data test: nothing drives a route as
> a territory-limited principal, because the seed creates no AreaAssignment
> rows.

**Nothing intermediate is deployed.** One project, one arrival point — the
steps below are dependency order, not releases. No compatibility scaffolding:
build `can()` against real entitlements, not against the old roles.

The design is [`permissions.md`](permissions.md). This is the implementation
checklist — the ordered steps, every gate with its exact assertion, and the
test matrix. It exists because the design took five audit passes and each one
found something; the findings are easy to lose and expensive to rediscover.

**Before writing a line of code, read `permissions.md` in full.** This file
assumes it.

---

## The things most likely to be forgotten

Each of these was found by an audit pass, not by design. They are listed first
because they are invisible until they bite.

- [ ] **`can()` takes a resolved principal, NEVER a userId.** A userId
      signature guarantees someone adds a DB lookup, which bypasses view-as
      and restores real powers. Make the type forbid it.
- [ ] **Resolution order: roles → impersonation → entitlements.**
      `plugins/rbac.ts` swaps only `roles` today. Entitlements added as a
      sibling field on `me` will NOT be swapped, and someone with `settings.manage` "viewing as" a
      worker will silently keep full powers.
- [ ] **One exported `Scope` type before touching any tab.** Sixteen files
      declare it inline as a structural literal; the compiler cannot tell you
      which one you missed when the shape changes.
- [ ] **Every scope default must fail CLOSED.** `CrewsTab` currently
      defaulted an absent scope to one that grants — the shape G2 now fails the build on.
- [ ] **`AuditScope` needs new enum values** — a Prisma migration. `ROLE` in
      Step 1; `AREA` and `AREA_ASSIGNMENT` in Step 3. Every state change in
      this app writes an AuditEvent.
- [ ] **Backfill `areaId` on existing rows in the same migration** that
      creates the root area, or every rollup returns zero on day one.
- [ ] **A surface hidden by entitlement must not look broken.** Say
      "You can view this; you cannot change it" once at the top. This is the
      claimer bug's failure mode and it is about to become systemic.
- [ ] **Never render an empty tab.** No entitlement in a family → no tab.
- [ ] **`inventory.pull` / `expenses.charge` are seeded grants, not inferred
      defaults.** Migrate today's effective values into rows, drop the two
      columns, add the "apply worker-type defaults?" prompt.
- [ ] **A `SYSTEM` principal for cron, pay links, display tokens and chain
      rollover.** Not `null`. It must show in the audit log.
- [x] ~~**Break-glass must not resolve through `can()`.**~~ SUPERSEDED by
      decision 47 — the env-var break-glass is deleted outright. Recovery is
      re-running the starter script, which never calls `can()`.
- [ ] **Area move is ONE guided transaction** — create new node, move
      properties, retire old, audit with a before-snapshot — behind a
      typed confirm (type the area name), like the user-decline flow.
- [ ] **Retired areas are hidden from PICKERS, never from REPORTING.**
- [ ] **No per-person entitlement grants. Ever.** Every grant goes through a
      named role; an exception is a role ("Contractor — no inventory"), not a
      tick on a person. Worker-type defaults are three `isSystem` roles.
- [ ] **Roles SUSPEND, areas RETIRE.** Two steps for a role: suspend
      (reversible, grants inactive immediately, assignments survive) then
      optionally delete from the suspended state. Suspend is also the
      everyone-at-once switch — no separate mechanism. Both warn **by name**.
- [ ] **A new occurrence's `areaId` resolves: previous occurrence in the chain
      → `Job.defaultAreaId` → the property's area if it has exactly one →
      prompt.** Inheritance FIRST, so automatic chain rollover can never hit
      an unanswerable prompt.
- [ ] **No hard depth cap on the tree**; warn past four levels.
- [ ] **`Area.path` is built from IDS, not names.** Names are neither unique
      nor stable; a slug path breaks on rename.
- [ ] **"Manager" never appears in UI copy.** It is a title from a taxonomy,
      not a thing the system knows. Say "anyone assigned to this area", or
      name the area's totals. Surfaces are named for what they show — *Area
      rollup*, never *Manager dashboard*.
- [ ] **One area per property, and it is OPTIONAL** — a nullable column, no
      join table. Unassigned is allowed but warned FOR ITS CONSEQUENCE:
      "its work won't appear in any manager's view." Day-one migration puts
      every property in the root area so nothing starts invisible.
- [ ] **Area names are NOT unique.** Only ids are. The UI must disambiguate
      by full path and badge retired areas with their retirement date.
- [ ] **Creating, renaming and retiring areas needs `areas.manage`** — the tree
      decides who sees what money.
- [ ] **45 entitlements.** `materials.charge`, `money.record` and
      `clients.contribute` were all added by the route-map review —
      `clients.contribute` had been dropped as routeless until property
      photos turned out to be contribute-shaped (decision 24). It is in
      the 45 and Jake holds it.
- [ ] **`materials.charge` ≠ `expenses.charge`.** Invoice charges bill the
      CLIENT; business expenses are the company's own spend. Two books.
- [ ] **`expenses.charge` has no enforcing route today** — add the check to
      business-expense creation. Behaviour change, not a relabel.
- [ ] **`payroll.*` is NOT `books.*`.** Payroll is individual wages; books is
      the business. A bookkeeper gets books without seeing anyone's pay.
- [ ] **Geocode `User.homeBaseAddress`** (Mapbox token already in env), store
      lat/lng, derive an area's location from its properties' centroid. The
      home-crew picker suggests by distance AND prior work in that area —
      suggestions only, anyone addable. Show distance, never the address.
- [ ] **Role builder copies a base role's entitlements as a STARTING POINT**,
      with a warning that the copy travels to anyone assigned the role even
      if they are not a Worker.

---

## Step 1 — Foundations

The schema comes FIRST. An earlier draft had `can()` in step 1 and the tables
it reads in step 2 — a leftover from when step 1 carried a roles-backed stub.
Removing the stub (nothing ships between steps) removed the only reason
`can()` could come before the tables.

1. [x] ~~**Structural migration:** `STAFF` on the `Role` enum · `ROLE` on
       `AuditScope` · `CustomRole` · `RoleEntitlement` · `UserCustomRole`
       (all with `suspendedAt`, `isSystem` on CustomRole).~~ **DONE** —
       `20261011232131_add_staff_role_and_custom_roles`. Applied to dev;
       **not yet promoted to production.**
2. [x] ~~**Data migration:** backfill STAFF onto every user holding
       WORKER.~~ **DONE** — `20261011232200_backfill_staff_role`, idempotent,
       5/5 on dev. Split out because the structural migration shipped without
       it and the omission was invisible: decision 3a claimed "migration" as
       its enforcement while no migration did it. Role-less users (clients,
       mid-onboarding) are deliberately skipped. `seed.ts` carries STAFF on
       all five internal users — its `deleteMany` strips any role not listed,
       so leaving STAFF out there would silently undo this on the next
       reseed.
3. [ ] Seed the three `isSystem` worker-type default roles.
4. [ ] Export one `Scope` type. Convert all seventeen inline declarations.
       *(Independent of 1 — can run alongside.)*
5. [x] ~~Make every `scope ?? {…}` default fail closed.~~ **DONE 2026-10-11** —
       `CrewsTab` was the only one. Its `scope` prop is now **required**
       rather than defaulted: all three callers already passed it, so the
       fail-open branch is gone instead of inverted, and a caller that forgets
       it is a compile error. G2 passes.
6. [ ] One exported `ENTITLEMENTS` array + `Entitlement` union + an
       `isEntitlement()` guard, and the only write helper for
       `RoleEntitlement`. No raw string reaches the table. Add the
       union-reconciliation check to
       `apps/api/scripts/verify-ledger-integrity.ts`, which `migrate:deploy` already
       runs before and after every promotion. *(Decision 4a — the column is
       `String` by design; the boundary is what makes that safe.)*
7. [ ] `can(principal, capability)` reading those tables. No stub, no
       roles-backed shim — there is nothing between steps to stay
       compatible with.
8. [ ] Resolve capabilities inside the single auth read, **after**
       `resolveImpersonation`, from the effective roles.
9. [ ] Grant STAFF on user creation, and refuse to remove the last STAFF row
       — the ongoing half of the floor that
       `20261011232200_backfill_staff_role` only backfilled.
10. [ ] Gates: **G1, G2, G3, G4, G19, G20, G28, G30, G31, G32, G33, G34, G35, G36, G37**.

## Step 2 — Permissions

1. [x] ~~Inventory every guarded route → declare its entitlement.~~ **DONE** —
       [`permissions-ROUTE-MAP.md`](permissions-ROUTE-MAP.md), 669 pairs, 0
       unmapped, every group reviewed. **503 carry an entitlement**; the rest
       are OWNERSHIP, PUBLIC, CLIENT-PORTAL, TOP-ROLE or ROLE-GRANT.
2. [x] ~~Correct the 36 worker-guarded routes filed under manage-level
       entitlements.~~ **DONE 2026-10-11.** Deriving the base bundles from
       today's guards put `schedule.manage`, `money.approve` and
       `money.record` in WORKER. Those 36 routes are a worker acting on their
       own visit — every sampled handler resolves `currentUserId(req)` and
       enforces claimer/assignee, and `completion-splits` even comments "Auth:
       claimer, or `schedule.manage`" — so they are ownership, not management.
       `schedule.manage` 85→55 · OWNERSHIP 66→100 · `marketing.manage` 57→55 ·
       `equipment.manage` 30→29 · `equipment.view` 15→16 · `money.approve`
       12→11 · `money.record` 4→2 · new `marketing.view` group (1). 669 total
       preserved. Bundles recomputed: WORKER 16, ADMIN 35, SUPER 43, no
       manage-level leaks. Uncorrected, WORKER holding `schedule.manage` would
       have granted every worker all 85 of its routes, including
       `/change-requests/:x/approve` — which ownership cannot catch.
3. [ ] **Base bundles are DERIVED, not declared.** Re-run the join of the
       route map against the `adminGuard`/`superGuard`/`workerGuard` argument
       on each registration whenever either side changes, and replace
       `BASE_BUNDLES` in `lib/entitlements.ts` from the result. The design
       states these only in prose ("ADMIN | runs the company"), which `can()`
       cannot read, and the coverage table cannot supply them because it names
       one holder per entitlement rather than every holder.
4. [ ] Apply that map: every guarded route declares its entitlement.
5. [ ] Migrate `canPullInventory` / `canChargeBusinessExpenses` to grants
        (seeded from today's *effective* values), drop the two columns, add
        the "apply worker-type defaults?" prompt.
6. [ ] Add the missing `expenses.charge` enforcement to business-expense
        creation — behaviour change, not a relabel.
7. [ ] Role builder + permissions matrix + effective-permissions view with
        provenance.
8. [ ] Offboarding flow; dormant-access audit check.
9. [ ] Gates: **G5, G6, G7, G8, G18, G23, G24, G29**.
10. [ ] The test suite below, in full.

## Step 3 — Areas

1. [ ] Migration: `Area` (self-ref + materialized `path`), `AreaAssignment`,
        `Property.areas[]`, `JobOccurrence.areaId`, `Job.defaultAreaId`;
        `AREA` + `AREA_ASSIGNMENT` on `AuditScope`. **Create the root area and
        backfill every existing row in this same migration.**
2. [ ] `areaScope(principal)` helper, threaded like `businessStartCutoff`.
3. [ ] Area tree UI, guided move, assignment editor, **area rollup tab**,
        area selector, **area-assignment badge**, temporary-cover check.
4. [ ] `PropertiesTab` Area filter (incl. "Unassigned") + multi-select bulk
        assign; "Add properties" picker on an area node; unassigned warning
        and the "Unassigned (n)" bucket on the tree.
5. [ ] Geocode `homeBaseAddress`; area location from its properties'
        centroid; home-crew picker suggesting on distance AND prior work.
6. [ ] Gates: **G10, G11, G12, G13, G14, G16, G17, G21, G22, G25**.

## Step 4 — Join them

1. [ ] `can(principal, capability, { areaId })`.
2. [ ] Gates: **G15**.

---

## The UI phase

Deliberately NOT a fifth step. The four steps above are what the server
enforces; the browser's job is the different one of never asking for
something the server will refuse, and it has its own document:
[`permissions-UI-BUILD.md`](permissions-UI-BUILD.md).

G15 is scheduled in Step 4 above and belongs to both — it is the assertion
that a UI condition matches its route's guard, so it cannot be written until
the UI condition exists. Build it alongside the tabs, not after them.

---

## Operational decisions

Made after the design was complete, when the question "what happens when this
runs in production" was asked properly.

**Entitlements load with the auth read, uncached.** Extend the `me()` query
that already runs on every request rather than adding round trips. **No
cache until measured** — caching permissions is where the frightening bugs
live: stale authority means someone keeps powers you revoked, and it looks
like nothing is wrong. Add it on evidence, not on principle.

**The old guards stay, flag-switched.** The big change ADDS `can()` checks
*beside* the existing `requireRole` guards; an env flag decides which runs.
The old guards are deleted in a follow-up weeks later — when you are
confident, not when you are hopeful.

> One deploy changes every permission in the app at once. Without this,
> recovery from a subtly wrong resolution is an emergency deploy while nobody
> can work. With it, recovery is flipping a variable. The cost is near zero,
> because writing the new checks is the expensive part either way.

**The privilege columns are dropped in the SAME migration** as the grants
they convert to. One change, no dead columns lingering for someone to wire
back up a year later.

That removes the ability to recompute, so the conversion must be *verified*
rather than trusted. Two mitigations, both required:

1. **Assert the conversion in the same transaction.** Count users whose
   *effective* `canPullInventory` is true (through `resolvePrivileges`, not
   the raw column) and assert it equals the number of `inventory.pull` grants
   written. Same for `expenses.charge`. A mismatch fails the migration and
   rolls the whole thing back — which is the real safety net, better than
   keeping columns nobody checks.
2. **Snapshot before destroying.** The repo rule is that destructive paths
   snapshot first; write the pre-migration effective values into an
   `AuditEvent` so the inputs survive in the audit log even though the
   columns do not.

**A display may optionally bind to an area.** Unbound displays behave exactly
as today, so nothing changes for the screen already paired. The binding lives
on the `Display` row and resolves from the pairing token, so it needs no
principal — which is what makes it workable for a device with no user.

**Area scoping is verified by OUTPUT, not by code shape.** G10 catches a
missing `areaScope()`; it cannot catch `areaScope(wrongUser)`, the wrong
column, or a subtly wrong prefix match. So:

> **One integration test drives EVERY area-scopable route** as a
> Raleigh-only principal against a two-area seed, and asserts no Durham
> record appears in any response.

Driven from the route map, so it covers new routes automatically. This is the
single most important test in the plan: ~101 routes whose failure mode is a
page rendering perfectly with another territory's data in it — the same
silent shape as the view-as bug that shipped three times, in the one place a
static gate cannot reach.

**Build everything, deploy once.** The question of shipping entitlements
first and leaving areas until a second location exists was put explicitly and
declined. The halves were designed together — `can(p, cap, { areaId })` only
means anything because both exist — and incomplete intermediate states are
worse here than waiting.

> So the scope is fixed and the timeline is long. Nothing in this plan should
> be re-litigated as "could we just ship part of it" later; that was asked
> and answered.

## Decision log

Every decision made while designing this, and **what stops it being
forgotten**. A row whose enforcement is "human" is a row that will be
forgotten — those are the ones to re-read before shipping.

| # | Decision | Enforced by |
|---|---|---|
| 1 | Four axes never collapse: worker type / roles / areas / client link | human |
| 2 | `STAFF` added to `Role`; **no further enum values, ever** | G19 |
| 3 | ~~STAFF is the floor and is never removed from an active account~~ **SUPERSEDED by 40.** There is no STAFF role to keep. The lockout it prevented — demotion leaving zero rows — cannot happen when "on payroll, no roles" is a valid state and profile access is ownership rather than an entitlement | n/a |
| 3a | Existing accounts holding WORKER are backfilled to STAFF; role-less users (clients, mid-onboarding) are not | migration |
| 4 | 45 entitlements; the TS union is the source of truth | G7 |
| 4a | A stored `RoleEntitlement.entitlement` is validated against the TS union at every write, and reconciled at deploy — the column stays `String`, the boundary does the work | **G28** |
| 5 | **Roles only** — no per-person entitlement grants | G20 |
| 6 | Worker-type defaults are three `isSystem` roles | test |
| 7 | Roles **suspend** (reversible); delete only from suspended | test |
| 8 | Area names are NOT unique; only ids are | schema |
| 9 | `Area.path` is built from **ids**, never names | G21 |
| 10 | Creating / renaming / retiring areas needs `areas.manage` | G5 |
| 11 | Areas are never reparented — copy-and-retire | G14 |
| 12 | `occurrence.areaId` frozen at completion | G22 |
| 13 | New `areaId`: previous occurrence → job default → sole property area → prompt | test |
| 14 | Retag needs `schedule.manage` in BOTH areas | G16 |
| 15 | Rollup defaults to area, toggles to "My team" | Playwright |
| 15a | A property belongs to **exactly one** area — a column, not a join table | schema |
| 15b | `Property.areaId` is **optional**, but unassigned is warned for its consequence, and an "Unassigned" bucket shows the backlog | Playwright |
| 15c | Moving a property moves its SCHEDULED visits, never completed ones | G22 + test |
| 15d | Moving a property needs `schedule.manage` in BOTH areas, like retagging | G16 |
| 15e | `PropertiesTab` gains an Area filter incl. "Unassigned", plus multi-select bulk assign | Playwright |
| 15f | "Manager" never appears in UI copy — it is a taxonomy title, not a role | G23 |
| 15g | Entitlements load with the auth read, uncached until measured | G3 |
| 15h | ~~Old guards stay beside the new ones, env-flag switched, removed later~~ — **superseded.** The cord was cut instead: the flag and the old guards were removed together, so there is no period with two paths to keep in step. | G24 |
| 15i | Privilege columns dropped in the same migration, with a count assertion + audit snapshot | migration |
| 15j | A display may optionally bind to an area; unbound = today's behaviour | test |
| 15k | Every area-scopable route is output-tested against a two-area seed | **G25** |
| 15l | Build all four steps, one deploy — asked explicitly, declined splitting | process |
| 15m | ~~Roles stack freely, EXCEPT at most one `isSystem` defaults role per person~~ **SUPERSEDED by 42/44.** `isSystem` worker-type roles stop existing, and with inheritance two roles descending from a common base is normal rather than incoherent | n/a |
| 15n | UsersTab's two privilege toggles and its duplicate `PRIV_DEFAULTS` table are removed; replaced by a single "Defaults role" picker | Playwright |
| 15o | STAFF is granted to users who ALREADY hold a role — never to clients, who hold none | migration |
| 15p | `/users/:x/privileges` retires with the columns it writes | G5 |
| 15q | People are organised FLAT — no reporting line. Area ownership is accountability for a place, never authority over a person. `people.manage` and `people.grant-roles` stay global-only. | G5 |
| 15r | The flat-people principle appears in BOTH help surfaces — role builder and area assignment — in the operator's own words | Playwright |
| 16 | `AreaMembership` grants nothing; no check may read it | G17 |
| 17 | `inventory.pull` / `expenses.charge` become grants; columns dropped | migration + test |
| 18 | Custom roles are **absolute**, never deltas from a base | test |
| 19 | Builder copies a base as a starting point, **with a warning** | Playwright |
| 20 | Geocode `homeBaseAddress`; picker suggests by distance AND work history | human |
| 21 | `payroll.*` split from `books.*` — payroll is wages | route map + G5 |
| 22 | `materials.charge` (bills the client) ≠ `expenses.charge` (own spend) | route map |
| 23 | `money.record` — recording a collection ≠ approving it | route map |
| 24 | `clients.contribute` — property photos are contribute-shaped | route map |
| 25 | `crews.view`, `content.view` — every family carries both verbs | route map |
| 26 | No money/payroll route resolves to `schedule.manage` | **G18** |
| 27 | `link-clerk` needs `identity.link` — binding a login is an auth act | G5 |
| 28 | `people.grant-roles`, bounded by *cannot grant what you lack* | **G6** |
| 29 | A duplicate global+area grant shows BOTH, area flagged redundant | Playwright |
| 30 | Warn past four levels of depth; never block | test |
| 31 | One arrival point — nothing intermediate is deployed | process |
| 32 | `can()` takes a resolved principal, never a userId | G3 |
| 33 | Resolution order: roles → impersonation → entitlements | **G4** |
| 34 | One `Scope` type; every default fails closed | G1, G2 |
| 35 | `AuditScope` gains `ROLE`, `AREA`, `AREA_ASSIGNMENT` | migration |
| 36 | Root area created and every existing row backfilled, same migration | migration |
| 37 | A named `SYSTEM` principal for cron / tokens / rollover | test |
| 38 | ~~Break-glass resolves without the entitlement tables~~ **SUPERSEDED by 47.** The env-var break-glass is deleted; initial assignment is the starter script run against the database. There is no in-app recovery path left to keep correct | n/a |
| 39 | A hidden surface never looks broken; no empty tabs | Playwright |
| 40 | **`Role` and `UserRole` are DELETED.** Not collapsed, not reduced — removed. "On payroll" is `workerType != null`; "what you may do" is custom roles. A vestigial enum carrying no entitlements is a second source of truth for a fact the worker type already states | schema |
| 41 | **No entitlements until a worker type is assigned.** Onboarded with no type resolves to nothing, whatever roles are attached. Payroll classification is the gate | G31 |
| 42 | **TRAINEE stops being a worker type.** Four money call sites prove it carries no payroll meaning — `EMPLOYEE \|\| TRAINEE` everywhere. A trainee is an EMPLOYEE who has not been granted the field-work role, which is additive and needs no subtraction | G32 |
| 43 | **`UNPAID` is a worker type.** A real answer to "how is this person paid": they are not. Entitlements resolve; money must never reach them | G33 |
| 44 | **Custom roles INHERIT.** Reverses decision 18. Adding an entitlement to a base must reach everything above it, or an operator maintains N duplicated sets by hand — and other companies will model their own ladders | G34 |
| 45 | **`CustomRole.key` is immutable and stable.** The starter script upserts by key, so rebuilding baseline roles preserves ids and every assignment pointing at them. `name` is an editable label and cannot be the key | schema |
| 46 | **Ships with NO custom roles.** The dev seed populates them; production runs a starter script. Another company writes their own | process |
| 47 | **The env-var break-glass is deleted.** Initial assignment is the starter script run against the database by someone with Neon access. No lockout concept, no in-app recovery path to keep correct | process |
| 48 | **SUPER is not special.** It becomes a custom role inheriting admin. The 21 hard-gated SUPER-only routes get real entitlements (~5 new), because G8 forbids any conditional reading a role NAME | G5, G8 |
| 49 | **One shared worker-class module.** 97 comparisons across 27 files decide pay by branching on `workerType` inline, and the key predicate is a NEGATION (`!== "EMPLOYEE"`) that silently sorts any new type into the contractor-fee branch | **G30** |
| 50 | A perspective is a named SUBSET of your own entitlements — it can only ever narrow, never grant. You see a perspective if you hold its role, plus those it inherits; Client is always present because it is a separate code path, not a subset | G35 |
| 51 | A button renders ONCE, in the row of the LOWEST perspective that grants it. Two perspective-roles holding the same capability would otherwise show the same action twice on someone with `settings.manage`'s screen | G36 |

**Four rows are enforced by nothing mechanical** — **1**, **15l**, **20**
and **31**. Re-read those before shipping; they are where this will drift,
and `permissions-docs-build-gate` fails if the list grows.

Migration rows are *not* on that list, although an earlier draft of this
sentence put them there and dropped 15l to make room. A migration assertion
is mechanical, and a strong one: 15i fails the migration and rolls the whole
thing back on a count mismatch, which is more than a static gate can do.
The row the old sentence omitted — **15l**, build all four steps and deploy
once, with splitting explicitly declined — is the largest commitment in this
document and the one most likely to be reopened under schedule pressure.

## Gates — exact assertions

Write each **before** the code it guards. Both of this codebase's worst bug
classes (view-as endpoints, the claimer invariant) are silent: the page
renders, it just shows the wrong thing.

**Sequencing lives in the steps above, not here.** This table used to carry
a *Step* column and it drifted: it placed G1, G2 and G4 in Step 3 while
Step 1 claimed all three, so "write the gate first" quietly stopped holding
depending on which table you read. One home for the schedule, one for the
assertions. `permissions-docs-build-gate` asserts every gate defined below
appears in exactly one step list.

| # | Assertion |
|---|---|
| **G1** | Exactly one exported `Scope` type exists; no file declares `isWorker: boolean; isAdmin: boolean; isSuper: boolean` inline. |
| **G2** | No `scope ?? { … isAdmin: true … }`. Every default fails closed. |
| **G3** | The permission module imports no `prisma` and no cache; `can`'s first parameter is not named or typed as a user id. Both together force resolution to happen once in the auth read, which is also what keeps impersonation correct. |
| **G4** | `rbac.ts` resolves capabilities AFTER `resolveImpersonation`, from the effective roles. A capability field assigned from `me` before impersonation fails the build. |
| **G5** | Every guarded route declares an entitlement; no bare role-named guard survives outside the documented hard-gated list. |
| **G6** | You cannot grant an entitlement you do not hold. |
| **G7** | The permissions matrix config lists every entitlement in the enum — matrix is generated, never hand-maintained. |
| **G8** | No conditional anywhere reads a role, tier or title **name** string. |
| **G10** | Every area-scopable route applies `areaScope()`, or carries `// area-scope-allow: <reason>`. |
| **G11** | A worker's own job feed is NOT narrowed by area. |
| **G12** | Areas form a tree — one parent, no cycles. |
| **G13** | Retired areas are excluded from pickers and INCLUDED in reporting aggregates. |
| **G14** | No code path reparents an area; moves go through the guided copy-and-retire action. |
| **G19** | No `Role` enum and no `UserRole` table exist. Supersedes the original "exactly four values" rule — decision 40 removes the enum rather than capping it. "On payroll" is `workerType != null`; "what you may do" is custom roles. A vestigial enum carrying no entitlements would be a second source of truth for a fact the worker type already states. |
| **G20** | No per-person entitlement table exists; every grant resolves through a named role. |
| **G21** | `Area.path` contains no name-derived segments. |
| **G22** | No code path writes `occurrence.areaId` on a COMPLETED or later occurrence. |
| **G24** | **RETIRED, and replaced in place by G24a–c.** It asserted that both guard paths survived while the flag did. There is no flag and no second path: `requireRole`, `adminGuard` and friends are deleted, so the original assertion can only ever pass vacuously — which reads as coverage of a rule nothing is following. What replaced it is stricter, because "one path" is a property worth asserting on its own: **G24a** exactly ONE authorization path exists; **G24b** no route is gated by a role NAME; **G24c** `approvedUser` appears only on routes the route map calls OWNERSHIP — added after a blanket `adminGuard → approvedUser` substitution silently opened four routes, one of which let anyone grant themselves ADMIN. |
| **G25** | Every route in the route map's area-scopable groups appears in the scope integration test. A new scopable route with no coverage fails the build. |
| **G23** | No user-facing string in `apps/web` contains "manager" outside a taxonomy value. Writing it promotes a label into a role and undoes manager-as-assignment. |
| **G18** | No money-mutating or payroll-mutating route resolves to `schedule.manage`. Write-off, mark-paid, split recalculation and hours approval all resolved to it because it had become the catch-all for occurrence routes. A manager with scheduling rights could have changed worker pay. |
| **G17** | No permission check reads `AreaMembership`. Home areas are informational; a check there silently restricts where people may work. |
| **G16** | Retagging an occurrence's area checks `schedule.manage` in BOTH the source and destination area — a single-sided check lets a manager move revenue onto or off their own books. |
| **G15** | Every UI action's condition matches its route's guard. *(The Unclaim bug: UI said `isClaimer`, server said `isClaimer \|\| schedule.manage`, so a claimer-less visit could not be released by anyone.)* |
| **G28** | Every write to `RoleEntitlement` goes through the validated helper — no raw `entitlement` string reaches the table. Paired with a reconciliation in `apps/api/scripts/verify-ledger-integrity.ts` (already run before and after every `migrate:deploy`) that fails on any stored value absent from the TS union. The column is `String` by design; without this the failure mode is a grant the role builder shows and `can()` denies, with no error anywhere. |
| **G29** | No worker-guarded route is mapped to a `.manage`, `.approve` or `.record` entitlement. A worker acting on their own record is OWNERSHIP; mapping it to a manage verb and then deriving WORKER's bundle from the guards escalates every worker to that entitlement's entire route set. Caught 36 such routes on 2026-10-11. Enforced on the SHIPPED LADDER in `install-starter-roles.ts`: no `.manage` / `.approve` / `.record` / `.adjust` capability may sit in the Trainee or Worker tier, because every new install starts there. `scripts/derive-base-bundles.ts` is DELETED — it computed role contents from the guards, and roles are editable database rows now, so there is nothing to derive. |
| **G30** | No file outside the shared worker-class module compares `workerType` to a string literal in a CONDITION. Presentation lists are exempt by annotation; logic is not. 97 comparisons across 27 files decided pay inline, and the critical one was a negation — `wt !== "EMPLOYEE"` reads "therefore a contractor", so any third worker type lands in the fee branch silently. `classify()` is an exhaustive switch, so a new type is a COMPILE error rather than a default. |
| **G31** | A principal with no `workerType` resolves to zero entitlements, whatever roles are attached. Payroll classification is the gate: being in the system is not being cleared to act in it. |
| **G32** | `TRAINEE` appears in no enum, no predicate and no migration as a worker type. It carried no payroll meaning — four money call sites read `EMPLOYEE \|\| TRAINEE` identically — so it was a permission concern living in a tax enum. A trainee is an EMPLOYEE without the field-work role. |
| **G33** | No `UNPAID` user appears in a `PaymentSplit`, a payroll row, a Gusto export, or holds a non-zero `hourlyWage`. `rateFor()` THROWS when handed `UNPAID` rather than defaulting — an unpaid person charged a contractor fee is a silent money bug, and a crash is recoverable. |
| **G34** | Role inheritance is acyclic, and editing a role shows its full downstream impact before saving — which roles change and how many people. Inheritance is the point (adding to a base must reach everything above it); silence about the blast radius is not. |
| **G35** | The active perspective's entitlements are a SUBSET of the person's own, always. A perspective that grants anything is not a downgrade, and the whole point of the dropdown is that looking at the app as someone with less access is safe. Also: a perspective is only offered to someone holding its role or a role inheriting it. |
| **G37** | No source reads a field the cord-cut deleted — `.roles`, `requireRole`, a per-role guard, `resolvePrivileges`, a `Role` enum member, the `UserRole` table, `TRAINEE`, or a dropped privilege column. These reads do not fail to compile: an `as any` or an optional chain makes them silently `undefined`, and the behaviour around them changes with no error anywhere. Found three live bugs the day it was written, failing in BOTH directions — a wage gate that refused everyone including Super, a pre-cutoff reveal header that had stopped working, and a worker being served a client's payment methods. Deleting a field is therefore a two-step job: delete it, then add its name here. Paired with a structural half that keeps `roles` off the `FastifyRequest` augmentation, so the next one is a compile error rather than a scan hit. |
| **G36** | No capability appears in more than one badged row on the same screen. Rows are labelled by perspective; a capability granted by two perspective-roles must render in the lowest one that grants it, or someone with `settings.manage` sees `Cancel` twice. Unlikely, and silent when it happens. |

---

## Test suite

**Eight personas**, chosen so every structural rule has a case that would
fail if the rule were implemented wrong. `can()` is a pure function, so this
is a table test with **no database and no Clerk account** — which is why the
list can be complete before the accounts exist.

The last column is what the 2026-10-11 audit added, and it is the point of
the table: seed users are resolved **by email** and created by signing in
through Clerk, never by the seed. A persona with no account is a unit-test
row only, and cannot be clicked through.

### Personas

| | Base | workerType | Custom role | Area assignment | Clerk account |
|---|---|---|---|---|---|
| **Jake** | WORKER | EMPLOYEE | District Manager | Raleigh | `admin+employee@` |
| **Dana** | WORKER | CONTRACTOR | Regional Manager | Triangle *(parent of Raleigh + Durham)* | `admin+contractor@` |
| **Fran** | STAFF | — | Office Coordinator | — *(global)* | **none — unit only** |
| **Sam** | WORKER | TRAINEE | — | — | `admin+trainee@` |
| **Casey** | STAFF | — | Bookkeeper | — *(global)* | **none — unit only** |
| **Morgan** | STAFF | — | Payroll | — *(global)* | **none — unit only** |
| **Alex** | ADMIN | — | — | — | `admin+admin@` |
| **Owner** | SUPER | EMPLOYEE | — | Raleigh | `mc30ski@gmail.com` |

**Alex is the existing `admin+admin@` user, not a new person.** That account
already holds STAFF+WORKER+ADMIN and no SUPER, which is exactly what Alex
exists to prove — that a caller with `schedule.manage` bundle is exercised by a role rather than
through SUPER's bypass. Naming him separately in the coverage table while
the account already existed is what made him look invented.

**Fran, Casey and Morgan are STAFF-only, and no account holds STAFF alone** —
STAFF was created on 2026-10-11. Three Clerk accounts are a prerequisite for
the clickable pass; see *Seeded personas* below.

> **The roles' contents are the coverage table below, not a second list
> here.** An abbreviated copy lived at this spot and had already drifted —
> it was missing `marketing.view` within minutes of that entitlement being
> added. One source of truth, same reason `PRIV_DEFAULTS` is being deleted
> from `UsersTab`.

### Expected outcomes — the cells that matter

| Case | Expect | Rule it proves |
|---|---|---|
| Jake · `schedule.manage` · Raleigh | ✅ | assignment grants in its own area |
| Jake · `schedule.manage` · Durham | ❌ | and nowhere else |
| **Jake · `work.claim` · Durham** | **✅** | **capability is NOT area-scoped — promotion must not shrink where you can work** |
| Dana · `schedule.manage` · Raleigh | ✅ | parent assignment covers the whole subtree |
| Dana · `money.approve` · Durham | ✅ | subtree, both children |
| Dana · `inventory.pull` | ✅ | CONTRACTOR default seeded as a grant |
| **Sam · `work.claim`** | **✅** | **trainees MAY claim — `TRAINEE_CANNOT_ACT` is scoped to start/complete/manage, and must not widen to claiming** |
| Sam · `work.complete` | ❌ | TRAINEE bundle omits it |
| Sam · `inventory.pull` | ❌ | TRAINEE default |
| Fran · `schedule.view` · anywhere | ✅ | global custom role, no area needed |
| Fran · `schedule.manage` | ❌ | never granted — not "removed" |
| Fran · `work.claim` | ❌ | STAFF has no field capability |
| Casey · `books.manage` | ✅ | global |
| Casey · `schedule.view` | ❌ | a bookkeeper sees no schedule |
| **Owner · `books.manage` · Durham** | **✅** | **union, never intersection — an assignment must not cage someone with `schedule.manage`** |
| Owner → impersonating Jake · `books.manage` | ❌ | impersonation swaps capabilities, not just roles |
| Jake grants Casey `books.manage` | ❌ | cannot grant what you do not hold |
| Jake · `audit.view` | ❌ | not in his role |
| Jake · `pricing.view` | ✅ | WORKER reads the price list; only `pricing.manage` is withheld |
| Dana · `routes.plan` | ✅ | planning the day's driving is in Regional Manager |
| Fran · `routes.plan` | ❌ | a coordinator views; she does not plan routes |
| Dana · historical rollup incl. a RETIRED child area | ✅ | retired hidden from pickers, present in reporting |
| Promote Fran to WORKER | gains WORKER bundle, keeps Office Coordinator | custom roles are absolute, not deltas |
| STAFF with zero custom roles | profile + policies + announcements only | the floor |
| **Morgan · `payroll.manage`** | **✅** | **payroll is reachable WITHOUT books — decision 21, the half Casey cannot prove** |
| **Morgan · `books.view`** | **❌** | **and it drags no books access with it** |
| **Alex · `compliance.manage`** | **✅** | **a caller with `schedule.manage` bundle exercised by a role, not through SUPER's bypass** |
| Alex · `payroll.view` | ❌ | payroll is not in a caller with `schedule.manage` bundle; Morgan holds it alone |

### Seeded personas — `apps/api/prisma/seed.ts`

The matrix above is a unit test. "Extensively tested locally" needs a
clickable counterpart: every persona must exist in dev so each can be signed
in as and driven through the UI. Touching `seed.ts` means re-running
`npm run db:seed` before reporting anything done.

> **The seed cannot create these users.** It resolves them **by email** and
> throws `Seed users not found in this database` when one is absent, because
> a User row comes from a Clerk sign-in and `clearDatabase()` preserves it
> for exactly that reason. Five accounts exist today:
> `admin+admin@` · `admin+contractor@` · `admin+employee@` ·
> `admin+trainee@` · `mc30ski@gmail.com`.
>
> **PREREQUISITE — three new Clerk accounts**, to be created when there is a
> surface to drive (Step 2, not before; today they would be three STAFF users
> who can see their own profile and nothing else):
> - [ ] `admin+coordinator@seedlingslawncare.com` → Fran
> - [ ] `admin+bookkeeper@seedlingslawncare.com` → Casey
> - [ ] `admin+payroll@seedlingslawncare.com` → Morgan
>
> Each then needs a `SEED_USER_EMAILS` entry, a `shape` row with
> `roles: ["STAFF"]`, and — to be clickable — a Playwright auth state
> alongside the existing `employee` / `admin` / `super` ones.

- [ ] Jake, Dana, Sam, Alex and Owner wired to the five **existing** accounts,
      with roles, worker types and assignments. Alex is `admin+admin@` — do
      not create a sixth admin.
- [ ] Fran, Casey and Morgan once their accounts exist. Until then they are
      unit-matrix rows only, and anything needing to be *clicked* as a
      STAFF-only user is blocked on the prerequisite above.
- [ ] An area tree **four levels deep**, so the depth warning, the
      materialized path and subtree rollups are all exercised for real:
      `North Carolina` → `Triangle` → `Wake County` → `Raleigh` /
      `Cary`, plus `Triangle` → `Durham County` → `Durham`
- [ ] At least one **unassigned property**, so the warning and the
      "Unassigned" bucket are both clickable
- [ ] One **retired** area with historical occurrences under it, so the
      hidden-from-pickers / present-in-reporting rule is clickable
- [ ] Occurrences spread across areas, including **a Durham job done by
      Jake**, who is assigned to Raleigh — the case that proves capability is
      not area-scoped, and the case behind open question B
- [ ] The four custom roles as real rows, so the role builder has content

### Playwright — what unit tests cannot cover

- [ ] Role builder: create a role, tick entitlements, assign, verify effect
- [ ] Effective-permissions view shows provenance (global vs area, via which role)
- [ ] A manager can still claim a job in another area
- [ ] A read-only surface says so once, and renders no action buttons
- [ ] No empty tabs for a persona holding nothing in that family
- [ ] Super viewing-as a worker does NOT retain their own entitlements

### Coverage — all 45 entitlements have a holder

"No entitlement ships untested" was a sentence until this table made it
checkable. Two personas reach the last of the 45:

- **Morgan** proves `payroll.*` is reachable **without** `books.*` — the other
  half of decision 21. Casey is the bookkeeper who gets books without seeing
  anyone's pay; Morgan is the inverse. Folding payroll onto Casey would delete
  the thing being tested, which is why they must be two people.
- **Alex** is a plain ADMIN, so the base bundle is exercised by a role instead
  of through SUPER's bypass. **Alex is the existing `admin+admin@` account**,
  not a new person.

Every *Held by* cell must name a persona from the persona table above —
enforced by `permissions-docs-build-gate`. Before that check existed, these
two were named only here, and a reader counting personas found six while
twelve entitlements pointed at names that appeared in no table, no outcome
row and no seed list.

| Entitlement | Held by |
|---|---|
| `audit.view` | Dana (+ District Manager's set) |
| `books.manage` | Casey |
| `books.view` | Casey |
| `clients.contribute` | Jake |
| `clients.manage` | Jake |
| `clients.view` | Jake, Fran |
| `compliance.manage` | ADMIN (Alex) |
| `compliance.view` | Fran |
| `content.manage` | ADMIN (Alex) |
| `content.view` | Fran |
| `crews.manage` | Jake |
| `crews.view` | Jake, Fran |
| `documents.manage` | ADMIN (Alex) |
| `documents.view` | Fran |
| `equipment.manage` | ADMIN (Alex) |
| `equipment.view` | Fran |
| `estimates.accept` | Dana (+ District Manager's set) |
| `estimates.create` | Jake |
| `expenses.charge` | Casey |
| `inventory.pull` | Jake, Dana — **not Sam** (TRAINEE defaults omit it) |
| `marketing.view` | Fran |
| `marketing.manage` | ADMIN (Alex) |
| `materials.charge` | Jake |
| `money.approve` | Dana (+ District Manager's set) |
| `money.record` | Dana (+ District Manager's set) |
| `money.view` | Jake, Fran, Casey |
| `notify.send` | ADMIN (Alex) |
| `payroll.manage` | Morgan |
| `payroll.view` | Morgan |
| `people.grant-roles` | ADMIN (Alex) |
| `people.manage` | ADMIN (Alex) |
| `people.view` | Jake, Fran, Morgan |
| `pricing.manage` | ADMIN (Alex) |
| `pricing.view` | Jake, Dana, Sam, Fran |
| `reports.view` | Dana (+ District Manager's set), Fran |
| `routes.plan` | Dana (+ District Manager's set) |
| `schedule.contribute` | Jake |
| `schedule.manage` | Jake |
| `schedule.view` | Jake, Dana, Sam, Fran |
| `supplies.manage` | ADMIN (Alex) |
| `supplies.view` | Fran |
| `time.approve` | Dana (+ District Manager's set) |
| `time.view` | Jake |
| `work.claim` | Jake, Dana, Sam — trainees MAY claim; `TRAINEE_CANNOT_ACT` covers start/complete/manage only |
| `work.complete` | Jake, Dana — **not Sam** (TRAINEE bundle omits it) |

**Sam (TRAINEE)** holds no custom role deliberately: he is the negative case
for `work.complete` and `inventory.pull`. **Owner (SUPER)** proves the union
rule — an assignment to Raleigh must not cage him.

### Also test

- [ ] Suspended grant resolves to denied; un-suspending restores it.
- [ ] A **suspended role** denies; un-suspending restores, assignments intact.
- [ ] A **system role** cannot be deleted or suspended.
- [ ] Changing a worker type prompts, and only then swaps the defaults role.
- [ ] Two areas named "Raleigh" (one retired) resolve independently by id.
- [ ] A user with zero roles (client, or mid-onboarding) resolves to nothing,
      and is distinguishable from STAFF.
- [ ] `SYSTEM` principal bypasses `can()` and appears in the audit log.
- [ ] Every entitlement in the enum appears in at least one persona's
      expected-outcome row — **no entitlement ships untested.** Gated by
      `permissions-docs-build-gate`: an entitlement named in `permissions.md`
      that appears nowhere in this file fails the build. `pricing.view` and
      `routes.plan` were already missing when that check was written.

---

## Open

**No open design questions.** Every question raised across five audit passes
is answered in `permissions.md`, and the section below records where each one
landed.

This is not the same as "nothing left to decide." Build-plan defects found by
the 2026-10-11 audit are tracked as checklist items and gates in the steps
above, not here — an open *question* belongs in this section; an open *task*
belongs in a step where it can be ticked.

## Previously open — and where each landed

Kept because the conclusions are not obvious and will otherwise be
re-litigated. Each line is closed; none of them is an instruction to go and
decide something.

- **Question B — a Raleigh-assigned worker doing a Durham job: whose rollup?**
  **Resolved: both**, via two different filters. The rollup defaults to the
  area ("Raleigh") with a toggle to people ("My team"), because a territory's
  revenue is the territorial number. The two answers are deliberately never
  summed into one figure — that would double-count the same visit across two
  managers. Full reasoning in `permissions.md`, *Questions carried over*.
- **The "five small undecideds" at the end of `permissions.md`.** Closed —
  that section is now *Known limitations / non-goals*, and each entry is a
  decided non-goal (no subtraction, global beats scoped, tree reorganisation
  splits reports, no time-based access, projects not modelled,
  client contacts undifferentiated). Nothing
  there is awaiting a decision.
- **UI/server agreement has never been swept.** Still true, and the only
  genuinely outstanding item here — but it is implementation work, not a
  design question. Carried by **G15** and Step 2; one instance found so far
  (the Unclaim bug).
- **Client-contact granularity.** Confirmed non-goal. Revisit only if asked.
