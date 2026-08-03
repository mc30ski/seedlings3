-- Manual QuickBooks reconciliation flag on BusinessExpense. Null =
-- unreconciled (default for every row, existing and new). Set when
-- the operator has verified this ledger row matches the corresponding
-- QuickBooks entry.
--
-- Historical rows intentionally stay null — the operator will sweep
-- through them over time. No backfill.

ALTER TABLE "BusinessExpense"
  ADD COLUMN "reconciledAt" TIMESTAMP(3),
  ADD COLUMN "reconciledById" TEXT;

ALTER TABLE "BusinessExpense"
  ADD CONSTRAINT "BusinessExpense_reconciledById_fkey"
  FOREIGN KEY ("reconciledById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "BusinessExpense_reconciledAt_idx" ON "BusinessExpense"("reconciledAt");
