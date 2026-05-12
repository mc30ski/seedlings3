-- AlterTable
ALTER TABLE "TimelineEvent" ADD COLUMN     "lastCompletedAt" TIMESTAMP(3),
ADD COLUMN     "nextDueDate" TIMESTAMP(3);

-- Backfill: every existing row starts active at its anchor date. New rows
-- set this at create-time in the service; only pre-existing rows need this.
UPDATE "TimelineEvent" SET "nextDueDate" = "anchorDate" WHERE "nextDueDate" IS NULL;

-- CreateIndex
CREATE INDEX "TimelineEvent_nextDueDate_idx" ON "TimelineEvent"("nextDueDate");
