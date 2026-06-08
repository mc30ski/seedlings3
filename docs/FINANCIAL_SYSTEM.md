# Seedlings Lawn Care — Financial System Reference

**Audience:** Admins and super admins who need to understand how payments, payouts,
processor fees, owner earnings, business expenses, and tax exports work.

**Also:** the canonical spec. If code changes ever cause behavior to drift from
this document, this document describes the *intended* behavior — treat a
mismatch as a bug to investigate, not a new normal.

**Companion document:** [TAX_AND_PAYROLL_PICTURE.md](./TAX_AND_PAYROLL_PICTURE.md)
is the big-picture business-owner view of how the three financial systems
(this app, Gusto, QuickBooks) work together. Start there if you're trying to
understand the WORKFLOW; come here for the technical detail of the app's
internal math, lifecycle, and export formats.

Last updated: 2026-06-08.

---

## Contents

1. [The workforce model](#1-the-workforce-model) — W-2 / 1099 / trainee / LLC owner
2. [The payment lifecycle](#2-the-payment-lifecycle) — completed → pending → approve/reject/adjust/write-off → closed
3. [Payout math](#3-payout-math--how-a-workers-share-is-calculated) — per-worker fees; gross → fee → net
4. [Reconciliation](#4-reconciliation--promised-vs-actual-underpay--overpay) — promised vs. actual, made-whole, pro-rata, shortfall/overage
5. [Processor fees](#5-processor-fees) — snapshot math, business always absorbs, fee override at approval
6. [Configurable payment methods](#6-configurable-payment-methods-payment_methods-setting) — the `PAYMENT_METHODS` taxonomy + placeholders
7. [The two payment contexts](#7-the-two-payment-contexts) — client request / on-site + the Request Payment toggle
8. [Owner earnings](#8-owner-earnings) — tracked like a worker, taken as a draw
9. [Business expenses & the Accounting tab Cash Flow view](#9-business-expenses--the-accounting-tab-cash-flow-view)
10. [Tax integrity rules](#10-tax-integrity-rules) — the five must-holds
11. [Settings reference](#11-settings-reference) — all financial settings + defaults
12. [Exports](#12-exports-super--money--exports) — Gusto + QuickBooks; QB journal-entry format, ledgerId, App Clearing Account
13. [Worker earnings views](#13-worker-earnings-views--home-tile--payments-tab) — Home tile & Payments tab anchors, worker-type split
14. [Audit events](#14-audit-events) — every payment/setting verb
15. [Glossary](#15-glossary)

---

## 1. The workforce model

The business runs a hybrid workforce. Every worker has a **worker type** that
determines how they're paid and taxed:

| Worker type | Tax treatment | Paid via | Notes |
|---|---|---|---|
| **EMPLOYEE** | W-2 | Gusto payroll, on a schedule | Made whole on underpaid jobs (see §4) |
| **TRAINEE** | W-2 | Gusto payroll | Same as employee for pay; cannot start/complete/manage jobs |
| **CONTRACTOR** | 1099 | Gusto contractor payments, per job | Absorbs a pro-rata share of client underpayment |
| **LLC Owner** | Owner's draw | Direct draw from the business bank account | A flag, not a worker type — see §8 |

The **LLC Owner** is additive: the owner is also an EMPLOYEE or CONTRACTOR for
worker-type purposes, and *also* carries an `isOwner` flag. Only one user can
be the owner at a time.

All payout percentages are **configurable settings** — never hardcoded. See §11.

---

## 2. The payment lifecycle

A job moves through these states once work is done:

```
Job completed by worker
        │
        ▼
  PENDING_PAYMENT  ──────────────────────────────┐
        │                                        │
        │  Payment recorded (confirmed = false)   │
        │   • Worker on-site (AcceptPaymentDialog)│
        │   • Client self-report (/pay/[token])   │
        ▼                                        │
  Pending Approvals queue                        │
        │                                        │
        │  Admin reviews                          │
        ├── Approve  ──────► CLOSED  (confirmed = true)
        ├── Adjust + Approve ► CLOSED  (amount corrected, then confirmed)
        ├── Reject  ───────► back to PENDING_PAYMENT (worker re-records)
        └── Write off ─────► CLOSED  (collected $0; see §4)
```

**Key rule:** a payment is not "real money" until an admin **confirms** it.
`confirmed = false` means recorded-but-unverified. The occurrence stays
`PENDING_PAYMENT` until an admin approves. Cash-basis reporting and all exports
key off the **confirmation date** (`confirmedAt`), not the record date.

Only **one** Payment row can exist per job occurrence at a time. To record a
different payment, an admin must Reject the existing one first.

---

## 3. Payout math — how a worker's share is calculated

When a payment is recorded, the collected amount is split among the job's
workers. The math is **per-worker** — each worker's fee is applied to their own
share, never to the pool as a whole.

For a collected amount and a set of workers with percentage splits:

```
N            = collected − job expenses          (the distributable pool)
gross_i      = N × (worker i's split %)           (worker i's share before fee)
rate_i       = that worker's fee/margin rate      (from Settings — see below)
fee_i        = gross_i × rate_i / 100
net_i        = gross_i − fee_i                    (worker i's take-home)
```

The **rate** depends on worker type:

- **CONTRACTOR** → "platform fee" / commission, from `CONTRACTOR_PLATFORM_FEE_PERCENT` (default 20%)
- **EMPLOYEE / TRAINEE** → "business margin", from `EMPLOYEE_BUSINESS_MARGIN_PERCENT` (default 30%)

The fee/margin is what the **business keeps**; the net is what the **worker
gets**. On a $100 job with one contractor at a 100% split: $20 commission to
the business, $80 to the contractor.

Mixed crews work the same way — each worker's own rate applies to their own
share. A 50/50 contractor+employee crew on $100 yields $40 to the contractor
($50 − 20%) and $35 to the employee ($50 − 30%).

---

## 4. Reconciliation — promised vs. actual, underpay & overpay

When a job is completed, the app takes a **promised-payout snapshot**: what each
worker *would* earn if the client paid the full invoice. This snapshot is the
contract used at admin-approval time.

When the actual collected amount differs from the invoice:

### Underpayment (client paid less than invoiced)
- **Employees / trainees are made whole.** They receive their full *promised*
  net. The business pays the difference (a "top-up") out of pocket.
- **Contractors absorb a pro-rata loss.** They receive the lesser of their
  actual net and their promised net — i.e. their share shrinks proportionally
  with the underpayment.
- The business **absorbs the shortfall** — recorded in `shortfallAmount`.

### Overpayment (client paid more than invoiced)
- All workers receive their **promised** net (no windfall to workers).
- The business **keeps the overage** — recorded in `overageAmount`.

### Write-off (client never paid)
- Collected = $0. Employees/trainees still receive their promised net.
  Contractors receive $0. The full promised amount lands in `shortfallAmount`.

**`shortfallAmount` and `overageAmount` are internal reporting fields only.**
They are NOT separate accounting entries and never appear on a tax return —
cash-basis accounting already reflects them in collected revenue and labor
cost. See §10.

### Timing — when each worker type is actually paid

Worker pay is on one of two clocks, chosen per occurrence at the moment
of the payment decision:

- **Employee / trainee (W-2)** — always work-anchored. Wage accrues
  **when the work is done**, is **paid on the regular payroll run for
  the period the work fell in**, regardless of whether or when the
  client pays. The business fronts it. If the client later underpays
  or never pays, that's a **business loss**; the employee's pay and
  W-2 are **never clawed back**.
- **Contractor (1099), post-GP** — payment-anchored. Pay is
  **contingent on the client payment** — paid when the payment is
  confirmed, in the reconciled (possibly pro-rata-reduced) amount. A
  client underpayment reduces what the contractor receives and what
  lands on their 1099.
- **Contractor (1099), during their GP period** — work-anchored. While
  the contractor's `guaranteedPayoutUntil` window is active, GP work is
  paid like W-2: on the regular contractor payroll run for the period
  the work fell in, regardless of client payment. Same model the
  employee path uses — only the tax form (1099 vs W-2) differs.

The choice happens per occurrence, automatically. When the app needs to
know "was this contractor paid via wage path or split path?", it
checks whether `occurrence.completedAt` falls inside the contractor's
GP window at completion time. If yes → wage path; if no → split path.
No per-contractor toggle, no state machine — just a derivation.

This asymmetry drives the export anchors in §12 — W-2 by work date,
post-GP 1099 by payment date, GP-period 1099 by work date.

---

## 5. Processor fees

Some payment methods charge a processing fee (e.g. Venmo Goods & Services).
Each method in the taxonomy (§6) carries a `feePercent` and a `feeFixed`.

When a payment is recorded, the app snapshots the fee:

```
grossCharged       = what the client paid
processorFeeAmount = round( grossCharged × feePercent / 100 + feeFixed , 2 )
netReceived        = grossCharged − processorFeeAmount
```

The fee rate is **snapshotted on the Payment row** at record time, so changing
the taxonomy later never rewrites historical payments.

### The business absorbs the fee

The business **always** absorbs the processor fee. Worker payouts are always
calculated on the **full gross** — the payment method the client chose never
changes what a worker is paid. The fee is recorded purely as a business
expense and flows to the QuickBooks expense export (§12) as a "Payment
Processing Fees" line. `grossCharged`, `processorFeeAmount`, and `netReceived`
are all stored on the Payment record.

### Correcting the fee at approval

`processorFeeAmount` is computed from the configured rate, which is only an
**estimate** — a processor's actual fee can land a cent off due to rounding.
When an admin approves a payment, they can **override the fee** with the
actual figure from the processor's statement (e.g. Venmo). The override
updates `processorFeeAmount` and `netReceived` only; because the business
absorbs the fee, it provably cannot affect any worker payout, split, top-up,
or reconciliation figure.

Historical payments recorded before processor-fee tracking existed are treated
as zero-fee (the fields are null).

---

## 6. Configurable payment methods (`PAYMENT_METHODS` setting)

**Payment methods are 100% configuration.** Adding, removing, renaming, or
re-pricing a method — or changing its instructions, deep link, or where it
appears — is a Settings edit in **Super → Settings → Payment Methods**. No code
change, no migration, no deploy.

> The only exception: introducing a brand-new method that has *never* existed
> requires a one-line database change first. Day-to-day, that does not happen —
> the four methods below plus any future additions are pure config.

Each method entry has:

| Field | Meaning |
|---|---|
| `key` | Unique identifier, stored on each Payment (e.g. `VENMO`) |
| `label` | Display name shown everywhere in the app |
| `feePercent` | Processor percentage fee (0 if none) |
| `feeFixed` | Processor fixed per-transaction fee in dollars (0 if none) |
| `supportsClientRequest` | Show on the client payment page (`/pay/[token]`) |
| `supportsOnSite` | Show in the worker on-site Initiate Payment dialog |
| `deepLinkTemplate` | Optional mobile deep link (e.g. `venmo://…`); null = no button |
| `instructions` | Optional text shown to the client |
| `active` | If false, hidden everywhere; historical records preserved |

Default methods: **Venmo** (1.9% + $0.10, both contexts, deep link), **Zelle**
(no fee, both contexts), **Cash** (no fee, on-site only), **Check** (no fee,
both contexts).

### Placeholders

`instructions` and `deepLinkTemplate` support two placeholder formats, resolved
at render time:

- `{SETTING_KEY}` — single braces, ALL CAPS — looked up from the Settings
  table. e.g. `{VENMO_BUSINESS_HANDLE}`, `{ZELLE_ADDRESS}`.
- `{{runtimeValue}}` — double braces, lowercase — filled in per payment.
  Supported: `{{amount}}` (dollar amount due), `{{note}}` (auto-generated
  payment note: property + date).

Example: `Send {{amount}} to @{VENMO_BUSINESS_HANDLE} on Venmo`.

`VENMO_BUSINESS_HANDLE` and `ZELLE_ADDRESS` remain standalone text settings —
the taxonomy *references* them, it does not replace them. Change your handle in
one place.

---

## 7. The two payment contexts

Payment collection happens in two places, each showing a different subset of
methods:

### Client Payment Request — `/pay/[token]`
- Used when a payment-request link is sent to the client after job completion.
- Shows methods with `supportsClientRequest = true` and `active = true`.
- Each method shows resolved instructions; if it has a deep link, an
  "Open [method] →" button appears.
- The client taps "I've sent my payment" to self-report. Admin still must
  approve.
- Gated by `REQUEST_PAYMENT_FROM_CLIENT_ENABLED` — see §7a.

### On-Site Worker Collection — Initiate Payment dialog
- Used when a worker collects payment at the property.
- Shows methods with `supportsOnSite = true` and `active = true`.
- Pre-fills the amount from the job price; shows a live processor-fee preview
  (gross / fee / net) for fee-bearing methods.

**Admin manual recording** shows *all active* methods regardless of context
flags.

### 7a. Request Payment feature toggle — `REQUEST_PAYMENT_FROM_CLIENT_ENABLED`

The "Request Payment from Client" path is gated by this on/off setting
(default **off**) so it can be rolled out gradually:

- **Off** — the Request Payment button is visible but disabled; the automatic
  payment-request send on job completion does not fire.
- **Super admins bypass the gate** — they can always use Request Payment, for
  testing, regardless of the setting.
- **On** — Request Payment works for everyone.

---

## 8. Owner earnings

The LLC owner sometimes completes jobs like any worker. Their earnings are
tracked **identically** to any worker's — same payout math, same
PaymentSplit record — with one difference: at export time, owner earnings are
a **draw**, not a paycheck.

- A super admin sets the `isOwner` flag on exactly one user (Users tab). It is
  additive to ADMIN/SUPER role and singleton-enforced.
- When a payment includes the owner as a worker, that PaymentSplit is flagged
  `ownerEarnings = true`.
- In the app, owner splits display as **"Owner Earnings"** (purple) instead of
  "Payout" — on job cards, the Money tabs, and the admin payment breakdown.
- **Gusto payroll export excludes owner-earnings splits entirely.** The owner
  takes a draw from the bank; payroll never sees it.
- **QuickBooks Income export still includes the full payment** — the client
  paid that amount regardless of who earned it. The owner's *draw* is captured
  outside this app — recorded directly in QuickBooks when the owner moves
  money out of the business bank account (manual journal entry, or via the
  QB Equity export when the draw is logged as a `BusinessExpense` with
  `type = OWNER_DRAW`).

The payout math is intentionally unchanged for the owner: applying the normal
margin/commission keeps job-profitability comparisons honest (an owner-worked
job and a non-owner-worked job can be compared apples-to-apples).

---

## 8a. Equipment rental billing

> **⚠️ Currently disabled.** The `EQUIPMENT_BILLING_ENABLED` setting is OFF
> in the current deployment — every release writes `Checkout.rentalCost = 0`
> regardless of the per-worker policy below. Equipment cost is absorbed
> into a higher `CONTRACTOR_PLATFORM_FEE_PERCENT` while the operator
> finalizes the billing + sales-tax model with a CPA. The per-worker
> policy documented in the rest of this section is what resumes when
> the toggle flips back ON. See `loadEquipmentBillingEnabled()` in
> `services/equipment.ts` for the gating logic.

Equipment owned by the LLC is rented by contractors when they use it on jobs;
the charge is rental **income** to the business (not an expense). Employees
and trainees use the same equipment at no cost — their usage is already
covered by the higher business margin charged on their jobs, so there's no
actual loss to the business when an employee handles a tool; it's an
accounting note that the equipment cost is paid for elsewhere.

Two billing models coexist, selected per piece of equipment via
`Equipment.equivalentJobs`:

### Flat daily (legacy)
When `equivalentJobs IS NULL`. Charge =
`rentalDays × dailyRate`, where `rentalDays` is the inclusive count of
Eastern-Time calendar days between `checkedOutAt` and `releasedAt`.

### Per-job with per-day cap
When `equivalentJobs > 0`. For each ET calendar day in the rental window:

```
perJob       = dailyRate / equivalentJobs
daySubtotal  = min(jobsCompletedThatDay × perJob, dailyRate)
rentalCost   = Σ daySubtotal
```

Jobs that count are formal-crew or solo `JobOccurrence`s with
`workflow ∈ {STANDARD, ONE_OFF}` and a finished status
(`COMPLETED / CLOSED / PENDING_PAYMENT`), whose `completedAt` falls within
`[checkedOutAt, releasedAt]`. Estimates, tasks, reminders, events,
followups, and announcements never count. Days with zero jobs cost
nothing. Days where many jobs would exceed the daily rate are capped
exactly at the daily rate.

### Mixed-crew policy

`writeCheckoutSplits` (`services/equipment.ts`) materializes per-worker
`CheckoutSplit` rows at release time using each `GroupMember`'s
`equipmentCostPercent` (when every worker has one summing to 100) or
even-split. After allocation, EMPLOYEE / TRAINEE shares are **zeroed**
(audit-trail rows are preserved with `amount = 0`). Unbilled shares are
**not redistributed** to remaining contractors.

`Checkout.rentalCost` stores the sum of contractor billings (= actual
income from this checkout), not the notional pre-split total. For solo
contractors that's the contractor's full amount; for solo employees it's
`0`; for groups it's the sum of contractor splits.

### Audit trail

Each release stores a `Checkout.rentalBreakdown` JSON column with one
entry per ET day:
```
[{ day: "YYYY-MM-DD", jobs: number|null, subtotal: number, capped: boolean }]
```
`jobs` is `null` for flat-daily billing, a count for per-job. The
worker money tab and admin receipts render this verbatim so any charge
is reconstructable.

### Tax export

The QB Income export emits **one row per contractor `CheckoutSplit`** for
group rentals (account `Equipment Rental Income`, Schedule C Line 1 by
default, ref `RENT-{checkoutId}-{userId}`) and a single row per checkout
for solo rentals. Employee/trainee splits never appear (their `amount`
is 0, filtered by the export's Prisma where clause).

---

## 9. Business expenses & the Accounting tab Cash Flow view

**Business Expenses tab** holds manually-entered, out-of-pocket business
expenses (fuel, supplies, dump fees, etc.), each categorized to a Schedule C
line. Per-job expenses and supply purchases also create paired BusinessExpense
records.

**Processor fees are NOT BusinessExpense entries** — they live on Payment
records and are reported separately.

The **Accounting tab Cash Flow** view (Super → Money → Accounting) is a
**management view, not a tax document**. It uses the **same filters as the
QB Income / QB Expenses exports** so the two reconcile to the penny:

- Confirmed payments only (`confirmed: true`, `writtenOff: false`), anchored on `confirmedAt`
- Fixed-asset purchases (cost ≥ `FIXED_ASSET_MIN_COST` setting, dated on/after the policy start) are split out of "Business expenses" into their own line, matching the QB Fixed Assets export's treatment

### Operating section

| Row | What it is | Reconciles with |
|---|---|---|
| Platform fees (contractors) | Commission the business retained from contractor splits | `Payment.platformFeeAmount` sum |
| Margin (employees/trainees) | Margin the business retained from employee/trainee splits | `Payment.businessMarginAmount` sum |
| Equipment rentals | Rental charges from contractor checkouts in window | QB Income equipment-rental rows |
| **Earnings (total)** | Sum of the three above — what the business retained from job operations | — |
| Business expenses | Operating expenses (EXCLUDES fixed-asset purchases) | QB Expenses BusinessExpense rows |
| Processing fees | Sum of `Payment.processorFeeAmount` (confirmed payments) | QB Expenses `*-F` processor-fee rows |
| **Operating net** | Earnings − Business expenses − Processing fees | QB P&L net (after the wage layer is added via Gusto integration) |
| Fixed asset purchases | Cost of capitalized purchases (≥ threshold) — shown separately because they don't hit the P&L | QB Fixed Assets export total |

### Equity section

| Row | What it is | Reconciles with |
|---|---|---|
| Capital contributions | `BusinessExpense.type = CAPITAL_CONTRIBUTION` in window | QB Equity contributions |
| Owner draws | `BusinessExpense.type = OWNER_DRAW` in window | QB Equity draws |
| **Equity net** | Contributions − Draws | — |

### Net cash change

```
Net cash change = Operating net + Equity net − Fixed asset purchases
```

Fixed asset purchases subtract from net cash change because they DO leave the
bank account, even though they don't hit operating P&L.

### What's NOT on the Accounting tab

- **Gross W-2 wages.** The app doesn't track gross wages (it only knows
  promised net — what the worker is owed before withholding). For complete
  P&L, layer Gusto's QB integration on top so the wage expense + employer
  payroll taxes flow into QB directly. See
  [TAX_AND_PAYROLL_PICTURE.md §10](./TAX_AND_PAYROLL_PICTURE.md#10-recommended-setup-for-a-complete-qb-picture).
- **1099 Contract Labor as a separate line.** The Accounting tab nets
  contractor pay into "Platform fees" (which is what the business retains
  *after* paying the contractor's share). QB shows the same data with a
  Contract Labor expense line. Same underlying math, different presentation.

This view carries the footnote *"Management view only. For tax reporting use
QuickBooks exports + Gusto."* The "Platform fees" and "Margin" lines are
internal allocations — they are **not** Schedule C line items.

---

## 10. Tax integrity rules

These rules MUST hold. Violating them corrupts the tax picture.

1. **Tax/QuickBooks exports use only raw cash-flow fields:**
   `Payment.amountPaid` / `Payment.grossCharged`, `PaymentSplit.amount`,
   `Expense.cost` / `BusinessExpense.cost`, `Payment.processorFeeAmount`.
2. **Internal allocation fields never appear as tax line items:**
   `shortfallAmount`, `overageAmount`, `businessMarginAmount`,
   `platformFeeAmount`, per-worker margin/fee breakdowns. These are
   operator-dashboard fields only.
3. **Cash basis.** Revenue and expenses are recognized when money moves, dated
   by `confirmedAt`. An unconfirmed (pending) payment is not yet revenue.
4. **No "Bad Debt Expense" line.** A write-off / shortfall is simply revenue
   that never arrived — cash basis already reflects it. There is no separate
   expense entry.
5. **Owner earnings are a draw,** not payroll and not a labor expense in
   QuickBooks. Excluded from Gusto; the draw is recorded directly in QB
   (via the QB Equity export when logged as `BusinessExpense.type = OWNER_DRAW`,
   or via a manual journal entry when the owner moves money out).

---

## 11. Settings reference

All in **Super → Settings**. Percentages and rates are read live — never
hardcoded.

| Setting | Default | Purpose |
|---|---|---|
| `CONTRACTOR_PLATFORM_FEE_PERCENT` | `20` | Commission retained from contractor (1099) splits |
| `EMPLOYEE_BUSINESS_MARGIN_PERCENT` | `30` | Margin retained from employee/trainee (W-2) splits |
| `HIGH_VALUE_JOB_THRESHOLD` | `200` | Jobs ≥ this price require contractor insurance to claim |
| `PAYMENT_METHODS` | (4 methods) | The payment-methods taxonomy — see §6 |
| `REQUEST_PAYMENT_FROM_CLIENT_ENABLED` | `false` | Enables the Request Payment path — see §7a |
| `PAYROLL_PERIOD_CADENCE` | `WEEKLY` | Pay-period cadence; drives the cadence preset buttons on the Exports tab (`WEEKLY` / `BIWEEKLY` / `MONTHLY`). NOT the default date range — that's always this calendar week's Mon–Sun |
| `FIXED_ASSET_MIN_COST` | `500` | BusinessExpense rows ≥ this cost (and dated on/after `FIXED_ASSET_START_DATE` in code, 2026-05-28) are capitalized as fixed assets — excluded from operating expenses, shown on a separate Accounting tab line, routed to the QB Fixed Assets export instead of QB Expenses |
| `EQUIPMENT_RENTAL_INCOME_CONFIG` | `{ qbAccount: "Equipment Rental Income", scheduleCLine: "1" }` | JSON config for how equipment rental income lines are labeled in the QB Income export |
| `VENMO_BUSINESS_HANDLE` | — | Business Venmo handle; referenced by the taxonomy |
| `ZELLE_ADDRESS` | — | Business Zelle address; referenced by the taxonomy |
| `DEFAULT_PAYMENT_COMMUNICATIONS_MODE` | `SERVER` | Whether payment-request comms are sent by the server or handed off to the claimer's device |
| `BUSINESS_START_DATE_ENABLED` / `BUSINESS_START_DATE` | `false` / — | Operator-controlled cutoff: when enabled, financial-event rows dated before the cutoff are hidden from every view and export. See `lib/businessStartCutoff.ts` |
| `QB_INCLUDE_CONTRACT_LABOR` | `true` | When ON, `qb-journal-expenses.csv` emits Contract Labor rows for contractor payments (post-GP splits, GP wage-path work, historical advances). When OFF, the whole Contract Labor section is dropped. Flip OFF once Gusto's QuickBooks integration is configured to post contractor payments to QB directly — the app's rows become duplicative at that point. See `loadIncludeContractLabor()` in `services/exports.ts`. |
| `EQUIPMENT_BILLING_ENABLED` | `false` (current operator setting; default ON for fresh installs) | Master toggle for equipment billing. When ON, equipment checkouts charge contractors per the equipment's daily rate (employees + trainees always pay $0). When OFF, every release writes `Checkout.rentalCost = 0` regardless of equipment dailyRate or worker type — `rentalDays` + `rentalBreakdown` are still preserved for audit. Currently OFF while the operator finalizes the contractor billing + sales-tax model with a CPA; equipment cost is absorbed into a higher `CONTRACTOR_PLATFORM_FEE_PERCENT`. See `loadEquipmentBillingEnabled()` in `services/equipment.ts`. |

---

## 12. Exports (Super → Money → Exports)

CSV downloads for verifying payroll and bookkeeping before importing into Gusto
and QuickBooks.

### Default date range

The Exports tab defaults to **this calendar week's Mon–Sun** (the week
containing today). The operator's standard workflow is to open the tab
mid-week or on weekends to upload what's happened so far; the calendar
boundary makes the "Last weekly" preset a one-click adjacent-week swap.

The cadence-loading useEffect reads `PAYROLL_PERIOD_CADENCE` for the preset
buttons but never overwrites the default date range (this was a regression
caught twice in the past — see the `feedback_exports_default_range` memory
note).

### Anchor logic

**Each export uses the anchor that's correct for what it represents** — they
are *not* all on one date field:

| File | One row per (logical) | Date anchor | Amount |
|---|---|---|---|
| `gusto-w2` | W-2 worker (employees + trainees) | **Job completion date** (`JobOccurrence.completedAt`) | **Promised net** for jobs they completed in the window |
| `gusto-contractors` (post-GP path) | 1099 contractor, paid via client payment | **Payment confirmation** (`Payment.confirmedAt`) | Reconciled `PaymentSplit.amount` (post pro-rata) — splits flagged `guaranteedPayoutPaidAt` are skipped |
| `gusto-contractors` (wage path) | 1099 contractor in their GP period | **Job completion date** (`JobOccurrence.completedAt`) | Promised net for GP-period jobs completed in the window (same compute as W-2) |
| `qb-journal-income` | Confirmed payment / equipment rental | `Payment.confirmedAt` / `Checkout.releasedAt` | Full `Payment.amountPaid` or `Checkout.rentalCost` |
| `qb-journal-expenses` | BusinessExpense (operating) + processor fee + post-GP contract labor + GP wage-path contract labor + historical GP advance | `BusinessExpense.date` / `Payment.confirmedAt` / `JobOccurrence.completedAt` / `GuaranteedPayoutAdvance.exportedAt` | Raw cost / fee / split amount / wage-path amount / advance amount |
| `qb-equity` | BusinessExpense with type CAPITAL_CONTRIBUTION or OWNER_DRAW | `BusinessExpense.date` | `cost` |
| `qb-fixed-assets` | BusinessExpense with type EXPENSE AND `cost ≥ FIXED_ASSET_MIN_COST` AND date on/after `FIXED_ASSET_START_DATE` | `BusinessExpense.date` | `cost` |

**Idempotency.** Every export is now pure-read: same inputs (window +
DB state) → same CSV. The `gusto-contractors` export specifically does
not insert advance rows or any other side effect. Re-run the same
window any number of times → identical output. Same for `qb-journal-expenses`.

**Contract Labor in `qb-journal-expenses` is transitional.** Gated by
the `QB_INCLUDE_CONTRACT_LABOR` setting (default ON). While ON, the
CSV emits Contract Labor rows for post-GP contractor splits, GP
wage-path work, and historical advance rows. Flip OFF once Gusto's
QuickBooks integration is configured to post contractor payments to
QB directly — the app's rows become duplicative at that point. The
in-app "Explain these files" panel on the Exports tab surfaces this
guidance to the operator.

**Why the W-2 export is work-anchored, not payment-anchored.** A W-2
employee's wages accrue when they do the work and must be paid on the regular
payroll schedule for that period — you cannot defer an employee's paycheck
until the customer pays (§4). So `gusto-w2` is driven by **jobs completed in
the window**, using each worker's **promised net** — independent of whether a
payment has been recorded or confirmed. The `gusto-contractors` export stays
payment-anchored because a contractor genuinely *is* paid out of the client's
payment.

Both Gusto exports **exclude owner earnings** (the owner takes a draw).
All confirmed-payment-anchored queries filter `confirmed: true` AND
`writtenOff: false`.

### QuickBooks Online journal-entry format

The two QB exports (`qb-journal-income`, `qb-journal-expenses`) emit
**balanced double-entry journal entries** matching QB Online's journal
importer column shape. Both files have the same header:

```
*JournalNo,*JournalDate,*AccountName,*Debits,*Credits,Description,Name,Currency,Location,Class
```

Every source transaction emits **two CSV rows** sharing the same `JournalNo`:

- **Income**: Row 1 debits `App Clearing Account`; Row 2 credits the configured income account (e.g., `Services`, `Equipment Rental Income`)
- **Expense**: Row 1 debits the mapped expense account (e.g., `Supplies`, `Contract labor`, `Other business expenses:Payment processing fees`); Row 2 credits `App Clearing Account`

The second row's `JournalDate` is **blank** (QB groups by adjacent JournalNo
and expects the date only on the leader row). There is **no TOTALS footer
row** — QB rejects unbalanced footer lines.

### Ledger IDs — short stable JournalNos

Every financial-event row carries a `ledgerId` of the form **`SLC-YYMMDD-XXXX`**
(14 chars), stamped at creation time. The ledger ID is used as the QB
`JournalNo` on export. Models with their own column:

- `Payment.ledgerId` → drives `JournalNo` for income rows + parent ID for derived fee rows
- `Checkout.ledgerId` → solo equipment rental income rows
- `BusinessExpense.ledgerId` → operating expense, equity, fixed-asset rows
- `GuaranteedPayoutAdvance.ledgerId` → historical GP advance rows (deprecated; no new rows created)

**Derived JournalNos** (split rows + processor fees + GP wage-path rows)
compose the parent's ledgerId with a short suffix to stay under QB's
21-char `doc_num` limit:

- **Processor fee** → `{Payment.ledgerId}-F` (e.g., `SLC-260605-X7K2-F`)
- **Contract labor (PaymentSplit)** → `{Payment.ledgerId}-{last4(userId).toUpperCase()}` (e.g., `SLC-260605-X7K2-CMG2`)
- **GP wage-path Contract Labor** → `GPW-{last8(occurrenceId).toUpperCase()}-{last4(userId).toUpperCase()}` — derived from the occurrence (no parent payment exists yet at wage-path time)
- **Group equipment rental (CheckoutSplit)** → `{Checkout.ledgerId}-{last4(userId).toUpperCase()}`

PaymentSplit and CheckoutSplit do NOT have their own ledger column — their
JournalNos derive from the parent at export time. This sidesteps the
split-delete-and-recreate problem at reconciliation: the parent's ledgerId
is stable, so the derived JournalNo stays stable across adjustments.

**Audit / cross-system lookup.** Given a QB JournalNo cell, find the row by
querying the parent ledgerId column directly:

```sql
SELECT * FROM "Payment" WHERE "ledgerId" = 'SLC-260605-X7K2';
-- For a fee or contract-labor row, strip the -F or -XXXX suffix first.
```

### Field-by-field of a QB journal row

| Column | Source |
|---|---|
| `*JournalNo` | Stable ledger ID (parent or derived) |
| `*JournalDate` | `confirmedAt` / `releasedAt` / `date` / `exportedAt` formatted as `MM/DD/YYYY` (UTC). **Row 2 blank.** |
| `*AccountName` | Mapped QB chart-of-accounts entry (income: hardcoded "Services" + `EQUIPMENT_RENTAL_INCOME_CONFIG.qbAccount`; expenses: `EXPENSE_CATEGORIES` taxonomy `qbAccount`; clearing: literal "App Clearing Account") |
| `*Debits` / `*Credits` | The source amount; one side filled, the other blank, per row |
| `Description` | The legacy reference (`Service payment — Doe (Home)`, `Contractor payout to Mark for Doe`, etc.) |
| `Name` | **Income**: Customer (client display name). **Expense**: blank (QB rejects journal entries with Names that don't exist as Vendors/Customers — vendor identity stays in the Description for traceability) |
| `Currency` / `Location` / `Class` | Always blank (single-currency, single-location, no class tracking) |

### Filenames

| Endpoint | Downloaded filename |
|---|---|
| `/admin/exports/qb-income.csv` | `qb-journal-income-{YYYY-MM-DD}_{YYYY-MM-DD}.csv` |
| `/admin/exports/qb-expenses.csv` | `qb-journal-expenses-{YYYY-MM-DD}_{YYYY-MM-DD}.csv` |
| `/admin/exports/qb-equity.csv` | `qb-equity-{YYYY-MM-DD}_{YYYY-MM-DD}.csv` (legacy 13-col format) |
| `/admin/exports/qb-fixed-assets.csv` | `qb-fixed-assets-{YYYY-MM-DD}_{YYYY-MM-DD}.csv` (legacy 13-col format) |
| `/admin/exports/qb-bundle.zip` | All four CSVs in one zip |

### Idempotent re-import

QB Online dedupes journal entries on `JournalNo`. Re-importing a CSV with
JournalNos already in QB causes the existing entries to be skipped/rejected
as duplicates; any NEW entries (e.g., from a row that failed the prior
import) land cleanly. Since ledgerIds are stable per source row, you can
safely re-pull and re-import the same window after fixing data without
creating duplicate journal entries.

### The boundary — what this app does NOT export

This app exports **wage/contractor data to Gusto** and **revenue/expense data
to QuickBooks**. It does NOT emit:

- Gross W-2 wage journal entries (Gusto's QB integration handles those)
- Employer-side payroll taxes (Gusto)
- Bank account transactions (reconciled manually against Chase statements — the bank feed is intentionally disconnected to avoid double-counting; see TAX_AND_PAYROLL_PICTURE.md §10)
- Equity earnings withdrawals as separate payroll events (those are direct bank events recorded via manual journal entries when needed)

A CPA at year-end pulls from QB (income, expenses, contract labor, equity)
+ Gusto (W-2 wages, employer payroll taxes, 1099-NEC issuance). There is no
separate "CPA export" from this app.

See [TAX_AND_PAYROLL_PICTURE.md §9–10](./TAX_AND_PAYROLL_PICTURE.md#9-the-three-systems-architecture)
for the full three-systems architecture and recommended QB ↔ Gusto integration setup.

---

## 13. Worker earnings views — Home tile & Payments tab

Each worker sees their earnings in two places. They use **different anchors
by worker type**, mirroring how that type is actually paid (§4).

### The worker Payments tab (the "Money" tab)

Lists the worker's `PaymentSplit` rows — their actual reconciled payouts —
filtered by date. The date filter is anchored on **`Payment.createdAt`** (when
the payment was *recorded*), not on `PaymentSplit.createdAt`. Reason: splits
are deleted and recreated at admin approval, so a split's own `createdAt`
jumps to the approval date; the `Payment` row is created once and never
recreated, so `Payment.createdAt` is a stable "when recorded" anchor that
doesn't move when an admin approves.

### The Home "Earnings (last 7 days)" tile

The window is the **7 days before today, excluding today** — today's
not-yet-settled work belongs to the title-bar projection, not here. The tile
is **worker-type-split**:

| | Employee / trainee | Contractor |
|---|---|---|
| Anchor | Job **completion date** | **Payment record date** (`Payment.createdAt`) |
| Amount | Promised net for jobs completed in the window | Actual `PaymentSplit.amount` for payments recorded in the window |
| Includes unpaid completed jobs? | **Yes** — wages accrue with the work | No — contractor pay tracks payments |
| Tile click → | **Jobs tab** (the jobs that produced the earnings) | **Payments tab** (the payment records) |
| "Earned for X jobs" link → | Jobs tab | Jobs tab |

The drill-down differs because each type's earnings genuinely *are* a
different thing: an employee's earnings are the **jobs they did**; a
contractor's earnings are the **payments they received**. The tile always
ties out to the tab it links to.

For a **contractor**, the Home tile and the Payments tab run literally the
same query for the same window — they're identical by construction. For an
**employee**, the Home tile is work-anchored (its own computation) and the
Payments tab remains a separate "payment activity" view; they answer
different questions and are not expected to match.

The Home **Hours (last 7 days)** tile is independent — it counts jobs
completed this week regardless of earnings.

---

## 14. Audit events

Every financial mutation writes an audit event (Super → Audit Log). Payment-
scope verbs:

| Verb | When |
|---|---|
| `CREATED` | Payment recorded by a worker/admin |
| `SELF_REPORTED` | Payment self-reported by a client via `/pay/[token]` |
| `APPROVED` | Admin confirmed a payment |
| `ADJUSTED` | Admin changed the amount at approval |
| `REJECTED` | Admin rejected a pending payment |
| `WRITTEN_OFF` | Admin wrote off an unpaid job |
| `REQUEST_SENT` / `TOKEN_ACCESSED` | Payment-request link sent / opened |
| `OWNER_EARNINGS_RECORDED` | A payment included owner earnings |
| `FEE_APPLIED` | A non-zero processor fee was calculated and stored |

Setting-scope: `PAYMENT_METHOD_UPDATED` fires whenever the `PAYMENT_METHODS`
taxonomy is edited (records the before/after JSON).

Export-scope: `DOWNLOADED` fires whenever the operator downloads a CSV
from the Exports tab. Records the `kind` (GUSTO_W2, GUSTO_CONTRACTORS,
QB_INCOME, etc.), the window, the row count, the total amount, and
the resolved filename. The ExportRun table separately persists the
exact bytes for byte-identical re-download; this audit event is the
operator-facing summary that surfaces in the Audit Log tab.

---

## 15. Glossary

- **Gross / grossCharged** — what the client actually paid.
- **Net received** — gross minus the payment processor's fee; what hits the bank.
- **Promised payout** — what a worker would earn at the full invoice amount;
  snapshotted at job completion.
- **Made whole** — an employee/trainee receiving their full promised net even
  when the client underpaid; the business covers the gap.
- **Pro-rata loss** — a contractor's payout shrinking proportionally with a
  client underpayment.
- **Shortfall** — promised payouts the business had to cover beyond what the
  client paid (underpay / write-off). Internal reporting only.
- **Overage** — collected above the invoice; kept by the business. Internal
  reporting only.
- **Platform fee / commission** — the cut the business retains from a
  contractor's share.
- **Business margin** — the cut the business retains from an employee/trainee's
  share.
- **Processor fee** — what the payment app (Venmo, etc.) charges per
  transaction.
- **Owner earnings** — job earnings of the LLC owner; tracked like a worker's
  but taken as a draw, excluded from payroll.
- **Confirmed** — an admin has verified and approved a payment; only then is it
  real revenue.
