-- Optional receipt photo attached to a BusinessExpense (any of the three
-- sources: freestanding, job-Expense pair, supply-purchase pair).
-- Object lives in the seedlings-receipts R2 bucket; receiptR2Key is the key.

ALTER TABLE "BusinessExpense" ADD COLUMN "receiptR2Key"        TEXT;
ALTER TABLE "BusinessExpense" ADD COLUMN "receiptFileName"     TEXT;
ALTER TABLE "BusinessExpense" ADD COLUMN "receiptContentType"  TEXT;
ALTER TABLE "BusinessExpense" ADD COLUMN "receiptUploadedAt"   TIMESTAMP(3);
