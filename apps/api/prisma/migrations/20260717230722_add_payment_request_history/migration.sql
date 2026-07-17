-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "paymentRequestFirstSentAt" TIMESTAMP(3),
ADD COLUMN     "paymentRequestResendCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill: for every row that already has a paymentRequestSentAt,
-- seed paymentRequestFirstSentAt to the same value. We can't recover
-- how many re-sends actually happened historically, so paymentRequestResendCount
-- stays at 0 for pre-existing rows — the counter starts fresh from
-- the first re-send after this migration ships.
UPDATE "JobOccurrence"
SET "paymentRequestFirstSentAt" = "paymentRequestSentAt"
WHERE "paymentRequestSentAt" IS NOT NULL
  AND "paymentRequestFirstSentAt" IS NULL;
