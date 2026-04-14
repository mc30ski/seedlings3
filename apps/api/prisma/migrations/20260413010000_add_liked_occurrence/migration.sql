-- CreateTable
CREATE TABLE "LikedOccurrence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LikedOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LikedOccurrence_userId_idx" ON "LikedOccurrence"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LikedOccurrence_userId_occurrenceId_key" ON "LikedOccurrence"("userId", "occurrenceId");

-- AddForeignKey
ALTER TABLE "LikedOccurrence" ADD CONSTRAINT "LikedOccurrence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LikedOccurrence" ADD CONSTRAINT "LikedOccurrence_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
