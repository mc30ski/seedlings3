# Seedlings Lawn Care — Financial System Reference

**Audience:** Admins and super admins who need to understand how payments, payouts,
processor fees, owner earnings, business expenses, and tax exports work.

**Also:** the canonical spec. If code changes ever cause behavior to drift from
this document, this document describes the *intended* behavior — treat a
mismatch as a bug to investigate, not a new normal.

Last updated: 2026-05-20.

---

## Contents

1. [The workforce model](#1-the-workforce-model) — W-2 / 1099 / trainee / LLC owner
2. [The payment lifecycle](#2-the-payment-lifecycle) — completed → pending → approve/reject/adjust/write-off → closed
3. [Payout math](#3-payout-math--how-a-workers-share-is-calculated) — per-worker fees; gross → fee → net
4. [Reconciliation](#4-reconciliation--promised-vs-actual-underpay--overpay) — promised vs. actual, made-whole, pro-rata, shortfall/overage
5. [Processor fees](#5-processor-fees) — snapshot math + BUSINESS / SPLIT absorption model
6. [Configurable payment methods](#6-configurable-payment-methods-payment_methods-setting) — the `PAYMENT_METHODS` taxonomy + placeholders
7. [The two payment contexts](#7-the-two-payment-contexts) — client request / on-site + the Request Payment toggle
8. [Owner earnings](#8-owner-earnings) — tracked like a worker, taken as a draw
9. [Business expenses & the Earnings vs Expenses dashboard](#9-business-expenses--the-earnings-vs-expenses-dashboard)
10. [Tax integrity rules](#10-tax-integrity-rules) — the five must-holds
11. [Settings reference](#11-settings-reference) — all financial settings + defaults
12. [Exports](#12-exports-super--money--exports) — Gusto + QuickBooks, file by file; W-2 work-anchored vs 1099 payment-anchored
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

- **CONTRACTOR** → "platform fee" / commission, from `CONTRACTOR_PLATFORM_FEE_PERCENT` (default 10%)
- **EMPLOYEE / TRAINEE** → "business margin", from `EMPLOYEE_BUSINESS_MARGIN_PERCENT` (default 20%)

The fee/margin is what the **business keeps**; the net is what the **worker
gets**. On a $100 job with one contractor at a 100% split: $10 commission to
the business, $90 to the contractor.

Mixed crews work the same way — each worker's own rate applies to their own
share. A 50/50 contractor+employee crew on $100 yields $45 to the contractor
($50 − 10%) and $40 to the employee ($50 − 20%).

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

The two worker types are paid on different clocks, and this matters for
payroll:

- **Employee / trainee (W-2).** Their wage accrues **when the work is done**.
  The amount is known at job completion (the promised net) and is **paid on
  the regular payroll run for the period the work fell in** — regardless of
  whether, or when, the client pays. The business fronts it. If the client
  later underpays or never pays, that's a **business loss** recognized when
  it's known; the employee's pay and W-2 are **never clawed back or amended**.
- **Contractor (1099).** Their pay is **contingent on the client payment**.
  They're paid when the payment is received/confirmed, in the reconciled
  (possibly pro-rata-reduced) amount. A client underpayment directly reduces
  what the contractor receives and what lands on their 1099.

This asymmetry drives the export anchors in §12 — W-2 by work date, 1099 by
payment date.

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

### Fee absorption model — `PROCESSOR_FEE_ABSORPTION` setting

- **BUSINESS** (default) — the business absorbs the processor fee. Worker
  payouts are calculated on the **full gross**; workers are unaffected by which
  payment method the client used.
- **SPLIT** — the fee comes off the gross *before* payouts are calculated, so
  workers share the cost proportionally.

Either way, `grossCharged`, `processorFeeAmount`, and `netReceived` are all
stored on the Payment record.

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
  by the bank feed in QuickBooks, not by this app.

The payout math is intentionally unchanged for the owner: applying the normal
margin/commission keeps job-profitability comparisons honest (an owner-worked
job and a non-owner-worked job can be compared apples-to-apples).

---

## 9. Business expenses & the Earnings vs Expenses dashboard

**Business Expenses tab** holds manually-entered, out-of-pocket business
expenses (fuel, supplies, dump fees, etc.), each categorized to a Schedule C
line. Per-job expenses and supply purchases also create paired BusinessExpense
records.

**Processor fees are NOT BusinessExpense entries** — they live on Payment
records and are reported separately.

The **Earnings vs Expenses** summary table (Super → Money → Expenses) is a
**management view, not a tax document**. Its rows:

| Row | What it is |
|---|---|
| Platform fees (contractors) | Commission the business retained from contractor splits |
| Margin (employees/trainees) | Margin the business retained from employee/trainee splits |
| Equipment rentals | Rental charges recovered from worker payouts |
| **Earnings (total)** | Sum of the three above |
| Business expenses | Manually-entered out-of-pocket expenses (negative) |
| Processing fees | Sum of processor fees across payments (negative; row hidden if all zero) |
| **Net** | Earnings − Business expenses − Processing fees |

This table carries the footnote *"Management view only. For tax reporting use
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
   QuickBooks. Excluded from Gusto; the bank feed captures the draw.

---

## 11. Settings reference

All in **Super → Settings**. Percentages and rates are read live — never
hardcoded.

| Setting | Default | Purpose |
|---|---|---|
| `CONTRACTOR_PLATFORM_FEE_PERCENT` | `10` | Commission retained from contractor (1099) splits |
| `EMPLOYEE_BUSINESS_MARGIN_PERCENT` | `20` | Margin retained from employee/trainee (W-2) splits |
| `HIGH_VALUE_JOB_THRESHOLD` | `200` | Jobs ≥ this price require contractor insurance to claim |
| `PAYMENT_METHODS` | (4 methods) | The payment-methods taxonomy — see §6 |
| `PROCESSOR_FEE_ABSORPTION` | `BUSINESS` | Who absorbs the processor fee: `BUSINESS` or `SPLIT` — see §5 |
| `REQUEST_PAYMENT_FROM_CLIENT_ENABLED` | `false` | Enables the Request Payment path — see §7a |
| `PAYROLL_PERIOD_CADENCE` | `WEEKLY` | Pay-period cadence; sets default date range on the Exports tab. `WEEKLY` / `BIWEEKLY` / `MONTHLY` |
| `VENMO_BUSINESS_HANDLE` | — | Business Venmo handle; referenced by the taxonomy |
| `ZELLE_ADDRESS` | — | Business Zelle address; referenced by the taxonomy |
| `DEFAULT_PAYMENT_COMMUNICATIONS_MODE` | `SERVER` | Whether payment-request comms are sent by the server or handed off to the claimer's device |

---

## 12. Exports (Super → Money → Exports)

CSV downloads for verifying payroll and bookkeeping before importing into Gusto
and QuickBooks.

**Each export uses the anchor that's correct for what it represents** — they
are *not* all on one date field:

| File | One row per | Date anchor | Amount |
|---|---|---|---|
| `gusto-w2` | W-2 worker (employees + trainees) | **Job completion date** (`completedAt`) | **Promised net** for jobs they completed in the window |
| `gusto-contractors` | 1099 contractor | **Payment confirmation** (`Payment.confirmedAt`) | Reconciled `PaymentSplit.amount` (post pro-rata) |
| `qb-income` | Confirmed Payment | `Payment.confirmedAt` | Full `grossCharged` as income, regardless of who earned it or fees |
| `qb-expenses` | BusinessExpense **+** processor-fee rows | `BusinessExpense.date` / `Payment.confirmedAt` | Processor fees appear as a "Payment Processing Fees" category (Schedule C line 17), sourced from Payment records, not BusinessExpense |

**Why the W-2 export is work-anchored, not payment-anchored.** A W-2
employee's wages accrue when they do the work and must be paid on the regular
payroll schedule for that period — you cannot defer an employee's paycheck
until the customer pays (§4). So `gusto-w2` is driven by **jobs completed in
the window**, using each worker's **promised net** — independent of whether a
payment has been recorded or confirmed. The `gusto-contractors` export stays
payment-anchored because a contractor genuinely *is* paid out of the client's
payment. Both exports **exclude owner earnings** (the owner takes a draw).

`qb-income` and `qb-expenses` remain cash-basis on `confirmedAt` — that's
correct for bookkeeping. Only the W-2 *payroll* export diverges, and it must.

Every CSV ends with a TOTALS row for eyeball verification against the Admin
Money tab.

Every CSV ends with a TOTALS row for eyeball verification against the Admin
Money tab.

**The boundary:** This app exports wage/contractor data to Gusto and
revenue/expense data to QuickBooks. Gusto's own QuickBooks integration pushes
payroll journal entries into QB — this app does not duplicate that. A CPA pulls
from Gusto + QuickBooks; there is no separate "CPA export" from this app.

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
