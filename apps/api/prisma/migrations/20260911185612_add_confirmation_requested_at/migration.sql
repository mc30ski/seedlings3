-- AlterTable
ALTER TABLE "JobOccurrence" ADD COLUMN     "confirmationFirstRequestedAt" TIMESTAMP(3),
ADD COLUMN     "confirmationRequestedAt" TIMESTAMP(3);
