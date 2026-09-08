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
| **Material — from inventory** | derived per unit | from the `Supply` | no | draws down |
| **Material — one-off** | typed | typed, **optional** | no | none |

- **Invoice total** = sum of every line. **Derived, never typed.**
- **Crew pool** = labor + services. What the crew is *paid* is this figure
  after margin and per-worker fees — see `packages/money`.
- **Job margin** = labor margin + (material charge − material cost).

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

## `pricingModel` — stamped per row, never inferred

```prisma
enum JobPricingModel { LEGACY ITEMIZED }
```

`JobOccurrence.pricingModel` records which rule a visit was created under. It
is stamped at creation and **never** inferred from a cutoff date, because the
P&L and the Forecast tab **replay** historical visits — the rule has to travel
with the row.

- `LEGACY` — materials were never billed to the client. They came out of the
  crew's pool. Every visit existing before the change is backfilled to this.
- `ITEMIZED` — materials are billed on top; the pool is labor + services.

### `crewPool` BRANCHES. This is the most dangerous function in the codebase.

```
ITEMIZED  materials billed on top      → pool = laborAndServices
LEGACY    materials came out of pool   → pool = max(0, laborAndServices − materialCharges)
```

Verify against the payout engine, which is authoritative —
`computeBreakdown(collected, charges, …)` computes `N = collected − charges`:

```
LEGACY    collected = 100, charges = 60  →  the crew is paid 40
ITEMIZED  collected = 160, charges = 60  →  the crew is paid 100
```

A version of this returned 100 for **both**, and the job card promised a pool
the crew was never going to see. The gate asserts `crewPool` against
`computeBreakdown` rather than against a hand-typed number, because a typed
number is exactly how that bug got locked in.

**`invoiceTotal` must build on the raw base, not on `crewPool`** — `crewPool`
subtracts materials under LEGACY, and subtracting them again would bill the
client less than the labor was worth.

**`packages/money` needs zero changes.** Feeding `computeBreakdown` the
itemized invoice and the material charges yields the labor pool automatically.

---

## The optional breadcrumb — and the one field that means two things

`InvoiceCharge.businessExpenseId` and `SupplyPurchase.businessExpenseId` are
**optional, many-to-one** pointers the operator sets by hand, so that six weeks
later a $500 Lowe's charge can tell you which jobs it went to.

`onDelete: SetNull`. Never `Restrict`. Never cascaded.

**It means two different things.** Only the occurrence's `pricingModel` tells
them apart:

- **`LEGACY`** — a real 1:1 pair created by the old dual-write. That ledger row
  **is** this line's deduction. These rows still exist, still feed the P&L, and
  are left alone on purpose.
- **`ITEMIZED`** — a decorative breadcrumb. **No total reads it.** Clearing it
  changes no number.

A cascade that looks correct on a LEGACY row destroys a $500 deduction on an
ITEMIZED one. This has cost a deduction twice.

### Deleting a ledger charge

- LEGACY pairs die with the row.
- ITEMIZED breadcrumbs just lose the pointer.
- **Inventory is never reversed.** A ledger row is no longer evidence that
  stock arrived, and several purchases may share one receipt.

### Editing a ledger charge

Never writes through to a job. Correcting a receipt must not change what a
client was billed — and on a many-to-one link it would change the wrong job.

---

## Worked example

Labor $150. 25 bags of mulch billed at $6 (cost $5 each). $50 of edging stone
at cost. One employee, 35% margin.

| Line | Charge | Cost |
|---|---|---|
| Mow & edge | $150 | — |
| Mulch — 25 bags at $6.00 | $150 | $125 |
| Edging stone | $50 | $50 |
| **Invoice total** | **$350** | |

- **Crew pool** = $150 (labor). The employee's gross share is $150.
- **Material margin** = ($150 − $125) + ($50 − $50) = **$25**.
- The client pays $350; the business banks the materials at cost-plus-$25 and
  pays the crew out of the $150 of labor.

Priced under `LEGACY`, the same job invoices **$150** and the pool is
**$0** — which is the defect the itemized model exists to fix.

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

Pulling stock onto a job creates a `SupplyHold` and a paired `InvoiceCharge` at
`quantity × Supply.jobPayoutCost`, with `actualCost` from
`Supply.businessCost`. The charge's **amount and name are derived** — editing
them directly desyncs the two and the next `+`/`−` overwrites whatever was
typed, so the server refuses with a 409. `detail` stays editable.

> `actualCost` was left NULL on every inventory pull until 2026-09-07. This is
> the one case where the cost is known exactly, and job profit was reporting
> "no cost recorded" and showing an upper bound on jobs whose materials came
> off our own shelf. It is now set on creation and **re-derived whenever the
> held quantity changes** — leaving it behind would state the margin on a
> quantity no longer on the job.

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

**Nothing internal leaves.** No `actualCost`, no margin, no supply unit cost.
Under LEGACY, material lines are omitted entirely — showing them would invent a
charge the client never owed.

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
- **Admin** — full add/edit/delete, the ledger-link picker, `actualCost` and
  per-line margin, and the invoice preview.
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

The two structural gates matter most:

- **"only the Ledger writes the Ledger"** walks every source file and fails on
  a ledger write outside `/admin/business-expenses/*`. Reviewing by memory
  finds the sites someone thought of; this finds all of them.
- **"a job line is an invoice charge, never an expense"** walks both apps and
  fails on the retired vocabulary.

Both strip comments before scanning, so this history can stay legible in prose.

**Mutation-test every assertion**: break the thing, watch the gate fail,
revert. A gate nobody has watched fail is a gate you don't have.
