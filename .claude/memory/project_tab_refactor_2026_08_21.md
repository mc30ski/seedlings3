---
name: project-tab-refactor-2026-08-21
description: Summary of the massive multi-session tab-blend refactor completed around 2026-08-21. Every role-aware tab was converted to the additive-scope pattern. Read before making assumptions about tab shape / mount / role visibility.
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:08:03.675Z
---

# Tab-blend refactor — 2026-08-21

## What changed

Converted every role-aware tab to the additive-scope pattern (see
[[reference-tab-blend-pattern]]). Established canonical top-tab and
sub-tab ordering (see [[reference-tab-ordering]]).

**Why:** Historically, separate Worker/Admin/Super tab files (or
purpose-prop branches) drifted apart visually and functionally. The
additive-scope pattern collapses them into single files with
explicit `scope` prop, mounted per role in the shell.

## Files touched

### New
- `apps/web/src/ui/tabs/CollectionsTab.tsx` — replaced
  `WorkerCollectionsTab.tsx` + `AdminCollectionsTab.tsx` (both deleted).
- `apps/web/src/ui/dialogs/SignedPolicyViewDialog.tsx` — worker's
  re-view of signed policy documents.

### Renamed
- `EquipmentTab.tsx` → `InventoryTab.tsx` (component
  `EquipmenTab` → `InventoryTab`, fixed typo).

### Deleted
- `WorkerCollectionsTab.tsx`
- `AdminCollectionsTab.tsx`
- `EquipmentUsageTab.tsx` (features folded into
  `UsageBreakdown` sub-component inside InventoryTab).

### Blended (scope prop added, additive extras derived)
- InventoryTab (gold-standard reference)
- CollectionsTab
- VehiclesTab
- ClientsTab
- PropertiesTab
- UsersTab (new `WorkerTeamRoster` sub-component for worker view)
- AdminGroupsTab (new `WorkerMyCrews` sub-component — labeled
  "My Groups")
- PaymentsTab
- PricingTab
- SuppliesTab
- JobsTab (partial — already had scope; converted Ops summary)
- HomeTab (Operations panel inlined inside orange Insights card)

## API changes

- `POST /admin/equipment` and `DELETE /admin/equipment/:id` —
  tightened to `superGuard` (create + hard-delete are super-only).
- Four `/super/equipment/*-for` endpoints (reserve-for /
  reserve-for/cancel / checkout-for / return-for) — loosened from
  `superGuard` to `adminGuard` so admin view-as can drive them.
- `GET /super/vehicles` — loosened to new `workerGuard` (list is
  read-only, mutations stay super).
- `GET /api/me/team` — new, workerGuard, sanitized worker roster.
- `GET /api/me/groups` — new, workerGuard, caller's crews without
  cost-split percentages.
- `getWorkerPoliciesView` history rows extended with content fields
  (`versionId`, `contentFormat`, `contentMarkdown`, `contentR2Key`,
  `contentFileName`, `contentContentType`) — powers the worker
  "View again" affordance on Recorded on file.

## Seed enrichment

`apps/api/prisma/seed.ts` — added `Equipment enrichment` block:
- 25 historical released checkouts (last 60 days, deterministic RNG)
- 12 PinnedEquipment rows across all workers
- 18 LikedEquipment rows
- Wheelbarrow (RETIRED) added to Spring Cleanup collection to
  populate Super Collections "Kits with issues" insight
- 12 additional mileage entries (9 approved + 3 pending in last 30d)
  in `seedVehicleFixtures` — populates Vehicles "Last 30d miles" +
  "Pending approvals" panels

Reseed trigger phrases documented in [[feedback-reseed-phrases]].

## Persisted-state migration

`apps/web/pages/index.tsx:213-224` — one-shot migration effect
redirects `workerTab`/`adminTab` LocalStorage values of `"reminders"`
(from the removed Planning tab) and `"usage"` (from the removed
Usage tab) to `"home"`. Prevents blank-tab flash on first load
after tab deletion.

## Known nice-to-haves not done

- `notifyEquipmentUpdated` event still emitted from InventoryTab
  after every mutation; no listeners in sibling tabs. Cross-tab
  auto-refresh not implemented (only active tab is mounted anyway).
- PricingTab / SuppliesTab `showSuperExtras` lacks the
  `hasSuperRole` defense-in-depth (they don't take `me` today; the
  shell is authoritative on `scope.isSuper`).
- Large-file compartmentalization (JobsTab ~9929 lines,
  AdminComplianceTab ~3636 lines, InventoryTab ~3868 lines) —
  deferred per rule of "only recommend extraction >2000 lines".
