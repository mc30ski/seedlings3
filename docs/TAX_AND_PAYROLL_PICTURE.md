# Complete Tax and Payroll Picture — Seedlings Lawn Care

**Audience:** Mike (LLC owner). The big-picture flow of how money, taxes, and payroll actually move through the business — across the three systems that hold the business's financial state (the app, Gusto, QuickBooks).

**Technical reference for the app's payment math, exports, and integrity rules:** see [FINANCIAL_SYSTEM.md](./FINANCIAL_SYSTEM.md).

Last updated: 2026-06-08.

---

## Contents

1. [The big picture — two tax worlds running in parallel](#1-the-big-picture--two-tax-worlds-running-in-parallel)
2. [World 1 — Employment taxes (NC DOR + IRS, via Gusto)](#2-world-1--employment-taxes-nc-dor--irs-via-gusto)
2a. [Contractor (1099) vs Employee (W-2) — what's different](#2a-contractor-1099-vs-employee-w-2--whats-different)
3. [World 2 — Personal business taxes (LLC owner)](#3-world-2--personal-business-taxes-llc-owner)
4. [Day-to-day money flow on a typical job](#4-day-to-day-money-flow-on-a-typical-job)
5. [The weekly / monthly / quarterly / annual rhythm](#5-the-weekly--monthly--quarterly--annual-rhythm)
6. [The three numbers to always know](#6-the-three-numbers-to-always-know)
7. [What the NC Withholding Account specifically does](#7-what-the-nc-withholding-account-specifically-does)
8. [How the Venmo (processor) fee is handled](#8-how-the-venmo-processor-fee-is-handled)
9. [The three-systems architecture](#9-the-three-systems-architecture)
10. [Recommended setup for a complete QB picture](#10-recommended-setup-for-a-complete-qb-picture)

---

## 1. The big picture — two tax worlds running in parallel

There are two completely separate tax worlds happening in the business at the same time. They share no overlap. Understanding which world a tax payment belongs to is the foundation of everything else.

| World | Who pays the tax | What it covers | Where the money flows |
|---|---|---|---|
| **World 1 — Employment taxes** | The W-2 employee — withheld from their paycheck. The business also pays an employer-side portion. | Federal income tax, NC state income tax, FICA (Social Security), Medicare | Gusto handles all of it. Gusto withholds from the paycheck, remits to IRS + NC DOR, files quarterly + annual forms. |
| **World 2 — Personal business taxes** | You (Mike), as the LLC owner — out of your personal post-distribution income. | Self-employment tax (SE), federal income tax on profit, NC state income tax on profit, NC franchise tax | You pay it yourself. Quarterly estimated payments to IRS + NC DOR; annual filing through your CPA. |

The NC Withholding Account number you registered for is for **World 1 only**. The EIN and LLC filing are what enable **World 2**.

---

## 2. World 1 — Employment taxes (NC DOR + IRS, via Gusto)

When a W-2 employee works for the business, every paycheck has taxes withheld. Here's the full flow:

```
Employee earns $500 gross for the week (from job work)
        ↓
Gusto calculates withholdings:
  Federal income tax withheld:  ~$50
  NC state income tax withheld: ~$22
  Employee Social Security:     ~$31 (6.2%)
  Employee Medicare:            ~$7  (1.45%)
        ↓
Employee receives net:          ~$390 deposited to their bank
        ↓
Gusto holds the withheld amounts
        ↓
Gusto remits to IRS + NC DOR on the appropriate schedule
        ↓
Gusto files Form W-2 at year-end and gives the employee their copy
```

The business also pays an **employer-side** portion on top of the gross wage (this doesn't come out of the worker's check — it's a separate cost to the business):

- Employer Social Security: **6.2%** of gross
- Employer Medicare: **1.45%** of gross
- NC SUTA (unemployment): roughly **0.06%–5.76%** depending on your experience rating
- Federal FUTA: **0.6%** of the first $7,000 paid per employee per year

So a $500 gross paycheck actually costs the business about **$538–$542** total once you include the employer-side payroll tax. Gusto handles all of this automatically and tells you each pay period what your total cost was.

**Your day-to-day involvement: zero.** You hit "Run payroll" in Gusto. Gusto does everything else.

### What the NC Withholding Account specifically does

Every time Gusto sends NC state income tax to the NC Department of Revenue on your behalf, it uses your NC Withholding Account ID so the payment is credited to **Seedlings Lawn Care LLC** — not someone else's account.

Without that account number, Gusto literally cannot send state withholdings to NC correctly. That's why it was required.

If total monthly NC withholding stays under $250/month across all employees, you file the NC withholding return **annually**, not quarterly. NC mails a preprinted booklet but Gusto files electronically, so you can ignore the booklet. Filing happens automatically through Gusto.

---

## 2a. Contractor (1099) vs Employee (W-2) — what's different

The flow in §2 above applies to **W-2 employees only**. Contractors (1099) are a completely different setup — they're independent business owners who happen to work jobs for you, not workers on your payroll. This distinction drives most of the differences in how each gets paid, taxed, and reported:

| | **W-2 Employee** | **1099 Contractor** |
|---|---|---|
| **Relationship** | The business's employee — works on the company's terms, schedule, equipment | Independent contractor — runs their own business, you're a customer |
| **Payment timing** | **Work-anchored.** Paid every payroll cycle for the work done in that period — even if the client hasn't paid yet. The business fronts the cash. | **Payment-anchored** (default). Paid AFTER the client pays. If the client never pays, the contractor doesn't get paid (pro-rata on underpayment, $0 on a write-off). **Exception:** during a contractor's GP period (see below), GP-period work is **work-anchored** like a W-2 employee. |
| **Withholding** | Yes — federal, NC state, FICA (Social Security), Medicare withheld from every paycheck | None. The contractor handles their own taxes; they receive the full split amount. |
| **Employer-side taxes** | Yes — business pays employer FICA (6.2%), Medicare (1.45%), NC SUTA, federal FUTA on top of the gross wage | None. You only pay the contractor's net split. |
| **Made-whole policy** | Yes — if client underpays, employee still gets their full promised net. Business absorbs the gap. | No — contractor absorbs a pro-rata share of any client underpayment. Their pay reflects the actual cash received. |
| **Year-end form** | W-2 (issued by Gusto on the business's behalf) | 1099-NEC (issued by Gusto, but only for contractors paid ≥ $600 in the calendar year) |
| **Business deduction line (Schedule C)** | Line 26 — **Wages** | Line 11 — **Contract labor** |
| **Employer payroll-tax deduction (Schedule C)** | Line 23 — Taxes/Licenses (the employer-side FICA + Medicare + SUTA + FUTA) | N/A — there are no employer payroll taxes on a contractor |
| **In the app's exports** | `gusto-w2.csv` (work-anchored on `completedAt`) | `gusto-contractors.csv` (payment-anchored on `confirmedAt`) AND `qb-journal-expenses.csv` Contract Labor lines |
| **Insurance requirement** | None (covered by the business's commercial policy) | High-value jobs (≥ HIGH_VALUE_JOB_THRESHOLD setting) require the contractor to have their own insurance on file |
| **In the app's payout math** | Business margin (default 30%) — the business keeps a margin and pays the employee the rest | Platform fee (default 20%) — the business keeps a commission and pays the contractor the rest |

### Why the work-anchored vs payment-anchored split matters

The **W-2 employee gets paid this pay period for this pay period's work**, full stop. Federal labor law requires that — you can't tell an employee "we'll pay you when the client pays us." The business effectively **fronts** their wage out of operating cash, then collects the client payment whenever it arrives. If the client never pays, the business eats the loss — the employee's W-2 wage is never clawed back.

The **1099 contractor's pay is contingent on the client's payment** because the contractor is essentially a co-vendor on the job. If the client pays 70% of the invoice, the contractor's share shrinks 30% too. This is what makes them a 1099 instead of a W-2 — they share in the business risk, not just the labor.

This asymmetry drives:
- **Gusto W-2 export** is anchored on the job's `completedAt` date → wages flow into the next payroll regardless of client payment
- **Gusto Contractors export** is anchored on the `Payment.confirmedAt` date → contractor pay flows the period after the client actually pays
- **QB Contract Labor expense** uses the same `confirmedAt` anchor — the deduction is recognized when cash actually moves

### The GP (Guaranteed Payout) exception

The app supports a **Guaranteed Payout window** for new contractors during their onboarding period — typically 30 days. During that window, the contractor is paid **exactly like an employee for that work**: the Gusto contractor payroll CSV is anchored on the job's completion date (not the client payment date), and the business fronts the cash. After the window expires, the same contractor reverts to the standard payment-anchored model for new jobs.

**The choice is per-occurrence.** Each completed job is evaluated against the contractor's GP window at completion time:
- Completed during GP → wage path (paid on the next Friday's contractor run for that week's work)
- Completed after GP → split path (paid after the client confirms payment)

A single contractor can have some jobs on each path — there's no per-contractor switch. The boundary is determined automatically by `occurrence.completedAt` vs `User.guaranteedPayoutUntil`.

**Tax form stays 1099.** GP changes the timing, not the classification. Gusto still issues a 1099-NEC at year-end based on what it actually paid the contractor through its contractor payment system. The app's role is producing the right CSV; Gusto's role is paying + reporting.

See [FINANCIAL_SYSTEM.md §4](./FINANCIAL_SYSTEM.md) for the wage-path / split-path rules and §12 for the export anchor table.

---

## 3. World 2 — Personal business taxes (LLC owner)

As the LLC owner, **you don't get a paycheck with taxes withheld.** Instead:

```
Seedlings Lawn Care earns $40,000 in revenue for the year
        ↓
Subtract all business expenses (Schedule C deductions):
  Worker payouts (W-2 + 1099):    $25,000
  Insurance:                      $800
  Software & subscriptions:       $1,572
  Equipment & fuel:               $2,700
  Other overhead:                 $1,000
  Processor fees:                 ~$400
        ↓
Net profit:                       ~$8,528
        ↓
This flows to your personal Form 1040 as self-employment income
        ↓
You owe:
  Self-employment tax (15.3% on net):       ~$1,305
  Federal income tax (~22% bracket):        ~$1,876
  NC state income tax (4.5%):               ~$384
  NC franchise tax (fixed annual):          $200
        ↓
Total annual tax bill:                      ~$3,765
```

Nobody withholds any of this for you. **You owe it directly and pay it yourself in quarterly installments** — that's what the quarterly estimated tax payments are for.

**Your day-to-day involvement:** set aside ~25–30% of every dollar of net profit into your Chase business savings account. Pay quarterly on the IRS estimated-tax schedule (April 15, June 15, September 15, January 15).

---

## 4. Day-to-day money flow on a typical job

A single client job, end to end:

```
Monday — Job completed at the client's property
        ↓
Worker records the payment in the app ($200 job price)
        ↓
App calculates per worker:
  Materials/expenses for the job:   $30
  Net distributable pool:            $170  ($200 − $30)
  Worker payout (assuming 80/20):   $136  (W-2 employee at 30% margin → $119; contractor at 20% fee → $136)
  Business retains:                  $34  (the 20% platform fee in the contractor case)
        ↓
Client pays $200 via Venmo Business
        ↓
Venmo charges its processor fee (1.9% + $0.10 = $3.90)
        ↓
$196.10 deposited to Chase business checking
        ↓
The app records:
  grossCharged       = $200.00
  processorFeeAmount = $3.90
  netReceived        = $196.10
  worker payout      = $136.00   (paid the FULL gross share — fee not deducted)
  business retains   = $34.00 − $3.90 = $30.10  (margin minus the Venmo fee)
```

The business **absorbs the Venmo fee** entirely. The worker's payout is always calculated on the full gross — payment method choice never reduces what the worker gets.

See [§8 below](#8-how-the-venmo-processor-fee-is-handled) for the full processor-fee policy and alternatives considered.

---

## 5. The weekly / monthly / quarterly / annual rhythm

### Daily / per job (~5 minutes per job)

- Make sure each completed job is recorded in the app
- Make sure the payment is recorded with the correct method (Venmo vs Zelle vs Cash vs Check)
- Make sure the worker payouts look right on the job card

### Weekly (~15 minutes)

- **Friday (or end of pay period):** download the `gusto-w2.csv` and `gusto-contractors.csv` from the app's Exports tab, upload them into Gusto, and run payroll. Gusto withholds taxes, deposits each worker's net pay, and remits the withholdings.
- **Sunday/Monday:** check Chase. Confirm all expected Venmo / Zelle / Cash deposits arrived. Catch any anomalies before they age into the next pay period.
- Move ~25–30% of the week's net profit into Chase business savings (for your personal estimated taxes).
- **Monday (optional):** export the previous week's CSVs from the app (Super → Money → Exports) and import them into QuickBooks. See [§10](#10-recommended-setup-for-a-complete-qb-picture) for why this matters.

### Monthly (~30–60 minutes)

- Pull the Chase business checking statement for the month
- Eyeball-match each Chase deposit and withdrawal against the journal entries already in QB (from the app's CSV uploads + Gusto's payroll posts)
- Record direct journal entries in QB for anything that happened outside the app (transfers, refunds, miscellaneous expenses, manual owner draws)
- Check the App Clearing Account balance in QB — it should drift toward zero as deposits offset the journal entries the app emitted. Anything stuck open is unmatched and worth investigating
- Review the app's Accounting tab Cash Flow for the month → cross-check the totals against QB's monthly P&L

### Quarterly (~30 minutes per quarter)

- Pull a year-to-date profit report from QuickBooks (Reports → Profit & Loss → YTD)
- Calculate what you owe in estimated federal + NC taxes
- Pay IRS via [IRS Direct Pay](https://www.irs.gov/payments/direct-pay)
- Pay NC via [NC Department of Revenue](https://www.ncdor.gov/) online portal
- Due dates: **April 15, June 15, September 15, January 15** (of the following year)

### Annually (April)

- Meet with your CPA — they do the heavy lifting
- File NC Annual Report ($200) by April 15 — separate from your tax return
- Review pricing and margins for the upcoming season

The CPA pulls QuickBooks reports (income, expenses, contract labor) + Gusto reports (W-2 wages, employer payroll taxes) and files:
- LLC Schedule C (your business income)
- Your personal Form 1040 + Schedule SE (self-employment tax)
- NC state return
- NC franchise tax filing

---

## 6. The three numbers to always know

At any point during the year you should be able to answer these three questions in under 30 seconds:

| Question | Where you find the answer |
|---|---|
| **How much has the business earned net of worker payouts?** | QuickBooks → Profit & Loss → YTD (the "Net Income" line) |
| **How much have I set aside for my personal taxes?** | Chase business savings account balance |
| **Are those two numbers in sync?** | Savings balance should be ~25–30% of net profit |

If those three things line up, your personal tax situation is under control and nothing will surprise you in April.

---

## 7. What the NC Withholding Account specifically does

(Covered in §2 above — the NC Withholding Account is the account ID Gusto uses to remit NC state income tax withheld from W-2 employee wages. Gusto handles the filing and the payments. Day-to-day requires zero action from you.)

---

## 8. How the Venmo (processor) fee is handled

When a client pays via Venmo Business (1.9% + $0.10 per transaction), the processor takes their fee before the money lands in Chase. **The business absorbs this fee in full.** Workers are paid on the gross transaction amount, not the net-of-fee amount.

### The math on a $200 Venmo-paid job (current policy — Option 1)

```
Client pays:               $200.00
Venmo fee (1.9% + $0.10):    $3.90
Net deposited to Chase:    $196.10
Materials expense:          $30.00
Net after expenses:        $170.00
Worker payout (80%):       $136.00     ← computed on gross, not on net-of-fee
Business margin (20%):      $34.00
Less: Venmo fee absorbed:    $3.90
Business actually retains:  $30.10
```

### Alternatives considered (NOT current behavior — documented for posterity)

**Option 2 — Fee comes off the top before the split.** Deduct the fee before calculating the 80/20:

```
Client pays:               $200.00
Venmo fee:                   $3.90
Net after fee:             $196.10
Materials:                  $30.00
Net after expenses:        $166.10
Worker payout (80%):       $132.88
Business margin (20%):      $33.22
```

Worker gets slightly less ($132.88 vs $136.00 — a $3.12 difference on a $200 job). The split is mathematically fair — everyone shares the cost of the payment method proportionally.

**Option 3 — Configurable per method.** A setting (currently planned but not implemented) would let the operator decide per-payment-method whether the fee comes off the top or comes out of the business margin.

### Why Option 1 is the current choice

- Simpler: workers always know exactly what they'll get; the payment method the client chose doesn't change anyone's payout
- The fee impact at current volume is manageable — total annual Venmo fees on $20K of Venmo revenue would be ~$390
- Reduces the operational friction of explaining to a worker why their payout differs by payment method
- The fee is properly reported as a business expense in QuickBooks (Schedule C deduction), so the business does get tax credit for absorbing it

### What this means for QuickBooks

The QB Expenses export emits a **Payment Processing Fees** line for every confirmed payment with a non-zero fee. So on Schedule C you get to deduct the $390 in annual processor fees as an operating expense, recovering ~22% (your federal bracket) + ~4.5% (NC bracket) of it in tax savings. Real net cost of the fees: roughly $390 × (1 − 0.265) = ~$287/year at current volume.

---

## 9. The three-systems architecture

The business's financial state is spread across **three systems**. Each one owns its domain and the others rely on it for that domain:

| System | What it OWNS (authoritative source) | What it DOES NOT know |
|---|---|---|
| **The Seedlings app** | Jobs, client payments, worker payouts (per-job), equipment income, business expenses, owner equity contributions/draws, business margin from operational work | Gross W-2 wages (after Gusto adds withholding gross-up); employer-side payroll taxes |
| **Gusto** | Gross wages, federal/state withholding amounts, FICA + Medicare math, employer-side payroll taxes, W-2 forms, 1099-NEC forms | Anything operational — Gusto doesn't know about client revenue, business expenses, or job-level economics |
| **QuickBooks Online** | Whatever has been imported into it — the canonical books of record for tax filing | Nothing on its own; QB is a passive ledger that holds what you push to it |

### The app's Accounting tab — your real-time view

The app's Super → Money → Accounting tab Cash Flow section is your **most current** view of the business because it's pulling live from the app's own data. It shows:

- Platform fees (from contractor work)
- Margin (from employee work)
- Equipment rentals
- Business expenses
- Processing fees
- Fixed asset purchases (capitalized — shown as a separate line, not in operating)
- Capital contributions / Owner draws (equity)
- Operating net, Equity net, Net cash change

The Accounting tab and the QB exports use the **same source filters** (confirmed payments, non-written-off, anchored on `confirmedAt`), so the numbers reconcile to the penny.

**Limitation: the app's Earnings line shows what the business *keeps* from worker work** (platform fees + margin + equipment), **not the gross W-2 wages**. The app intentionally doesn't try to compute gross wages because that requires withholding math that lives in Gusto.

### QuickBooks — your formal books of record

QB is where Schedule C gets filed from. The numbers there must be correct and complete. To make them correct and complete, you push data in from two sources:

- **From the app** (weekly CSV import): client income, business expenses, contractor labor, equipment rental income, owner equity transactions
- **From Gusto** (via integration — see §10): gross W-2 wages, employer-side payroll taxes, payroll liabilities

Once both sources are flowing, QB's P&L is the **single source of financial truth** for the business.

---

## 10. Recommended setup for a complete QB picture

To make QuickBooks a complete and accurate view (so its P&L is real, not approximate), connect **two integrations**:

### Connect Gusto to QuickBooks

In Gusto: **Settings → Integrations → QuickBooks Online → Connect**

Authorize with your QB login, map Gusto's wage accounts to QB's chart of accounts (Gusto walks you through it), and you're done. Takes ~10 minutes one time.

Going forward, every time you run payroll in Gusto, the integration automatically posts a journal entry to QB:
- **Debit Wages expense** (gross — matches Schedule C Line 26)
- **Debit Payroll Tax expense** (employer FICA + Medicare + SUTA — Schedule C Line 23)
- **Credit Bank Account** (net pay drawn down)
- **Credit Payroll Liabilities** (withholdings held until remittance)

Numbers are exact. No manual math, no approximation, no reconciliation drift.

### Bank reconciliation — Chase feed is intentionally DISCONNECTED

This is a deliberate choice in the current setup. The Chase bank feed is **NOT** connected to QuickBooks, and that's correct for now.

**Why it's disconnected:** The app already pushes every income and expense event into QB as a balanced journal entry (debit + credit through the App Clearing Account). If the Chase bank feed were also connected, QB would import the same client payment twice:

- Once as a journal entry from the app's CSV ("Client paid us $200 — debit App Clearing, credit Service Income")
- Once as a bank-feed line ("Chase received $196.10 from Venmo")

In a clean setup, you would **match** the bank-feed line against the existing journal entry, and the two would cancel out in App Clearing. In practice, matching is fiddly — Venmo deposits don't exactly equal the gross client payment (the processor fee is taken out), timing is offset by a day or two, and any miss creates a duplicate income entry. The risk of accidentally inflating revenue is real and hard to detect after the fact.

So the **current approach is manual reconciliation**:

- Once a week, open Chase online and pull the transaction list
- Eyeball-match each Chase deposit against the income journal entries already in QB for that week
- For anything that didn't come through the app (transfers, refunds, miscellaneous, manual owner draws), record a direct journal entry in QB to cover it
- The App Clearing Account balance should drift toward zero over time as everything reconciles; check it monthly and investigate anything that stays open

This is slightly more work than a bank-feed reconciliation but eliminates the double-counting risk.

**If you ever want to reconnect Chase**, the trade-off would be: you gain automatic daily import + faster reconciliation, but you have to commit to **always matching** every bank line to an existing journal entry (never letting QB record a bank line as a new transaction). Some operators find the matching workflow worth it once they're comfortable; others stick with the manual approach. Either is valid.

The bank feed is **not required** for any tax filing. Schedule C is filed from the journal entries (the app's exports + Gusto's payroll posts) regardless of whether the feed is connected.

### Weekly upload from the app

Continue to export the app's QB Income, QB Expenses, QB Equity, and QB Fixed Assets CSVs weekly (default range is the current Mon–Sun calendar week) and import them into QB. Each entry uses a stable short ledger ID (`SLC-YYMMDD-XXXX`) as the QB JournalNo, so re-imports of overlapping data correctly dedupe on QB's side.

### Once all three flows are connected

| Data | How it gets into QB | Lands in QB as |
|---|---|---|
| Client revenue | App exports `qb-journal-income.csv` → you upload to QB weekly | Service Income + Equipment Rental Income lines |
| Operating expenses | App exports `qb-journal-expenses.csv` → you upload to QB weekly | Categorized expense lines (Supplies, Insurance, Advertising, etc.) |
| Processor fees | Same `qb-journal-expenses.csv` upload | Payment Processing Fees expense |
| Contractor labor (1099) | **Currently:** same `qb-journal-expenses.csv` upload — the app emits Contract Labor rows for post-GP splits, GP wage-path work, and historical advance rows, gated by the `QB_INCLUDE_CONTRACT_LABOR` setting (default ON). **After connecting Gusto-QB:** flip `QB_INCLUDE_CONTRACT_LABOR` to OFF in Settings → Payments & Payouts. The app's Contract Labor section disappears from the CSV; Gusto's integration posts contractor payments to QB directly. | Contract Labor expense |
| W-2 wages | App exports `gusto-w2.csv` → you upload to Gusto → run payroll → **Gusto auto-posts to QB** | Wages expense |
| Employer payroll taxes | Run payroll in Gusto (same step as above) → **Gusto auto-posts to QB** | Payroll Tax expense |
| Owner equity (contributions/draws) | App exports `qb-equity.csv` → you upload to QB weekly | Owner Investments / Owner Draws (equity accounts) |
| Fixed asset purchases | App exports `qb-fixed-assets.csv` → you upload to QB weekly | Fixed Assets (balance sheet) |
| Bank account activity | NOT connected to QB right now (intentional — see Chase section above). You reconcile manually monthly. | (kept outside QB; verified against journal entries via App Clearing Account drift) |

**A note on what's "automatic" here.** The app does NOT push data directly to Gusto or QB on any schedule. For payroll, you still **manually download `gusto-w2.csv` from the app and upload it to Gusto** every pay period — this is the only data source telling Gusto what work each employee did. Once payroll runs in Gusto, THAT step — and only that step — auto-posts wage and payroll-tax journal entries into QB via the Gusto-QB integration. Same for the QB CSVs (income, expenses, equity, fixed assets): you download them from the app and upload them to QB on your own cadence (weekly is recommended). The Chase bank feed could be connected for automatic daily import, but is currently disconnected on purpose to avoid double-counting income (see the Chase section above) — reconciliation is done manually instead. A direct app → Gusto and app → QB push integration could be added in the future to eliminate the manual CSV steps, but it's not built today.

QB is now your single source of truth for tax filing. Schedule C fills itself out at year-end from the combined data.

### Day-to-day operational view stays in the app

You still use the **app's Accounting tab** for in-the-moment decisions (is this week profitable? am I trending up or down? how much should I move to savings?). QB lags the app by a day or two (because exports happen weekly and Gusto posts after each payroll run), so it's not the right tool for "right now" visibility — but it IS the right tool for "what should I file on Schedule C this year."

Three systems, three roles, clean lines:

- **App** = operational, real-time
- **Gusto** = payroll execution + tax withholding + W-2/1099 forms
- **QB** = formal books, tax filing, bank reconciliation, monthly/annual P&L

---

## Cross-references

- Payment math, reconciliation, owner earnings, equipment rentals, exports — see [FINANCIAL_SYSTEM.md](./FINANCIAL_SYSTEM.md)
- Payment-methods taxonomy — see FINANCIAL_SYSTEM.md §6
- W-2 work-anchored vs 1099 payment-anchored — see FINANCIAL_SYSTEM.md §12
- Export filenames and JournalNo format — see FINANCIAL_SYSTEM.md §12
