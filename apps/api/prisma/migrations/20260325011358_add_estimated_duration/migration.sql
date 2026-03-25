-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "estimatedMinutes" INTEGER;

-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "estimatedMinutes" INTEGER,
ADD COLUMN     "startedAt" TIMESTAMP(3);
