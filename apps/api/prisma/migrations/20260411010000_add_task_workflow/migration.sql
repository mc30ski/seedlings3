-- AlterEnum
ALTER TYPE "OccurrenceWorkflow" ADD VALUE 'TASK';

-- AlterTable: make jobId nullable
ALTER TABLE "JobOccurrence" ALTER COLUMN "jobId" DROP NOT NULL;

-- AlterTable: make kind nullable
ALTER TABLE "JobOccurrence" ALTER COLUMN "kind" DROP NOT NULL;

-- AlterTable: add title column
ALTER TABLE "JobOccurrence" ADD COLUMN "title" TEXT;
