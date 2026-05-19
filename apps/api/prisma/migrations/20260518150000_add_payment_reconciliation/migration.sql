-- Adds payment reconciliation fields: per-worker breakdown on PaymentSplit,
-- promised-payout snapshot on JobOccurrence, and shortfall/overage/adjustment/
-- write-off tracking on Payment.
-- All additions are nullable or have defaults; no backfill needed.

-- JobOccurrence: promised-payout snapshot taken at completion
ALTER TABLE "JobOccurrence" ADD COLUMN "promisedPayouts" JSONB;

-- Payment: reconciliation, admin adjustment, write-off
ALTER TABLE "Payment" ADD COLUMN "shortfallAmount"    DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "overageAmount"      DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "adjustedAt"         TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "adjustedById"       TEXT;
ALTER TABLE "Payment" ADD COLUMN "adjustedFromAmount" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "writtenOff"         BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "writtenOffAt"       TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "writtenOffById"     TEXT;
ALTER TABLE "Payment" ADD COLUMN "writeOffReason"     TEXT;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_adjustedById_fkey"
  FOREIGN KEY ("adjustedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_writtenOffById_fkey"
  FOREIGN KEY ("writtenOffById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Payment_writtenOff_createdAt_idx"
  ON "Payment" ("writtenOff", "createdAt");

-- PaymentSplit: per-worker fee/margin breakdown
ALTER TABLE "PaymentSplit" ADD COLUMN "grossAmount" DOUBLE PRECISION;
ALTER TABLE "PaymentSplit" ADD COLUMN "ratePercent" DOUBLE PRECISION;
ALTER TABLE "PaymentSplit" ADD COLUMN "feeAmount"   DOUBLE PRECISION;
ALTER TABLE "PaymentSplit" ADD COLUMN "netAmount"   DOUBLE PRECISION;
ALTER TABLE "PaymentSplit" ADD COLUMN "topUpAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;
