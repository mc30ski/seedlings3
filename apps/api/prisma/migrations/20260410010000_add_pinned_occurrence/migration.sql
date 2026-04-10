-- CreateTable
CREATE TABLE "PinnedOccurrence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinnedOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinnedOccurrence_userId_idx" ON "PinnedOccurrence"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PinnedOccurrence_userId_occurrenceId_key" ON "PinnedOccurrence"("userId", "occurrenceId");

-- AddForeignKey
ALTER TABLE "PinnedOccurrence" ADD CONSTRAINT "PinnedOccurrence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinnedOccurrence" ADD CONSTRAINT "PinnedOccurrence_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
