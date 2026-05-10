-- Optional recurrence flag on BusinessExpense for "due to record"
-- suggestions on the BusinessExpensesTab.

CREATE TYPE "ExpenseRecurrence" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY');

ALTER TABLE "BusinessExpense" ADD COLUMN "recurrence" "ExpenseRecurrence";
