-- CreateTable
CREATE TABLE "GuaranteedPayoutAdvance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exportedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuaranteedPayoutAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuaranteedPayoutAdvance_userId_exportedAt_idx" ON "GuaranteedPayoutAdvance"("userId", "exportedAt");

-- CreateIndex
CREATE INDEX "GuaranteedPayoutAdvance_occurrenceId_idx" ON "GuaranteedPayoutAdvance"("occurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "GuaranteedPayoutAdvance_userId_occurrenceId_key" ON "GuaranteedPayoutAdvance"("userId", "occurrenceId");

-- AddForeignKey
ALTER TABLE "GuaranteedPayoutAdvance" ADD CONSTRAINT "GuaranteedPayoutAdvance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuaranteedPayoutAdvance" ADD CONSTRAINT "GuaranteedPayoutAdvance_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuaranteedPayoutAdvance" ADD CONSTRAINT "GuaranteedPayoutAdvance_exportedByUserId_fkey" FOREIGN KEY ("exportedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "PaymentSplit_advancePaidAt_idx" RENAME TO "PaymentSplit_guaranteedPayoutPaidAt_idx";
