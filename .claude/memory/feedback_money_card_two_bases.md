---
name: feedback-money-card-two-bases
description: "A PaymentSplit carries TWO money bases (actual-collected vs promised-invoice). Rendering the wrong one produced equations that didn't match the payout. Any money card must reconcile to its own stated total."
metadata:
  type: feedback
---

# A split has two bases — render the one that produced `amount`

`PaymentSplit.grossAmount` / `feeAmount` are the **actual** breakdown
`reconcileApproval` computes on **everything the client handed over**,
tip included. `PaymentSplit.amount` is what the worker is **paid** —
for an employee, their share of the **invoice** (`promisedPayouts`),
because employees don't share in an overpayment.

**On an overpaid job these diverge.** `gross − fee ≠ amount`.

Shipped bug (2026-08-31, prod): the payment card rendered the actual
basis — `$63.00 share − $22.05 margin (35%) + $10.50 tip = $51.45` — on
a real payout of `$34.12 + $10.50 = $44.62`, contradicting its own
`$89.24` headline. The job card was worse: its payout block rendered
only `sp.amount` + margin under a header reading "Paid: $126.00" and
simply omitted the $21 tip.

**Why:** rendering whichever columns were handy instead of the basis
that actually resolves to the payout.

**How to apply:**
- Pick the basis that produces `amount` (use `promisedPayouts` when
  `amount ≈ promised.net`, else the split's own gross/fee). Carry an
  explicit `total` field; never recompute the total from
  `share − deduction`.
- `topUpAmount` is a BUSINESS-side note, not an addend in the worker's
  equation — adding it double-counted on write-offs.
- Every money card must account for **all** of `amountPaid`: job pay +
  tips + business (commission, margin, tip-to-business, overage,
  expenses). Show a visible remainder rather than hiding it.

## The seed hid this for months

Dev fixtures wrote **agreeing** columns on every payment
(`amount == netAmount == gross − fee`), so **no dev row could reproduce
the divergence** and the tips e2e suite stayed green while production
was wrong. `prisma/seed.ts` now has a post-pass (after the expense
reconciler, which would otherwise undo it) that stamps the production
two-basis shape on every overpaid fixture. See
[[feedback-seed-must-match-production-math]] and
[[project-tips-feature-design]].

## The test that catches it

`apps/web/tests/e2e/specs/money-card-math-admin.spec.ts` asserts **no
dollar figures at all** — it reads what the cards render and checks the
equations close against each other. Every prior spec compared a value
to the DATABASE, which is why none of them could see a rendering bug.
Verified by reverting each fix and confirming failure.

Gotchas for that spec: scope per `data-testid="payment-card"` (slicing
page text mixes cards, because a card with no headline doesn't reset the
slice); the JobsTab status filter honours **one** status (passing three
renders only the first); the payout block exists **only** at
`density: "expanded"`; and both money fixtures are `CLOSED`.
