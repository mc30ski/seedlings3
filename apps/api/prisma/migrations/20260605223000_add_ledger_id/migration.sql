-- Accounting-system-agnostic ledger ID column on the four parent financial-
-- event tables. Format SLC-YYMMDD-XXXX (14 chars), used as the QuickBooks
-- JournalNo. PaymentSplit and CheckoutSplit JournalNos derive at export time
-- from their parent row's ledgerId + a user suffix — those tables get no
-- column.
--
-- Nullable column with a unique index. The codebase stamps new rows at
-- creation time; existing rows are populated by a one-time backfill UPDATE
-- (run separately — pure SQL, paste-into-Neon-safe).

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "ledgerId" TEXT;

-- AlterTable
ALTER TABLE "Checkout" ADD COLUMN "ledgerId" TEXT;

-- AlterTable
ALTER TABLE "BusinessExpense" ADD COLUMN "ledgerId" TEXT;

-- AlterTable
ALTER TABLE "GuaranteedPayoutAdvance" ADD COLUMN "ledgerId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_ledgerId_key" ON "Payment"("ledgerId");

-- CreateIndex
CREATE UNIQUE INDEX "Checkout_ledgerId_key" ON "Checkout"("ledgerId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessExpense_ledgerId_key" ON "BusinessExpense"("ledgerId");

-- CreateIndex
CREATE UNIQUE INDEX "GuaranteedPayoutAdvance_ledgerId_key" ON "GuaranteedPayoutAdvance"("ledgerId");
