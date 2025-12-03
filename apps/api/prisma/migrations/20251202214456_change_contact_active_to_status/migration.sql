-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "ClientContact" ADD COLUMN     "status" "ContactStatus" NOT NULL DEFAULT 'ACTIVE';
