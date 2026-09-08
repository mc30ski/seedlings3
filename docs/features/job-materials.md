# Job materials / invoice charges — feature reference

Canonical spec for how money on a job splits between **what the client is
billed** and **what the business deducts**. Bound to
[`apps/api/src/services/job-materials-build-gate.test.ts`](../../apps/api/src/services/job-materials-build-gate.test.ts).
If the code and this doc disagree, one of them is wrong — fix both in the same
PR.

---

## Why the old design failed

A job's "expenses" were conflated with the tax ledger. Adding an expense to a
job **also wrote a `BusinessExpense`** — a Schedule C deduction. So when the
operator later entered the real card charge from their bank statement, which
they must because that is the actual record, **the same money was deducted
twice.**

Worse: an expense on a job came **out of the crew's payout**. A $60 job needing
$30 of mulch left the workers absorbing the mulch, and the client was never
billed for it.

---

## Two books. They are not the same book.

| | **The Ledger** | **A job's invoice** |
|---|---|---|
| Model | `BusinessExpense` | `InvoiceCharge` |
| What it is | real money off a bank/card statement | what the CLIENT is billed |
| Tax | **is** the Schedule C deduction | creates **no** deduction, ever |
| Who writes it | only `/admin/business-expenses/*` (Super) | the job surfaces (admin-only) |
| Surface | Super → Money → Ledger | job card → **Add Charge** |

They reconcile **in aggregate only**. A $500 Lowe's receipt is one ledger row;
the mulch off it lands on four different jobs. There is no row-to-row
relationship and there must never be one.

**Nothing on a job may write a `BusinessExpense`.** Not adding a charge, not
editing one, not deleting one, not recording a supply purchase, not consuming
inventory, and not a job status change re-dating a linked row. A build gate
walks every source file and fails on a ledger write outside the Ledger's own
routes.

---

## Model

A job carries **lines**. Every line has a charge; some have a cost; each is
either in the crew's pool or a pass-through.

> **Vocabulary.** The UI calls these **invoice charges** — "charge" is the word
> for the number a client pays, where "cost" is what we paid.
>
> **The model is `InvoiceCharge`.** It was called `Expense`, and that name is
> precisely how the two books got conflated. The physical table is still
> `Expense` (via `@@map`) — renaming it would break the deployed API the
> instant the migration ran, for no gain. Do not "clean that up" later.

| Line kind | Charge | Cost | In pool? | Stock |
| --- | --- | --- | --- | --- |
| **Labor** | typed | — | **yes** | — |
| **Service** (add-on) | typed | — | **yes** | — |
| **Material — from inventory** | typed per job (catalog default) | **none** | no | draws down |
| **Material — one-off** | typed | typed, **optional** | no | none |

- **Invoice total** = sum of every line. **Derived, never typed.**
- **Crew pool** = labor + services. What the crew is *paid* is this figure
  after margin and per-worker fees — see `packages/money`.
- **Job margin** = labor margin + (material charge − material cost), where a
  cost exists. Inventory-backed lines carry none — their cost lives in the
  Ledger — so job margin is an upper bound on jobs served off our own shelf.

### A service and a material charge are entered the same way

Both are lines on the client's invoice: a **name** plus an **optional
client-visible detail**.

| | Name | Detail (optional) |
| --- | --- | --- |
| Service (add-on) | "Trim the bushes" | "5 bushes at $25.00 each" |
| Material charge | "Mulch" | "25 bags at $6.00" |

They render identically, from `invoiceLines()`. The only difference is where
the money goes: **a service is work, so it lands in the crew's pool.** Adding a
service raises the invoice *and* the pool. Adding a material charge raises only
the invoice.

**Say "pool", never "the crew splits it".** They are not the same claim. The
pool is what the payout engine divides, and margin plus per-worker fees come
off before anyone is paid — how much of a $50 service reaches a worker depends
entirely on the margin and fee settings. Copy promising the crew the whole
amount is a promise the engine does not keep, and the operator repeats it to
the crew. Both job dialogs say "raises the crew's pool" and carry the caveat;
a build gate holds the phrasing.

### The labor line is a single typed amount

Not rate × hours. You type $150. The occurrence carries `estimatedMinutes` and
real clocked time, so hours exist elsewhere for anyone who wants them — they
just don't drive the price. `laborDetail` is the operator's choice; an itemized
"Labor $150" discloses your hourly rate.

### Cost is real, but unreconciled

`actualCost` is not invented — it comes from what was paid. It is simply not
tied to a ledger row. "Unreconciled" is the accurate word; calling it fake
invites treating it carelessly, and then it becomes fake.

**Never on the invoice, never in the payout, never shown to a client.**

### Absorbed costs are not job lines

A gas can, a broken trimmer line, fuel to the site: these are covered by the
business margin, which is what the margin is for. They are ledger rows with no
job attached. If a cost is not billed to the client, it does not belong on the
job at all.

---

## One pricing model. There is no era flag.

There was a `JobPricingModel { LEGACY ITEMIZED }` enum on `JobOccurrence`,
stamped per row, because historical visits never billed their materials: a $100
mow with $60 of mulch invoiced $100 and paid the crew out of $40. Reproducing
that needed a rule that travelled with the row, so every money calculation
branched — **nineteen sites across eight files, and the same "forgot to branch"
bug shipped in six of them**, including `adjustOccurrencePrice`, which is the
payout *contract*.

It was never necessary. Both facts are reproducible by rewriting the DATA:

```
LEGACY   : invoice = base,             pool = base − charges
ITEMIZED : invoice = price + charges,  pool = price
```

Set `price = base − charges` and the itemized rule reproduces **both** exactly.
Migration `20260908090000_unify_pricing_model` did that and dropped the column
and the enum. It refuses to run rather than half-apply if any row would go
negative; production had none (516 occurrences, 9 carrying charges).

**Never reintroduce an era flag.** If a historical fact needs preserving,
rewrite the data so one rule reproduces it. The gates fail on any occurrence of
`pricingModel` or `LEGACY` in either app.

### The two functions

```
crewPool(occ)     = laborAndServices(occ)
invoiceTotal(occ) = laborAndServices(occ) + materialChargeTotal(occ)
```

Both live in `apps/api/src/lib/jobPricing.ts` and nothing may inline either.
The gate asserts `crewPool` against the payout engine —
`computeBreakdown(collected, charges)` computes `N = collected − charges` —
rather than against a hand-typed number, because a typed number is exactly how
the earlier bug got locked in.

**Feed `computeBreakdown` the INVOICE, not labor alone.** `packages/money`
needs no changes: given the itemized invoice and the material charges it
returns the labor pool automatically.

---

## The optional breadcrumb — and the one field that means two things

`InvoiceCharge.businessExpenseId` and `SupplyPurchase.businessExpenseId` are
**optional, many-to-one** pointers the operator sets by hand, so that six weeks
later a $500 Lowe's charge can tell you which jobs it went to.

`onDelete: SetNull`. Never `Restrict`. Never cascaded.

**It is a breadcrumb and nothing more. No total reads it.** Clearing it
changes no number anywhere — not the invoice, not the payout, not the P&L, not
the Forecast. It exists so a human can answer "which jobs did that receipt go
to?", and that is its whole job.

It once meant two things — on pre-itemized rows it was a real 1:1 pair created
by the old dual-write, and *that* ledger row was the line's deduction. Those
pairs are gone: the unification rewrote the data so the ledger row is always
the deduction and the job line never is. A cascade through this pointer used to
destroy a $500 deduction depending on which era the row belonged to. **It has
cost a deduction twice. Never cascade through it.**

### Deleting a ledger charge

- Job lines and supply purchases are **unlinked**, never deleted.
- **Inventory is never reversed.** A ledger row is no longer evidence that
  stock arrived, and several purchases may share one receipt.

### Editing a ledger charge

Never writes through to a job. Correcting a receipt must not change what a
client was billed — and on a many-to-one link it would change the wrong job.

---

## Worked example

Labor $150. 25 bags of mulch billed at $6, bought for the job and entered as
**one-off charges** with their cost typed in. $50 of edging stone at cost. One
employee, 35% margin.

| Line | Charge | Cost |
|---|---|---|
| Mow & edge | $150 | — |
| Mulch — 25 bags at $6.00 | $150 | $125 |
| Edging stone | $50 | $50 |
| **Invoice total** | **$350** | |

- **Crew pool** = $150 (labor). The employee's gross share is $150.
- **Material margin** = ($150 − $125) + ($50 − $50) = **$25**. Had the mulch
  come **off our own shelf** instead, the line would carry no cost at all and
  this figure would read $0 — what those bags cost sits in the Ledger, against
  the receipt that stocked them.
- The client pays $350; the business banks the materials at cost-plus-$25 and
  pays the crew out of the $150 of labor.

Before the model was unified, this same job invoiced **$150** and left the
pool at **$0** — the crew absorbing $175 of materials the client was never
billed for. That is the defect this exists to fix.

---

## Money rules

- Payout math is unchanged; `packages/money` is untouched.
- An underpaid job comes out of the **business margin**, not the crew.
- Contractors stay **pro-rata**.
- Material markup is revenue, not a reduction in cost.

---

## Services and charges are managed in their dialogs, never from a card

**Edit Services** and **Edit Charges** are the only surfaces that add or remove
a line. A card lists what is on the visit; it does not change it.

Both the job card and the Services tab used to render a bare red ✕ beside every
add-on. One tap on a collapsed card, one confirm, and a line came off the
client's invoice — on a phone, in the field, next to the line you were only
trying to read. Two copies of that affordance also meant two copies of the
confirm text, drifting apart.

The dialogs list every line on the visit together, so a removal is made with
the whole invoice in view. Removal still confirms, and the gate holds both
halves: no `apiDelete` to `/addons/` outside `ManageAddonsDialog`, and that
dialog must mount a `ConfirmDialog`.

The buttons say **Edit**, not **Add** — the dialog does both, and a button that
says "Add" hides where removal lives.

---

## Permissions

Every mutation — add, edit, delete, and pulling from inventory — is
**admin-only**. A job line raises what the client is billed, so it is not a
worker's call. The refusal says why; a bare "forbidden" reads as a bug.

Workers see a **read-only list**. The UI hides the buttons rather than letting
someone click into a 403.

---

## Inventory lifecycle

Pulling stock onto a job creates a `SupplyHold` and a paired `InvoiceCharge`.

**The price is decided per job, not in the catalog.** The same mulch can be
$5.00 to one client and $9.00 to another — `Supply.clientUnitPrice` is only an
optional *default* the pull dialog pre-fills. Likewise the line's name defaults
to the supply's but is the operator's to change, and `detail` is free text
("25 bags at $6.00").

**The line records no cost.** Not `actualCost`, not the catalog's
`businessCost`, nothing. What we paid is a `BusinessExpense` in the Ledger;
importing a cost into a client charge makes the approximate stock layer look
authoritative. Migration `20260908170000_supply_charge_is_not_a_cost_record`
cleared the values a brief earlier version wrote.

**Nothing about the line is locked.** An inventory-backed charge is an ordinary
invoice line — name, detail and amount all editable. It used to refuse edits
with a 409 on the grounds that the amount was "derived"; that made a supply
line a second-class citizen on the invoice for no benefit. The hold owns the
**stock** only: changing the held quantity re-prices the amount and leaves the
wording alone.

### Stock states, and what each one moves

| Hold status | Physical stock | The client's charge |
| --- | --- | --- |
| `ACTIVE` | **reserved**, not removed — `available = onHand − Σ active` | on the invoice |
| `CONSUMED` | **leaves the shelf** (`onHand` decremented) | stays — they were billed |
| `RELEASED` | returned | dropped, pointer cleared |

Reverting a payment reactivates consumed holds and puts the stock back.
A hold can never exceed what is available; `adjustHold` re-checks on every
increment.

### `businessCost` is a last-paid heuristic

This is the "what you pay" figure on the Supplies form, and it is
**informational** — it never reaches a client's invoice or a payout.

`recordPurchase` takes the **receipt total** — it includes tax and any discount
and is the figure that reconciles to a bank line — and derives the per-unit
cost from it, then **overwrites `Supply.businessCost`** with that figure. So
the catalog cost tracks the most recent purchase, and an `actualCost`
snapshotted on an older job may not match today's catalog. That is intended:
the snapshot says what those units cost, not what the next ones will.

Recording a purchase tracks **stock, not taxes**: it creates no ledger row.

---

## The client-facing invoice

`invoiceLines()` is the only place invoice lines are built. The pay page, the
receipt and the admin preview all read it, so a line can never appear on one
and be missing from another — and the sum equals `invoiceTotal`, which the gate
asserts rather than trusts.

**Nothing internal leaves.** No `actualCost`, no margin, no supply unit cost,
no ledger link.

> The unification made 9 historical production invoices itemise where they
> previously showed one line. Same total, same payout, same deduction — but a
> client reopening a months-old link sees "$183.23 + $279.27" where they once
> saw "$462.50". That was a deliberate, accepted trade.

**Never print an internal key.** An add-on carries a raw `tag` (`HEDGE`,
`LEAF_CLEANUP`). Resolution order: typed custom label → the `SERVICE_TYPES`
catalog → `humanizeTag()` (`LEAF_CLEANUP` → "Leaf cleanup", *not*
"Leaf_cleanup"). The catalog is loaded once per invoice so half the lines can't
render with labels and half with keys. A malformed catalog degrades; it never
fails the invoice.

### Changing a total the client has already been given

`amountDue` is computed live, so changing a job changes what a client sees when
they open a link they were emailed days ago. Every surface that can move the
total — charges, services, re-price — shows `InvoiceAlreadySentNote`. Warning
on some of them is worse than none: it teaches the operator that silence means
safe.

---

## Invoice preview

Admin/Super only, gated on the **selected** scope (`isAdmin || isSuper`), never
`forAdmin ||` — that would light it up for a Super sitting on the Worker chip.

Reads through `buildInvoice`, the same function the pay page uses, so it cannot
show a number the client wouldn't get. It computes nothing of its own and
writes nothing.

It carries a yellow warning quoting **this job's real numbers** — what the crew
shares versus what is billed on top. "Services are shared, charges aren't" is
easy to nod along to and still misread a $350 total as $350 of work.

---

## What each role sees

- **Worker** — a read-only list of charges, and copy explaining these don't come
  out of their pay.
- **Admin** — full add/edit/delete, the ledger-link picker, the invoice
  preview, and `actualCost` / per-line margin **on one-off charges only**
  (an inventory-backed line carries no cost, by design).
- **Client** — the invoice lines and the total. Nothing else.

---

## Non-goals

- Row-to-row reconciliation between the two books.
- Splitting one receipt across jobs by amount.
- Per-line receipt photos. A receipt belongs to the **ledger** row — that is
  what survives an audit. The old job-line receipt routes wrote to the linked
  ledger row's receipt columns: on a new charge the link is null and it 409'd;
  on one carrying the breadcrumb it attached to a receipt shared with other
  jobs, and replacing it deleted the previous file.
- Deriving labor from an hourly rate.

---

## Testing

`apps/api/src/services/job-materials-build-gate.test.ts` — run with
`cd apps/api && npm run test:build-gate`.

The structural gates matter most:

- **"only the Ledger writes the Ledger"** walks every source file and fails on
  a ledger write outside `/admin/business-expenses/*`. Reviewing by memory
  finds the sites someone thought of; this finds all of them.
- **"a job line is an invoice charge, never an expense"** walks both apps and
  fails on the retired vocabulary, `pricingModel` and `LEGACY` included.
- **"a detached Prisma include/select is type-annotated"** — an include lifted
  into its own `const` is NOT key-checked by TypeScript, so it can name a
  relation that no longer exists and still compile. That is how a renamed
  relation took the whole Ledger tab down in production on 2026-09-08 with both
  apps typechecking clean. Use `Prisma.validator<Prisma.XInclude>()({ … })`.

Both strip comments before scanning, so this history can stay legible in prose.

**Mutation-test every assertion**: break the thing, watch the gate fail,
revert. A gate nobody has watched fail is a gate you don't have.
