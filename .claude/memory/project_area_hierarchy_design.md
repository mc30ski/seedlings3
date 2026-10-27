---
name: project_area_hierarchy_design
description: Permissions/roles/areas — the design now lives in docs/features/permissions.md; this is the pointer plus what the doc cannot say
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-22T00:00:00.000Z
---

**Three files, all in the repo:** `docs/features/permissions.md` is the
design. `permissions-BUILD.md` is the implementation checklist — steps,
gates with exact assertions, and the persona test matrix.
`permissions-ROUTE-MAP.md` maps every route to its entitlement.
**Start at the BUILD file**; it opens with the findings most likely to be
forgotten. Read it, not this. This file exists so a future session knows the
docs are there and knows how much they cost.

**No counts here on purpose.** Earlier versions of this note stated a line
count, a gate range and a persona count, and all three were wrong within the
day — the gate range still said G1–G15 when there were 28. The documents
state their own figures and are gated against drifting from them. Don't
reintroduce a number into this file.

**Status: LARGELY BUILT — verified against the repo 2026-10-18.** The old
line here said "everything else UNBUILT", which stopped being true. What
exists: the `Area`, `AreaMembership` and `AreaAssignment` models; the
`/areas`, `/areas/:id`, `/areas/:id/retire`, `/areas/:id/unretire` routes on
`areas.manage`; `AreasTab.tsx` as the tree UI; `areaScope()` applied across
the list reads; and `RolesTab.tsx` for roles. **G13 and G25 were built 2026-10-18** and the permissions gate now has no
`it.todo` left. G13 asserts a retired area refuses new work and stays in
reporting; G25 asserts a route narrows by the capability it is guarded on.
Neither executes a query. The design below is the reasoning, not a to-do
list — check each claim against the code.

**The "no area data" gap MOVED, 2026-10-22 — it did not close.** The old
claim here and in the index was "the seed creates ZERO AreaAssignment rows,
so scoping has never run against real data". That is now false: `seed.ts`
builds a deliberate fixture — **District Lead (Durham)**, holding Admin
*inside Durham only* with no company-wide grant, and it strips company-wide
grants and assignments to other areas first so the fixture cannot quietly
stop being "one territory" while still looking right.

What is still missing is anything that SIGNS IN AS IT. `District Lead` is
not in `PERSONAS` (`tests/e2e/helpers/personas.ts`), so no e2e run has ever
driven an area-scoped principal through the UI. Area scoping is proven by
`areaScope.test.ts` (25 cases) and by static gates — never by a request
from a real narrowed user.

**DONE the same day — the gap is closed at both layers.**

1. `areaScope.integration.test.ts` (5 cases, `npm run test:integration`)
   builds the principal the way `services/currentUser.ts` does and runs
   real Prisma queries: District Lead sees 9 of 22 properties, exactly
   those under Durham; a company-wide Super gets no filter; holding the
   capability NOWHERE yields `[]` → an impossible condition, never
   "everything".
2. **`districtLead` is the tenth Playwright persona.** Clerk test account
   `user_3L4dcamBCzjUi4HM66iShU6jRFx` /
   `admin+districtlead@seedlingslawncare.com`; the seed now carries that
   real id in BOTH upsert branches, because an older database still held
   the synthetic one and a create-only fix would leave it there.

**Two traps this sprang, worth knowing before adding persona eleven:**

- **`personaCapabilities()` read only `userCustomRole`.** A persona whose
  access is entirely an `AreaAssignment` resolved to zero capabilities, so
  the sweep's "every tab they can reach opens" test skipped itself on
  `capabilityTabs.length === 0` — and the run still reported *19 passed*.
  The one persona added to prove area scoping was the one the sweep did
  not drive. It now reads both grant kinds. A skip and a pass look
  identical in a summary line; check the `-` markers.
- Signing in did NOT orphan the fixture (one row, assignment intact, zero
  company-wide grants) — but verify that after any persona change. Five
  hardcoded seed ids once went dead exactly this way and took out 52
  tests with foreign-key errors deep inside helpers.

Scope grew well past "areas". It is now one design covering: four orthogonal
axes (workerType / roles+entitlements / areas / client linkage), a STAFF base
role, the entitlement vocabulary with its UI copy (this file said 60, the
index said 61, and `ENTITLEMENTS.length` was 63 on 2026-10-22 — the rule
above about not putting counts in this file exists for a reason), custom
roles defined in-app, the area tree, and three coexisting permission
systems.

**Why five audit passes, and what that predicts.** Every pass found
something, and the pattern is sharp: passes that invented ROLES found gaps in
the entitlement list; passes that read the ACTUAL AUTH CODE found the
dangerous ones. The worst — `resolveImpersonation` swaps only `roles`, so
entitlements added as a sibling field would hand someone with `settings.manage` full powers while
"viewing as" a worker — is three lines of code that already exist.

**The web side HAS been audited since.** G15
(`ui-capability-build-gate.test.ts`) scans the web tree for any file that
mutates behind a capability it never names. Its PENDING backlog is
shrink-only: 52 files on 2026-10-22, 14 cleared that day, 38 left. One real
bug fell out — Tasks mounted "Workdays to approve" on `time.approve` while
the endpoint is guarded on `time.manage`, so Admin and Coordinator saw the
section and got a 403 from every click.

**Two reversals worth not re-litigating:** time-based expiry was proposed and
rejected (silent failure at the worst moment; suspend + a dormancy audit
check instead). `inventory.pull`/`expenses.charge` were first kept as a
separate workerType layer, then reworked into ordinary grants seeded from
worker type — because the subtraction only existed while the default was
implicit.

**THE AREA LENS — built 2026-10-26, and it is NOT a grant.** The user's
point: "I should be able to scope down a view to an area even if I have more
permission." Grants widen (what you are ALLOWED to see); the lens narrows
(what you are LOOKING AT). One header control (`AreaLensChip`), sent as
`X-Area-Lens` carrying an Area id, resolved in `plugins/rbac.ts` onto
`principal.lensPath` — so every existing `areaWhere(principal, …)` site
honours it with **no edit**, and so does anything written later. The
per-route `?areaId=` on `/operations` was REMOVED along with the Dashboard
`area` prop: one control, not one per panel.

Three things not to undo:
- **It cannot widen.** `applyLens` intersects the chosen path with the
  granted subtrees. Outside them → `[]` → **200 with no rows**, never that
  district's data. Proven end-to-end: districtLead + a forged Chapel Hill
  lens returns 0 clients, not a 403. No header validation is load-bearing.
- **`can()` must never read it** — **G47** fails the build if anything in
  `@repo/permissions` after the type declaration does, or if any API file
  outside `areaScope`/`areaLens`/`rbac` reads `lensPath`. A lens may hide a
  row; it may never refuse an action. This is also why the lens DOES narrow
  lists for `work.claim`/`work.complete`, which a grant never narrows.
- **Persisted, therefore loud.** The chip names the area whenever one is set
  and the INSIGHTS note stops saying "the whole company". Removing the chip
  without removing the persistence recreates the exact silent failure the
  area feature exists to avoid. Hidden entirely below two selectable areas.

Binding: `area-lens-owner.spec.ts` (3 cases) + the lens block in
`areaScope.test.ts` (11 cases) + the "A grant is not a lens" section of
`docs/features/permissions.md`.

**THE SEED TREE IS TWO LEVELS DEEP (2026-10-26).** A flat tree proves prefix
matching and nothing else; depth is what decides whether scoping works.
```
All areas                      0 own   22 subtree   (no point)
  Durham        District       9       9            35.994,-78.8986   ← districtLead
  Chapel Hill   District       6       8            35.9132,-79.0558
    Carrboro    Route          1       1            35.9101,-79.0753
    Hillsborough Route         1       1            36.0754,-79.0998
  Chatham       District       0       5            (no point)
    Pittsboro   Route          5       5            35.7196,-79.1778
```
Each node is there for a reason: **Chatham holds nothing itself** (a branch
whose lens must still return its child's rows), **Chatham has no coordinates**
(so the fall-back-to-business-address path is in the fixture), and the root
now holds **zero** properties — it is the container, not a place.
**Nothing is reparented to build this** — Durham and Chapel Hill keep their
ids and paths, so the districtLead fixture, the e2e id constants and any
hand-set coordinates survive a reseed, and the app forbids reparenting anyway
(G14). Verified after reseeding: Chapel Hill lens → 8 (not its own 6),
Chatham → 5, Carrboro → 1, and a Durham lead lensing Pittsboro → 0.

**`/statistics` — SCOPED, and deliberately NOT moved to `reports.business`
(2026-10-26).** The move was the tidier-sounding option and was WRONG:
**Admin and Bookkeeper hold `reports.view` and not `reports.business`**, so
it would have removed the screen from company-wide staff in order to narrow
it for one district lead. Three dev accounts would have lost it. Check who
holds what before re-proposing it. `areaWhere` already draws the line
correctly — a company-wide holder gets an empty fragment and an unchanged
query (Admin: 44 occurrences, no filter, `areaScope: null`); only an
area-limited holder narrows (District Lead: 10, one path, labelled).

The response carries `areaScope: { names } | null` so the page can say the
figures are a slice. **That label is not optional**: hours and pay count only
work inside the area, so somebody who also worked the next district shows
LESS than they earned — an unlabelled per-person earnings figure is the one
that ends up in a pay conversation, wrong in the direction that costs the
worker.

**STATISTICS TAB REINSTATED, and a `District Lead` ROLE created
(2026-10-26).** `StatisticsTab` had been unwired from both shells per
operator preference, so the scoping above had no screen. It is back under
**Insight → Statistics** on `reports.view` (not Money — it reports PEOPLE;
its per-person earnings are separately gated on `payroll.view` and omitted
by the server without it).

INSIGHTS and Statistics are DIFFERENT reports, which is why both were
wanted: `/operations` is the business (jobs, revenue, equipment, estimates,
3 summary team numbers) on `reports.business`; `/statistics` is the people
(per-worker jobs, actual vs estimated minutes, efficiency, earnings) on
`reports.view`.

**`reports.business` was NOT added to Admin.** It is kept off that tier
deliberately so INSIGHTS stays hidden from Admin, and "District Lead" was
only ever the Admin role pinned to Durham — so granting it there would have
handed INSIGHTS to every company-wide Admin. Instead `install-starter-roles.ts`
now installs `seedlings.district-lead`: inherits Admin, adds the single
capability. 8 starter roles now, not 7. **Production needs
`install-starter-roles.ts --apply`** for it.

The seed's districtLead fixture holds District Lead (not Admin) inside
Durham, and deletes any Durham assignment carrying a different role so a
reseed cannot leave the persona holding both.

Verified after reseeding — Admin Worker is UNCHANGED, which was the point:
| person | INSIGHTS | Statistics | pay | area |
|---|---|---|---|---|
| District Lead | yes | yes | yes | Durham |
| Bookkeeper | no | yes | no | company-wide |
| Admin Worker | **no** | yes | yes | company-wide |
| Michael (Super) | yes | yes | yes | company-wide |

Driven through the UI: the lead's Statistics reads 9 occurrences labelled
"Durham only…", their INSIGHTS returns Durham's rollup; the Bookkeeper gets
43 occurrences, `areaScope: null`, no notice, and `totalEarnings` omitted.

**`playwright/.auth/admin.json` and `super.json` are STALE (Oct 17) and
auth-setup does not write them** — no `admin` or `super` entry in its
persona list. A spec using them fails on a dead session, which reads exactly
like a code failure; it cost a wrong diagnosis here. Use `bookkeeper` for a
company-wide `reports.view` reader.

**THE "DURHAM ONLY" NOTICE IS APP-WIDE (2026-10-26)** —
`AreaScopeNotice.tsx`, mounted ONCE in `pages/index.tsx` under the
breadcrumb, above whatever tab is open.

The gap it closed: scoping ran through ~30 query sites across 11 files and
exactly TWO said so (the Statistics tab and the INSIGHTS note). Worse, the
header lens chip **hides itself when there is nothing to choose between** —
which is precisely the grant-limited case — so **districtLead, the person
most affected, had no indicator anywhere**. Shorter lists on Jobs, Clients,
Payments and the schedule, nothing naming Durham. That is the exact failure
the area design exists to prevent.

- Driven by **`me.areaScope: { names, mixed } | null`**, computed in
  `users.me()` from the caller's own grants (the three `areaAssignments`
  includes now select `name` as well as `path`).
- **`mixed`** = they also hold something company-wide, so only SOME views
  narrow; the wording softens rather than claiming every tab is filtered.
  Overstating would be its own bug — a notice found wrong once stops being
  believed when it matters.
- A **lens** outranks a grant in the wording: it is narrower by
  construction and is what the reader just chose.
- If the cached lens NAME is missing but the id is set (cleared storage), it
  resolves from `/me/areas` rather than saying the useless "One area".
- **It sits ABOVE the tab row** — a sibling placed BEFORE `<BreadcrumbNav>`,
  inside a fragment (that element was the lone child of its conditional).
  Never AFTER it: BreadcrumbNav renders the active tab's content as its own
  CHILD, so a sibling after it lands below the entire page. That is where
  it first went — y=1305 on a 1376px page — and it read as a *flicker*,
  because switching tabs changed the content height and slid the strip in
  and out of view at the bottom. Two attempts to reproduce that by polling
  for mount/unmount returned 0 flips; measuring its COORDINATES found it.
- **G21 GOT SHARPER on the way (2026-10-26).** It flagged the trail code as
  a false positive — a TYPE ANNOTATION (`{ path: string; name: string }`)
  looked like a path built from a name — so a carve-out was added beside
  the existing `path: true` one. Checking the rule still fired afterwards
  turned up a REAL pre-existing hole: it matched `\bpath\b`, so
  `const areaPath = parent.path + slugify(area.name)` slipped through
  entirely, and that is precisely the variable name someone writes when
  building one. Now `[A-Za-z]*[Pp]ath`. Verified against eight cases, real
  and benign.
- **IT SHOWS THE CHAIN, AND IT IS PURPLE.** `<pin> Showing Chapel Hill →
  **Carrboro** only` — ancestors in normal weight, the area you are
  actually in bold. A bare leaf name cannot say how much of the business is
  out of view, and two districts may each have a route called "North". The
  trail is built SERVER-side (`me.areaScope.trails`, and `trail` on each
  `/me/areas` option) because only the server can name an ancestor the
  viewer may not be allowed to select; the root is dropped, since prefixing
  every trail with "All areas" says nothing. Purple matches the lens pin in
  the title bar — the two state the same fact, one in an icon and one in
  words, and orange read as a warning.
- **ONE ROW AT EVERY WIDTH**, reading `<pin> Showing **Durham** only`. It
  is a standing condition — an area-limited person sees it on every screen
  of every session — so it costs a line, not a paragraph; it first ran to
  THREE lines on a 390px phone. 28px tall on a phone, 32px on desktop.
  The `mixed` qualification (some views narrowed, some not) lives in the
  `title` tooltip rather than the line.
- **DISMISSIBLE — but only when there is a lens to dismiss.** The × calls
  `setAreaLens(null)`, which purges cached responses and fires the
  changed-event, so the app widens immediately (verified: 5 clients → 16).
  A GRANT-limited reader gets no ×: their view is not a choice they made,
  it is what their access IS, so a dismiss there could only do nothing or
  lie — and a control that does nothing teaches people to distrust the
  notice it sits in.
- Do NOT add per-tab notices. That repeats the mistake the lens avoided by
  moving to the principal: a thing every new view must remember, where
  forgetting is invisible.

Verified: districtLead sees it on Jobs, Clients AND Payments; a
company-wide Bookkeeper sees nothing until they set a lens.

**HOW A PROPERTY GETS AN AREA (UI built 2026-10-26).** Four ways, and
until now none of them was reachable from the app:
1. **Explicit on create** — `POST /properties` takes `areaId`. The property
   dialog now has an Area picker that sends it.
2. **Inherited** — if none given, `properties.create` adopts the client's
   other properties' area, but ONLY if they all agree; a client split
   across two districts leaves it null rather than guessing. The response
   says which happened via `areaResolvedBy`.
3. **Retagged** — `PATCH /properties/:id/area` (`areas.manage`). The edit
   dialog calls this SEPARATELY from the property patch, because
   `properties.update` deliberately does not write `areaId`: moving has
   consequences the plain patch skips — unfinished visits follow, completed
   ones stay where the work happened (G22), a retired area is refused, and
   the audit records the count. The success toast reports how many visits
   moved.
4. **The seed**, by city.

**"Which properties are in this area?"** is the Areas tab: selecting an
area lists them, SUBTREE included so the list agrees with the count beside
the name (Chapel Hill → 8, not its own 6), with rows from a child marked
"below". Served by `GET /properties?areaId=`, which resolves the id to a
path server-side; `areaId=none` asks for the untagged ones. It is ANDed
with the caller's own `areaWhere`, so it only ever subtracts.

**G46 caught a real bug here**: AreasTab GETs `/properties`, guarded on
`clients.view`, which somebody holding `areas.manage` need not have — the
403 would have arrived as an empty card with no explanation. The read is
now gated on `scope.can("clients.view")`.

**JOB CARDS SHOW THE PROPERTY'S AREA (2026-10-26)** — a purple
`· Durham` beside the property, on JobsTab and ServicesTab. The payload
carries it now: `area: { select: { name: true } }` was added to the six
property selects in `services/jobs.ts` that already carry `street1`
(5 occurrence-shaped + the jobs list). Name only — the card states where
the work sits, it does not filter by it.

**A COLLAPSED JOBS CARD HAS NO ADDRESS.** The request was "next to the
property address", and the expanded card does have one (the `MapLink`
block) — but a closed card identifies the property by NAME, and that is
what a person scanning a list actually reads. The badge is in BOTH places
for that reason. Finding this cost several passes of DOM-hunting: the tab
renders through more than one card variant, and the first two edits landed
on ones that were not on screen. If a badge does not appear, check WHICH
renderer is live before assuming the data is missing.

**IT IS A `<Badge>`, ON THE SAME ROW** — purple, subtle, beside the address
(or beside the property NAME on a collapsed job card, which has no
address). First shipped as a `· Name` span trailing the link, which wrapped
onto its own line and read as a separate fact rather than a qualifier on
the address. The address rows are `HStack`s for that reason.

Also on the **property card** in PropertiesTab, not just inside its editor:
"which area is this in" is a question you ask while scanning a list, and
having to open each property to answer it is how a mis-tagged one goes
unnoticed. `properties.list` includes `area: { id, name }`.

Changing that row to an HStack broke a stale matcher in
`job-materials-build-gate.test.ts` — it looked for `<Box fontSize="sm">` +
`<MapLink` and silently stopped finding the panel it polices. Widened to
`<(?:Box|HStack)`; the vertical-rhythm rule itself (owns its top gap, sets
no bottom margin) is unchanged and still enforced.

Omitted entirely when the property has no area — a blank badge reads as a
territory called nothing. Tasks and reminders have no property, so they
correctly show none (60 of 65 occurrences in the dev fixture carry one).

**ONE PERMANENT ROOT, decided 2026-10-26.** Every area sits under "All
areas"; there are no other top-level areas and the root cannot be retired.
The reason is structural, not taste: area scoping is a PATH-PREFIX match, so
one root makes "the whole company" a single prefix. A second root creates two
disjoint trees and then NO prefix means everywhere — a company-wide grant
would have to be two grants and the lens's "All areas" would mean "both
trees", which no path can express. Retiring the root is the same failure from
the other end: it closes the coordinate system every area-scoped query matches
on while every row still points into it.

- `areas.create` refuses a null parent once any area exists
  (`AREA_NEEDS_A_PARENT`); null is allowed ONLY to bootstrap an empty tree.
- `areas.setRetired` refuses the root (`AREA_IS_THE_ROOT`). This is a
  SEPARATE check from the pre-existing live-children / open-work guards —
  clear both and the root would otherwise have gone.
- **Renaming the root stays allowed.** The label is free to change because
  paths are built from ids (G21). It is retire and delete that are
  impossible; delete always was (no service method, FK `onDelete: Restrict`).
- The root also shows **no tier and no lat/lng** — it is the container, not a
  place. Its weather is the business address. See [[reference_weather_config]].
- **NOBODY IS ASSIGNED TO THE ROOT** (`areas.assign` refuses it,
  `AREA_IS_THE_ROOT`). Not tidiness — a correctness rule. "This role at the
  root" and "this role company-wide" read as the same sentence and are NOT
  the same query: a company-wide grant applies **no filter**, while a
  root-scoped one filters `area.path startsWith <root>`, and a relation
  filter cannot match a row whose `areaId` is null. Untagged records are
  allowed, so the two diverge the moment one exists — and the symptom is a
  page that renders perfectly with rows missing. The way to say "everywhere"
  is the ordinary global role grant. (Dev has 0 untagged properties,
  occurrences or jobs today, so the divergence is LATENT, not observable —
  do not go looking for it in the current data and conclude it is not real.)
- The root editor is therefore **a name field and nothing else**: no tier, no
  coordinates, no Retire, no assignment panel.
- Enforced by `areas.root.integration.test.ts` (6 cases, `npm run
  test:integration`). The UI hides both actions, which is exactly why the
  service test exists: hiding a button is not enforcement.
- All the "sole root" special-casing (`/me/areas`, the lens picker, the tier
  field, the coordinates) keys on **sole root**, not "is a root" — so if a
  second top-level area is ever deliberately allowed, each becomes a real
  slice and the fields come back on their own.

**The materialised `path` is no longer rendered in AreasTab** — it was a
debug line in the area editor; the user asked for it gone 2026-10-26.

See also [[reference_view_as_endpoints]], [[reference_claimer_invariant]],
[[feedback_config_driven_taxonomies]].
