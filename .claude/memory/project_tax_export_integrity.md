---
name: project-tax-export-integrity
description: "For QuickBooks / tax exports, use only the raw cash-flow fields. Never include internal reporting fields (shortfall, overage, margin breakdown) as tax line items."
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:28:19.019Z
---

When building the QuickBooks export (or any tax-relevant export), pull
**only** these source-of-truth cash-flow fields. Do NOT include the
internal reporting fields as line items — they'd double-count or invent
phantom deductions on a cash-basis return.

## Tax-safe fields (use these)

| Tax line | Source | Notes |
|---|---|---|
| Gross revenue | `Payment.amountPaid` | What actually landed in the bank |
| Wages (W-2) | `PaymentSplit.amount` where `user.workerType` ∈ {EMPLOYEE, TRAINEE} | Already includes topUp for made-whole cases |
| 1099 / subcontractor | `PaymentSplit.amount` where `user.workerType` = CONTRACTOR | Reflects pro-rata payouts after underpay |
| Business expenses | `Expense.cost` (or `BusinessExpense` table for tax-ledger fields) | Schedule C-aligned via `BusinessExpense.category` |

## Internal-only fields (NEVER export as tax lines)

These exist for **operator dashboards** only. They show how a job's
payment deviated from expectations, but they don't correspond to real
accounting events on cash basis.

- `Payment.shortfallAmount` — money the business "expected vs. didn't get." Not a deductible bad-debt expense (cash basis = only recognize what you collect).
- `Payment.overageAmount` — extra above expected. Already included in `amountPaid`; don't add again.
- `Payment.platformFeeAmount` / `businessMarginAmount` — represent the promised cut on the invoiced amount. Already implicit in `amountPaid` − `Σ PaymentSplit.amount` − `Σ Expense.cost`. Don't add as separate revenue lines.
- `Payment.adjustedFromAmount` — audit field for "originally reported value." Not a transaction.
- `Payment.writtenOff` — flag for filtering reports. Not a separate expense; the write-off's financial impact is already captured by `amountPaid` ≈ 0 + `PaymentSplit.amount` > 0 (employee made whole).
- `JobOccurrence.promisedPayouts` — snapshot at completion. Reference data; not a transaction.

## Why this matters

Cash basis (which seedlings3 uses, per [[project-payment-math]]):
- Revenue is recognized when collected, not when invoiced.
- Wages are deductible when paid, not when accrued.

The internal fields shadow these realities for *operator* visibility:
seeing "$90 shortfall" lets the owner notice a bad job at a glance.
But the same $90 already shows up correctly in the cash math:
`$10 revenue − $80 labor = −$70 net loss` (with the remaining $20 of
the "shortfall" being margin that simply never existed as revenue).

Exposing the internal fields as separate tax lines would:
1. Inflate deductions (treating uncollected revenue as a bad-debt expense).
2. Inflate revenue (counting overage twice).
3. Create reconciliation breaks with the bank.

## 1099 totals are Gusto's job, not the app's

The app does NOT produce year-end 1099 totals. Contractor payments
flow through Gusto's contractor payment system; Gusto issues the
1099-NEC at year-end based on what it actually paid. The app's role
is producing accurate weekly CSVs that drive those payments.

If the operator wants a reconciliation total ("did Gusto's 1099
match what we told it to pay?"), they re-run the Gusto Contractors
CSV for `1/1 → 12/31` — the same idempotent export, just with a
year-long window. Diff that against Gusto's 1099 report; any mismatch
flags a missed or duplicate CSV upload.

The same logic applies to W-2 totals: Gusto produces the W-2 from
what it paid; the app's `gusto-w2.csv` for `1/1 → 12/31` is the
reconciliation source.

The app NEVER tracks "did Gusto pay them." That coupling is what
created the GuaranteedPayoutAdvance complexity, since removed —
see [[project-guaranteed-payout-removal]].

Related: [[project-payment-math]], [[financial-system-doc]], [[feedback-payments-build-gate]] — invariant D covers this rule mechanically.

## Contract Labor in QB Expenses is gated by a toggle

Setting: `QB_INCLUDE_CONTRACT_LABOR` (boolean, default ON). Located
in Settings → Payments & Payouts.

When ON: the app's `qb-journal-expenses.csv` emits Contract Labor
rows for confirmed contractor splits. This is the only path
getting contractor labor into
QB until Gusto's QB integration is configured.

When OFF: the entire Contract Labor section is dropped from the CSV.
Appropriate once Gusto's QuickBooks integration posts contractor
payments to QB directly — the app's rows become duplicative.

Reader: `loadIncludeContractLabor()` in `services/exports.ts`.
Wiring: `qbExpensesCsv()` wraps all three Contract Labor loops in
a single `if (includeContractLabor)` block — one flag controls the
whole section.

## Header note for the export

When the export feature ships, include a header comment:

> *Cash-basis export. Lines reflect actual collected revenue, wages paid, and expenses paid. Internal reporting fields (shortfall, overage, promised margin) are intentionally excluded — they're operator dashboards, not accounting events.*
