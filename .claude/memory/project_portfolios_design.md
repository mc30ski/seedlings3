---
name: project_portfolios_design
description: "Area → Portfolio. Tree + membership shipped and IN PRODUCTION. 2026-11-01: nodes can be REPARENTED (G14 rewritten, not deleted), retired+empty ones DELETED, money has ONE grouping. Canonical spec: docs/features/portfolios.md."
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-01T00:00:00.000Z
---

Agreed and **BUILT on 2026-10-28** — schema, migrations, API, gates and the
rename across 125 files. **Applied to DEV only; production untouched and
nothing committed.** Supersedes the framing in
[[project_area_tree_for_the_business]], which stays valid for *which*
groupings the real business should have.

## What shipped

Two migrations, both hand-written as `ALTER TABLE … RENAME` because
Prisma's differ reads a model rename as `DROP TABLE` and would have taken
the root node and its property FKs with it:

- `20261028210000_area_becomes_portfolio` — the tree, the two join tables
  (`PropertyPortfolio`, `JobOccurrencePortfolio`), the backfill, the enum
  values renamed in place, settings and entitlements.
- `20261028223000_rename_root_portfolio` — the root ROW was left as "All
  areas" by the first one, and the seed finds the root BY NAME, so the
  first reseed built a **second root and a duplicate tree**. Guarded to
  match only the exact shipped string so an operator's rename survives.

Two things the compiler could not catch, both found by hand:

- `portfolioWhere` returns `Record<string, unknown>`, so its stale
  `{ portfolio: { OR: … } }` compiled fine against a model with no such
  field. It would have matched nothing — every scoped reader seeing an
  empty app, no error. The unit tests in `portfolioScope.test.ts` are the
  only guard; they now carry a `Shape` type and a comment saying so.
- The web typechecks against `any` for API shapes, so six card badges read
  a `portfolio` that no longer exists. `lib/portfolios.tsx` now owns the
  flattening.

Gates retargeted: **G13** (destination writes), **G16** (moved from the
deleted `retagOccurrence` to `setPropertyPortfolios`, written as two
explicit `can()` calls because the gate counts them), **G22** (points at
`lib/occurrencePortfolio.ts`, where the freeze now lives), **G26** (window
widened — the sync runs AFTER the create, not before), **G5** + the route
map.

## The idea

An **Area** is already not geographic — nothing in the schema checks that a
node is a place, `lat`/`lng` are optional, and `tier` is per-row free text
(dev already labels three children "Route"). So the concept outgrew the
word. A **Portfolio** is a named grouping of properties that someone is
assigned to manage: geographic if you give it coordinates, otherwise a
route, a set of accounts you know personally, anything. Portfolios nest and
an assignment cascades down the subtree.

The inversion that drove it: today you navigate property → area → assignee.
It should read owner → portfolio → properties.

## Decisions

1. **Full rename, database included.** `Area`→`Portfolio`,
   `AreaAssignment`→`PortfolioAssignment`, `areas.*`→`portfolios.*`,
   `X-Area-Lens`→`X-Portfolio-Lens`, root "All areas"→"All properties".
   Not a UI veneer — the user was explicit.
2. **Many-to-many.** A property may be in several portfolios, with a
   warning at assignment naming the others.
3. **Roll-ups dedupe** instead of summing children. Side-by-side portfolio
   reports may contain the same property twice; that is accepted.
4. **A completed visit remembers the FULL SET**, frozen.
5. **No primary.** Rejected after checking: `areaId` is never a `groupBy`
   key anywhere, and `AreaAssignment` feeds nothing but capability
   resolution — so both problems a primary solves do not exist yet. Still
   available later at the cost of one column.
6. **Open visits follow the property; membership freezes at completion.**
   This REVERSES today's chain-first rule in
   `apps/api/src/lib/occurrenceArea.ts` (previous occurrence → job default
   → property → null). Chain-first was right when an area was a place; a
   portfolio is re-tagged deliberately, so a new route would otherwise show
   nothing until the next 14-day cycle regenerated visits.

## Schema consequences

- `Property.areaId` → a `PropertyPortfolio` join.
- `JobOccurrence.areaId` → a `JobOccurrencePortfolio` join, snapshotted at
  completion. **The one genuinely new mechanism** — G12/G22 currently guard
  a single frozen column and must learn the join, enforcing the snapshot is
  written exactly once.
- `Job.defaultAreaId` → same join shape.
- Entitlement rename is a plain data `UPDATE` — `RoleEntitlement.entitlement`
  is a String with no enum.

The scope filter becomes
`{ portfolios: { some: { portfolio: { OR: [{path: {startsWith}}] } } } }` —
still one indexed prefix test, so the security proof in
`lib/areaScope.ts` survives: grants widen, the lens narrows, intersection by
path containment, G47 intact. See [[reference_capabilities_model]].

## Size, measured 2026-10-28

**101 files** mention area, 10 of them gates. 183 `areaId`, 177 `areaWhere`,
152 `area.`, 58 `areaScope`, 28 `lensPath`, 23 `areas.manage`,
12 `AreaAssignment`, 2 `X-Area-Lens`.

**Do it now rather than later:** production has ONE node ("All areas"), all
93 properties at the root, and **zero** `AreaAssignment` rows. Nothing real
to migrate, and every week adds grants and docs to the thing being renamed.

## The gap that explains why nothing is tagged

**There is no UI anywhere that sets a property's portfolio.** Every `areaId`
write in `apps/web` is a role grant. The API is finished — `POST/PATCH
/properties` accept `areaId`, `GET /properties?areaSubtreePath=` filters,
and create inherits from the client's other properties when they agree —
but the screen was never built. That, not a modelling flaw, is why
production is one flat root.

## The UI, also done

1. **Property membership** — `PortfoliosTab`'s drill-down gained Add (a
   picker of everything not already in the node) and Remove per row, both
   writing the WHOLE list through `PUT /properties/:id/portfolios`. Remove
   carries a ConfirmDialog. Rows arriving from a descendant now name that
   descendant instead of saying "below", and Remove only ever detaches the
   node you are looking at.
2. **Person-first assignment** — "Also manages … as … / Assign" in the
   ROLES block on `UsersTab`, plus an × on each scoped badge to revoke.
   Same two endpoints the tree uses, so one rule and one audit trail
   whichever side you start from. `users.ts` now returns `grantId` on each
   grant (null company-wide) so the person's card can revoke directly.
3. **Roll-up moved server-side** — `portfolios.list()` returns
   `rollup: { properties, occurrences }` from two `COUNT(DISTINCT …)`
   queries over the subtree. The old client-side prefix sum was exact only
   while membership was single-valued; under overlap a parent counted a
   shared property once per child.


## The dev fixture now mirrors production's SHAPE — 2026-10-29

`prisma/seed.ts` used to build a two-level tree (root → Durham / Chapel
Hill / Chatham, with three "Route" leaves). It now builds the real
five-level shape with dev's own cities, so a question answered on the
fixture is answered for production:

```
All properties
└── North Carolina            State
    └── Triangle              Market
        ├── Durham            District  9     ← districtLead's grant, now 3 levels down
        ├── Chapel Hill       District  8 distinct
        │   ├── Chapel Hill West  Zone  6
        │   ├── Carrboro          Zone  1
        │   ├── Hillsborough      Zone  1
        │   └── Chapel Hill Route Route 5     ← cuts across all three zones
        ├── Chatham           District  5   (no coords — weather fallback case)
        │   └── Pittsboro         Zone  5
        └── Mike's Book       Book      5     ← cuts across three districts
```

22 properties, **32 memberships** — the first dev fixture with overlap, so
the `COUNT(DISTINCT …)` roll-up finally has a case that differs from a
naive sum (Chapel Hill: children sum 13, distinct 8).

How it is built, and the three traps:

- **The build is recursive and the sweep matches on IDENTITY, not name.**
  A name-based sweep SPARES an old root-level "Durham" when the fixture
  moves Durham three levels down — two nodes, same name, different ids,
  the exact duplicate-tree failure the sweep exists to prevent. It now
  deletes anything under the root this run did not create, deepest-first,
  and refuses to delete a node holding a grant that is not the
  districtLead fixture's.
- **city → node is READ OFF THE TREE** (`cities:` on each node) instead of
  a second hand-written list that can drift.
- **Route membership is computed** from the occurrences the seed actually
  generated — the district's properties serviced on the busiest weekday,
  logged because it moves with the seed date. **Book membership is by
  CLIENT NAME** (Martinez Family, River Bend Office Park), because a rule
  with a boundary would make it a zone.

### What the reshape caught — a real bug aimed at production

`GET /me/portfolios` dropped "a sole root" from the lens picker. That was
the right rule only for a one-level tree. With a State and a Market above
the districts, somebody granted **Durham alone was offered "North
Carolina", "Triangle" and "Durham"** — three entries returning identical
rows, because the lens is intersected with their grants. The rule now
says what it always meant: **an option is offered only if something the
caller can otherwise see falls outside it.** One root + global reader →
drops exactly the root (old behaviour); scoped reader → drops the
over-wide ancestors. Caught by `portfolio-lens-owner.spec.ts`, now 4/4 green.

Two more things the reshape broke and repaired:

- `portfolio-lens-owner.spec.ts` hardcoded two portfolio cuids that **had
  already rotted** — neither existed in dev, so "the lens reaches the
  server" was comparing one dead string to another. It looks them up by
  name now.
- `scripts/verify-portfolio-scope.ts` counted the negative control on the
  NODE rather than the SUBTREE, so it failed the moment Chapel Hill's
  properties moved into zones beneath it. 7/7 green after the fix.

### Tree UI reworked the same day

Five levels broke the row layout — "North Caroli…", "Chap…", "Chapel
Hi…". The count was the culprit: `22 properties (0 own)` is ~110px that
never yielded, on a row already paying for indent. Now the column is
20rem, the indent is 14px a level and stops stepping after six, the name
**wraps instead of truncating**, and the count is digits (`22 · 0 own`)
with the sentence in a tooltip. Verified by screenshot, not by reading
the diff.

## `frozenAt` dropped — 2026-10-29

`JobOccurrencePortfolio.frozenAt` and `freezeOccurrencePortfolios()` are
**gone** (migration `20261029180000_drop_occurrence_portfolio_frozen_at`).

The function had **zero callers** repo-wide. Only `seed.ts` ever wrote the
column, so in production it would have been NULL on every completed visit
while dev had it populated — and the first report filtering
`frozenAt IS NOT NULL` would have returned nothing in prod and the right
answer in dev. Nothing was broken by its absence, because the stamp was
never the protection.

**Whether a visit's portfolios are frozen is `occurrence.completedAt`,
and only that.** Two guards, both asserted by G22:
`resyncPortfoliosForProperty` selects only open visits, and
`syncOccurrencePortfolios` returns early on a completed one even if handed
the id directly.

**Proven against real dev rows** before the column went: removing a
property from Chapel Hill West moved its **6 open** visits and left the
**25 completed** ones, and the zone's payment total was `$1706.00` before,
after and once restored. So: *the future follows the property, the past
stays where it was counted.*

**G12/G22 was rewritten**, because its old assertion had been vacuous since
the rename — it looked for `portfolioId:` in `services/jobs.ts`, a column
that no longer exists, so it passed by having nothing to match. It now
asserts the rule that holds: only `lib/occurrencePortfolio.ts` may write
`JobOccurrencePortfolio` (the seed is exempt — it builds from scratch), the
`completedAt` guard is still in that file, and no `frozenAt` field comes
back. Three negative controls, each failing for its own reason.

Related, found the same day: **hard-deleting a property** cascades its
`PropertyPortfolio` rows away, but `hardDelete` refuses if the property has
ANY job — so only work-free properties can be deleted and no money history
can be lost that way. **Archiving** touches membership not at all: the
property stays in its portfolios and keeps counting in the tree's rollup
(measured — the rollup SQL never joins `Property`, so status cannot affect
it).

## Production data cleaned up — 2026-10-31

Four writes to production, each explicitly authorised by the user and each
dry-run first. All audited; no money row touched; totals unchanged
throughout (509 payments / $37,462.37).

1. **20 `completedAt` timestamps backfilled.** Those visits had
   `status = CLOSED` and no completion timestamp — work entered after the
   fact before the flow stamped one. Portfolio attribution reads
   `completedAt`, not `status`, so they were being treated as still-open
   and would have followed their property around. Written from `endAt`,
   which equalled `startAt` on all twenty.
2. **Three abandoned records deleted** — Claire [?] (+ property, job,
   2 visits), Scott [?] / "132 Marshall?" (never had a job at all), and
   Keria Gould / 1108 Valley Rose Way (a 36-hour July lead whose single
   auto-generated visit was deleted when the client was paused).

**Production is now 90 properties, and ALL 90 place cleanly** by the
ZIP/street rules — 35 Chapel Hill West · 28 Briar Chapel · 12 Chapel Hill
East · 11 Chatham · 4 Carrboro. No unplaced list, no exceptions.

Two residues:
- **8 orphaned R2 objects** from the Hampton Ct visit. Rows cascaded; the
  files did not. Keys are in that occurrence's audit entry.
- Any future cleanup of a PRE-CUTOFF record hits the same wall — see the
  delete-guard defect in [[project_deferred_work]].

## Not yet done

- **Rule-assisted bulk tagging** (by ZIP, by street). The Add picker is
  one at a time, which is fine for maintenance and slow for the first
  load of 93. The rollout script in the section above is still the plan
  for that.
- **E2E**: `portfolio-lens-owner` is green (4/4, re-run 2026-10-31). The
  rest of the suite has still not been run against the rename OR against
  the money basis — see [[project_portfolio_money_basis]].
- **The placement script is NOT written.** Deliberately: deploy first, so
  the money basis exists before the tree does. Otherwise filtering to a
  zone hides 12 outstanding payment requests and 5 completed-unbilled
  visits — live money, on the screen you chase it from.

Rollout caution carried from [[project_area_tree_for_the_business]]: the
re-tag script must also update the **67 open occurrences**, or recurring
work keeps inheriting the root and the change looks like it did nothing.
Two bad records skip any ZIP rule: `132 Marshall?` (postal `55555`) and
`105 Hampton Ct` (no ZIP).

The user runs anything that writes to production — see
[[feedback_never_write_production_db]].

---

# 2026-11-01 — THE MODEL CHANGED. Read this before the older notes above.

Canonical spec is now
[`docs/features/portfolios.md`](../../../dev/seedlings3/docs/features/portfolios.md),
which supersedes anything below it that disagrees.

## Portfolios can be REPARENTED now

`POST /portfolios/:id/move`. The old rule ("portfolios are never moved,
copy-and-retire instead") is gone, because the two things it rested on
both changed: **nothing persists a path** — the joins key on id, grants
resolve per request, the lens carries an id — and the money view whose
whole promise was that a past total could not move was removed.

The move repaths the subtree in one transaction and refuses a cycle, the
root, and anything retired. **G14 was REWRITTEN, not deleted**: it now
asserts that only `move()` writes `parentId` and that `move()` still
repaths descendants, refuses cycles and the root, and records the
visibility delta. The failure it guards is a PARTIAL repath — a node whose
path matches no prefix does not error, it silently empties every scoped
view of itself.

**A move changes who can see the subtree**, because grants resolve
per-request. The audit records who gained and lost it; the UI says so in
the success message. Nothing else writes that down.

## Retired + empty portfolios can be DELETED

`DELETE /portfolios/:id`. Permanent, and the only irreversible operation
in this model. Requires retired first, then empty — and **empty means four
things**: no properties, **no completed visits**, no leads, no children.
All four are `Restrict` FKs so the database refuses anyway;
`GET /portfolios/:id/delete-blockers` exists so the button is disabled
WITH THE REASON instead of clickable and refused.

The visit count is the one that keeps a node alive forever. **You can
delete a mistake, never a record.** In production that made exactly two
nodes deletable (`OLD - Carrboro`, `OLD - Chatham`) and everything else
blocked.

## Money has ONE grouping

Always current membership. See [[project_portfolio_money_basis]] for why
the alternative was removed and why its rows are still written.

## Snapshots and history were PUNTED, deliberately

Designed in detail — structure log, named snapshots, replay-as-read,
auto-snapshot on move — then dropped on 2026-11-01 as not worth it at this
scale. The consequence: no way to see how money was grouped in the past,
and no record of what a move changed beyond its audit entry. Reversible
only while `JobOccurrencePortfolio` keeps being written.

## Smaller things that shipped the same day

- **Sibling order** (`sortOrder`) — display only, depth-first from the
  server so every picker agrees. Arrows on each tree row.
- **`instructions`** — "what belongs here", shown at the moment of filing.
- **`color`** — a Chakra palette NAME, never hex. Null = auto by position.
  Drives map pins, the map legend and list headings from one assignment.
- **The map** got a toggleable colour legend and a full-page expand. Two
  real bugs there were found only by driving it: the container resolved to
  2px, and tiles were zero-width from `max-width: 100%` against a
  zero-width absolute parent.
- **Counts were leaking and lying.** `portfolios.list()` counted every row
  in the database — a portfolio-limited lead saw the whole company's
  volume, and the tree disagreed with the panel under it whenever a lens
  was set.
- **Unfiled properties are visible.** The root counts them and lists them
  under their own heading; a property stripped of its last portfolio used
  to vanish from the tab entirely.
- **Archived properties are IN by default** in the panel, with a Hide
  toggle governing list and map together.
- **The scope strip no longer renders** for somebody who holds everything
  company-wide and merely leads a portfolio — it was a permanent row
  saying nothing was happening.

## Production state

Tree built and cleaned. Three migrations (`sortOrder`, `instructions`,
`color`) are committed AND applied to production. This session's work adds
no schema change — the move uses existing columns and delete removes a row
— so it deploys without a migration.

## The strip's tab table — a Set became a table (2026-11-12)

`apps/web/src/lib/portfolioFilteredTabs.ts` was `FILTERED_TABS`, a flat
`Set` of tab names, read by the purple strip and the tab-row marker.
**A name cannot answer the question**, because there are two ways to be
narrowed: a **lens** you picked from the chip, and a **grant** that is
simply your access. `GET /reports/portfolio-performance` passes
`ignoreLens` on purpose — the tab compares portfolios, so a lens
collapsing it to one would empty it — while a grant still applies. With a
Set there was **no entry true for both readers**: omitting `performance`
told a grant-limited lead the whole business was in front of them, listing
it would have told a lens-holder their lens narrowed a tab that ignored it.

Now `TAB_NARROWING`: each tab carries `{ grant, lens }`, each of which is
`true`, `false`, or `{ part: "…" }`. The third shape is for a company-wide
tab with ONE narrowed panel — `equipment` (the Insights leaderboard reads
`/operations`) and `portfolios` (the property picker reads `/properties`).
The strip stays quiet for those but says **"this tab is company-wide apart
from the Insights panel"** instead of "shows the whole business", which was
true of the tab and false of the control about to be used.

- Callers pass `NarrowingInForce`; strongest applicable wins. `grantIsNarrowing`
  split out of `portfolioIsNarrowing` — conflating them would mark a
  lens-only reader's tabs as grant-narrowed.
- **No exemption list.** There was one for a day; mutation testing got
  `repeating: "excuse"` through it. The table states every case instead,
  and G50 fails a `{ grant: false, lens: false }` entry as "this rule
  switched off for that tab".
- G50 proves the table matches the API **both ways**. `apps/api/src/lib/
  portfolio-narrowing.test.ts` (registered in the build-gate filter list,
  via `@web-lib`) proves the RESOLVER — a `tabNarrowing` returning `true`
  for everything satisfies every regex in G50.
- Found via [[project_repeating_tab]], where `repeating` was simply absent.
