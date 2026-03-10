-- Migrate existing window dates to startAt/endAt where not already set
UPDATE "JobOccurrence" SET "startAt" = "windowStart" WHERE "startAt" IS NULL AND "windowStart" IS NOT NULL;
UPDATE "JobOccurrence" SET "endAt" = "windowEnd" WHERE "endAt" IS NULL AND "windowEnd" IS NOT NULL;

-- Drop the window columns
ALTER TABLE "JobOccurrence" DROP COLUMN "windowStart";
ALTER TABLE "JobOccurrence" DROP COLUMN "windowEnd";
