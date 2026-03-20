-- Add isEstimate flag to JobOccurrence (default false = normal occurrence)
ALTER TABLE "JobOccurrence" ADD COLUMN "isEstimate" BOOLEAN NOT NULL DEFAULT false;
