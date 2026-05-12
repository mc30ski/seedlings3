-- AlterTable
ALTER TABLE "TimelineEvent" ADD COLUMN     "category" TEXT;

-- CreateIndex
CREATE INDEX "TimelineEvent_category_idx" ON "TimelineEvent"("category");
