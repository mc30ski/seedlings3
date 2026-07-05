-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'SKIPPED';
ALTER TYPE "AuditVerb" ADD VALUE 'UNSKIPPED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "skipReason" TEXT,
ADD COLUMN     "skippedAt" TIMESTAMP(3),
ADD COLUMN     "skippedById" TEXT;

-- CreateIndex
CREATE INDEX "Payment_skippedAt_createdAt_idx" ON "Payment"("skippedAt", "createdAt");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_skippedById_fkey" FOREIGN KEY ("skippedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
