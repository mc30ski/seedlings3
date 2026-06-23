-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'LEDGER_FOLLOWUP';

-- CreateTable
CREATE TABLE "LedgerFollowup" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerFollowup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LedgerFollowup_resolvedAt_idx" ON "LedgerFollowup"("resolvedAt");

-- CreateIndex
CREATE INDEX "LedgerFollowup_entityType_entityId_resolvedAt_idx" ON "LedgerFollowup"("entityType", "entityId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "LedgerFollowup" ADD CONSTRAINT "LedgerFollowup_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerFollowup" ADD CONSTRAINT "LedgerFollowup_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
