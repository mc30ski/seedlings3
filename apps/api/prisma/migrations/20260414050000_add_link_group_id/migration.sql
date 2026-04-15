-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN "linkGroupId" TEXT;

-- CreateIndex
CREATE INDEX "JobOccurrence_linkGroupId_idx" ON "JobOccurrence"("linkGroupId");
