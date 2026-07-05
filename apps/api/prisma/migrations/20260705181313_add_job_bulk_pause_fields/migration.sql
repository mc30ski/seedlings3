-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "clientBulkPausedAt" TIMESTAMP(3),
ADD COLUMN     "clientBulkPausedById" TEXT;

-- CreateIndex
CREATE INDEX "Job_clientBulkPausedAt_idx" ON "Job"("clientBulkPausedAt");
