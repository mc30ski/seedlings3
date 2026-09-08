---
name: project-payment-math
description: "Canonical formula for splitting a client payment across workers, handling fees/margins, and reconciling overpay/underpay/write-off."
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:03.743Z
---

## Canonical payment math

Given a payment, its **invoice charges**, and per-worker splits with worker
types:

```
N         = collected − charges                           (charges come off the top)
gross_i   = N × split_i                                   (worker i's share of the net)
rate_i    = CONTRACTOR_PLATFORM_FEE_PERCENT (contractor or null workerType)
            EMPLOYEE_BUSINESS_MARGIN_PERCENT (employee or trainee)
fee_i     = gross_i × rate_i
net_i     = gross_i − fee_i
```

**Say "charges", never "expenses".** These are `InvoiceCharge` rows — what the
CLIENT is billed. They are NOT `BusinessExpense` and create no deduction; the
old name is precisely how the two books got conflated. See
[[reference-expenses-charges-supplies]].

**Feed `computeBreakdown` the INVOICE, not labor alone.** `crewPool` is labor +
services; `invoiceTotal` adds the charges. Passing labor-only and then
subtracting charges takes materials out of the crew's pool a second time.

Fee is applied to **each worker's own share**, not the pool. Class totals (`platformFeeTotal`, `businessMarginTotal`) are sums of per-worker fees, not a re-computation from the pool.

## Worker-type policy

- `WorkerType` enum: `EMPLOYEE | CONTRACTOR | TRAINEE | null` (null = contractor-class for fees)
- TRAINEE is treated identically to EMPLOYEE for both fee class AND payout protection (made whole on underpay)
- Settings hold the rates: `CONTRACTOR_PLATFORM_FEE_PERCENT`, `EMPLOYEE_BUSINESS_MARGIN_PERCENT`

## Promised vs. collected reconciliation

At completion time, snapshot per-worker promised payouts onto `JobOccurrence.promisedPayouts`. This is immutable — it locks in what each worker is owed regardless of what the client ends up paying.

At admin approval time:

| Scenario | Workers | Business | Recorded as |
|---|---|---|---|
| `collected == promised` | Paid as computed | Net of fees/margin | normal |
| `collected > promised` | Paid promised amount | Keeps the overage | `Payment.overageAmount` |
| `collected < promised` | Employees+trainees made whole. Contractors pro-rata the shortfall. | Absorbs the rest | `Payment.shortfallAmount` |
| `collected == 0` (write-off) | Employees+trainees made whole. Contractors get $0. | Absorbs all of it | `Payment.shortfallAmount = promised` |

Admin can adjust `collected` on approval if the reported amount doesn't match what actually hit the bank — info banner on the adjust dialog explains this.

## Why no Bad Debt Expense / Super Money Expense entry

**Why:** On cash basis (which seedlings3 uses), revenue is only recognized when collected. Underpayment isn't a deductible bad debt — it's just lower revenue and proportionally higher labor cost. The employee top-up money is already labor expense (wages), not a separate bad-debt write-off. Booking it as a Super Money Expense would double-count it.

**How to apply:** `shortfallAmount` and `overageAmount` are internal reporting fields — surface them in admin reporting ("money lost to underpayment this quarter"), but never expose them as a separate accounting entry, P&L line, or tax-relevant expense. They're informational, not transactional.

## Related

- [[project-guaranteed-payout-removal]] — GP was REMOVED 2026-08-31; contractors are payment-anchored, always.
- [[feedback-prisma-migrations]] — all schema changes for this go through a single new migration on top of the latest, never `db push`.
- [[feedback-payments-build-gate]] — invariants that lock the math above.
- [[project-tax-export-integrity]] — never export shortfall/overage as tax lines.
- [[project-equipment-rental-income]] — equipment rental is income; separate from this file's math but on the same P&L.
- [[reference-expenses-charges-supplies]] — the two-books model these charges live in.
