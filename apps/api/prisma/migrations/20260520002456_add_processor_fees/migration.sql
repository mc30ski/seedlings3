-- Processor-fee tracking on Payment + audit verbs for the configurable
-- payment-methods taxonomy. All Payment columns are nullable; historical
-- rows are treated as zero-fee at read time. No backfill needed.

-- 1. AuditVerb additions
ALTER TYPE "AuditVerb" ADD VALUE 'FEE_APPLIED';
ALTER TYPE "AuditVerb" ADD VALUE 'PAYMENT_METHOD_UPDATED';

-- 2. Payment: processor-fee fields. All nullable.
--    processorFeePercent / processorFeeFixed = snapshot of fee config at
--    payment time (so changing the taxonomy later doesn't rewrite history).
--    processorFeeAmount = computed dollar fee.
--    grossCharged       = what the client paid (matches amountPaid by design).
--    netReceived        = grossCharged − processorFeeAmount.
ALTER TABLE "Payment" ADD COLUMN "processorFeePercent" DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "processorFeeFixed"   DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "processorFeeAmount"  DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "grossCharged"        DOUBLE PRECISION;
ALTER TABLE "Payment" ADD COLUMN "netReceived"         DOUBLE PRECISION;

-- Index for the Earnings-vs-Expenses summary that aggregates fees by month.
CREATE INDEX "Payment_processorFeeAmount_createdAt_idx"
  ON "Payment" ("processorFeeAmount", "createdAt");
