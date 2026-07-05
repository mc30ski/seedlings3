-- Step 5 of pause-simplification: drop PAUSED from ClientStatus and
-- ContactStatus enums. Data migration (Step 4) ran first so no rows
-- carry the PAUSED value.
--
-- Postgres enum-shrink template — same pattern as
-- 20260319000002_remove_property_pending_status:
--   1. Drop default (enum swap requires it)
--   2. Create new enum with only the values we're keeping
--   3. Retype the column to the new enum
--   4. Rename old → *_old, new → original name
--   5. Drop *_old
--   6. Restore default

-- ── ClientStatus ─────────────────────────────────────────────────────

-- Safety net: any residual PAUSED rows get flipped to ACTIVE. Step 4's
-- migration should have already done this, but the guard keeps the
-- enum swap from failing if any row escaped the script.
UPDATE "Client" SET "status" = 'ACTIVE' WHERE "status" = 'PAUSED';

ALTER TABLE "Client" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "ClientStatus_new" AS ENUM ('ACTIVE', 'ARCHIVED');
ALTER TABLE "Client" ALTER COLUMN "status" TYPE "ClientStatus_new" USING ("status"::text::"ClientStatus_new");
ALTER TYPE "ClientStatus" RENAME TO "ClientStatus_old";
ALTER TYPE "ClientStatus_new" RENAME TO "ClientStatus";
DROP TYPE "ClientStatus_old";

ALTER TABLE "Client" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"ClientStatus";

-- ── ContactStatus ────────────────────────────────────────────────────

UPDATE "ClientContact" SET "status" = 'ARCHIVED' WHERE "status" = 'PAUSED';

ALTER TABLE "ClientContact" ALTER COLUMN "status" DROP DEFAULT;

CREATE TYPE "ContactStatus_new" AS ENUM ('ACTIVE', 'ARCHIVED');
ALTER TABLE "ClientContact" ALTER COLUMN "status" TYPE "ContactStatus_new" USING ("status"::text::"ContactStatus_new");
ALTER TYPE "ContactStatus" RENAME TO "ContactStatus_old";
ALTER TYPE "ContactStatus_new" RENAME TO "ContactStatus";
DROP TYPE "ContactStatus_old";

ALTER TABLE "ClientContact" ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"ContactStatus";
