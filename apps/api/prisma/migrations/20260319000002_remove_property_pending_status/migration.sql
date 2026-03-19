-- Move any existing PENDING properties to ACTIVE
UPDATE "Property" SET "status" = 'ACTIVE' WHERE "status" = 'PENDING';

-- Change default to ACTIVE
ALTER TABLE "Property" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- Remove PENDING from the enum
CREATE TYPE "PropertyStatus_new" AS ENUM ('ACTIVE', 'ARCHIVED');
ALTER TABLE "Property" ALTER COLUMN "status" TYPE "PropertyStatus_new" USING ("status"::text::"PropertyStatus_new");
ALTER TYPE "PropertyStatus" RENAME TO "PropertyStatus_old";
ALTER TYPE "PropertyStatus_new" RENAME TO "PropertyStatus";
DROP TYPE "PropertyStatus_old";
