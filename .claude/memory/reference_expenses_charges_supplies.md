---
name: reference-expenses-charges-supplies
description: The two-books model — the Ledger is the only deduction; job charges and supplies never write to it.
metadata:
  type: reference
---

**Two books, and they never write to each other.** Canonical spec:
`docs/features/job-materials.md`, bound to
`apps/api/src/services/job-materials-build-gate.test.ts`.

| | **Ledger** (`BusinessExpense`) | **Job line** (`InvoiceCharge`) |
|---|---|---|
| What | real money off a card statement | what the CLIENT is billed |
| Tax | **is** the Schedule C deduction | **none, ever** |
| Written by | `/admin/business-expenses/*`, Super only | the job surfaces, admin only |
| Reconciled with | Gusto / QuickBooks — the source of truth | nothing |

They reconcile **in aggregate only**. One $500 Lowe's receipt is one ledger
row; the mulch off it lands on four jobs. Never row-to-row.

**Nothing on a job may write a `BusinessExpense`** — not adding/editing/
deleting a charge, not recording a supply purchase, not pulling stock, not a
status change re-dating a linked row. A build gate walks every source file.

**Supplies are a pseudo-inventory layer ABOVE the Ledger**, deliberately
approximate and the operator's own to keep accurate. Recording a purchase adds
units and creates no tax entry. A supply has **no Schedule C category** — it
produces no deduction, so there is nothing to file.

**The ledger link is an optional, MANY-TO-ONE breadcrumb** on both
`InvoiceCharge.businessExpenseId` and `SupplyPurchase.businessExpenseId`.
**No total reads it.** Clearing it changes no number. `onDelete: SetNull` —
never cascade; a cascade here has destroyed a real deduction twice. Deleting a
ledger row unlinks job lines and purchases, never deletes them, and never
reverses stock.

**What the stock COST is derived, never stored.** Add Supply establishes what
a supply IS (no quantity, no cost); **Buy** records each purchase's price and
date; **Adjust** corrects the count with no price. The catalog's **Average
price** is the weighted average over FIFO cost layers replayed from those
events — consumption draws the oldest layer first, so a price you have stopped
paying leaves the figure as that stock is used. Engine:
`apps/api/src/lib/supplyCost.ts`. `Supply.businessCost` was dropped
(`20260908210000`) because every purchase silently overwrote it. Do not
reintroduce a stored cost: replaying is what makes reverting a payment and
correcting a back-dated receipt come out right by themselves.

**What a client pays is decided when the supply goes on the job**, not in the
catalog — the same mulch can be $5 to one client and $9 to another;
`Supply.clientUnitPrice` (renamed from the lying `jobPayoutCost`) is only a
default. An inventory-backed line is an **ordinary invoice line**: name, detail
and amount all editable, nothing locked. **It records no cost** — what we paid
is the Ledger's business.

**ONE pricing model.** `crewPool = labor + services`;
`invoiceTotal = crewPool + material charges`. The `LEGACY | ITEMIZED` enum was
deleted and the data rewritten (`price = base − charges`); never reintroduce an
era flag. **Materials never come out of anyone's pay.**

Related: [[reference-financial-system-doc]], [[project-payment-math]],
[[project-tax-export-integrity]], [[feature-per-job-equipment-billing]].
