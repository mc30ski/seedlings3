-- AlterTable
ALTER TABLE "BusinessExpense" ADD COLUMN     "recurrenceSeriesId" TEXT;

-- CreateIndex
CREATE INDEX "BusinessExpense_recurrenceSeriesId_idx" ON "BusinessExpense"("recurrenceSeriesId");
