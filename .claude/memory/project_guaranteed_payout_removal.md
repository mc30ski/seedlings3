---
name: project-guaranteed-payout-removal
description: "Guaranteed Payout (GP) was REMOVED from the app on 2026-08-31 — feature deleted, columns and GuaranteedPayoutAdvance table dropped. The two AuditVerb enum values intentionally remain. Read before reintroducing anything GP-shaped."
metadata:
  node_type: memory
  type: project
---

# Guaranteed Payout — removed 2026-08-31

The contractor "guaranteed payout" onboarding window is **gone**. Do not
reintroduce it without an explicit decision — the user removed it because
it was confusing and effectively unused.

## Why it went

Production had exactly one GP subject ever: **Mark Baliff**, window
2026-06-05 → ended early 2026-07-09, and he was **test data with live
records** who never appeared on a Gusto payroll. Zero users had an open
window at removal time.

## What was removed

- `User.guaranteedPayoutUntil / StartedAt / History`
- `PaymentSplit.guaranteedPayoutPaidAt` + its index
- model `GuaranteedPayoutAdvance`
- both admin endpoints, the daily expiry cron **and its `vercel.json`
  schedule entry**, `wasUserInGuaranteedPayoutAt`,
  `fetchAdvanceFlagsByUser`, `loadGpWorkAnchoredItems` + 8 call sites
- the "Guaranteed payout expiring" header alert + Tasks card (and its
  alert-ordering gate mapping entry), UsersTab dialog/filter/chip,
  ProfileTab banner, "Advance paid" chip, the GP suffix on the
  wage-compliance banner
- build-gate section E, the `payments-guaranteed-payout` seed template

Migration: `20260831144118_drop_guaranteed_payout`.

## The two things that intentionally SURVIVE

1. **`AuditVerb.GUARANTEED_PAYOUT_STARTED` / `_ENDED`** — production has
   3 `AuditEvent` rows referencing them. Dropping a Postgres enum value
   with live rows fails the migration. `HistoryTab` still renders their
   labels so that history stays readable. Nothing writes them.
2. **Mark's data** — 47 splits / $2,870.50, 53 occurrence assignments,
   still counted as W-2 wages in the P&L. The user is dealing with it
   later in the year; leave it alone.

## Data effects of the drop

- Contract labor in the P&L drops **$152** (4 advance rows).
- Mark's 7 previously-flagged splits (**$390**) become visible in the
  worker-facing surfaces (workdays CSV, MY EARNINGS, payments earnings
  queries) that used to filter `guaranteedPayoutPaidAt: null`.

## Ratchet notes

- `audit-coverage` baseline for `routes/admin.ts` went **32 → 33**. Not a
  regression: the GP endpoint was one mutation with TWO audit branches,
  so deleting it removed 1 site and 2 `writeAudit` calls.
- `routes/cron.ts` baseline entry removed — its only unaudited mutation
  was the GP expiry job. Now pinned at 0.

## Consequence for Tips

GP's removal is what unblocks [[project-tips-feature-design]]: with the
`guaranteedPayoutPaidAt: null` query filters gone, tips go back on
`PaymentSplit.tipAmount` instead of needing a separate table, and the
`observerRedaction` leak disappears for free.
