-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "hoursApprovedAt" TIMESTAMP(3),
ADD COLUMN     "hoursApprovedById" TEXT;

-- CreateIndex
CREATE INDEX "JobOccurrence_hoursApprovedAt_idx" ON "JobOccurrence"("hoursApprovedAt");

-- AddForeignKey
ALTER TABLE "JobOccurrence" ADD CONSTRAINT "JobOccurrence_hoursApprovedById_fkey" FOREIGN KEY ("hoursApprovedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
