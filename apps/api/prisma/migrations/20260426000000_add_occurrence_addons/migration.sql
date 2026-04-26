-- CreateTable
CREATE TABLE "OccurrenceAddon" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "tag" TEXT,
    "customLabel" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OccurrenceAddon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OccurrenceAddon_occurrenceId_idx" ON "OccurrenceAddon"("occurrenceId");

-- AddForeignKey
ALTER TABLE "OccurrenceAddon" ADD CONSTRAINT "OccurrenceAddon_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OccurrenceAddon" ADD CONSTRAINT "OccurrenceAddon_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
