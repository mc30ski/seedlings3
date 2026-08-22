---
name: reference-tab-ordering
description: "Canonical top-tab category order and per-role sub-tab order across Worker / Admin / Super. Reference before adding, removing, or reordering tabs."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:07:15.491Z
---

# Canonical tab ordering

## Top-level categories (Super's category strip)

**Work → Equipment → Directory → Money → Records → Tools → System**

Every category the user configured. Records was placed between Money
and Tools per the 2026-08-21 spec. Worker/Admin have flat tab lists
(no category strip today) but the SAME logical grouping is preserved
via the section-comment order in the tab arrays, and the `catMap`
lookups match this ordering.

## Worker sub-tabs (flat list, in order)

Work: Home, Jobs, Routes, Actions
Equipment: Inventory, Collections, Vehicles
Directory: Clients, Properties, Users, Groups
Money: Payments, Pricing, Supplies
System: Profile

(No Records or Tools categories for Worker.)

## Admin sub-tabs (flat list, in order)

Work: Home, Jobs, Routes, Services, Actions
Equipment: Inventory, Collections, Vehicles
Directory: Clients, Properties, Users, Groups
Money: Payments, Pricing, Supplies
Records: Engagement, History, Timeline, Documents
System: Profile, Notify, Settings

(No Tools category for Admin.)

## Super sub-tabs (per category)

- **Work**: Home, Jobs, Routes, Services, Actions
- **Equipment**: Inventory, Collections, Vehicles
- **Directory**: Clients, Properties, Users, Groups
- **Money**: Payments, Pricing, Supplies, Ledger, Promotions
  (Ledger + Promotions are Super-only.)
- **Records**: Reconcile, Workdays, Compliance, Engagement, History,
  Timeline, Documents, Audit
- **Tools**: Mowing, Mulch (calculators; Super-only)
- **System**: Profile, Notify, Vanity, Settings
  (Vanity is Super-only.)

## Category dispatch maps

`apps/web/pages/index.tsx` has three catMap tables that MUST stay in
sync with the actual tab tree ordering:

1. **Worker `catMap`** (~L1290) — inline object mapping tab value →
   category label. Consumed by BreadcrumbNav's category derivation.
2. **Admin `catMap`** (~L1339) — same shape.
3. **Super `superCatMap`** (~L3010) — same shape but as a lookup
   inside the `navigate:superTab` event handler. Every super inner
   tab needs an entry; values must match the `category:` field on the
   tab entry. Bugs in this map cause cross-tab jumps to land with
   the wrong category highlighted.

The 2026-08-21 audit caught six wrong entries in `superCatMap`
(`reconcile/workdays/compliance/activity → "Records"`,
`promotions → "Money"`, `tools-mowing/tools-mulch → "Tools"`). All
fixed. `goToCompliance` and `goToWorkerCompliance` also had wrong
category strings and were corrected.

## Chip styling on tabs

The Actions/tasks tab was previously rendered as a rounded chip on
Worker + Admin (via `chip: t.value === "tasks"`) but plain on Super.
The mismatch read as a bug. All roles now render Actions without the
chip (`chip: false` on the tab-transform map).

## Types union file

`apps/web/src/lib/types.ts` — `WorkerTabs`, `AdminTabs`, `SuperTabs`
unions must include every value that appears in the respective tab
array. The 2026-08-21 refactor added `"users"` + `"groups"` +
`"vehicles"` to WorkerTabs, `"vehicles"` to AdminTabs, and pruned
dead `"reminders"` / `"usage"` / `"statistics"` values. If a tab
value is missing from the union, TypeScript errors on
`setWorkerInnerTab("xxx")` etc.
