-- Rename PolicyGateService.VEHICLE_RESERVE → RESERVE_EQUIPMENT.
--
-- Historic name was misleading — not every piece of equipment is a vehicle.
-- The new name matches how the field is used (per-piece equipment
-- reservation gate).
--
-- ALTER TYPE ... RENAME VALUE is available in Postgres 10+. Neon runs a
-- current Postgres version so this is safe. Rolls forward automatically
-- for any rows that reference the old enum value.
--
-- Idempotent — skip if the value has already been renamed (dev DB may have
-- run this via db push before the migration was authored).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'PolicyGateService' AND e.enumlabel = 'VEHICLE_RESERVE'
  ) THEN
    ALTER TYPE "PolicyGateService" RENAME VALUE 'VEHICLE_RESERVE' TO 'RESERVE_EQUIPMENT';
  END IF;
END $$;
