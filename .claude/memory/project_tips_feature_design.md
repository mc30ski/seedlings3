---
name: project-tips-feature-design
description: "Agreed design for the Tips feature (overpayment → tip split between business and workers). Fully specced with the user 2026-08-31, NOT yet implemented. Blocked behind the GP removal. Read this before writing any tip code."
metadata: 
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-08-31T18:28:11.302Z
---

# Tips — agreed design, not yet built (specced 2026-08-31)

A tip is a **designated overpayment**. There is no standalone tip entry:
job $50, client pays $60, operator designates $10 as a tip when
approving (or via Adjust). The user confirmed this flow covers every
dollar that actually moves through the business.

## Sequencing

**Blocked on the GP removal** — see [[project-guaranteed-payout-removal]].
The original design needed a separate `PaymentTipSplit` table *only*
because GP's `guaranteedPayoutPaidAt: null` filters drop split rows at
the DATABASE, making a tip on that row unreachable. With GP gone, tips
go back on `PaymentSplit` and two audit findings disappear (see below).

## Schema (post-GP-removal shape)

- `Payment.tipAmount` — total designated as a tip
- `Payment.tipToBusinessAmount` — business share
- `PaymentSplit.tipAmount` — each worker's share
- `overageAmount` narrows to the **undesignated** remainder; tip and
  overage are mutually exclusive.

Extended build-gate identity C:

```
amountPaid = Σ split.amount + Σ split.tipAmount + platformFee
           + businessMargin + tipToBusinessAmount + overageAmount
           − shortfallAmount + expenses
```

**Do NOT fold tips into `split.amount`.** Every existing reader of
`split.amount` (payroll `netPaid`, QB income, workdays CSV, 1099
aggregation, worker earnings) would absorb tips and mis-anchor them.

## The anchoring rule — the core of the design

- **Job pay is WORK-anchored** — `reconcileWorkers` buckets by
  `JobOccurrence.completedAt`.
- **Tips are PAYMENT-anchored** — `payment.confirmedAt`. A tip does not
  exist until the client pays it.

So a worker can get the job payout on one payroll and the tip on
another. The user explicitly confirmed this is correct, not a
compromise.

## Decided policy

- Tips **bypass fee and margin entirely** — the business's cut is
  exactly the percentage assigned, no 20%/30% on top.
- Default split = the job's `completionSplits` percentages, **Business
  0%**. A trainee credited 20% of the job defaults to 20% of the tip.
- **Excluded from min-wage / effective-hourly.** Already safe for
  min-wage: `belowMinWage` uses `preTopUpHourly = (grossEarnings −
  feesOrMargin)/hours`, so keep tips out of `grossEarnings`. But
  `effectiveHourly` reads `displayNet` — tips must be a SEPARATE field:
  `totalGross = displayNet + tips` while `effectiveHourly` stays on
  `displayNet`.
- Trainees eligible. Observers excluded.
- **LLC owner needs no new mechanism** — the owner is a normal assignee
  whose split carries `ownerEarnings: true` (stamped via
  `loadOwnerSet`). That one flag already redirects money at every
  reporting boundary, so owner tips ride free. Keep the Business row and
  the Owner row separate (owner share stays attributed per-job), but the
  dialog must say "Business keeps X% — 0% business + X% owner share",
  or a 0% business row reads as "the business takes nothing".

## Audit findings that still apply

1. `pnlReport.ts` — employee tips must be added to `wagesAccruedTotal`
   (W-2 wage expense), contractor tips to `contractLaborTotal`. Owner
   tips excluded via the existing `ownerEarnings: false` query filters.
2. `exports.ts:894` — Income CSV sums `workerPayouts += sp.amount`;
   `amountPaid` includes the tip, so the row stops balancing without
   tip payouts added.
3. Gusto export gets its own **Tips** column — NOT folded into
   `additionalEarnings`. Gusto treats tips as a distinct earning type
   (and "Cash Tips" vs "Paycheck Tips" are different things).

Two findings from the original audit **go away** once GP is removed:
the GP row-drop trap, and the `observerRedaction.ts` leak (it already
filters `payment.splits` to the caller's own row, so tips on that row
are redacted for free).

## UI

Rule: **anywhere a payout number appears, the tip appears beside it as
its own line — never silently summed in.**

- Payment card: `Tip $X` badge replacing the purple `Overpaid` badge
  (see [[feature-overpaid-badge]]), plus "Tip $15.00 — $9.00 to
  workers, $6.00 to business".
- Job card: tip as a sibling line under the payout block.
- MY EARNINGS / MY PAYDAY / Payroll tab: own column; when the tip's
  period differs from the job's, say so or the two-payroll case reads
  as a bug.
- Receipt: job total, tip, grand total.

## Deferred

- **Gusto IMPORT mapping** — waiting on a real CSV with tips (~2026-09-07).
  Safe to wait: `PayrollEntry.raw` keeps the verbatim row and
  `PayrollPeriod.sourceR2Key` keeps the file forever, so a backfill
  needs no re-upload. Symptom meanwhile: gross includes tips with no
  line item.
- **Direct cash tips** that never touch the business (client pays exact
  amount, hands worker cash). Out of v1 by agreement.

`docs/FINANCIAL_SYSTEM.md` must be updated in the same change.
