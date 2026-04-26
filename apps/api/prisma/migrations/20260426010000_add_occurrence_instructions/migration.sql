-- CreateTable
CREATE TABLE "OccurrenceInstruction" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "repeats" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OccurrenceInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OccurrenceInstruction_occurrenceId_idx" ON "OccurrenceInstruction"("occurrenceId");

-- AddForeignKey
ALTER TABLE "OccurrenceInstruction" ADD CONSTRAINT "OccurrenceInstruction_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migrate existing pinnedNote data to OccurrenceInstruction
INSERT INTO "OccurrenceInstruction" ("id", "occurrenceId", "text", "isPreset", "repeats", "sortOrder", "createdAt")
SELECT
    gen_random_uuid()::text,
    "id",
    "pinnedNote",
    false,
    "pinnedNoteRepeats",
    0,
    NOW()
FROM "JobOccurrence"
WHERE "pinnedNote" IS NOT NULL AND "pinnedNote" != '';
