-- AlterEnum
ALTER TYPE "JobOccurrenceStatus" ADD VALUE 'PAUSED';

-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "totalPausedMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "manualDurationMinutes" INTEGER;
