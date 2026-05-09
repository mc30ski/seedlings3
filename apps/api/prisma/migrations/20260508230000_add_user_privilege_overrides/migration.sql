-- Per-user privilege overrides (MVP-step-3 follow-up).
-- NULL = follow workerType default; TRUE/FALSE = explicit override.

ALTER TABLE "User" ADD COLUMN "canPullInventory"          BOOLEAN;
ALTER TABLE "User" ADD COLUMN "canChargeBusinessExpenses" BOOLEAN;
