-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "businessExpenseId" TEXT;

-- AlterTable
ALTER TABLE "BusinessExpense" ADD COLUMN "occurrenceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Expense_businessExpenseId_key" ON "Expense"("businessExpenseId");

-- CreateIndex
CREATE INDEX "BusinessExpense_occurrenceId_idx" ON "BusinessExpense"("occurrenceId");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_businessExpenseId_fkey" FOREIGN KEY ("businessExpenseId") REFERENCES "BusinessExpense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessExpense" ADD CONSTRAINT "BusinessExpense_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
