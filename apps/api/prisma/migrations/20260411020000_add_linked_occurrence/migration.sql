-- AlterTable: add linkedOccurrenceId column
ALTER TABLE "JobOccurrence" ADD COLUMN "linkedOccurrenceId" TEXT;

-- AddForeignKey
ALTER TABLE "JobOccurrence" ADD CONSTRAINT "JobOccurrence_linkedOccurrenceId_fkey" FOREIGN KEY ("linkedOccurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
