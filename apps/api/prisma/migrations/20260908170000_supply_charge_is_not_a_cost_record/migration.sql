-- A supply line on a client's invoice is not a record of what we paid.
--
-- Pulling stock onto a job briefly wrote `actualCost` onto the paired charge,
-- derived from the supply catalog, so a job-profit figure could show a
-- material margin. That imported a COST into a CLIENT CHARGE.
--
-- Supplies are a stock-tracking layer — deliberately approximate, maintained
-- by the operator and the crew. What was actually spent is a BusinessExpense
-- in the Ledger, which is what gets reconciled against the accounting
-- software. Mixing the two makes the approximate layer look authoritative.
--
-- Only rows the inventory path wrote are cleared. A cost typed by hand on a
-- one-off charge is the operator's own figure and is left alone.
UPDATE "Expense" e
   SET "actualCost" = NULL
  FROM "SupplyHold" h
 WHERE h."expenseId" = e."id"
   AND e."actualCost" IS NOT NULL;
