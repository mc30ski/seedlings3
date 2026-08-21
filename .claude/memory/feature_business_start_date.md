---
name: feature-business-start-date
description: Business Start Date filter — non-destructive money cleanup. Pre-cutoff Payments/Expenses/Checkouts/AuditEvents hidden from every view & export. Server-enforced; toggle in Settings.
metadata:
  node_type: memory
  type: feature
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:58.700Z
---

The Business Start Date feature lets the operator present a clean slate from a configured cutoff onward (Seedlings official start = 2026-06-01) while preserving every row in the database. It is a READ-TIME FILTER, never a destructive operation.

**Why:** The pre-launch period (early 2026) contained "test" payments, equipment charges, and audit events that the operator didn't want polluting Worker dashboards, Money tabs, or QuickBooks/Gusto/Schedule-C exports. The user explicitly required "absolutely no data destruction" and the ability to bring all data back at any time.

**How to apply:** Whenever working on a query that reads from `Payment`, `PaymentSplit`, `BusinessExpense`, `Expense`, `Checkout`, `AuditEvent`, or `SupplyPurchase`, OR whenever working on an aggregation that iterates `JobOccurrence` and rolls up money fields, use the helpers in [apps/api/src/lib/businessStartCutoff.ts](apps/api/src/lib/businessStartCutoff.ts):

- `resolveCutoff(req)` — returns the effective cutoff for the current request (null = filter off; Super reveal header also returns null).
- `cutoffWhere(model, cutoff)` — Pattern A: top-level money table filter. Returns `{}` when cutoff is null.
- `paymentSplitCutoffWhere(cutoff)` — PaymentSplit anchors via parent `payment.createdAt`. NEVER use PaymentSplit.createdAt directly — it jumps on re-approval.
- `expenseCutoffWhere(cutoff)` — Expense anchors via paired BusinessExpense.date when present, falls back to Expense.createdAt.
- `paymentIncludeWithCutoff(cutoff, extras)` / `expensesIncludeWithCutoff(cutoff, extras)` — Pattern B: filtered includes on JobOccurrence so operations/statistics aggregations skip pre-cutoff money with no math changes.
- `occurrenceWorkDateCutoff(cutoff)` — Pattern C: for employee earnings aggregations that iterate JobOccurrence directly. Filters on `completedAt ?? startedAt ?? startAt`.

Per-table date anchors (canonical):

| Model | Date field | Notes |
|---|---|---|
| Payment | `createdAt` | Stable; doesn't move on approval |
| PaymentSplit | `payment.createdAt` (traversed) | SPLIT'S OWN createdAt is unreliable — re-created on approval |
| BusinessExpense | `date` (user-entered) | Both EXPENSE and equity entries |
| Expense | `businessExpense.date` if paired, else `createdAt` | Keeps the 1:1 pair consistent |
| Checkout | `releasedAt` | For CHARGE views only. Usage views use `checkedOutAt`. |
| AuditEvent | `createdAt` | |
| SupplyPurchase | `date` | |

**Client side:** [apps/web/src/lib/businessStartCutoff.tsx](apps/web/src/lib/businessStartCutoff.tsx) exposes `useBusinessStartCutoff()` and `useIsPreCutoff(date)`. The Super "reveal" override is IN-MEMORY only (not localStorage) — page reload resets it to filtered. Header `X-Reveal-Pre-Cutoff` is attached automatically by [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts) when the toggle is on.

**Client portal — BSD does NOT apply.** Routes in [apps/api/src/routes/client.ts](apps/api/src/routes/client.ts) (`/client/me`, `/client/jobs`, `/client/upcoming`, `/client/change-requests`, `/client/estimates/*`, etc.) deliberately never call `resolveCutoff(req)`. Reason: BSD is an internal accounting boundary; a customer should always see their own service history regardless of the operator's cutoff. The 12-month rolling window on `/client/jobs` is the independent client-side cap. Do not propagate `cutoff` into client routes — there's a guard comment at the top of `clientRoutes` saying so.

**Safety invariants** (preserve when extending):
1. When the filter is off OR the Super reveal is honored, every helper returns `{}` / `extras` unchanged — the underlying query is byte-identical to its pre-feature shape.
2. Any failure path (settings throw, parse fail, role lookup throw) defaults to NO FILTER. Never hide data on a transient error.
3. Production deploys land OFF. The seed for `BUSINESS_START_DATE_ENABLED` is `"false"`.

**Settings rows** (seeded in [apps/api/prisma/seed.ts](apps/api/prisma/seed.ts)):
- `BUSINESS_START_DATE` — ISO date string (YYYY-MM-DD). Seeded to `2026-06-01` in dev.
- `BUSINESS_START_DATE_ENABLED` — `"true"`/`"false"`. Seeded to `"false"`.
- Both live in the `fresh_start` section, pinned to the top of the Settings tab via [apps/web/src/lib/settingSections.ts](apps/web/src/lib/settingSections.ts).

**UI surfaces that adjust visibly:**
- Settings tab — top section shows active-state indicator and the Super reveal toggle. See `BusinessStartStatusPanel` in [apps/web/src/ui/tabs/SettingsTab.tsx](apps/web/src/ui/tabs/SettingsTab.tsx).
- JobsTab — pre-cutoff occurrences are HIDDEN ENTIRELY (server filters them out of `/occurrences` via `occurrenceWorkDateCutoff`). The old dash-badge treatment was removed 2026-06-01 — operator preferred hiding to match Payments tab behavior. Pre-cutoff data still exists in the DB and still feeds analytics (e.g. `time_estimate_mismatch` audit check), it's just invisible on the operator JobsTab while the filter is on.
- Payments tab — pre-cutoff payments hidden via the listMyPayments/listAllPayments cutoff filter.

**Endpoints touched** (search for `resolveCutoff` to see the full list): worker money endpoints (/payments/mine, /payments/earnings-summary, /payments/title-bar-earnings, /payments/equipment-charges, /dashboard-summary, /dashboard-summary/aggregate, /me/outstanding-payment-requests), admin money endpoints (/admin/payments, /admin/payments/equipment-charges, /admin/payments/pending, /admin/payment-requests/outstanding, /admin/audit, /admin/business-expenses, /admin/business-expenses/vs-revenue, /admin/business-expenses/summary, /admin/users/:id/earnings-summary, /admin/statistics, /admin/operations, /admin/export, /admin/export-summary, /admin/supplies/:id/history, /admin/exports/* including bundles), and a small `/me/business-start` endpoint that returns the effective cutoff to the client.

**Tax-export integrity:** see [[project-tax-export-integrity]]. The cutoff is layered ON TOP OF each export's existing date range — it can hide rows the date-range query would have returned. Each export endpoint logs a warning when running with cutoff active, and the operator should toggle reveal ON before exporting full-history files for the CPA.

Related: [[project-payment-math]], [[project-equipment-rental-income]], [[feedback-payments-build-gate]].
