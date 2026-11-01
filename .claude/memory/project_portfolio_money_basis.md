---
name: project_portfolio_money_basis
description: "The money basis was BUILT 2026-10-31 and REMOVED 2026-11-01. Money is grouped by current membership, always. 'As it happened' has no referent once a property moves twice — do not rebuild it. The per-visit frozen rows ARE still written."
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-01T00:00:00.000Z
---

**BUILT 2026-10-31, DEPLOYED, then REMOVED 2026-11-01** — four days.
Recorded so nobody rebuilds it. Canonical spec now:
[`docs/features/portfolios.md`](../../../dev/seedlings3/docs/features/portfolios.md).
See [[project_portfolios_design]].

## What it was

An `X-Money-Basis: happened | today` header let each viewer choose what a
portfolio-filtered money figure meant:

- **today** — all payments for the properties currently in this portfolio
- **happened** — counted where the visit was when it completed, read from
  its own frozen `JobOccurrencePortfolio` rows

It replaced a 527-row backfill, which was the right call at the time: the
same screen from a query instead of rewriting history.

## Why it was removed

The operator's argument, and it is better than the one I was defending:
**"as it happened" has no referent.** A property in Zone A in March, B in
May and C in August produces an annual Zone A total made of whichever
visits happened to complete while it was in A — a smear across every
arrangement that ever existed, matching no org chart that was ever real.

"As organized now" and "as of a snapshot" are each ONE coherent
arrangement applied consistently. "As it happened" is the only one that
cannot name the arrangement it used.

**And the data settled it harder than the argument.** Every visit
completed before the tree was built points at the root, so on real
production data "as it happened" reported the entire history to the root
and nothing to any zone. Not merely muddy — empty.

## What replaced it

Nothing. One grouping, always current. The strip still says *"money as
organized now"* on money tabs, because with nothing to switch people stop
thinking about it and are then surprised when re-tagging moves last
month's total.

Snapshots were the planned home for historical grouping and were
**deliberately punted** the same day — not worth it at this scale, add
later if it matters.

## THE ROWS ARE STILL WRITTEN, AND THAT IS LOAD-BEARING

`lib/occurrencePortfolio.ts` still freezes a visit's portfolios at
completion even though **nothing reads them for grouping any more**. A
future session will find a table nobody selects from and reasonably want
to delete it. Don't.

Current membership can always be re-derived; past attribution cannot.
Stopping the capture is the irreversible half, and it silently forfeits
the whole period it is off with no way to backfill. The file says this at
the top. Deleting it is a product decision, not a cleanup.

## Also removed with it

The toggle in the lens panel ("MONEY SHOWS"), `lib/moneyBasis.ts`, the
basis parameter on `occurrencePortfolioWhere` /
`occurrencePaymentPortfolioWhere`, the paired unit tests, and the
`getMoneyBasis` / `setMoneyBasis` helpers in the web.

## What is still true from that work

The two INSIGHTS fixes shipped with it and stand: **processor fees** read
`processorFeeAmount` (Venmo/Stripe) rather than `platformFeeAmount` (the
contractor percentage), and **expenses** come from `BusinessExpense`, not
`invoiceCharges` — the Ledger is the only deduction. Both tiles are
capability-gated and return `null` rather than a quietly-wrong zero.

The per-tab loud/quiet strip and the filtered-tab markers also stand;
the canonical list of which tabs the filter touches is still
`apps/web/src/lib/portfolioFilteredTabs.ts`, guarded by G50.
