-- CreateEnum
CREATE TYPE "OccurrenceWorkflow" AS ENUM ('STANDARD', 'ONE_OFF', 'ESTIMATE');

-- AlterEnum
ALTER TYPE "JobOccurrenceStatus" ADD VALUE 'PROPOSAL_SUBMITTED';
ALTER TYPE "JobOccurrenceStatus" ADD VALUE 'ACCEPTED';
ALTER TYPE "JobOccurrenceStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN "workflow" "OccurrenceWorkflow" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN "proposalAmount" DOUBLE PRECISION,
ADD COLUMN "proposalNotes" TEXT,
ADD COLUMN "rejectionReason" TEXT;

-- Backfill: set workflow based on existing boolean flags
UPDATE "JobOccurrence" SET "workflow" = 'ESTIMATE' WHERE "isEstimate" = true;
UPDATE "JobOccurrence" SET "workflow" = 'ONE_OFF' WHERE "isOneOff" = true AND "isEstimate" = false;
