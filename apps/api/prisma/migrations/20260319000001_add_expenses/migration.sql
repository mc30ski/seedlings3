-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Expense_occurrenceId_idx" ON "Expense"("occurrenceId");

-- CreateIndex
CREATE INDEX "Expense_createdById_idx" ON "Expense"("createdById");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
