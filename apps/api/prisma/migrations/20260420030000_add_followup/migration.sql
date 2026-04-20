-- AlterEnum
ALTER TYPE "OccurrenceWorkflow" ADD VALUE 'FOLLOWUP';

-- CreateTable
CREATE TABLE "FollowupClient" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowupClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowupJob" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowupJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FollowupClient_occurrenceId_clientId_key" ON "FollowupClient"("occurrenceId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowupJob_occurrenceId_jobId_key" ON "FollowupJob"("occurrenceId", "jobId");

-- AddForeignKey
ALTER TABLE "FollowupClient" ADD CONSTRAINT "FollowupClient_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowupClient" ADD CONSTRAINT "FollowupClient_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowupJob" ADD CONSTRAINT "FollowupJob_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowupJob" ADD CONSTRAINT "FollowupJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
