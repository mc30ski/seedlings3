---
name: project-mark-baliff-purge
description: "2026-09-01: the test users Mark Baliff and Matthew Wanderski were purged from production, their work/money reassigned to the owner. Explains why the owner has ~96 payment splits and 177 job assignments."
metadata:
  type: project
---

# Test users purged from production (2026-09-01)

Two accounts, same night, same approach: **Mark Baliff** (748 rows) and
**Matthew Wanderski** (16 rows).

## Mark Baliff

"Mark Baliff" (`cmgih3yce0000kz04ip0rib2g`) was a second login the owner
used, not a real worker — `$0` wage, never in Gusto, no W-2 or 1099. But
he carried real activity: 53 job assignments across 23 real clients, 47
payment splits, $520 collected, 132 photos, 14 checkouts.

**748 rows changed** via `apps/api/scripts/purge-mark-baliff.ts` (kept as
the record of exactly what moved). Work and money were **reassigned to the
owner** with `ownerEarnings: true`, never deleted — the splits sit on
$3,740 of real client revenue, so deleting them would have erased real
income and broken payment conservation.

So if the owner's ~94 splits or his job count ever look surprising: about
half of them came from here. Revenue was unchanged ($29,689 total).

## Things that were NOT obvious

- **`promisedPayouts` / `completionSplits` embed userIds in JSON.** A
  `UPDATE PaymentSplit SET userId` does not reach them, and stale entries
  make the payment card fall back to the wrong money basis. 25 occurrences
  needed rewriting. See [[feedback-money-card-two-bases]].
- **Observer promotion.** On 3 of 5 shared jobs the owner was only an
  `observer`. Deleting the duplicate row without promoting him to worker
  would have left an observer holding a payout — a state the
  observer-filter gate says cannot exist.
- **Bulk-op ordering.** The first production attempt aborted on a
  blast-radius guard: an `updateMany` on `assignedById` touched 45 rows,
  not 47, because 2 of those rows were deleted by an earlier statement in
  the same transaction. Pre-computed row counts can drift once statements
  interact.
- **Clerk was not actually deleted** by the script — see
  [[reference-local-env-is-test-clerk]].

## What was deliberately left

132 `JobOccurrencePhoto.r2Key` paths still contain his user id. They are
internal storage paths, never rendered or exported; renaming means a
copy+delete per object for no visible benefit.

## Matthew Wanderski

A CONTRACTOR who **never signed in**, created the same day as Mark. Only 16
rows: 2 assignments, 2 splits ($40 + $0), 1 crew membership, 1 push
subscription, 1 role, 8 audit-metadata hits. His $40 went to the owner as
owner earnings.

Two hazards Mark's case did not have:

- **The surname is shared.** Mark's purge could safely replace the bare
  string "Baliff". "Wanderski" belongs to the owner, Jacob, David and
  Family — Jacob and David are real paid workers. Only the FULL name, id,
  email and Clerk id are safe to match. The bare first name is unsafe too:
  "Matthew Wolfe" is a different real user.
- **The owner was not on either job** (`Jacob + Matthew`, `Jacob + Matthew
  + Justin`), so reassignment ADDED him as an assignee to two jobs he did
  not work. Accepted deliberately — the app is not the source of record.
  Reassigning to Jacob was rejected: he is a real W-2 employee in Gusto and
  it would have made the app diverge from payroll for a real person.

`scripts/purge-matthew-wanderski.ts` added a **protected-user fingerprint**
(split count + total + assignees + workdays + crews for Jacob and David,
compared before and after inside the transaction) so "must not be changed"
is a hard stop rather than a convention.

## Open afterwards

**David Wanderski** is an EMPLOYEE with $1,176.25 of recorded wages, 10
workdays, and **zero Gusto entries or PayrollIdentity** — the only person
with W-2 wages and no payroll behind them ($538.25 of it post-cutoff).
Either his payroll was never imported, or he should be owner-earnings /
contractor. Deferred by the user 2026-09-01.
