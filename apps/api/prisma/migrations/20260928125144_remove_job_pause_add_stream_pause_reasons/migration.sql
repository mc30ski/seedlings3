-- AlterEnum
BEGIN;
CREATE TYPE "JobStatus_new" AS ENUM ('PROPOSED', 'ACCEPTED', 'ARCHIVED');
ALTER TABLE "public"."Job" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Job" ALTER COLUMN "status" TYPE "JobStatus_new" USING ("status"::text::"JobStatus_new");
ALTER TYPE "JobStatus" RENAME TO "JobStatus_old";
ALTER TYPE "JobStatus_new" RENAME TO "JobStatus";
DROP TYPE "public"."JobStatus_old";
ALTER TABLE "Job" ALTER COLUMN "status" SET DEFAULT 'PROPOSED';
COMMIT;

-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "streamPauseReasonCode" TEXT;

-- CreateTable
CREATE TABLE "JobOccurrencePauseEvent" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "reasonLabel" TEXT NOT NULL,
    "note" TEXT,
    "pausedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedById" TEXT,
    "reminderAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "resumedById" TEXT,
    "resumedOntoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobOccurrencePauseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobOccurrencePauseEvent_occurrenceId_pausedAt_idx" ON "JobOccurrencePauseEvent"("occurrenceId", "pausedAt");

-- CreateIndex
CREATE INDEX "JobOccurrencePauseEvent_reasonCode_pausedAt_idx" ON "JobOccurrencePauseEvent"("reasonCode", "pausedAt");

-- CreateIndex
CREATE INDEX "JobOccurrencePauseEvent_resumedAt_idx" ON "JobOccurrencePauseEvent"("resumedAt");

-- AddForeignKey
ALTER TABLE "JobOccurrencePauseEvent" ADD CONSTRAINT "JobOccurrencePauseEvent_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrencePauseEvent" ADD CONSTRAINT "JobOccurrencePauseEvent_pausedById_fkey" FOREIGN KEY ("pausedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrencePauseEvent" ADD CONSTRAINT "JobOccurrencePauseEvent_resumedById_fkey" FOREIGN KEY ("resumedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

