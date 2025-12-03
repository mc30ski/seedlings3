/*
  Warnings:

  - You are about to drop the column `active` on the `ClientContact` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "public"."ClientContact_clientId_active_idx";

-- AlterTable
ALTER TABLE "ClientContact" DROP COLUMN "active";

-- CreateIndex
CREATE INDEX "ClientContact_clientId_status_idx" ON "ClientContact"("clientId", "status");
