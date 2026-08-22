---
name: project-equipment-rental-income
description: "Equipment rental charges to contractors are INCOME to the business, not a cost. Affects Admin Money summary display, QB Income export, and Schedule C reporting."
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:25:58.823Z
---

## CURRENT STATE: equipment billing toggle is OFF (2026-06-08)

**`EQUIPMENT_BILLING_ENABLED = false`** in the current deployment. Every
checkout release writes `Checkout.rentalCost = 0` regardless of the
per-worker policy below. Equipment cost is being absorbed into a higher
`CONTRACTOR_PLATFORM_FEE_PERCENT` while the operator finalizes the
contractor billing + NC sales-tax model with a CPA.

When the toggle flips back ON, the policy documented below resumes
verbatim — the gating happens at release time only, and `rentalDays` +
`rentalBreakdown` are still recorded for audit even when billing is OFF.

Gating logic: `loadEquipmentBillingEnabled()` in
[services/equipment.ts](apps/api/src/services/equipment.ts), checked in
both the regular release path and the force-release path. When the
setting is OFF, both paths force `effectiveRentalCost = 0` and pass
that into `writeCheckoutSplits` (for groups) or directly to the
checkout update (for solo).

## Policy (resumes when EQUIPMENT_BILLING_ENABLED is ON)

`Checkout.rentalCost` is the amount the business **actually billed contractors** for using equipment. The business OWNS the equipment; contractors pay to use it. This is **rental income to the business**, not a cost.

**Two billing models coexist, selected per piece via `Equipment.equivalentJobs`:**
- **`equivalentJobs IS NULL` → flat daily.** `rentalCost = rentalDays × dailyRate`. Legacy behavior.
- **`equivalentJobs > 0` → per-job with per-day cap.** For each ET day in the rental window: `daySubtotal = min(jobsCompletedThatDay × (dailyRate / equivalentJobs), dailyRate)`. Total = Σ daySubtotal. Days with zero billed jobs cost nothing. See [docs/FINANCIAL_SYSTEM.md §8a](docs/FINANCIAL_SYSTEM.md).

**`Checkout.rentalCost` stores ACTUAL billings, not notional.** For solo contractor: full amount. For solo employee/trainee: `0`. For group: sum of contractor `CheckoutSplit.amount`. `Checkout.rentalBreakdown` JSON column carries the per-day audit trail.

**Mixed crews (post-2026-06-02 fix):** Splits are computed for every non-observer crew member, then EMPLOYEE/TRAINEE shares are zeroed (audit row preserved, `amount = 0`). Unbilled shares are NOT redistributed to remaining contractors — the W-2/trainee equipment usage is already covered by the higher business margin on their jobs. See [[project-crews-roadmap]] and [[feature-per-job-equipment-billing]] for the two policy quirks this fix closed.

**Why:** Equipment is a capital asset of the LLC. When a contractor (1099) uses it on a job, the business charges them — that charge offsets the contractor's job payout. The business's actual cash flow:

```
Client pays $X (job payment)                  → business cash in
PaymentSplit.amount goes to contractor        → business cash out
Equipment charge reduces contractor's actual receivable
                                              → business keeps the charge
                                                (= rental income)
```

So `Net to Business = (commission + margin + overage − shortfall) + equipment rental income`.

**How to apply:**

- **Admin / Super Money summary:** Equipment line goes ABOVE Net to Business and **adds** to it. Do not treat it as a deduction (the bug fixed on 2026-06-XX did exactly that — sat below "Gross Collected" with a minus sign).
- **Worker Money summary:** Equipment is a deduction from THEIR take-home pay (correct — the contractor's wallet sees the charge as a debit). Don't change the worker view.
- **QB Income export:**
  - **Solo rentals** (no CheckoutSplit rows): one row per checkout. Amount = `Checkout.rentalCost` (which is `0` for solo employees, full amount for solo contractors). Ref = `RENT-{checkoutId}`.
  - **Group rentals** (CheckoutSplit rows materialized): one row PER CONTRACTOR SPLIT. Amount = `CheckoutSplit.amount` (employee splits are amount=0 and filtered out by the export's `splits.where: { amount: { gt: 0 } }`). Customer = the contractor on that split. Ref = `RENT-{checkoutId}-{userId}` so each contractor's row dedupes independently on re-import.
  - Date column = `releasedAt`, Account = "Equipment Rental Income" (configurable via setting).
- **Schedule C export:** Rental income lands on **Schedule C Line 1 (Gross receipts or sales)** — same line as service revenue. Configure via the EXPENSE_CATEGORIES taxonomy if a separate Line 6 (Other gross receipts) treatment is preferred — confirm with the CPA before flipping.
- **Tax-export integrity tests:** Equipment fixture rows must appear in qb-income.csv with the correct amount, and must NOT contain derived fields (no margin/commission columns).
- **`charge` semantics:** Only contractors are charged (`computeRentalCost` in [services/equipment.ts](apps/api/src/services/equipment.ts) returns null for EMPLOYEE/TRAINEE/null). Don't generalize this to other worker classes without a separate review — employees use equipment for free as part of W-2 work.

**Related:**
- [[project-payment-math]] — payment splits and commission/margin math. Equipment is separate from this.
- [[project-tax-export-integrity]] — exports may only carry raw cash-flow fields. Equipment rental income IS a raw cash-flow field (`Checkout.rentalCost`), so it's safe to surface; just make sure no derived fields tag along.
- [[feature-business-start-date]] — Equipment is filtered by `releasedAt` (when the charge materializes), not `checkedOutAt`. Same anchor in exports.
- [[feature-per-job-equipment-billing]] — the per-job-with-cap billing mode alternative to flat-daily.
- [[project-crews-roadmap]] — group rentals split via writeCheckoutSplits.

**Anti-patterns:**
- ✗ Subtracting equipment from "Net to Business" in the Admin summary (the original bug)
- ✗ Treating equipment income as a Schedule C deduction (Line 14)
- ✗ Adding equipment to qbExpensesCsv — it's income, not an expense
- ✗ Counting employee equipment use as income (it's free; only contractors are billed)
