---
name: feedback-audit-every-mutation
description: "TABLE STAKES — every state-changing mutation must write an AuditEvent. Check audit coverage as part of building ANY feature, not as a follow-up. Whole features shipped unaudited for months because nothing failed when they didn't."
metadata:
  node_type: memory
  type: feedback
---

**Every mutation that changes user-meaningful state MUST write an audit
row.** This is not a nice-to-have or a later pass — it is part of what
"the feature is done" means, in the same way a ConfirmDialog is.

Ask it for every single feature, unprompted: *what does this change, and
where does that show up in History?*

**Why:** On 2026-08-22 a system-wide sweep found **158 unaudited
mutations**, 46 of them HIGH severity. Not stragglers — five entire
services had **zero** audit coverage since the day they shipped:
`expenses.ts`, `mileage.ts`, `supplies.ts`, `groups.ts` (Crews), and
`vehicles.ts`. The `AuditScope` enum had no `EXPENSE`, `SUPPLY`,
`MILEAGE`, `GROUP`, or `VEHICLE` value at all, which is the mechanical
proof nobody reached for the audit system while building them.

The worst finds, all live in production for months:

- **An ordinary cash payment wrote no audit row.** `createPayment` only
  audited when a split was owner earnings or a processor fee applied —
  and cash has no fee. The single most routine money event in the
  business was the least traceable.
- **`deletePayment` had no audit anywhere**, while hard-deleting the
  payment, cascading its splits, and destroying an auto-generated next
  occurrence with its assignees and comments.
- **Reverting an occurrence destroyed `Payment` + `PaymentSplit` rows**
  at two sites, logged only as `JOB.OCCURRENCE_UPDATED` with
  `{occurrenceId, record}` — amount, method, and who was owed what all
  gone.
- **`ADMIN_BOOTSTRAP_EMAILS` granted ADMIN silently** — the one
  privilege-escalation path in the codebase, unaudited, while the normal
  approve/addRole paths both logged.
- **Crews silently rewrote money math**: removing a member reset *every
  remaining member's* `equipmentCostPercent` to an even split, invisibly.

The user's reaction was unambiguous: *"it's not ok to miss this,
auditing should be an aspect that is always considered for any feature.
This is table stakes."*

**How to apply:**

1. When building ANY feature that writes to the database, add the
   `writeAudit` call in the same edit as the mutation. Not after. Not in
   a follow-up pass.
2. When reviewing or touching an existing mutation, check whether it
   audits. If it doesn't, say so.
3. A mutation that DESTROYS data must snapshot what it destroyed into
   the audit metadata BEFORE the delete. After the row is gone the audit
   entry is the only surviving evidence.
4. Money fields get BEFORE and AFTER values, never just the new one.
5. Idempotent paths that run on every request (auto-provision, bootstrap,
   sync) must audit only real transitions — read-then-write rather than
   blind upsert — or they bury the History tab under a row per request.
6. Legitimately exempt: counters (`viewCount`/`clickCount`), read-through
   caches, sync/queue bookkeeping, denormalized recomputation that
   accompanies an already-audited action, and writes inside a function
   whose caller already audits the same logical action. Say WHY when you
   skip one.

**Mechanics** — see [[reference-audit-system]] for the convention, where
constants live, and the fact that scopes/verbs are Prisma enums needing a
migration.

Related: [[feedback-run-build-gate-after-changes]] (the enforcement
pattern this repo uses for exactly this class of "shipped N times"
problem), [[feedback-confirm-dialogs]] (the other non-negotiable that
attaches to every mutation).
