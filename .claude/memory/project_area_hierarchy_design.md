---
name: project-area-hierarchy-design
description: "Multi-area expansion — the Area/Manager design worked out 2026-09-17. DESIGN ONLY, nothing built. Read before writing any code for territories, managers or scoped permissions."
metadata: 
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-19T15:36:09.684Z
---

# Area hierarchy & managers — design, not code

**NOTHING IS BUILT.** No schema, no migration, no routes. This is a design
worked out in conversation on 2026-09-17, paused so other work could go first.
Read it before touching anything to do with territories, managers or scoped
permissions — the expensive mistakes are already identified here.

**Context:** ~75 customers within ~20 miles today. A second, farther location
is being considered, which needs someone overseeing it — and that is where
"admin" stops fitting.

## The design

**Area is ONE construct that nests freely.** An area contains areas. A
"region" is just an area with children. Tier names — Regional / District /
Area manager — are job-title vocabulary, never schema, so the tree can be
reshaped without a migration.

**Manager is an ASSIGNMENT, not a role.** `Role` stays `WORKER | ADMIN |
SUPER`. A user is a manager because a row assigns them to an area. This is the
single most important decision (see costs below) and it mirrors how the app
already works: a *claimer* is not a role either — `JobOccurrenceAssignee.role`
is a plain `String?` on the assignment row, and `Group.claimerUserId` is a
pointer.

**Anyone can be assigned, including a Super.** The owner can run one area
personally without giving up global access.

> **Authority = global (if Admin/Super) OR union of assignments. NEVER the
> intersection.** Otherwise the day the owner assigns himself to one area he
> locks himself out of the company.

**Money rides the OCCURRENCE, not the property.** `JobOccurrence.areaId`, set
when the occurrence is created. `Job` holds a default area for projections.
This matches three patterns already in the schema — `price` (snapshotted),
`frequencyDays` ("Overrides Job.frequencyDays when set"), and completion
splits ("Immutable snapshot taken when the occurrence is completed").
`Payment.occurrenceId` is `@unique`: the occurrence IS the money-bearing row.

Consequence worth keeping: **reassigning a property later cannot move last
year's revenue**, because the occurrence snapshotted its area. History stays
put by construction rather than by a rule someone must remember.

**Property → one or more areas.** Safe because money does not ride the
property. (An earlier draft had money on the property with a "primary area";
it was worse — it would have silently restated history, and many-to-many on a
reporting path invents revenue, which `payments-build-gate`'s "Income
aggregate EXCLUDES write-offs (no phantom revenue)" exists to prevent.)

**No area on:** client (follows the property), equipment (moves physically;
the local crew uses it), business expenses (already company-level — the
expense→job link is *"PURELY DECORATIVE… no total reads it"*).

**Workers → one or more areas, but can work anywhere.** Visibility is scoped;
capability is not.

**Geography suggests, never decides.** `Property.lat/lng` are optional and
populated only by a best-effort parcel lookup. Assignment is explicit; a
"30-mile radius" is how a human draws the line, not how the DB stores it.

**Ship with ONE all-encompassing area first.** Nothing scoped, nothing breaks,
and the tree can be shaped while it is inert.

## Why "manager as assignment" matters — the numbers

`requireRole` is **exact membership, not ranked**:
`if (!roles?.includes(role)) throw forbidden`. There is no hierarchy in code —
"super implies admin" is written by hand (`r.role === "ADMIN" || r.role ===
"SUPER"` in `lib/privileges.ts`).

So every role enum value added costs a migration **plus a decision at ~523
role comparisons** (94 API, 429 web). `MANAGER_AREA` + `MANAGER_REGIONAL`
would pay that twice, and again for every tier invented later. A missed `||`
fails silently.

Manager-as-assignment costs **zero** of that.

## A Manager is NOT an area-scoped Admin

Of ~200 `adminGuard` routes in `routes/admin.ts`, roughly half cannot be
scoped to an area at all:

| Area-scopable (~101) | Company-global (~99) |
|---|---|
| occurrences 16 · clients 16 · properties 12 | **policies 30** · business-expenses 15 |
| jobs 11 · payments 9 · groups 8 | users 13 · supplies 13 · equipment 11 |
| followups 4 · events 4 · change-requests 4 | pricing 4 · announcements 4 |
| timeline 4 · invoice-charges 3 · contacts 4 | documents 3 · banners 3 · settings 2 |

Compliance **policies alone is 30 routes** and is definitively company-wide.
So: **a Manager runs operations in their areas; an Admin runs the company.**
For the company-global half the rule is **hide, not scope** — which is simpler
to implement than a filter.

Two resources genuinely need splitting rather than hiding: **users** (see your
workers, maybe approve hours; never set wages or roles) and **supplies**
(company catalog vs per-job purchases — depends which they are).

## The real cost: the filter surface

Every admin list today means "any admin, all data" — e.g.
`app.get("/admin/clients", adminGuard, …)` returns every client, always. Each
scopable route needs a second question answered, and **a missed filter does not
crash** — the page renders and a Raleigh manager quietly sees Wilmington's
clients. Same silent shape as the view-as bug that shipped three times.

**The playbook already exists:** `businessStartCutoff` is a cross-cutting
filter threaded through 19 files with shared helpers and a build gate that
fails the build on an unfiltered money query. Do that — one `areaScope(user)`
helper, applied everywhere, gated. Write the gate BEFORE the first route.

Good news: money queries start at the occurrence, so they gain one `where`
clause with no joins. The larger, less catastrophic half is the list surfaces.

## STILL OPEN — H gates everything

| # | Question | Lean |
|---|---|---|
| **H** | **Read-only manager, or read-write?** Approve payments? Adjust price? Edit clients? | **Answer first — it sizes the whole project.** Read-only is a reporting feature (days). Write touches the money invariants (weeks). |
| A | When does `occurrence.areaId` freeze? | Default at creation, editable while SCHEDULED, frozen at completion — same rule as completion splits. |
| B | Worker activity vs. area work | Two separate filters. A Raleigh-assigned worker doing a Durham job shows for BOTH managers. First case with two right answers. |
| C | What money can a manager see? | Subtree revenue + payouts. No company P&L. |
| D | Two managers over one area? | Allow (union is safe); design the UI for the single case. |
| E | Cycle prevention on reparent | A→B→A is an infinite ancestor walk. Check + build gate. |
| F | Does moving an area rewrite list history? | Money follows the snapshot; lists follow current structure. |
| G | Order of scoping the ~101 routes | Money first, then lists. Gate before the first route. |
| I | Does a Super's assignment act as a UI lens? | Yes — a filter, like view-as. Confirm it is wanted. |

## Implementation shape (when it starts)

Three tables: `Area` (self-ref tree + **materialized `path`**), `AreaAssignment`
(user ↔ area), and `Property.areas[]` + `JobOccurrence.areaId` +
`Job.defaultAreaId`.

`path` matters because **Prisma has no native recursive CTE** — a materialized
path turns "everything below my node" into one indexed prefix match:
`where: { area: { path: { startsWith: "/nc/triangle/" } } }`. Cost is
maintaining `path` on reparent, which is rare.

Related: [[reference-view-as-endpoints]] (same silent-failure class),
[[feedback-payments-build-gate]], [[reference-audit-system]].
