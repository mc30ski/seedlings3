-- Add isTentative flag to JobOccurrence (default false = confirmed)
ALTER TABLE "JobOccurrence" ADD COLUMN "isTentative" BOOLEAN NOT NULL DEFAULT false;
