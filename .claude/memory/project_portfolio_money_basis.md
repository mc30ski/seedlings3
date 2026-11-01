---
name: project_portfolio_money_basis
description: "The portfolio filter means two things for money — BUILT 2026-10-31, dev only, NOT deployed. Default 'as organized now'; toggle in the lens panel; purple strip goes loud/quiet per tab; filtered tabs carry a marker. Spec: docs/features/portfolio-money-basis.md."
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-31T21:12:38.544Z
---

**BUILT 2026-10-31. Dev only — NOT deployed, nothing committed.** Canonical
spec: [`docs/features/portfolio-money-basis.md`](../../../dev/seedlings3/docs/features/portfolio-money-basis.md).
Builds on [[project_portfolios_design]].

## The problem it solves

The portfolio filter answered two different questions and said neither.
Properties/Clients/Jobs filter on membership **as it is now**; Payments and
Statistics filtered on membership **as it was when the visit completed**.
Tag 35 properties into a zone and the property list says 35 while the money
says $50 — both true, different questions, one panel.

Only money is timestamped, which is why only money has a second answer.

## What shipped

**Two bases, chosen per viewer.** Nothing is rewritten either way; both
read data that already exists, so switching is a reading choice.

- **"Work as organized now"** (DEFAULT) — all payments for the properties
  currently in this portfolio, whenever earned.
  `Payment → occurrence → job → property → PropertyPortfolio`
- **"Work as it happened"** — counted where the visit was when it
  completed. `Payment → occurrence → JobOccurrencePortfolio`

**Transport:** `X-Money-Basis: happened | today` beside the lens header,
defaulting to `today` when absent or unrecognised. Parsed in `rbac.ts` onto
`req.moneyBasis` — deliberately **not** on `Principal`, so `can()` can
never see it. A basis selects rows; it grants nothing.

**Helpers:** `occurrencePortfolioWhere` and `occurrencePaymentPortfolioWhere`
in `lib/portfolioScope.ts`. Six endpoints: `/payments`, `/payments/pending`,
`/payment-requests/outstanding`, `/statistics`, `/operations`,
`/dashboard-summary/aggregate`. All six are rooted on JobOccurrence.

**Proven on real rows**, not reasoned: a principal confined to one zone saw
12 payments / $1706 under both bases; after moving one property out,
"happened" stayed $1706 and "today" dropped to $1018.

## This REPLACED a backfill, and that is the point

A `backfillRootOnlyHistory` was designed, built, tested and **deleted** the
same week. It would have moved 527 completed visits off the root onto their
new zones so the zones showed history. The basis gets the identical screen
by changing a query instead of 527 rows — reversible, auditless, nothing
rewritten. **Do not rebuild it.**

## Where the controls are

- **Toggle** — the lens dropdown, under a divider, heading "MONEY SHOWS".
  Two rows: *Work as organized now* / *Work as it happened*. Greyed with an
  explanation when no lens is set, because unlensed both bases agree.
  Changing it purges cached responses, same as changing the lens.
- **Always-visible label** — the purple strip appends "· money **as
  organized now**" on money tabs, and the INSIGHTS note carries the same
  clause where that card exists. The guarantee lives in the strip because
  **the Payments tab has no INSIGHTS card** — a label that is sometimes
  absent is the failure this feature exists to prevent.

## The strip now tells the truth per tab (same build)

It renders ONCE above the tab row, so it speaks for whatever is below. It
used to say "showing Durham only" on all 21 tabs including the 11 it does
not touch — the whole company's Ledger read as one portfolio's.

- **Loud** (filled purple, 6px bar, strong text) when the open tab is
  actually narrowed.
- **Quiet** (transparent, thin outline, muted) otherwise, reading
  "— this tab shows the whole business".
- Same box, same height either way, so the row never reflows.
- `leadsOnly` stays quiet: that person holds everything company-wide and is
  merely recorded as leading a portfolio. Nothing is hidden from them.
- **Filtered tabs carry a purple Layers glyph** in the tab row while a
  filter is in force — `InnerTab.portfolioFiltered`, a TRAILING marker, never
  a replacement for the tab's own icon. The strip speaks for the tab you are
  on; the glyph answers "which others are affected" before you click.

## WHICH TABS THE FILTER TOUCHES — measured, in code

One list, `apps/web/src/lib/portfolioFilteredTabs.ts`, read by both the
strip and the tab row. **Measured from the API's call sites**, because ten
route files import `portfolioWhere` and never call it — reading imports
gives the wrong answer.

**Filtered (10):** jobs · services · clients · properties · payments ·
collections · statistics · home · tasks · displays
**Of those, money (5):** payments · collections · statistics · home · tasks
**NOT filtered:** Ledger · Reconcile · Forecast · Users · Crews · Equipment
· Supplies · Vehicles · Documents · Policies · Settings

Ledger and Reconcile are `books.view`, which is global-only by design. The
popover had claimed the Ledger WAS narrowed and omitted Payments and
Statistics — wrong in both directions; corrected.

**G50** guards the list: the strip must be told the open tab and act on it,
`index.tsx` must pass it, every claimed tab must name the endpoint that
makes it true, `MONEY_TABS ⊆ FILTERED_TABS`, and ledger/reconcile/forecast
may never appear. Six negative controls, all re-run after the list moved
out of the notice into the shared lib.

## Decisions, settled with the operator

1. Default **"as organized now"** — matches every other tab.
2. **Per viewer**, not per business. A filter, not a setting.
3. **Same default for a portfolio-scoped user.** One default, one meaning.
4. **Keep storing both.** From the frozen rows the current-membership view
   is always derivable; the reverse is impossible.
5. **Forecast stays unfiltered** and now says so.

## Two INSIGHTS money bugs, found and fixed the same day

Spotted by the operator on PRODUCTION: "Expenses $0, Processor fees $0 —
this absolutely cannot be correct." It was not. Both tiles on
`GET /operations` read the wrong column.

**Processor fees** summed `payment.platformFeeAmount` — the percentage
charged to CONTRACTORS — under the label for the Venmo/Stripe cut, which
is `processorFeeAmount`. With no contractor splits in the window it
honestly reported $0 of the wrong thing while $11.63 of real Venmo fees
went unshown. Both are material all-time ($329.25 and $321.57), so both
now have their own tile under their own name.

**Expenses** summed `invoiceCharges` — materials billed TO THE CLIENT,
which is revenue-side and never a deduction — and subtracted it to make
Net. The real $145.24 of fuel and meals sat in `BusinessExpense`, unread.
Per [[reference_expenses_charges_supplies]] the Ledger is the only
deduction. Now two tiles — **Job charges** and **Ledger expenses** — and
Net comes off the ledger.

Production's last 14 days go from `Expenses $0 · Net $885 · Processor $0`
to `Job charges $0 · Ledger $145.24 · Net $739.76 · Processor $11.63`.

**The ledger is capability-gated.** `/operations` is `reports.business`;
the ledger is `books.view`, and Portfolio Lead holds the first and not the
second. So `totalLedgerExpenses` and `netRevenue` are **null** for them and
the UI hides both tiles — a Net that silently deducts nothing would be a
different number wearing the same label.

Every other tile on that card was checked against production and
reconciles. It was two wrong field references, not an untrustworthy card.

## Open

- Nothing is deployed.
- **Full Playwright HAS now been run** — see
  [[project_e2e_full_run_2026_10_31]]. None of the 24 failures came from
  this work, proven by stashing; 20 of them were fixed the same day.
