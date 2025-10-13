/*
  Warnings:

  - The `action` column on the `AuditEvent` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Added the required column `scope` to the `AuditEvent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `verb` to the `AuditEvent` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."AuditScope" AS ENUM ('USER', 'EQUIPMENT', 'CLIENT', 'JOB');

-- CreateEnum
CREATE TYPE "public"."AuditVerb" AS ENUM ('APPROVED', 'ROLE_ASSIGNED', 'CREATED', 'UPDATED', 'RETIRED', 'DELETED', 'CHECKED_OUT', 'RELEASED', 'MAINTENANCE_START', 'MAINTENANCE_END', 'RESERVED', 'RESERVATION_CANCELLED', 'RETURNED', 'FORCE_RELEASED');

-- AlterTable
ALTER TABLE "public"."AuditEvent" ADD COLUMN     "scope" "public"."AuditScope" NOT NULL,
ADD COLUMN     "verb" "public"."AuditVerb" NOT NULL,
DROP COLUMN "action",
ADD COLUMN     "action" VARCHAR(64);

-- DropEnum
DROP TYPE "public"."AuditAction";

-- CreateIndex
CREATE INDEX "AuditEvent_scope_createdAt_idx" ON "public"."AuditEvent"("scope", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_verb_createdAt_idx" ON "public"."AuditEvent"("verb", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_scope_verb_createdAt_idx" ON "public"."AuditEvent"("scope", "verb", "createdAt");
