-- CreateTable
CREATE TABLE "PropertyPhoto" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "fileName" TEXT,
    "contentType" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobPropertyPhoto" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "propertyPhotoId" TEXT NOT NULL,

    CONSTRAINT "JobPropertyPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OccurrencePropertyPhoto" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "propertyPhotoId" TEXT NOT NULL,

    CONSTRAINT "OccurrencePropertyPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyPhoto_propertyId_idx" ON "PropertyPhoto"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "JobPropertyPhoto_jobId_propertyPhotoId_key" ON "JobPropertyPhoto"("jobId", "propertyPhotoId");

-- CreateIndex
CREATE UNIQUE INDEX "OccurrencePropertyPhoto_occurrenceId_propertyPhotoId_key" ON "OccurrencePropertyPhoto"("occurrenceId", "propertyPhotoId");

-- AddForeignKey
ALTER TABLE "PropertyPhoto" ADD CONSTRAINT "PropertyPhoto_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyPhoto" ADD CONSTRAINT "PropertyPhoto_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPropertyPhoto" ADD CONSTRAINT "JobPropertyPhoto_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobPropertyPhoto" ADD CONSTRAINT "JobPropertyPhoto_propertyPhotoId_fkey" FOREIGN KEY ("propertyPhotoId") REFERENCES "PropertyPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccurrencePropertyPhoto" ADD CONSTRAINT "OccurrencePropertyPhoto_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccurrencePropertyPhoto" ADD CONSTRAINT "OccurrencePropertyPhoto_propertyPhotoId_fkey" FOREIGN KEY ("propertyPhotoId") REFERENCES "PropertyPhoto"("id") ON DELETE CASCADE ON UPDATE CASCADE;
