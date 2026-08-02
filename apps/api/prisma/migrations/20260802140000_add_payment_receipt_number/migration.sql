-- Client-facing receipt identifier on Payment. Nullable at first so
-- existing rows aren't broken; backfilled by the Node script at
-- prisma/backfill-receipt-numbers.ts. A follow-up migration will
-- flip this to NOT NULL once the backfill has run in prod.

ALTER TABLE "Payment" ADD COLUMN "receiptNumber" TEXT;

CREATE UNIQUE INDEX "Payment_receiptNumber_key" ON "Payment"("receiptNumber");
