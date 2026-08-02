-- Backfill Payment.receiptNumber for every row and lock the column to
-- NOT NULL. Runs atomically in a transaction — either every row gets
-- a value AND the constraint tightens, or nothing changes.
--
-- Derivation matches the pre-migration receipts/statements rule
-- ("SL-" + last 8 chars of occurrenceId, uppercased) so any receipt
-- PDF a client has ever downloaded continues to resolve after this
-- migration ships.
--
-- Collision handling: on the astronomically-unlikely case that two
-- occurrences share the same last-8 tail, ROW_NUMBER partitioned by
-- the tail gives the first occurrence the bare number and subsequent
-- ones a "-2", "-3", ... suffix. Suffixed values still uphold the
-- unique index and remain resolvable via the same search flow.
--
-- Idempotent within its own transaction: only touches rows where
-- receiptNumber IS NULL, so re-running the migration (which shouldn't
-- happen, but just in case) is a no-op.

WITH numbered AS (
  SELECT
    id,
    'SL-' || UPPER(RIGHT("occurrenceId", 8)) AS base_num,
    ROW_NUMBER() OVER (
      PARTITION BY UPPER(RIGHT("occurrenceId", 8))
      ORDER BY id
    ) AS rn
  FROM "Payment"
  WHERE "receiptNumber" IS NULL
)
UPDATE "Payment" p
SET "receiptNumber" = CASE
  WHEN n.rn = 1 THEN n.base_num
  ELSE n.base_num || '-' || n.rn
END
FROM numbered n
WHERE p.id = n.id;

ALTER TABLE "Payment" ALTER COLUMN "receiptNumber" SET NOT NULL;
