---
name: reference-tab-ordering
description: "Canonical category and tab order for the one staff tab list. Read before adding, removing or reordering a tab."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-10-18T00:00:00.000Z
---

# Canonical tab ordering

**Rewritten 2026-10-18.** This file described three sub-tab lists — Worker,
Admin and Super — each with its own category strip and its own `catMap`.
All of that is deleted. There is ONE staff tab list and one category map.
If you are reading an older copy, discard it.

## Two shells

`topTab` persists as `"client" | "staff"` (`seedlings_topTab`). The inner
tab is `seedlings_staffTab`, the category strip is `seedlings_staffCategory`.
There are no per-shell keys; anything else persisted is migrated to `staff`
on read.

## The one staff list — 37 tabs, in order

Defined as `staffTabs` in `apps/web/pages/index.tsx`. Category order is the
order these first appear:

| Category | Tabs, in order |
|---|---|
| Work | home, jobs, routes, services, tasks |
| Equipment | equipment, collections, vehicles |
| Directory | clients, properties, users, groups |
| Money | payments, payroll, ledger, pricing, supplies, promotions, forecast |
| Records | reconcile, workdays, compliance, activity, history, timeline, documents, guides, audit |
| Tools | tools-mowing, tools-mulch |
| System | profile, notify, roles, areas, vanity, displays, settings |

## Which of them a person sees

Not a list per rank — a capability question, one row per tab in
`TAB_REQUIREMENTS` (`apps/web/src/lib/tabRequirements.ts`). A tab renders
when the signed-in person holds one of its entitlements, read from the
PERSPECTIVE-NARROWED set `/api/me` returns. Two tabs (`guides`, `profile`)
carry the `ALWAYS` sentinel and need none.

So the answer to "who sees Ledger" is "whoever holds `books.view`", and it
changes when an operator edits a role — not when someone edits this file.

## Cross-tab jumps

`TAB_CATEGORY` at the top of `index.tsx` maps every tab id to its category,
and the single `navigate:staffTab` handler uses it to move the category
strip so the destination is revealed. Values must match the `category:` on
the tab entry.

Two things to know, both of which shipped broken:

- There were THREE handlers on that one event, one per old shell. Every
  jump ran all three — `pushNavHistory` up to three times for one
  navigation, which is why Back sometimes needed several presses.
- Their maps disagreed. the copy was missing ten tabs, so a jump to
  Ledger, Promotions, Forecast, Reconcile, Workdays, Compliance, Audit,
  Tools, Vanity or Displays resolved no category and left the strip where
  it was, showing the wrong inner tabs.

Adding a tab means adding it to `staffTabs`, to `TAB_REQUIREMENTS`, and to
`TAB_CATEGORY`. Miss the third and it is reachable by deep link but not by
clicking.

Related: [[reference-tab-blend-pattern]], [[reference-capabilities-model]].
