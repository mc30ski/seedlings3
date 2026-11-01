# What the portfolio filter covers

**Status: BUILT 2026-10-29.** Decisions settled with the operator the same
day; both halves implemented and verified against real rows. Applied to dev
only — production untouched, nothing committed.

One thing moved during the build: the basis label was specified for the
INSIGHTS note, and the Payments tab turns out to have no INSIGHTS card. A
label that is sometimes absent is the failure this feature exists to
prevent, so the guarantee moved to the purple strip — which is on every
tab — with the INSIGHTS note carrying it as well where the card exists.

Companion to [`permissions.md`](permissions.md) (how portfolios work) and
[`FINANCIAL_SYSTEM.md`](../FINANCIAL_SYSTEM.md) (what money means here).

---

## The problem

The portfolio filter answers two different questions depending on which tab
you are on, and nothing on screen says which.

On **Properties, Clients and Jobs** it means *"things that are in this
portfolio"*. On **Payments and Statistics** it means *"money earned while
the property was in this portfolio"*.

So when you tag 35 properties into Chapel Hill West, the property list says
35 straight away and the money says $50 — because all that past work was
earned before the zone existed. Both numbers are true. They are answers to
different questions sitting on one screen.

Measured against production on 2026-10-29, building the planned tree would
produce:

| Zone | Properties | Money shown | Money still on the root |
|---|---|---|---|
| Chapel Hill West | 35 | $50.00 | $14,170.00 |
| Briar Chapel | 28 | $440.00 | $11,813.00 |
| Chapel Hill East | 12 | $75.00 | $3,774.37 |
| Chatham | 11 | $125.00 | $6,310.00 |
| Carrboro | 4 | $0.00 | $545.00 |

The small non-zero figures are payments already sitting on unfinished
visits. Unfinished visits follow the property immediately; finished ones
never move.

And there is a second, worse version of the same problem, below.

## The fix, part one: say which question the money is answering

Let the viewer choose, and always show the choice.

- **As organised today** — everything these properties have ever earned, no
  matter when. Chapel Hill West shows $14,170 the moment you tag it. Move a
  property out tomorrow and its money goes with it.
- **As it happened** — only money earned while the property was actually in
  this portfolio. Chapel Hill West shows $50 and grows from there. Moving
  properties never changes it.

**Nothing is rewritten either way.** Both answers come out of data that
already exists; this is a choice about which one to read. There is no
backfill, no migration, and no edit to any finished visit — that was
considered and rejected on 2026-10-29.

### Decisions

1. **The default is "as organised today."** It matches every other tab, so
   the mismatch above disappears, and it is the question actually being
   asked: *is Briar Chapel big enough to be its own thing?*
2. **The choice is personal, not business-wide.** It lives with the viewer,
   beside the lens, like a filter — not in Settings.
3. **It stays "as organised today" for everyone**, including somebody whose
   access is limited to one portfolio. One default, one meaning; a number
   that means something different depending on who is looking is worse than
   a number that needs explaining once.
4. **Keep storing both.** Every finished visit already records what it
   counted toward. From that, "as organised today" can always be worked
   out, because the property's current portfolio is right there to look up.
   The reverse is impossible — once what-actually-happened is gone, nothing
   can reconstruct it. Store both, read one.

### Where the switch goes

In the portfolio dropdown in the title bar, below the list of portfolios,
after a divider:

```
  MONEY SHOWS
  ● Work as organised today    Everything these properties have ever earned
    Work as it happened        Only what was earned while tagged here
```

One switch, in the same place you pick the portfolio, because it only means
anything once a portfolio is picked. Greyed out with a line of explanation
when no portfolio is selected.

**The state is always visible.** The orange INSIGHTS note already reads
*"Chapel Hill only — over the selected period."* It gains a clause, and the
clause is clickable:

> Chapel Hill only — over the selected period, **as organised today**.

The Payments total carries the same clause, because the total is the number
people screenshot. The note is unchanged on tabs where money is not
involved.

The rule underneath: a money figure must never depend on a setting you
cannot see. That is how two people read the same page and quote different
numbers.

## The fix, part two: stop claiming tabs are filtered when they are not

This came out of asking what Forecast should do, and it is the more urgent
half, because it is **wrong today rather than merely confusing**.

The purple notice is rendered once, above the tab row, so it applies to
whatever is below it. But only some tabs are actually filtered by
portfolio. On the rest, the notice says *"Portfolio filter: showing Durham
only"* above a page showing the whole company.

That is the dangerous direction: a reader takes the whole company's Ledger
for Durham's and concludes Durham had a huge month.

**Filtered by portfolio:** Jobs · Clients · Properties · Payments ·
Statistics · Home (dashboard and rollups) · Inventory (its operations
figures) · the display photo wall.

**Not filtered at all:** Ledger · Reconcile · Forecast · Users · Crews ·
Equipment · Supplies · Vehicles · Documents · Policies · Settings.

So the notice has to know which tab is open and say so:

> **Filtered tab:** Portfolio filter: showing **Durham** only.
> **Unfiltered tab:** Portfolio filter: **Durham** — this tab shows the
> whole business.  *(quiet styling: outline, muted text)*

Same purple strip, same place. The second wording is the entire point of
the change: Forecast, Ledger and Reconcile stay exactly as they are, and
say so.

Driven off one list, in the same file as the notice, so adding portfolio
filtering to a tab means moving its name between two arrays and nothing
else. A hand-maintained list is the risk here — a tab that gains filtering
and is not moved will claim it is unfiltered, which is the safe direction
of wrong, but still wrong.

## What changes under the hood

One filter shape, in the six endpoints that scope money:

```ts
// as it happened (today's behaviour)
{ occurrence: { portfolios: { some: { portfolio: { OR: paths } } } } }

// as organised today (the new default)
{ occurrence: { job: { property: { portfolios: { some: { portfolio: { OR: paths } } } } } } }
```

The same indexed prefix test, one join deeper. Nothing about access changes:
grants widen, the lens narrows, the two intersect. The basis changes which
*rows* match, never which *portfolios* a caller may ask about.

Endpoints: `GET /payments`, `/payments/pending`,
`/payment-requests/outstanding`, `/statistics`, `/operations`,
`/dashboard-summary/aggregate`.

Carried as a header, `X-Money-Basis: happened | today`, beside the existing
lens header, defaulting to `today` when absent — so it threads the way the
lens already does and no endpoint can forget it in one of its branches.

**Checked:** all 505 production payments reach a property through
occurrence → job → property, so no money drops out of the new basis.

## Edge cases

| Case | What happens |
|---|---|
| Property in two portfolios (a zone and a Book) | Counted under both. A parent still counts it once, because parent totals already count each property once. Unchanged. |
| Property in no portfolio | Invisible under any portfolio filter, either basis. The "In no portfolio" filter on Properties is how you find them. |
| Archived property | Still counted. Archiving does not change portfolio membership. |
| Retired portfolio | Still counted. Retiring hides a portfolio from pickers, not from reports. |
| Property moved between portfolios | "As organised today" moves all its history; "as it happened" moves none. That difference is the feature. |
| A visit attributed to a portfolio its property has since left | Visible under "as it happened" only. This is the one place the stored history is readable, and the reason for decision 4. |

## How it gets proven

- **Unit** — one case per basis in `portfolioScope.test.ts`. A past bug
  there was a filter that compiled fine and matched nothing; a second shape
  carries the same risk.
- **Integration** — the scope test drives both bases as a one-zone user and
  asserts no other zone's rows come back. A leaking basis is an access bug,
  not a reporting one.
- **The check worth running by hand** — move one property, then look at the
  top of the tree. **"All properties" must show the same total in both
  modes, before and after.** If the root ever disagrees with itself,
  something is double-counting and the whole thing is wrong.
- **End to end** — extend `portfolio-lens-owner.spec.ts`: set a lens, read
  the total, flip the basis, assert the total changed *and* the on-screen
  wording changed with it. A figure that moves without its label moving is
  the failure this design exists to prevent. Plus one case landing on
  Forecast with a lens set and asserting the notice says the tab is not
  filtered.

## Out of scope

Ledger, Reconcile, Forecast, payroll and the tax exports. None are filtered
by portfolio today, none would be, and part two makes them say so.
