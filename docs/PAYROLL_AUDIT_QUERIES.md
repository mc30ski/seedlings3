# Payroll audit queries

Self-contained SQL you can paste into the Neon SQL Editor to verify the
Reconcile → Payroll surface against the underlying data, without having
to trust the application code.

Use these when:

- You suspect a worker's earnings on the Payroll CSV are wrong.
- You want to cross-check a past pay period after a bug fix (e.g. the
  NULL-role filter fix) to decide whether to re-issue payroll.
- You want to verify the assignee → payment-split chain for any window.

All queries are READ-ONLY. They never mutate data.

---

## Setting the window

Every query below is parameterized on `:from` and `:to` — ET-anchored
calendar dates. Neon's editor does not support `:param` substitution
the way some tools do, so set the window inline at the top of each
block. Example for the week of Mon Jun 15 to Sun Jun 21 2026 ET:

```
-- ET-anchored UTC bounds (ET = UTC-4 in EDT, UTC-5 in EST)
-- Summer (EDT): use 04:00 UTC
-- Winter (EST): use 05:00 UTC
WHERE o."completedAt" >= '2026-06-15 04:00:00+00'
  AND o."completedAt" <= '2026-06-22 03:59:59+00'
```

---

## 1. Worker × period totals (the canonical audit)

For each user who was either an assignee on a completed job OR has a
workday in the window, show:

- `workday_hours`     — active workday hours (started + ended rows)
- `jobs_assigned`     — # of completed JobOccurrences they were on
- `payment_splits_$`  — sum of their PaymentSplit.amount
- `owner_earnings_$`  — sum of their PaymentSplit.amount where ownerEarnings = true

Compare these to the Payroll CSV's Total Gross for the same window.
Discrepancies = bug or data quirk.

```sql
WITH window_assignees AS (
  -- Every non-observer (or NULL-role) assignee on a completed job in window.
  -- This is the canonical "did this person work a payable job" set.
  SELECT
    a."userId",
    a."occurrenceId",
    a.role,
    o.price,
    o."completedAt"
  FROM "JobOccurrenceAssignee" a
  JOIN "JobOccurrence" o ON o.id = a."occurrenceId"
  WHERE o."completedAt" >= '2026-06-15 04:00:00+00'
    AND o."completedAt" <= '2026-06-22 03:59:59+00'
    AND o.workflow IN ('STANDARD', 'ONE_OFF', 'ESTIMATE')
    AND (a.role IS NULL OR a.role != 'observer')
),
window_workdays AS (
  -- Workday hours per user. Only "ended" rows contribute to active
  -- hours; in-progress / paused rows aren't payable.
  SELECT
    w."userId",
    SUM(
      EXTRACT(EPOCH FROM (w."endedAt" - w."startedAt"))
      - COALESCE(w."totalPausedMs", 0) / 1000.0
    ) / 3600.0 AS hours
  FROM "WorkerWorkday" w
  WHERE w."workdayDate" >= '2026-06-15'
    AND w."workdayDate" <= '2026-06-21'
    AND w."endedAt" IS NOT NULL
  GROUP BY w."userId"
),
window_splits AS (
  -- PaymentSplit dollars per user on payments confirmed (any state)
  -- whose parent occurrence completed in window. Split into personal
  -- pay vs owner-earnings columns.
  SELECT
    ps."userId",
    SUM(CASE WHEN ps."ownerEarnings" THEN 0 ELSE ps.amount END) AS personal_amount,
    SUM(CASE WHEN ps."ownerEarnings" THEN ps.amount ELSE 0 END) AS owner_amount
  FROM "PaymentSplit" ps
  JOIN "Payment" p ON p.id = ps."paymentId"
  JOIN "JobOccurrence" o ON o.id = p."occurrenceId"
  WHERE o."completedAt" >= '2026-06-15 04:00:00+00'
    AND o."completedAt" <= '2026-06-22 03:59:59+00'
    AND p."writtenOff" = false
  GROUP BY ps."userId"
)
SELECT
  COALESCE(u."displayName", u.email, u.id) AS worker,
  u."workerType",
  u."isOwner",
  ROUND(COALESCE(wd.hours, 0)::numeric, 2)                       AS workday_hours,
  COUNT(DISTINCT wa."occurrenceId")                              AS jobs_assigned,
  ROUND(COALESCE(ws.personal_amount, 0)::numeric, 2)             AS payment_splits_dollars,
  ROUND(COALESCE(ws.owner_amount, 0)::numeric, 2)                AS owner_earnings_dollars
FROM "User" u
LEFT JOIN window_workdays  wd ON wd."userId" = u.id
LEFT JOIN window_assignees wa ON wa."userId" = u.id
LEFT JOIN window_splits    ws ON ws."userId" = u.id
WHERE wd."userId" IS NOT NULL
   OR wa."userId" IS NOT NULL
   OR ws."userId" IS NOT NULL
GROUP BY u.id, u."displayName", u.email, u."workerType", u."isOwner",
         wd.hours, ws.personal_amount, ws.owner_amount
ORDER BY worker;
```

What "Total Gross" on the Payroll CSV should equal:

- **For a non-owner worker**: roughly `payment_splits_dollars` (gross
  share minus business margin/contractor fee plus top-ups). Exact match
  isn't expected because the Payroll calc may use the promisedPayouts
  snapshot when present; this column shows what was actually persisted
  on PaymentSplit rows.
- **For the LLC owner**: `payment_splits_dollars + owner_earnings_dollars`.
  Owner earnings are tracked separately so they don't pollute personal
  wage totals elsewhere, but the Payroll surface adds them back for the
  owner row.

If you see a worker with `jobs_assigned > 0` but `$0.00` for both
`payment_splits_dollars` and (where applicable) the Payroll CSV,
that's a red flag — drop down to query #2 to inspect the specific
occurrence.

---

## 2. Per-occurrence breakdown for one user

When query #1 surfaces a discrepancy, run this to see every job that
worker was on and what each data source says they earned for it.

Replace `'<USER_ID>'` with the worker's id from query #1.

```sql
SELECT
  o.id                       AS occurrence_id,
  o.title,
  o."completedAt",
  o.price,
  o."completionSplits",      -- JSON. Look for this user's percent.
  o."promisedPayouts",       -- JSON snapshot. Look for net/gross for this user.
  a.role                     AS assignee_role,
  ps.amount                  AS split_amount,
  ps."grossAmount"           AS split_gross,
  ps."feeAmount"             AS split_fee,
  ps."topUpAmount"           AS split_top_up,
  ps."ownerEarnings"         AS split_owner_earnings,
  p.confirmed                AS payment_confirmed,
  p."writtenOff"             AS payment_written_off,
  p."amountPaid"             AS payment_amount_paid
FROM "JobOccurrenceAssignee" a
JOIN "JobOccurrence" o ON o.id = a."occurrenceId"
LEFT JOIN "Payment" p      ON p."occurrenceId" = o.id
LEFT JOIN "PaymentSplit" ps ON ps."paymentId"   = p.id AND ps."userId" = a."userId"
WHERE a."userId" = '<USER_ID>'
  AND o."completedAt" >= '2026-06-15 04:00:00+00'
  AND o."completedAt" <= '2026-06-22 03:59:59+00'
ORDER BY o."completedAt";
```

How to read the output:

- `assignee_role IS NULL` is normal — it means "regular worker, no
  special role set." Anything other than `'observer'` is payable.
- If `split_amount IS NULL` and `payment_confirmed = true`, the worker
  is on the job but has no PaymentSplit row. That's a real bug — open
  the payment in the app and check whether the split was created.
- The system computes the worker's share with this precedence:
  1. `promisedPayouts` snapshot per-userId (gross/fee/net).
  2. `computeBreakdown` fallback from `price`, `expenses`, and the
     `completionSplits` percentages.
  3. `PaymentSplit.gross / fee / topUp` as the final fallback.
- Manually compute the expected gross to cross-check:
  `gross = (price − sum_of_expenses) × (userPercent / sum_of_percents)`

---

## 3. Find all assignees with NULL role on completed jobs

If query #1 surprises you with workers you didn't expect (or doesn't
show workers you DO expect), this surfaces every assignee whose role is
unset. Before the NULL-role filter fix, all of these were silently
dropped from the Payroll surface.

```sql
SELECT
  o."completedAt"::date AS completed_date,
  o.title,
  u."displayName" AS worker,
  a.role
FROM "JobOccurrenceAssignee" a
JOIN "JobOccurrence" o ON o.id = a."occurrenceId"
JOIN "User" u ON u.id = a."userId"
WHERE o."completedAt" >= '2026-06-15 04:00:00+00'
  AND o."completedAt" <= '2026-06-22 03:59:59+00'
  AND o.workflow IN ('STANDARD', 'ONE_OFF', 'ESTIMATE')
ORDER BY completed_date, worker;
```

If past payroll runs were generated with the buggy filter and any rows
here have `role IS NULL`, that worker was underpaid for that period
and may need a retroactive adjustment.

---

## How to expand this audit

If you ever spot a new class of discrepancy, add the query here so the
next investigation is one paste away. Keep this doc as the canonical
audit toolkit — better than re-deriving queries from the schema every
time.
