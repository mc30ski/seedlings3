-- CreateTable
CREATE TABLE "JobOccurrencePhoto" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "fileName" TEXT,
    "contentType" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobOccurrencePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobOccurrencePhoto_occurrenceId_idx" ON "JobOccurrencePhoto"("occurrenceId");

-- AddForeignKey
ALTER TABLE "JobOccurrencePhoto" ADD CONSTRAINT "JobOccurrencePhoto_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOccurrencePhoto" ADD CONSTRAINT "JobOccurrencePhoto_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
