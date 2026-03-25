-- AlterEnum: remove INDIVIDUAL and HOUSEHOLD from ClientType
ALTER TYPE "ClientType" RENAME TO "ClientType_old";
CREATE TYPE "ClientType" AS ENUM ('PERSON', 'ORGANIZATION', 'COMMUNITY');
ALTER TABLE "Client" ALTER COLUMN "type" TYPE "ClientType" USING ("type"::text::"ClientType");
DROP TYPE "ClientType_old";
