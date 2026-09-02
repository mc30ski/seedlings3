-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'FORECAST';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'DUPLICATED';
ALTER TYPE "AuditVerb" ADD VALUE 'ASSESSED';

-- CreateTable
CREATE TABLE "Forecast" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "windowFrom" TEXT NOT NULL,
    "windowTo" TEXT NOT NULL,
    "compareFrom" TEXT,
    "compareTo" TEXT,
    "assumptions" JSONB NOT NULL,
    "baselineSnapshot" JSONB,
    "baselineCapturedAt" TIMESTAMP(3),
    "assessment" JSONB,
    "assessedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Forecast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Forecast_createdById_idx" ON "Forecast"("createdById");

-- CreateIndex
CREATE INDEX "Forecast_archivedAt_updatedAt_idx" ON "Forecast"("archivedAt", "updatedAt");

-- AddForeignKey
ALTER TABLE "Forecast" ADD CONSTRAINT "Forecast_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
