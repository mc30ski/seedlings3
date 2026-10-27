-- The area tree: structural only.
--
-- Split from the root-area creation and backfill (the next migration) for a
-- Postgres reason: `ALTER TYPE ... ADD VALUE` makes the new enum value
-- visible only AFTER the transaction commits, so an AuditEvent written with
-- scope 'AREA' in this same migration would fail. The data migration that
-- follows creates the root, backfills every row, and audits it — which
-- decision 36 requires to be one unit, and it is.
--
-- `onDelete: Restrict` on every area foreign key, never SetNull: a null
-- areaId silently de-attributes revenue, which is the assignedById incident.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.
ALTER TYPE "AuditScope" ADD VALUE 'AREA';
ALTER TYPE "AuditScope" ADD VALUE 'AREA_ASSIGNMENT';
-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "defaultAreaId" TEXT;
-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "areaId" TEXT;
-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "areaId" TEXT;
-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT,
    "parentId" TEXT,
    "path" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "AreaMembership" (
    "userId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    CONSTRAINT "AreaMembership_pkey" PRIMARY KEY ("userId","areaId")
);
-- CreateTable
CREATE TABLE "AreaAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "customRoleId" TEXT NOT NULL,
    "isTemporary" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,
    CONSTRAINT "AreaAssignment_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "Area_path_idx" ON "Area"("path");
-- CreateIndex
CREATE INDEX "Area_parentId_idx" ON "Area"("parentId");
-- CreateIndex
CREATE INDEX "Area_retiredAt_idx" ON "Area"("retiredAt");
-- CreateIndex
CREATE INDEX "AreaMembership_areaId_idx" ON "AreaMembership"("areaId");
-- CreateIndex
CREATE INDEX "AreaAssignment_userId_idx" ON "AreaAssignment"("userId");
-- CreateIndex
CREATE INDEX "AreaAssignment_areaId_idx" ON "AreaAssignment"("areaId");
-- CreateIndex
CREATE UNIQUE INDEX "AreaAssignment_userId_areaId_customRoleId_key" ON "AreaAssignment"("userId", "areaId", "customRoleId");
-- CreateIndex
CREATE INDEX "Job_defaultAreaId_idx" ON "Job"("defaultAreaId");
-- CreateIndex
CREATE INDEX "JobOccurrence_areaId_idx" ON "JobOccurrence"("areaId");
-- CreateIndex
CREATE INDEX "Property_areaId_idx" ON "Property"("areaId");
-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_defaultAreaId_fkey" FOREIGN KEY ("defaultAreaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "JobOccurrence" ADD CONSTRAINT "JobOccurrence_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "Area" ADD CONSTRAINT "Area_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AreaMembership" ADD CONSTRAINT "AreaMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AreaMembership" ADD CONSTRAINT "AreaMembership_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AreaAssignment" ADD CONSTRAINT "AreaAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AreaAssignment" ADD CONSTRAINT "AreaAssignment_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AreaAssignment" ADD CONSTRAINT "AreaAssignment_customRoleId_fkey" FOREIGN KEY ("customRoleId") REFERENCES "CustomRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "AreaAssignment" ADD CONSTRAINT "AreaAssignment_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
