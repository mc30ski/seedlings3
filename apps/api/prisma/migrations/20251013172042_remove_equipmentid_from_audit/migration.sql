/*
  Warnings:

  - You are about to drop the column `equipmentId` on the `AuditEvent` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."AuditEvent" DROP CONSTRAINT "AuditEvent_equipmentId_fkey";

-- DropIndex
DROP INDEX "public"."AuditEvent_equipmentId_createdAt_idx";

-- AlterTable
ALTER TABLE "public"."AuditEvent" DROP COLUMN "equipmentId";
