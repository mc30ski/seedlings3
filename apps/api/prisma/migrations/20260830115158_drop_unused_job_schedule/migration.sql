-- DropForeignKey
ALTER TABLE "public"."JobSchedule" DROP CONSTRAINT "JobSchedule_jobId_fkey";

-- DropTable
DROP TABLE "public"."JobSchedule";

-- DropEnum
DROP TYPE "public"."Cadence";

