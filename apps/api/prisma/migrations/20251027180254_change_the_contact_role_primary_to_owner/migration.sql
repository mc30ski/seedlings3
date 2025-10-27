/*
  Warnings:

  - The values [PRIMARY] on the enum `ContactRole` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ContactRole_new" AS ENUM ('OWNER', 'SPOUSE', 'COMMUNITY_MANAGER', 'PROPERTY_MANAGER', 'BILLING', 'TECHNICAL', 'OPERATIONS', 'LEGAL', 'OTHER');
ALTER TABLE "ClientContact" ALTER COLUMN "role" TYPE "ContactRole_new" USING ("role"::text::"ContactRole_new");
ALTER TYPE "ContactRole" RENAME TO "ContactRole_old";
ALTER TYPE "ContactRole_new" RENAME TO "ContactRole";
DROP TYPE "public"."ContactRole_old";
COMMIT;
