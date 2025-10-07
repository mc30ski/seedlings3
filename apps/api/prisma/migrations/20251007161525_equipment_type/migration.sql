-- AlterTable
ALTER TABLE "public"."Equipment" ADD COLUMN     "type" TEXT,
ALTER COLUMN "shortDesc" DROP NOT NULL,
ALTER COLUMN "longDesc" DROP NOT NULL;
