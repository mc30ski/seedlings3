-- CreateEnum
CREATE TYPE "ExportKind" AS ENUM ('GUSTO_W2', 'GUSTO_CONTRACTORS', 'QB_INCOME', 'QB_EXPENSES', 'QB_EQUITY', 'QB_BUNDLE');

-- CreateTable
CREATE TABLE "ExportRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "kind" "ExportKind" NOT NULL,
    "rangeStart" TIMESTAMP(3) NOT NULL,
    "rangeEnd" TIMESTAMP(3) NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,

    CONSTRAINT "ExportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportRun_createdAt_idx" ON "ExportRun"("createdAt");

-- CreateIndex
CREATE INDEX "ExportRun_createdById_idx" ON "ExportRun"("createdById");

-- CreateIndex
CREATE INDEX "ExportRun_kind_idx" ON "ExportRun"("kind");

-- AddForeignKey
ALTER TABLE "ExportRun" ADD CONSTRAINT "ExportRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
