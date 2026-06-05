-- AlterTable
ALTER TABLE "PaymentSplit" ADD COLUMN     "advancePaidAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "makeWholeStartedAt" TIMESTAMP(3),
ADD COLUMN     "makeWholeUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PaymentSplit_advancePaidAt_idx" ON "PaymentSplit"("advancePaidAt");
