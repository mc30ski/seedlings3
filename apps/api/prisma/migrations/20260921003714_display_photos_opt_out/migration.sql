/*
  Warnings:

  - You are about to drop the column `featuredById` on the `JobOccurrencePhoto` table. All the data in the column will be lost.
  - You are about to drop the column `featuredForDisplayAt` on the `JobOccurrencePhoto` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."JobOccurrencePhoto" DROP CONSTRAINT "JobOccurrencePhoto_featuredById_fkey";

-- DropIndex
DROP INDEX "public"."JobOccurrencePhoto_featuredForDisplayAt_idx";

-- AlterTable
ALTER TABLE "JobOccurrencePhoto" DROP COLUMN "featuredById",
DROP COLUMN "featuredForDisplayAt",
ADD COLUMN     "hiddenById" TEXT,
ADD COLUMN     "hiddenFromDisplayAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "JobOccurrencePhoto_hiddenFromDisplayAt_idx" ON "JobOccurrencePhoto"("hiddenFromDisplayAt");

-- AddForeignKey
ALTER TABLE "JobOccurrencePhoto" ADD CONSTRAINT "JobOccurrencePhoto_hiddenById_fkey" FOREIGN KEY ("hiddenById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
