-- Backfill hoursApprovedAt for every JobOccurrence that already had its
-- time tracked before the column existed. We stamp the existing completedAt
-- so historical rows don't suddenly show up in the "unapproved hours" alert.
--
-- One-time migration: rows created after this point follow the normal
-- auto-approve rule in jobs.ts (auto-approve within variance threshold, else
-- leave null until admin/super approves).
UPDATE "JobOccurrence"
SET "hoursApprovedAt" = "completedAt"
WHERE "completedAt" IS NOT NULL
  AND "hoursApprovedAt" IS NULL;
