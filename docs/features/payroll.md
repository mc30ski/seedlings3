# Payroll — Feature Reference

> **Purpose.** Show workers what they were actually paid, by importing the
> payroll CSV that Gusto produces for each pay period. Gusto is the source
> of truth; this app is a viewer with history. Nothing here feeds the
> financial system, and nothing here is a tax document.
>
> This document is the **canonical spec** for how payroll is supposed to
> work. If code and doc disagree, one of them is wrong — fix both, in the
> same PR.
>
> **Status: SPEC ONLY.** No code exists yet. Sections below describe
> intended behavior; the Build order at the bottom tracks what has landed.

## Why this is different from everything else in the app

Two numbers describe a worker's pay and they will not match:

| | Where it comes from | What it means |
|---|---|---|
| **Estimated** | `payments.ts` — payment splits, guaranteed payout, `WorkerHourlyPayCard` | What the app *thinks* the work was worth |
| **Actual** | This feature — Gusto CSV | What Gusto *paid*, after taxes and adjustments |

The app is **not** the source of truth for pay. Every estimate surface
must keep saying so ("Approximate pay per hour"), and every payroll
surface must be unambiguous that it reflects money actually paid, with
the pay day shown.

The two are displayed near each other on Home **on purpose**. Hiding one
does not make the discrepancy go away; it makes it look like a bug when
a worker eventually finds it.

**Payroll is decoupled from the financial system.** No `Expense` rows, no
P&L lines, no QuickBooks/tax export columns — not even `Employer Cost`,
which is a genuine business cost but would double-count against the
worker-payment math already in `payments.ts`. See
[`docs/FINANCIAL_SYSTEM.md`](../FINANCIAL_SYSTEM.md) and the tax-export
policy: exports pull only raw cash-flow fields, and the app does not
produce 1099 totals — that is Gusto's job.

## Source file

A Gusto **Payroll Journal Report**, exported as CSV. Real example
(2026-08-21 pay day) — nine preamble lines, then the data:

```
"Payroll Journal Report"

"Seedlings Lawn Care, LLC"
"225 Stony Branch Trl"
"Chapel Hill","NC","27516"

"Employee Earnings"
"Weekly Payroll payroll period"," 08/10/2026 - 08/16/2026"
"Pay day"," 08/21/2026"
"Last Name","First Name","Work Address",… 26 columns …
"Serrano","Caleb",…,"0.00",…
"Torres","Justin",…,"563.79",…
"Wanderski","Jacob",…,"726.29",…
"Payroll Totals","","","","","37.77",…
```

### Parsing rules

1. **Not a plain CSV.** Skip the preamble; locate the `"Employee Earnings"`
   marker, then the period line, the pay day line, then the header row.
2. **Quoted commas are real.** `"225 Stony Branch Trl, Chapel Hill, NC 27516"`
   is one field. Use a real CSV parser — never `split(",")`. The repo has
   no CSV *parser* today (`exports.ts` only generates).
3. **Leading spaces in dates.** `" 08/10/2026 - 08/16/2026"` — trim.
4. **`MM/DD/YYYY` must route through a canonical date helper.** A new
   helper in [`apps/api/src/lib/dates.ts`](../../apps/api/src/lib/dates.ts)
   returning a branded `EtDateKey`, with unit tests. Parsing it inline
   will fail the date-handling build gate. See
   [`docs/DATE_HANDLING.md`](../DATE_HANDLING.md).
5. **Blank is not zero.** Caleb's `Regular (Hours)` is `""` while his
   `Gross Earnings` is `"0.00"`. Jacob's `FUTA (Employer)` is `""` while
   Justin's is `"3.38"`. Store `""` as **null** and `"0.00"` as **0** —
   collapsing them destroys the difference between "not applicable" and
   "computed to zero", and you can no longer answer "did we owe FUTA this
   period".
6. **`"Payroll Totals"` is not an employee.** Exclude it from entries;
   use it for the conservation check below.
7. **Multiple sections.** A journal can contain more than one
   `"Employee Earnings"` block when the company runs multiple pay
   schedules. Parse **all** of them into separate periods in one upload
   and show them all in the review step. Never silently take the first.
8. **Column names are jurisdiction-specific.** `NC State Tax (Employee)`,
   `NC Unemployment Tax (Employer)`. Hiring outside NC changes these
   headers. Match state tax/unemployment columns **by pattern**, not by
   literal string, and keep the untouched source row (see `raw` below).

### Conservation check (upload is rejected on failure)

The sum of every employee row must equal the `"Payroll Totals"` row, for
every money column. A mismatch means a truncated, hand-edited, or
misparsed file, and it must be caught **before** the numbers reach a
worker's screen.

Money is stored as `Float` in this schema (matching `Payment.amountPaid`),
so compare at **cent precision**, not exact equality.

This is the same shape as the invariants in
`apps/api/src/services/payments-build-gate.test.ts`.

## Data model

```
PayrollPeriod
  id
  sourceKind      EMPLOYEE_PAYROLL | CONTRACTOR_PAYMENTS
  periodStart     EtDateKey     ─┐ natural key
  periodEnd       EtDateKey     ─┘
  payDay          EtDateKey
  label           "Weekly Payroll"   (descriptive only — never logic)
  sourceR2Key     original CSV, kept forever
  totals          parsed "Payroll Totals" row
  uploadedByUserId, uploadedAt
  archivedAt      soft delete

PayrollEntry
  id, payrollPeriodId
  userId          NULLABLE — null until identity is confirmed
  rawLastName, rawFirstName
  employeeType, paymentMethod, workAddress
  regularHours, regularRate, regularAmount, additionalEarnings,
  grossEarnings, employeeTaxes, federalIncomeTax,
  socialSecurityEmployee, medicareEmployee, additionalMedicareEmployee,
  stateTaxEmployee, employerTaxes, socialSecurityEmployer,
  medicareEmployer, futaEmployer, stateUnemploymentEmployer,
  netPay, reimbursements, donations, checkAmount, employerCost
  raw             Json — the complete source row, verbatim

PayrollIdentity
  id, lastName, firstName → userId
  confirmedByUserId, confirmedAt
```

**Why `raw` exists.** Typed columns cover what the UI shows; `raw`
preserves everything else. A new state's tax line, a renamed Gusto
column, or a question nobody has asked yet costs a query instead of a
re-import.

**Why `sourceKind` exists now, before contractors.** Gusto pays 1099
contractors through a different report with a different shape. Adding the
discriminator while the table is empty is free; adding it later means a
migration plus a data backfill. The parser is written as a named
**"Gusto Payroll Journal" adapter**, not as *the* parser, so a second
adapter slots in beside it.

**Natural key is `(periodStart, periodEnd)` — pay day is deliberately
excluded.** If pay day were part of the key, re-uploading to correct a
wrong pay day would create a *second* period for the same week instead of
replacing the first.

## Identity matching

The CSV has **no employee identifier** — only `"Last Name","First Name"`.
Matching a name to a `User` is fuzzy, and a wrong match shows one person
another person's net pay.

**Names are never auto-matched.**

1. On upload, each row is looked up in `PayrollIdentity`.
2. Known names link automatically.
3. Unknown names land in a **mapping review** the Super confirms once —
   pick the app user, or mark the row as "not an app user".
4. The confirmed mapping persists. Later uploads only surface genuinely
   new names.

**Unmatched rows are still stored.** They must be, or the conservation
check against `"Payroll Totals"` stops balancing. They are invisible to
every worker and appear only in Super's view, flagged as unmatched.

## Visibility

| Role | Whose rows | What they see |
|---|---|---|
| **Worker** | own only | full detail — gross, every tax line, net |
| **Admin** | any worker | **hours / gross / net only** |
| **Super** | any worker | full detail, plus unmatched rows |

A worker's own tax breakdown is their own pay-stub data, so they get all
of it. The hours/gross/net restriction is about **Admin looking at
someone else**.

Admin's default view is the **combined period total**; per-worker figures
appear only once a worker is selected.

### Enforcement

- **Server-side, always.** A worker's query must be incapable of
  returning another user's row. Client-side filtering is not a control.
  The `payroll-build-gate` asserts this.
- Any `GET /me/payroll*` route accepts `?viewAsUserId=<id>` behind an
  ADMIN/SUPER role gate, or carries `// view-as-allow: <reason>`. Enforced
  by `view-as-endpoints-build-gate.test.ts`. See
  [`docs/VIEW_AS_ENDPOINTS.md`](../VIEW_AS_ENDPOINTS.md).
- The Admin projection is built **server-side**. The tax columns must not
  be sent to an Admin client and hidden with CSS.

## Upload, replace, delete

**Upload.** The file is a few KB, so the client POSTs the raw text; the
server stores it in R2 and parses. No presigned two-step.

**Replace (this is what "edit" means).** Re-uploading a period that
already exists:

1. Confirm dialog naming the period being replaced.
2. Snapshot **every existing row** into the audit event first.
3. Replace the entries.
4. Keep both CSVs in R2 — provenance survives, and the previous numbers
   remain recoverable.

Individual parsed values are **not** hand-editable. Editing imported
payroll breaks its correspondence with the stored source file, and the
stored file is the only thing making these numbers trustworthy.

**Delete.** Super only, soft delete via `archivedAt` (the repo's existing
pattern), confirm dialog, audit snapshot before archiving.

**Audit.** Upload, replace, and delete each write an `AuditEvent` in the
same edit as the mutation. `AuditScope` is a Prisma enum, so the new
`PAYROLL` scope requires a **migration** — see
[`reference_audit_system`](file:///Users/michaelwanderski/.claude/projects/-Users-michaelwanderski-dev-seedlings3/memory/reference_audit_system.md).

## Surfaces

**Money → Payroll tab.** Blended additive-scope (`scope: { isWorker,
isAdmin, isSuper }`) per
[`reference_tab_blend_pattern`](file:///Users/michaelwanderski/.claude/projects/-Users-michaelwanderski-dev-seedlings3/memory/reference_tab_blend_pattern.md).
`showSuperExtras` must **not** fall back to `forAdmin ||`. Periods listed
newest-first; a worker opens any past period. No fixed "1 week" range —
periods are whatever was uploaded, filtered by date range or picked from
the list.

**Home → PAYROLL section.** Follows the `Dashboard` pattern used by MY
ACTIVITIES, placed adjacent to the approximate-pay card. Shows last pay
day, net pay, and the period covered.

> **No "next payday".** Uploads are manual and sequential, so a predicted
> next date would be inferred from history and wrong the first time a
> schedule changes. Do not add it.

**Super → Records → Reconcile.** Shortcut opening the same upload dialog,
so the common case doesn't require navigating to Money → Payroll.

## Empty and edge states

| Case | Behavior |
|---|---|
| Worker with no matched rows (incl. every contractor today) | "No payroll records for you yet" — must not read as an error |
| Zero-value row (Caleb Serrano: on payroll, no hours) | Renders a real $0 period; copy must not imply failure |
| Row not matched to any user | Super-only, flagged unmatched; invisible to workers |
| Conservation check fails | Upload rejected with the offending column named; nothing persisted |

## Non-goals

- **Not a tax document.** No 1099s, no W-2s, no tax-export columns.
- **Not a payroll calculator.** The app never computes withholding.
- **Not reconciliation** against estimated pay. The schema permits an
  estimated-vs-actual variance view later; it is deliberately not built.
- **Not a Gusto integration.** Manual CSV upload only. No API, no sync.

## Where invariants are enforced

| Invariant | Enforced by |
|---|---|
| Worker query cannot return another user's row | `payroll-build-gate.test.ts` |
| Admin projection omits tax columns server-side | `payroll-build-gate.test.ts` |
| Entries sum to the `"Payroll Totals"` row | import-time check + build gate |
| Blank vs `0.00` preserved as null vs 0 | parser unit tests |
| `MM/DD/YYYY` parsed via canonical helper | `date-handling-build-gate.test.ts` |
| `/me/payroll*` is view-as-aware | `view-as-endpoints-build-gate.test.ts` |
| Every mutation writes an `AuditEvent` | `payroll-build-gate.test.ts` |
| Payroll never appears in a tax export | `payments-build-gate.test.ts` |

## Build order

- [ ] 1. Migration: `PayrollPeriod`, `PayrollEntry`, `PayrollIdentity`, `AuditScope.PAYROLL`
- [ ] 2. `MM/DD/YYYY` → `EtDateKey` helper in `dates.ts` + unit tests
- [ ] 3. Gusto Payroll Journal adapter + conservation check, unit-tested against the real file
- [ ] 4. Service + routes, three-tier projection, view-as-aware
- [ ] 5. `payroll-build-gate.test.ts`
- [ ] 6. Money → Payroll tab + identity review UI
- [ ] 7. Home PAYROLL section + Reconcile shortcut
- [ ] 8. Playwright specs (`payroll-*.spec.ts`)

Migrations go through `prisma migrate dev` — never `db push` — and are
applied to dev before any dependent code lands.
