-- CreateEnum
CREATE TYPE "ChangeRequestKind" AS ENUM ('RESCHEDULE', 'SKIP');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELED');

-- CreateTable
CREATE TABLE "OccurrenceChangeRequest" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "kind" "ChangeRequestKind" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "proposedStartAt" TIMESTAMP(3),
    "comment" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OccurrenceChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OccurrenceChangeRequest_occurrenceId_idx" ON "OccurrenceChangeRequest"("occurrenceId");

-- CreateIndex
CREATE INDEX "OccurrenceChangeRequest_requestedById_idx" ON "OccurrenceChangeRequest"("requestedById");

-- CreateIndex
CREATE INDEX "OccurrenceChangeRequest_status_idx" ON "OccurrenceChangeRequest"("status");

-- AddForeignKey
ALTER TABLE "OccurrenceChangeRequest" ADD CONSTRAINT "OccurrenceChangeRequest_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccurrenceChangeRequest" ADD CONSTRAINT "OccurrenceChangeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccurrenceChangeRequest" ADD CONSTRAINT "OccurrenceChangeRequest_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
