---
name: feature-per-job-equipment-billing
description: Equipment can be billed per-job with a per-day cap (alternative to flat-daily). Opt in per piece via Equipment.equivalentJobs. Shipped 2026-06-02 alongside the mixed-crew billing bug fix.
metadata:
  node_type: memory
  type: feature
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:25:41.571Z
---

The equipment rental billing model was extended to support a per-job rate with a per-day cap. Selected per piece via a new `Equipment.equivalentJobs` integer column. NULL = legacy flat-daily billing (unchanged).

**Why:** Contractors complained that the flat-daily model overcharged on days when they only used a piece on 1–2 jobs. Per-job-with-cap means the contractor pays per job they actually completed, never more than the daily rate.

**How to apply:**
- Server-side billing math lives in `computeRentalCost` in [services/equipment.ts](apps/api/src/services/equipment.ts). Don't reconstruct cost from `rentalDays × dailyRate` anywhere — the relationship no longer holds for per-job pieces; always read `Checkout.rentalCost` (which is now the **actual** contractor billed total).
- Display side uses `resolveBillingMode` + `shortBillingChip` + `instructiveBillingText` from [lib/equipmentBilling.ts](apps/web/src/lib/equipmentBilling.ts). Every equipment chip and reserve/checkout copy goes through these so the UI stays consistent across surfaces.
- BSD orthogonal — checkouts before the cutoff stay frozen on whatever model they used at release.

## The math (per piece, contractor side)

```
If Equipment.equivalentJobs IS NULL:
  rentalCost = rentalDays × dailyRate
Else:
  perJob = dailyRate / equivalentJobs
  For each ET calendar day D in [checkedOutAt, releasedAt]:
    jobsOnD = count of JobOccurrences where:
      • workflow ∈ {STANDARD, ONE_OFF}
      • status ∈ {COMPLETED, CLOSED, PENDING_PAYMENT}
      • completedAt is in ET day D
      • completedAt within [checkedOutAt, releasedAt]
      • for group checkout: assignedGroupId == checkout.groupId
        for solo checkout: this user is an assignee, NOT a group-assigned job
    daySubtotal(D) = min(jobsOnD × perJob, dailyRate)
  rentalCost = Σ daySubtotal
```

A day with 0 jobs costs $0. The cap protects against high-volume days. After computation, the splitter (`writeCheckoutSplits`) zeros out EMPLOYEE/TRAINEE shares — same mixed-crew policy as flat-daily mode.

## Where things live

- `Equipment.equivalentJobs Int?` — new column, migration `20260602215206_add_equipment_equivalent_jobs`.
- `Checkout.rentalBreakdown Json?` — new column, migration `add_checkout_rental_breakdown`. Persisted at release time so receipts + worker money tab can show the per-day audit trail without recomputing.
- `computeRentalCost(checkedOutAt, releasedAt, dailyRate, equivalentJobs, jobsByDay)` — exported pure function. Returns `{ rentalDays, rentalCost, breakdown }`. NO worker-type gating; gate happens at the caller (`release()`) or in `calculateContractorSplits` for groups.
- `fetchJobsByDayForCheckout(tx, ctx)` — DB helper that buckets formal-crew or solo jobs by ET day for use as the `jobsByDay` input.
- `calculateContractorSplits(workers, rentalCost)` — pure-function splitter. Exported for tests. Zeroes EMPLOYEE/TRAINEE shares without redistribution.
- `writeCheckoutSplits(tx, params)` — DB wrapper around the splitter. Returns `{ contractorTotal }` so the caller can store it in `Checkout.rentalCost`.

## UI surfaces

- **Equipment edit dialog** ([dialogs/EquipmentDialog.tsx](apps/web/src/ui/dialogs/EquipmentDialog.tsx)) — "Equivalent Jobs / Day" input field with live preview of per-job rate.
- **Equipment chip** — `shortBillingChip()` returns `"$X.XX/day"` for flat, or `"$Y.YY/job · max $X.XX/day"` for per-job. Used in `InventoryTab` cards (renamed from EquipmentTab in the 2026-08-21 refactor — see [[project-tab-refactor-2026-08-21]]), BeginWorkDayWorkflow, PlanWorkdayWorkflow, PaymentsTab worker money cards, and the reserve confirm dialog.
- **Reserve / checkout copy** — `instructiveBillingText()` returns the full user-facing explanation. Shown in the reserve confirm dialog.
- **Worker money tab equipment card** — renders `Checkout.rentalBreakdown` per-day lines below the chip so the worker can audit the charge ("Day 1: 4 jobs → $4.00 (capped). Day 2: 2 jobs → $2.00. Total: $6.00").
- **Operations equipment leaderboard** — "Jobs Billed" column shows `Σ rentalBreakdown.jobs` across the window. Null (rendered as "—") when the piece's recent rentals were all flat-daily. New chart metric option.

## Tests

- `services/equipment.test.ts` — 36 tests. Cover both billing modes, including capping, zero-jobs days, multi-day mixed busy/idle, fractional rates, and defensive equivalentJobs ≤ 0 fallback. Also cover the mixed-crew Scenario A (contractor claimer + employee member) and Scenario B (employee claimer + contractor members) policy fixes.
- `services/exports.test.ts` — 25 tests. Cover per-contractor-split rows for group rentals, mixed-crew (employee filtered), and combined solo + group income totals.

## Related

- [[project-equipment-rental-income]] — same income classification, just with the new billing math.
- [[project-crews-roadmap]] — closed the two mixed-crew policy bugs (employee-in-contractor-crew billed; employee-claimer = whole-crew-free) as part of this work.
- [[financial-system-doc]] — `docs/FINANCIAL_SYSTEM.md §8a` has the canonical operator-facing description.
- [[feedback-payments-build-gate]] — invariants that lock the split math.
