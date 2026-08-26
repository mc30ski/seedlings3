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
> **Status: SHIPPED.** All eight build steps complete.
> Sections below describe intended behavior; the Build order at the
> bottom tracks what has landed.

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
7. **Rate columns are NOT additive.** `Regular (Rate)` reports 7.25 in the
   totals row when two workers are both at 7.25 — it is a rate, not a sum.
   Summing it and comparing to the totals row rejects every legitimate
   upload. Each mapped column carries an `additive` flag for this reason.
8. **Multiple sections.** A journal can contain more than one
   `"Employee Earnings"` block when the company runs multiple pay
   schedules. Parse **all** of them into separate periods in one upload
   and show them all in the review step. Never silently take the first.
9. **Column names are jurisdiction-specific.** `NC State Tax (Employee)`,
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

**The queue surfaces in three places, all Super-only** (added 2026-08-26 —
before that it was only the in-tab banner, so the one person who could fix
it had to happen to visit the Payroll tab while the affected worker was
told to go ask them):

| Surface | Behaviour |
|---|---|
| Payroll tab banner | The original. Full picker, in place. |
| Header alerts dropdown | `"Payroll names to match"`, purple, routes to Super → Money → Payroll. |
| Tasks page | An **inline** `CollapsibleSectionCard` embedding `PayrollIdentityReview` verbatim — the whole action is one picker plus a confirm, so navigating away would be more steps than doing it there. Sits directly above "Job hours awaiting payroll review". |

Both new surfaces count via `GET /payroll/identities/unmatched` (already
`superGuard`ed) and refresh on the **`seedlings:payroll-changed`** event,
which `notifyPayrollChanged()` in `apps/web/src/lib/payroll.ts` fires on
both edges: an import adds names, a match removes one. Without it the
header badge kept showing the pre-match number until a full reload — the
repo's standing "event emitted but nothing listens" gap, except here
nothing was emitted at all.

The emitter lives in the client lib rather than `PayrollTab`, so the Tasks
page does not pull that (large) tab module in for a one-line dispatch.

1. On upload, each row is looked up in `PayrollIdentity`.
2. Known names link automatically.
3. Unknown names land in a **mapping review** the Super confirms once —
   pick the app user, or mark the row as "not an app user".
4. The confirmed mapping persists. Later uploads only surface genuinely
   new names.

**Unmatched rows are still stored.** They must be, or the conservation
check against `"Payroll Totals"` stops balancing. They are invisible to
every worker and appear only in Super's view, flagged as unmatched.

### What the affected worker sees

An unmatched row belongs to nobody, so no worker query returns it. Two
situations, handled differently:

**No history yet** (new hire, name never mapped) — they get the empty
state. Its copy deliberately does NOT explain *why* it's empty: "nothing
imported" and "imported but unattributed" are indistinguishable from the
worker's side, so it points at the remedy instead ("payroll is matched to
your account by name"). It previously claimed nothing had been imported
and that contractors were the excluded ones — both false for an unmatched
W-2 employee whose pay was sitting in the review queue.

**History, then a gap** — the dangerous one. Payroll attaches by NAME, so
a marriage, a Gusto typo, or "Mike" vs "Michael" imports as an
unattributed row: older periods still render, the newest is simply absent,
and the worker concludes payroll is late. `getPendingMatchNotice` gives
them the only signal they get.

It is **targeted, not broadcast**. All three must hold:

1. the worker has payroll history (payroll demonstrably applies to them),
2. they have no row in the most recent period (a real gap exists),
3. that period contains at least one unmatched row.

So a fully-matched worker is never told about someone else's pending row,
and contractors — never in a Gusto payroll journal at all — are never told
about a problem that cannot be theirs. The response carries a flag and a
date only: a worker learns that *a* period is unattributed, never whose or
how much.

## Visibility

| Role | Whose rows | What they see |
|---|---|---|
| **Worker** | own only | their pay stub — gross, every WITHHOLDING line, net. **No employer-side column.** |
| **Admin** | any worker | **hours / gross / net only** |
| **Super** | any worker | everything, incl. the employer side, plus unmatched rows |

A worker's own tax breakdown is their own pay-stub data, so they get all
of it. The hours/gross/net restriction is about **Admin looking at
someone else**.

### Employer cost — Super only, on every surface

The employer side is Social Security, Medicare, FUTA, NC unemployment,
total employer taxes, and total employer cost. It appears in three places,
**all Super-tab only**:

| Surface | Where |
|---|---|
| Timeframe total | Payroll tab header, beside team net and gross |
| Per period | On the period row, and as an **EMPLOYER COST — WHOLE RUN** block when the period is expanded (Gusto's own `"Payroll Totals"` row, not a client-side sum) |
| Per worker | An **EMPLOYER COST** block on each entry |

**Every surface needs BOTH a role gate and a presence check. Neither
substitutes for the other** — this was shipped wrong once (2026-08-26,
employer cost visible on the Admin tab) and the two halves are load-bearing
for different reasons:

- **`showSuperExtras` — the surface.** `operatorViewer` resolves the
  viewer by **role**, so a SUPER+ADMIN+WORKER account receives a super
  payload on *every* tab; the server cannot know which tab is being
  rendered. Presence alone therefore leaks onto the Admin tab. This is the
  same shape as the standing rule that `showSuperExtras` must never fall
  back to `forAdmin ||`.
- **The presence check — the data.** A genuine admin-only account gets a
  payload with no `employerCost` at all. Rendering `$0.00` for them would
  read as "payroll cost the business nothing" rather than "you cannot see
  this".

**The aggregates are gated server-side too.** `listPeriods` omits
`teamTotals.employerCost`, and the period-detail route omits
`employerTotals`, unless `viewer.kind === "super"`. The per-entry
projection already withholds `employerCost` from an admin, so shipping an
aggregate would return it through the back door — and on a three-person
payroll an aggregate is close enough to per-person to matter.

**A worker never receives the employer side at all.** `fieldsFor` used to
read `admin ? ADMIN_VISIBLE_FIELDS : ALL_NUMERIC_FIELDS`, which made
"everything" the default for anything that was not an admin — so `worker`
and `super` shared one projection and a worker's own payload carried
`employerTaxes`, FUTA, NC unemployment and `employerCost`. The UI never
rendered them; they were one DevTools tab away. Client-side omission is
not a control. Now:

```
WORKER_VISIBLE_FIELDS = ALL_NUMERIC_FIELDS − EMPLOYER_SIDE_FIELDS
```

Derived by **subtraction**, so a new column reaches the worker
automatically unless it is declared employer-side. That is the safe
default for pay-stub data — a new withholding line is theirs by right —
while anything belonging to the company's books must be named in
`EMPLOYER_SIDE_FIELDS` to be withheld. `fieldsFor` now switches on every
viewer kind explicitly; no branch falls through to "everything".

The line is drawn where Gusto draws it: your stub tells you what you
earned and what was withheld from it. The employer's matching
contributions and what you cost the company are the company's books.

These are **actuals**. They are still not connected to the P&L's
`"Employer payroll taxes (est.)"` line — see the firewall below.

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

**Replace reports whether anything actually changed.** Re-importing the
same export is a normal thing to do — you lose track of which file you
already loaded — and it is a genuine no-op. But a bare "replaced" reads as
"something changed", so a no-op import looked like a broken one (reported
2026-08-26). The import compares each row's verbatim source line against
what is stored and returns `changed`, which the UI renders as **"no
change"** rather than "replaced". The audit row records it too.

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

**Money → Payroll tab.** Carries the same timeframe picker (defaulting to
"all time" — this is the tab you open to go back through history), with
running totals for the selected window. Blended additive-scope (`scope: { isWorker,
isAdmin, isSuper }`) per
[`reference_tab_blend_pattern`](file:///Users/michaelwanderski/.claude/projects/-Users-michaelwanderski-dev-seedlings3/memory/reference_tab_blend_pattern.md).
`showSuperExtras` must **not** fall back to `forAdmin ||`. Periods listed
newest-first; a worker opens any past period. No fixed "1 week" range —
periods are whatever was uploaded, filtered by date range or picked from
the list.

**Home → MY PAYDAY section.** Follows the `Dashboard` pattern used by MY
ACTIVITIES, placed adjacent to the approximate-pay card. Carries a
**timeframe picker** (latest period / 90 days / 6 months / this year / all
time) and shows totals across the selection — one period reads as "Paid
<date>" with net + gross; several read as "N pay periods" with totals.

**Timeframes filter by PAY DAY, not by period dates.** A period worked in
December and paid in January belongs to January for anyone reconciling
against their bank. The UI never says "this week" — cadence can change and
the app must not assume one.

The section **renders even when empty**. An invisible section is
indistinguishable from a missing feature, which is exactly how this was
first reported.

**Palette.** Uses `Dashboard`'s `info` (blue) variant — added for this
section — with content sitting DIRECTLY in the frame; an inner tinted card
would be a section inside a section. Blue rather than green because green
reads as "good result", and payroll states what was paid rather than
judging it. The neighbouring approximate-pay card was also fixed to a
neutral gray (it previously recoloured by earnings tier, which tracked the
period dropdown as much as the worker). The tab and section use a
**banknote** icon, not the dollar glyph already carried by the Money
category and the Payments tab.

> **No "next payday".** Uploads are manual and sequential, so a predicted
> next date would be inferred from history and wrong the first time a
> schedule changes. Do not add it.

**Super → Records → Reconcile.** Shortcut opening the same upload dialog,
so the common case doesn't require navigating to Money → Payroll. It sits
on the **always-visible timeframe row**, not inside one of the collapsible
cards — every card on that tab is collapsed by default, so a shortcut
buried in one isn't a shortcut. It is also deliberately NOT in the "Export
Data" card: this is an import, and the direction matters.

Note the neighbouring surface: Reconcile already has a **"Worker Payroll"**
card whose job is the opposite direction — it shows Gusto-copy fields the
operator types INTO Gusto when running payroll. This feature is the return
leg: what Gusto paid, coming back. They are complementary and share no
code or data. Do not merge them.

## Dev seed

`seed.ts` generates **four weeks of Gusto-format CSVs and imports them
through the real parser** (`importPayrollCsv`), rather than writing rows
directly with Prisma. Writing rows would be shorter but would skip
`parseGustoPayrollJournal` and `checkConservation` — so a parser regression
could ship with a green seed. This way a broken importer fails the seed
loudly, and seeded data is byte-identical to a genuine upload.

The generated files are also written to **`apps/api/prisma/fixtures/payroll/`**
so the upload dialog can be hand-tested: re-uploading one exercises the
REPLACE path, and editing a number in one exercises the conservation
check's rejection.

Seeded people are **W-2 employees only** — the contractor is deliberately
absent, leaving a live example of the contractor empty state. Their names
are deliberately DIFFERENT from the ones in
`__fixtures__/gusto-payroll-journal.csv`; if they collided, importing that
fixture would auto-link against seeded identities and stop exercising the
unmatched-name path it exists to demonstrate. One unmatched row is seeded
on the newest period so the identity-review queue is never empty.

## Empty and edge states

| Case | Behavior |
|---|---|
| Worker with no matched rows (incl. every contractor today) | "No payroll records for you yet" — must not read as an error |
| Zero-value row (Caleb Serrano: on payroll, no hours) | Renders a real $0 period; copy must not imply failure |
| Row not matched to any user | Super-only, flagged unmatched; invisible to workers |
| Conservation check fails | Upload rejected with the offending column named; nothing persisted |

## The estimate/actual firewall — do not cross it

The app **already** estimates employer payroll tax, and it predates this
feature:

- [`services/payrollTaxEstimates.ts`](../../apps/api/src/services/payrollTaxEstimates.ts)
  holds operator-tunable percentages (SS 6.2%, Medicare 1.45%, FUTA 0.6%,
  SUTA 1.5%).
- [`services/pnlReport.ts`](../../apps/api/src/services/pnlReport.ts)
  surfaces them as a synthetic **`"Payroll:Employer payroll taxes (est.)"`**
  line on the Reconcile P&L.

This feature imports the *actual* figures for the same quantities —
`socialSecurityEmployer`, `medicareEmployer`, `futaEmployer`,
`stateUnemploymentEmployer`, `employerCost`.

**These two must never be connected.** Not "not yet" — never. One is an
estimate the operator tunes; the other is ground truth from the payroll
provider. Entangling them means every future question about a P&L number
starts with "is this period one where payroll was uploaded?", and the
answer changes retroactively as periods are imported, replaced, or
archived. A P&L line that silently changes meaning depending on unrelated
upload activity is worse than one that is consistently an estimate.

Concretely, and enforced by `payroll-build-gate.test.ts`:

- No payroll module imports `pnlReport` or `payrollTaxEstimates`.
- Neither of those imports payroll, or references `PayrollEntry` /
  `PayrollPeriod`.
- The P&L line keeps its `(est.)` suffix regardless of what has been
  imported.

If actuals should ever appear on an operator's P&L, that is a **new,
separately-labelled line** — not a substitution into the existing one.

## Non-goals

- **Not a tax document.** No 1099s, no W-2s, no tax-export columns.
- **Not a payroll calculator.** The app never computes withholding.
- **Not reconciliation** against estimated pay. The schema permits an
  estimated-vs-actual variance view later; it is deliberately not built.
- **Not a P&L input.** See the firewall section above — the synthetic
  "Employer payroll taxes (est.)" line stays an estimate, permanently.
- **Not a Gusto integration.** Manual CSV upload only. No API, no sync.

## Testing

| Layer | Where | Proves |
|---|---|---|
| Parser | `payrollImport.test.ts` (36) | Real Gusto export parses; blank ≠ zero; rates aren't additive; totals conserve |
| Projections + wiring | `payroll-build-gate.test.ts` (28) | Admin field list; worker projection excludes the employer side; no viewer kind falls through to "everything"; worker `where` clause; route guards; estimate/actual firewall; employer-cost aggregate gating |
| Worker isolation | `payroll-worker.spec.ts` (employee) | A worker sees ONLY their own row, and no employer-side field in the response or on the page — **in a browser, against the real response** |
| Admin projection | `adminrole-payroll.spec.ts` (admin-role) | An admin payload carries no tax field, and no employer cost in the period aggregate either |
| Operator surfacing | `payroll-alerts-admin.spec.ts` (super) | The queue appears in the alerts dropdown with a count matching the endpoint, and as an inline Tasks section with the real picker embedded |
| Super flows | `payroll-admin.spec.ts` (super) | Upload, replace-not-duplicate (figures actually move), no-op re-import reports "no change", identity match, archive, **and a SUPER-role user on the ADMIN tab sees no employer cost** |

**The `admin-role` Playwright project exists for one reason.** SUPER
outranks ADMIN and receives the full payload, so an admin-only restriction
is invisible from a `super` session — testing it there would pass while
proving nothing. The project uses an ADMIN-but-not-SUPER account, and its
specs are named with the `adminrole-` prefix (mirroring `mobile-`).

Both browser suites read the **API response**, not just the DOM. A payload
that carried tax figures and hid them in the UI would still be a leak.

## Where invariants are enforced

| Invariant | Enforced by |
|---|---|
| Worker query cannot return another user's row | `payroll-build-gate.test.ts` |
| Employer cost withheld from admin, aggregate included | `payroll-build-gate.test.ts` + `adminrole-payroll.spec.ts` |
| Employer cost withheld from a worker's own row | `payroll-build-gate.test.ts` + `payroll-worker.spec.ts` |
| Employer cost hidden on the Admin tab for a SUPER-role user | `payroll-admin.spec.ts` |
| Identity queue is Super-only on every surface | `adminrole-payroll.spec.ts` |
| Admin projection omits tax columns server-side | `payroll-build-gate.test.ts` |
| Entries sum to the `"Payroll Totals"` row | import-time check + build gate |
| Blank vs `0.00` preserved as null vs 0 | parser unit tests |
| `MM/DD/YYYY` parsed via canonical helper | `date-handling-build-gate.test.ts` |
| `/me/payroll*` is view-as-aware | `view-as-endpoints-build-gate.test.ts` |
| Every mutation writes an `AuditEvent` | `payroll-build-gate.test.ts` |
| Payroll never appears in a tax export | `payments-build-gate.test.ts` |

## Build order

- [x] 1. Migration: `PayrollPeriod`, `PayrollEntry`, `PayrollIdentity`, `AuditScope.PAYROLL` — `20260824192922_add_payroll`
- [x] 2. `MM/DD/YYYY` → `EtDateKey` helper in `dates.ts` + unit tests — `parseUsDateToEtDateKey`, `parseUsDateRangeToEtDateKeys`
- [x] 3. Gusto Payroll Journal adapter + conservation check — `services/payrollImport.ts`, 36 tests against the real export
- [x] 4. Service + routes, three-tier projection, view-as-aware — `services/payroll.ts`, `routes/payroll.ts`
- [x] 5. `payroll-build-gate.test.ts` — 21 tests, mutation-verified
- [x] 6. Money → Payroll tab + identity review UI — `PayrollTab`, `PayrollUploadDialog`, `PayrollIdentityReview`
- [x] 7. Home PAYROLL section + Reconcile shortcut — `PayrollHomeSection`, timeframe-row button on ReconcileTab
- [x] 8. Playwright specs — `payroll-worker` (employee), `adminrole-payroll` (admin-role), `payroll-admin` (super)

Migrations go through `prisma migrate dev` — never `db push` — and are
applied to dev before any dependent code lands.
