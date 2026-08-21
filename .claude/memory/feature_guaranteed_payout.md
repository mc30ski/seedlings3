---
name: feature-guaranteed-payout
description: "Contractor guaranteed payout period — during the window, contractor pay is wage-anchored (paid like W-2). After the window, pay reverts to split-anchored (paid when client confirms). No advance table, no commit step — pure derivation from User.guaranteedPayoutUntil + JobOccurrence.completedAt."
metadata:
  node_type: memory
  type: feature
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:25:16.929Z
---

**Contractor guaranteed payout period (GP)** — a Company-defined window
(1-90 days from today, operator picks the end date) during which a
contractor's pay is **work-anchored**: paid on the next contractor
payroll run for the period the work was completed in, exactly like a
W-2 employee. After the window expires, the same contractor reverts to
**split-anchored** (paid when the client's payment is confirmed).

**Why:** Helps onboard new contractors by removing client-payment
timing risk while they ramp. Defensible as a limited onboarding
accommodation; tax form stays 1099, only the payment timing changes.
Paired with an offline-signed addendum.

**Don't confuse** with "made whole" in [payments.ts](apps/api/src/services/payments.ts)
(employees paid promised net even when clients underpay — that's about
AMOUNT, GP is about TIMING).

## The mental model

Three systems, three roles. Following this strictly is what made the
current design simple:

- **App = calculator.** Computes "who should be paid for what" from
  work + client-payment data. Produces idempotent CSVs.
- **Gusto = payroll authority.** Pays workers, withholds taxes,
  produces W-2s + 1099-NECs, syncs to QuickBooks.
- **QuickBooks = ledger.** P&L, balance sheet, Schedule C, tax filing.

The app never tracks "did Gusto pay them." That's Gusto's job. The
app's job is producing accurate CSVs.

## The decision rule (single, per occurrence)

At the moment a payment decision is made — either CSV generation or
client-payment confirmation — the question is:

> Was `occurrence.completedAt` inside `user.guaranteedPayoutUntil`
> at the time the occurrence was completed?

If YES → wage path. The occurrence appears on the Gusto Contractors
CSV for the window the work falls in. When the client later pays,
the resulting `PaymentSplit.guaranteedPayoutPaidAt` is stamped (with
the `completedAt` value) and the split is skipped on future CSVs.

If NO → split path. The occurrence does NOT appear on the CSV until
the client confirms payment, at which point the standard
post-GP-contractor logic emits a CSV row anchored on `Payment.confirmedAt`.

No event-driven transition. No state flag on the contractor. No
"current period" snapshot. Just the derivation, evaluated independently
per occurrence at decision time.

## Idempotency contract

`gustoContractorsCsv(start, end)` is a **pure read**. Same inputs →
same output. No DB writes. The function may be called any number of
times for any window:
- Weekly Mon-Sun: produces the payroll CSV
- March 1-31: produces the CPA's monthly report
- 1/1-12/31: produces the year-end reconciliation total against Gusto's 1099

All three are the same function, same compute, same answer.

## Implementation surfaces

- **`apps/api/src/services/exports.ts loadGpWorkAnchoredItems(start, end, opts?)`** —
  the canonical wage-path computation. Returns one item per (user ×
  occurrence) for contractors in GP at `completedAt`. Used by
  gustoContractorsCsv (no userId filter) AND by worker/admin
  dashboards (userId-filtered) so the CSV and the dashboards stay in
  lockstep.
- **`apps/api/src/services/payments.ts fetchAdvanceFlagsByUser`** —
  derives `PaymentSplit.guaranteedPayoutPaidAt` at split-creation time
  using the same `wasUserInGuaranteedPayoutAt` rule. Runs on every
  split-creation site so flagging is consistent.
- **`apps/api/src/services/exports.ts gustoContractorsCsv`** — combines
  (a) confirmed non-flagged PaymentSplits in window (post-GP path)
  with (b) loadGpWorkAnchoredItems(start, end) (wage path). Pure read.

## Deprecated: GuaranteedPayoutAdvance table

The `GuaranteedPayoutAdvance` table is preserved for historical audit
reference but is **no longer written to by new code**. Pre-cutover rows
remain in the database for pre-cutover-period reporting. The
schema-level comment on the model documents the deprecation.

`PaymentSplit.guaranteedPayoutPaidAt` is still set, but it's now
derived from `occurrence.completedAt + user.guaranteedPayoutUntil`,
not from an advance-row lookup. The downstream dedup logic
(payment-anchored CSV skipping flagged splits) is unchanged.

## QB Contract Labor — gated by toggle

Setting: `QB_INCLUDE_CONTRACT_LABOR` (default ON, in Settings →
Payments & Payouts).

When ON, the QB Expenses CSV emits Contract Labor rows for:
- Post-GP confirmed PaymentSplits (anchored on `confirmedAt`)
- GP wage-path work-anchored items (anchored on `completedAt`)
- Historical advance rows from before the cutover (anchored on
  `exportedAt`)

When OFF, the entire Contract Labor section is dropped. Flip OFF
after configuring Gusto's QuickBooks integration to post contractor
payments directly. The Exports tab's "Explain these files" panel and
the setting's own description text guide the operator on when to
flip it.

## Operational/legal context

Bounded to 1-90 days max (DOL/IRS prefer time-bounded onboarding
arrangements to indefinite ones). Contractor signs an offline addendum
with the same end date before the toggle activates. NC-based business
so federal FLSA applies; no state ABC test.

## Audit verbs (unchanged)

- `USER_GUARANTEED_PAYOUT_STARTED` — operator activated/extended a period
- `USER_GUARANTEED_PAYOUT_ENDED` — operator ended early OR cron auto-expired
- `EXPORT_DOWNLOADED` (new) — operator downloaded any CSV from the Exports tab

## Cron

- `/api/cron/guaranteed-payout-expirations` runs daily ~1am ET. Clears
  expired `guaranteedPayoutUntil` + `guaranteedPayoutStartedAt`,
  appends to `guaranteedPayoutHistory`, writes
  `USER_GUARANTEED_PAYOUT_ENDED` audit row.

## Cutover

Pre-cutover GP work was paid via the old advance-row mechanism. Those
rows stay in the DB. The operator hand-computes the transition payroll
period(s); new code handles all forward periods. No migration of
historical advance rows is done — they're left as historical artifacts.

## Seed for validation

`npx prisma db seed -- --template=payments-guaranteed-payout`
(trigger phrase: "reseed payment gp"). Creates a contractor on active
GP through today+60 with scenarios across wage-path and post-GP work.

Related: [[project-payment-math]], [[project-tax-export-integrity]], [[feedback-reseed-phrases]], [[feedback-payments-build-gate]] — invariant E covers the GP flag mechanically.
