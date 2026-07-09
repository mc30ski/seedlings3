-- Per-document override for the publish-time grace window (hours).
-- Null → fall back to the global POLICY_DEFAULT_GRACE_HOURS setting (24).
-- Zero → no grace (BLOCK gate fires the instant a version publishes).
-- Positive → that many hours.
--
-- Idempotent — safe to re-run against a schema that already has the column
-- (e.g. dev DB that already ran an ad-hoc `db push` during development).
ALTER TABLE "PolicyDocument" ADD COLUMN IF NOT EXISTS "graceHoursOverride" INTEGER;
