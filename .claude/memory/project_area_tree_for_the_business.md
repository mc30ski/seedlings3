---
name: project_area_tree_for_the_business
description: "Proposed real-world portfolio tree for Seedlings (Chapel Hill / Briar Chapel / Chatham) from a 2026-10-27 production analysis — tree NOT built; the TIER VOCABULARY it uses was settled and shipped to code 2026-10-29"
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-29T00:00:00.000Z
---

Drafted 2026-10-27 from a read-only analysis of the production database.
**Nothing has been created and nothing was written to production.** Picked
up and paused again on 2026-10-28 — the user wants to come back to it.

Context for the feature itself is in [[project_area_hierarchy_design]]; this
file is about which areas the REAL business should have.

**The concept was renamed in design on 2026-10-28** — areas become
portfolios, and membership becomes many-to-many. See
[[project_portfolios_design]]. The tree proposed below is still the right
shape; read "area" as "portfolio" throughout.

## The production picture (2026-10-27 — re-verify, these move)

| | Properties | 90-day visits | Collected, all time |
|---|---|---|---|
| Chapel Hill — 27516 / 27517 / 27514 | 76 | 240 | $30,192 (81%) |
| Pittsboro — 27312 | 11 | 43 | $6,435 (17%) |
| Carrboro — 27510 | 4 | 7 | $545 |
| Durham — 27712 | 1 | 0 | — |

93 properties (13 archived), 91 clients, **all residential** — no commercial
or community accounts yet. Whole footprint fits in 12.6 × 9.8 miles. 51 of
68 accepted jobs run on a 14-day cycle, so this is a ROUTE-DENSITY business,
not a territory-coverage one. Field volume 90d: Jacob 194 Chapel Hill visits,
Justin 86, Caleb 57, Michael 33, David 5.

**The finding that drives the shape: the densest cluster is a SUBDIVISION,
not a city.** At least 29 of the 63 properties in 27516 are on Briar Chapel
streets (Great Ridge Parkway 7, Tobacco Farm Way 4, Pokeberry Bend,
Juneberry, Amber Wood Run, Stoney Branch Trail, Chauncey Circle, New
Parkside, Ashwood), and the tightest geocoded pocket holds 11 inside about
half a mile. The pricing settings already encode this:
`pricing_full_service_tier_1_e_g_briar_chapel_standard_lot` and
`pricing_full_service_tier_2_e_g_pittsboro_standard_lot`.

## The proposed tree

```
All areas
├── Chapel Hill          ~80 properties · a lead
│   ├── Briar Chapel     ~29+ · densest route, pricing tier 1
│   ├── Chapel Hill West 27516 outside Briar Chapel
│   ├── Chapel Hill East 27514 + 27517
│   └── Carrboro         27510
└── Chatham              ~11 · a lead, or folded in for now
    └── Pittsboro        27312 · pricing tier 2
```

**Organize by drive time and route density, NOT by county.** Briar Chapel
mails as Chapel Hill but physically sits in **Chatham County** — a county
tree would cut the densest cluster away from the rest of the Chapel Hill
book, which is backwards for routing. (Worth confirming against the parcel
data the app already pulls.)

Why Briar Chapel earns a node: a third of the book in one subdivision, its
own price tier, and the one place a crew can work a full day without moving
the truck. Measuring margin there separately is the first real question the
area feature can answer.

## How it maps to leads and directors

Three rungs, only two staffed now:

- **Zone** (Briar Chapel, Carrboro…) — a crew's working unit, no role.
- **District** (Chapel Hill, Chatham) — where a **lead** is granted. A grant
  at a district cascades to every zone beneath it, so a Chapel Hill lead
  covers Briar Chapel without a second grant.
- **All areas** — director / owner.

When it outgrows that, insert a **Region** tier between All areas and
District rather than widening districts; the materialised path makes
inserting a level cheap. Planning number: one lead per ~150–250 recurring
properties or two crews. Today's ENTIRE business is one district's worth of
work — the second district exists because the drive and the pricing differ,
not because volume demands it.

## Assignment rule — ZIP, with one carve-out

Deterministic and needs no geocoding:

`27510 → Carrboro` · `27312 → Pittsboro` · `27514, 27517 → Chapel Hill East`
· `27516 → Chapel Hill West`

Briar Chapel cannot be derived from a ZIP. Tag it from the street list;
**only 42 of 93 properties are geocoded**, so streets are more reliable than
coordinates right now (the map view backfills lazily).

## Do these first

- **Two bad records** will be skipped by any ZIP rule: `132 Marshall?` has
  postal code `55555` and city `?`; `105 Hampton Ct`, Chapel Hill, has no ZIP.
- **All 93 properties already point at the root area**, so this is a bulk
  RE-TAG, not a first assignment.
- **The lone Durham property does not justify a district.** Leave it at the
  root until there is a cluster — an area with one property is a node
  everyone clicks past.

## Dev does not match

Dev was seeded 2026-10-26 with a different tree: All areas → Durham, Chapel
Hill (→ Carrboro, Hillsborough), Chatham (→ Pittsboro). It carries Durham and
Hillsborough that the real data does not justify, and has no Briar Chapel.
Decide whether dev should be reshaped to match.

Also relevant: **dev has zero `AreaAssignment` rows**, so the area-badge path
in the Roles → People view has never rendered, and the `districtLead`
Playwright persona (described elsewhere as a Durham-only Admin) holds no
grants at all — area-scoping e2e coverage may currently be vacuous. See
[[project_area_hierarchy_design]].

## The tier vocabulary — SETTLED and in code, 2026-10-29

`PORTFOLIO_TIER_NAMES` is no longer a flat string list. It is an array of
`{ name, description }`, and the description is shown under the tier picker
in `PortfoliosTab` — because the words do not explain themselves and an
operator choosing blind mixes Zone and Route inside a week.

**A spine, and two kinds that cut across it:**

| Tier | What it is |
|---|---|
| **State** | A legal boundary — payroll tax, licensing, insurance, wage floors. Not just the map. |
| **Market** | A metro and the area it commutes to. The unit you open or close. |
| **District** | One person's span of accountability. The rung a lead is usually granted on. |
| **Zone** | A patch with a boundary — a town, a postcode, a subdivision. You could draw it. |
| **Route** | A journey, in order. **Sequence** is what makes it a route; if order does not matter it is a zone. |
| **Book** | A set of accounts one person keeps, wherever they are. Defined by WHO, not WHERE. |

State → Market → District → Zone **nest, in that order**. Route and Book do
not: they sit at the lowest node containing everything they touch, and a
property belongs to one **as well as** its zone — which is what the
many-to-many membership in [[project_portfolios_design]] is for.

**Dropped deliberately:** *Region* (only earns a place above State; type it
when the business is that size) and *Territory* (means "district" to some
people and "a rep's patch" to others — two words for one rung is the exact
confusion the list exists to prevent).

Where it lives, all four kept in step:
`scripts/install-starter-roles.ts` (production, upgraded through
`supersedes` so an edited vocabulary is never overwritten) ·
`prisma/seed.ts` (dev — **reseeded 2026-10-29, verified in the dev row**) ·
a dedicated `PortfolioTierNamesEditor` on SettingsTab · **G49** in
`permissions-build-gate.test.ts`, which fails the build if the two source
copies drift or if the key is ever routed back at `StringListEditor` (that
editor coerces rows with `String(x)` and would silently save
`"[object Object]"` over the whole vocabulary). Both halves of G49 were
negative-controlled.

**Production still needs the installer re-run** to pick the new value up —
its row is still the old four strings, which is one of the `supersedes`
entries, so it will upgrade cleanly. The user runs it.

## The production tree in this vocabulary (measured 2026-10-28)

| Portfolio | Tier | Properties | 90-day visits | Collected |
|---|---|---|---|---|
| North Carolina → Triangle | State → Market | 78 | 502 | $35,532 |
| Chapel Hill | District | 67 | 425 | $29,097 |
|  → Chapel Hill West | Zone | 30 | | |
|  → Briar Chapel | Zone | 24 | | |
|  → Chapel Hill East | Zone | 9 | | |
|  → Carrboro | Zone | 4 | | |
| Chatham / Pittsboro | District | 11 | 77 | $6,435 |
| Mike's Book | Book | 5 | 45 | $2,865 |

Two properties are unplaced (the bad records below). Briar Chapel is a
**Zone, not a Route** — it is a subdivision with a boundary, and nothing
about the order of visits inside it is load-bearing. Mike's Book is a Book
whose properties **also** sit in their geographic zones.

## Open questions, to answer before building

1. **Is Chatham its own district, or is Pittsboro folded under Chapel Hill
   for now?** Eleven properties is thin for a district, but the drive and the
   price tier both differ.
2. **Should dev be reshaped to match** at the same time?

## How it would be built

A script that creates the area rows and does the ZIP/street assignment, with
a DRY RUN printing every change first. **The user runs it against
production** — see [[feedback_never_write_production_db]]. Area writes must
audit like any other mutation ([[feedback_audit_every_mutation]]).

One caution to carry forward: the area lens narrows visibility only and never
grants anything, and a grant at a parent cascades down. Build the tier that
can be staffed, not the tier hoped for — an empty middle level costs every
user a click and buys nothing until somebody is accountable for it.
