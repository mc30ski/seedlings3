-- End-series flag on recurring BusinessExpense rows. Set on the LATEST
-- row in a recurrenceSeriesId group when the operator clicks "End
-- series" in the Due-to-record panel. Historical rows keep their data
-- — this is purely a "stop suggesting new occurrences" signal.
--
-- No backfill — every existing series stays null (active), matching
-- current behavior.

ALTER TABLE "BusinessExpense"
  ADD COLUMN "recurrenceEndedAt" TIMESTAMP(3),
  ADD COLUMN "recurrenceEndedById" TEXT;

ALTER TABLE "BusinessExpense"
  ADD CONSTRAINT "BusinessExpense_recurrenceEndedById_fkey"
  FOREIGN KEY ("recurrenceEndedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
