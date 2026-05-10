-- "Skip" support for the Due to record panel — when the user skips a
-- particular instance, store that expected date here so the next-expected
-- computation advances by one cadence period.

ALTER TABLE "BusinessExpense" ADD COLUMN "recurrenceSkippedUntil" TIMESTAMP(3);
