# Portfolios

The territory tree, who looks after which part of it, and what the filter
means. Canonical: if this and the code disagree, one of them is wrong and
both get fixed.

Enforced by `apps/api/src/services/permissions-build-gate.test.ts`
(G12/G14/G17/G21/G22/G25/G26/G49/G50) and the scope unit tests in
`apps/api/src/lib/portfolioScope.test.ts`.

## What a portfolio is

A place the business works, or a way of grouping work that is not a place.
Give somebody a role **in a portfolio** and they hold it there and nowhere
else — the same role, confined to one branch of the tree and everything
under it.

- **One tree, one root.** The root is the container, not a territory: it
  has no tier, no coordinates, nobody in charge of it, and it cannot be
  retired, moved or deleted. A second root is not expressible, because
  scoping is a path PREFIX test and "both trees" is not a prefix.
- **`path` is built from ids**, delimited and terminated (`/a/b/`). Names
  are neither unique nor stable; the trailing delimiter is what stops
  `/a/b/` matching `/a/bb/`.
- **Tiers are a vocabulary, not a constraint.** `PORTFOLIO_TIER_NAMES` in
  Settings names each level and describes it. Nothing validates that a
  District sits inside a Market — the words describe the convention, the
  tree does not enforce it.

## Membership

A property belongs to **any number of portfolios** (`PropertyPortfolio`).
A zone and a Book can both hold the same property; it is counted once by
each and once by their shared parent.

A property in **no** portfolio is a real and visible state, not an error.
It reaches no lens, counts toward no rollup, and is invisible to every
portfolio-scoped reader — which is why the root shows it (`N unfiled`,
and listed under its own heading when the root is selected) rather than
letting it vanish.

### Visits

`JobOccurrencePortfolio` holds what a visit counted toward. Open visits
follow their property; completion freezes them. `lib/occurrencePortfolio.ts`
is the only writer and the only thing that checks `completedAt`.

**Nothing reads these rows for grouping.** They are written and kept
anyway: current membership can always be re-derived, past attribution
cannot, so stopping the capture is the one irreversible half. History was
deferred, not cancelled.

## Money is grouped by where work is organised NOW

Always. A visit counts toward whatever its property belongs to today,
however recently that changed. Re-tagging a property changes last month's
zone totals, and the purple strip says `money as organized now` on every
tab that shows any, so the rule is stated even though there is nothing to
choose.

**There was a second answer and it was removed** (2026-11-01). An
`X-Money-Basis` header offered "as it happened" — each visit counted where
it sat when it completed. It was deleted because it has no referent: a
property that changes zone twice produces a total that is a smear across
every arrangement that ever existed and matches no org chart that was ever
real. On this business's data it was worse — every visit completed before
the tree existed points at the root, so it reported the entire history to
the root and nothing to any zone. **Do not reintroduce it.**

## Moving a node

`POST /portfolios/:id/move`, `portfolios.manage`.

Reparenting was refused outright until 2026-11-01 (the old G14). The
rewrite it feared is real — a move changes the materialized path of every
descendant — but the conclusion no longer holds, for two reasons that both
changed:

- **Nothing stores a path.** Both join tables key on `portfolioId`, a
  grant resolves its reach from the live row on every request, and the
  lens header carries an id. The transaction is the whole migration.
- **No view promises a frozen total any more**, since the money basis went.

What a move does change, and the operator is told before confirming:
every rollup above the node, and **who can see the subtree** — a lead on
the old parent loses it, a lead on the new parent gains it. That delta is
written into the audit because grants resolve per request and nothing
else records it.

Refused: into its own subtree (detaches the branch), the root, anything
retired at either end.

**Sibling order** (`sortOrder`) is separate and display-only: not in any
path, nothing filters on it, no history resolves through it. The API
returns the tree depth-first in that order so every picker, the lens menu
and the tab agree without each sorting for itself.

## Retiring and deleting

**Retire** hides a portfolio from every picker and leaves it in all
reporting, because history has to resolve through a closed territory.
Refused while live work still points at it.

**Delete** (`DELETE /portfolios/:id`, `portfolios.manage`) is permanent and
is the only irreversible operation in this model — a move moves back, a
retire un-retires, a re-tag re-tags. There is no snapshot to restore from,
by decision.

It requires the portfolio to be **retired first** (the speed bump: out of
every picker while anything still depending on it surfaces) and **empty**,
which means four things:

| Blocker | Why |
|---|---|
| properties | still filed here |
| **completed visits** | history points at it, and always will |
| leads | somebody is assigned here |
| children | including retired ones |

All four are `onDelete: Restrict` in the schema, so the database refuses
regardless. `GET /portfolios/:id/delete-blockers` exists so the button can
be **disabled with the reason** rather than clickable and refused.

The visit count is the one that keeps a node alive for good. The line
lands where it should: **you can delete a mistake, never a record.**

## Scoping — what narrows a view

`lib/portfolioScope.ts`. Grants widen, the chosen lens narrows, and the two
intersect — so no value of the `X-Portfolio-Lens` header can reach a
territory the grants do not already cover.

- **Global authority means no filter.** A portfolio assignment can only
  ever ADD places somebody can see.
- **Capability is never scoped, only visibility.** `work.claim` and
  `work.complete` are in `NEVER_AREA_SCOPED` — a worker looking after one
  zone must still be able to cover a visit in another.
- **Retired portfolios stay in reporting.**
- **An explicitly named portfolio beats the ambient lens** (`ignoreLens`).
  Clicking a portfolio IS the narrowing for that request; intersecting it
  with a lens set days ago on another tab is what made the tree read
  "Carrboro · 4" above a panel reading "Nothing in Carrboro yet".

### Which tabs the filter touches — and by which route in

One table, `TAB_NARROWING` in `apps/web/src/lib/portfolioFilteredTabs.ts`,
measured from the API's call sites and guarded by G50 in both directions.
Ledger, Reconcile and Forecast are **not** filtered.

It was a flat `Set` of tab names until **2026-11-12**, and a name cannot
answer the question, because there are two ways to be narrowed and they are
not the same event:

| | |
|---|---|
| a **lens** | a portfolio picked from the header chip — a view setting, with an × to clear it |
| a **grant** | a role granted *inside* a portfolio, so that is simply what this person's access is; no × is offered, because there is nothing to switch off |

Most tabs obey both. `performance` obeys one: `GET
/reports/portfolio-performance` passes `ignoreLens` deliberately (the tab
compares portfolios side by side, and a lens collapsing it to one would
empty the comparison), while a grant still applies, because a grant is what
you may see rather than what you chose to look at. With a single list there
was **no entry that was true for both readers** — omitting it told a
grant-limited lead the whole business was in front of them, listing it would
have told a lens-holder their lens had narrowed a tab that ignored it.

Each tab therefore carries `{ grant, lens }`, and each of those is one of:

- `true` — the tab's own lists and totals narrow;
- `false` — that kind of narrowing does not reach the tab at all;
- `{ part: "…" }` — the tab is company-wide **apart from** the named panel.

The third shape covers `equipment` (its Insights leaderboard reads
`/operations`, which comes from occurrences) and `portfolios` (only the
property picker in the filing dialog reads `/properties`). The strip stays
quiet for those — their own figures *are* the company's — but it no longer
says "this tab shows the whole business", which was true of the tab and
false of the control the reader was about to use. It says "this tab is
company-wide apart from the Insights panel" instead.

The caller supplies which kinds are in force; the strongest applicable
answer wins, so a grant-limited lead who also picks a lens is narrowed by
both. There is **no exemption list** — for one day there was, and an escape
hatch with a prose justification is a hatch: mutation testing got
`repeating: "excuse"` through it. The table states all three cases instead.

Behaviour is locked in by `apps/api/src/lib/portfolio-narrowing.test.ts`,
run from the build gate through the `@web-lib` alias. G50 proves the table
agrees with the API; those tests prove the resolver reads it correctly —
a `tabNarrowing` returning `true` for everything would satisfy every regex
in G50 and put the old lie back on every tab at once.

## Presentation

- **Colour** is a Chakra palette NAME, never a hex — a literal would be the
  same colour in all fourteen themes. `null` means auto, taken from
  position, so ten zones are distinguishable before anybody has chosen ten
  colours. One assignment in `apps/web/src/lib/portfolioColors.ts` feeds the
  map pins, the map legend and the list headings.
- **Instructions** ("what belongs here") is free text, enforced by nothing,
  shown where a property is actually being filed.
- **The map** colours by the deepest descendant a property belongs to — the
  same rule the grouped list uses — with a toggleable legend and a
  full-page expand.

## Deliberately not built

**Snapshots and structure history.** Discussed at length and postponed on
2026-11-01 as not worth it at this scale. The consequence is that there is
no way to see how money was grouped in the past, and no record of what a
move changed beyond its audit entry. This is reversible only while
`JobOccurrencePortfolio` keeps being written — see above.
