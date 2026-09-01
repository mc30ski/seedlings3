---
name: project-mark-baliff-purge
description: "2026-09-01: the test user Mark Baliff was purged from production and all his work/money reassigned to the owner. Explains why the owner has ~94 payment splits and 100+ job assignments."
metadata:
  type: project
---

# Mark Baliff purged from production (2026-09-01)

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
