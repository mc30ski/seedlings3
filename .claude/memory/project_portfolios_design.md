---
name: project_portfolios_design
description: "Area → Portfolio: COMPLETE 2026-10-28; DEV FIXTURE RESHAPED to production's 5-level shape 2026-10-29, which exposed a real lens-picker bug. Applied to DEV only, nothing committed."
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-29T00:00:00.000Z
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

## Not yet done

- **Rule-assisted bulk tagging** (by ZIP, by street). The Add picker is
  one at a time, which is fine for maintenance and slow for the first
  load of 93. The rollout script in the section above is still the plan
  for that.
- **E2E**: `portfolio-lens-owner` is green (4/4, 2026-10-29). The rest of the
  suite has still not been run against the rename.

Rollout caution carried from [[project_area_tree_for_the_business]]: the
re-tag script must also update the **67 open occurrences**, or recurring
work keeps inheriting the root and the change looks like it did nothing.
Two bad records skip any ZIP rule: `132 Marshall?` (postal `55555`) and
`105 Hampton Ct` (no ZIP).

The user runs anything that writes to production — see
[[feedback_never_write_production_db]].
