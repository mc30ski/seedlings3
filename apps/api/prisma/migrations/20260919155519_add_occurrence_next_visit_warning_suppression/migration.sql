-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "nextVisitWarningSuppressedAt" TIMESTAMP(3),
ADD COLUMN     "nextVisitWarningSuppressedById" TEXT;
