/*
  Warnings:

  - You are about to drop the column `hiddenFromDisplayAt` on the `JobOccurrencePhoto` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "public"."JobOccurrencePhoto_hiddenFromDisplayAt_idx";

-- AlterTable
ALTER TABLE "JobOccurrencePhoto" DROP COLUMN "hiddenFromDisplayAt",
ADD COLUMN     "hiddenFromPublicAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobOccurrencePhoto_hiddenFromPublicAt_idx" ON "JobOccurrencePhoto"("hiddenFromPublicAt");
