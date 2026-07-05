-- AlterEnum
ALTER TYPE "JobOccurrenceStatus" ADD VALUE 'STREAM_PAUSED';

-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "streamPauseReason" TEXT,
ADD COLUMN     "streamPausedAt" TIMESTAMP(3),
ADD COLUMN     "streamPausedById" TEXT,
ADD COLUMN     "streamResumeReminderAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobOccurrence_streamResumeReminderAt_idx" ON "JobOccurrence"("streamResumeReminderAt");
