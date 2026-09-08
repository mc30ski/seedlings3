-- Job invoice charges — the two-books split.
--
-- A line on a job is what the CLIENT IS CHARGED. It is NOT a business expense
-- and creates NO Schedule C deduction; the deduction is the real card charge
-- entered in the Ledger from a bank statement. See docs/features/job-materials.md.
--
-- NOTE: the `Expense` TABLE is deliberately not renamed. The Prisma model is
-- now `InvoiceCharge` with @@map("Expense"). Renaming the table would break the
-- deployed API the instant this ran, for no gain.

-- ── Which pricing rule a visit was created under ─────────────────────────────
CREATE TYPE "JobPricingModel" AS ENUM ('LEGACY', 'ITEMIZED');

ALTER TABLE "JobOccurrence"
  ADD COLUMN "pricingModel" "JobPricingModel" NOT NULL DEFAULT 'ITEMIZED',
  ADD COLUMN "laborDetail" TEXT;

-- Every visit that already exists priced the old way: materials came out of
-- the crew's pool and the client was never billed for them. The P&L and the
-- Forecast REPLAY these, so the rule is stamped per row, not inferred later.
UPDATE "JobOccurrence" SET "pricingModel" = 'LEGACY';

-- ── Client-visible line detail ───────────────────────────────────────────────
ALTER TABLE "Expense"         ADD COLUMN "detail" TEXT;
ALTER TABLE "OccurrenceAddon" ADD COLUMN "detail" TEXT;

-- ── What we actually paid (optional, informational, job margin only) ─────────
ALTER TABLE "Expense" ADD COLUMN "actualCost" DOUBLE PRECISION;

-- Historical LEGACY rows carried a 1:1 paired BusinessExpense created by the
-- old dual-write, and that pairing was made at cost. Seed actualCost from it
-- so existing jobs show a truthful margin instead of a blank.
UPDATE "Expense" SET "actualCost" = "cost" WHERE "businessExpenseId" IS NOT NULL;

-- ── The ledger link becomes an OPTIONAL, MANY-TO-ONE breadcrumb ──────────────
-- One $500 Lowe's receipt covers several jobs and several supply purchases.
-- Nothing may cascade through this link: a cascade that looks right on a
-- LEGACY row destroys a real deduction on an ITEMIZED one.
DROP INDEX IF EXISTS "Expense_businessExpenseId_key";
CREATE INDEX "Expense_businessExpenseId_idx" ON "Expense"("businessExpenseId");

ALTER TABLE "SupplyPurchase" DROP CONSTRAINT IF EXISTS "SupplyPurchase_businessExpenseId_fkey";
DROP INDEX IF EXISTS "SupplyPurchase_businessExpenseId_key";
ALTER TABLE "SupplyPurchase" ALTER COLUMN "businessExpenseId" DROP NOT NULL;
CREATE INDEX "SupplyPurchase_businessExpenseId_idx" ON "SupplyPurchase"("businessExpenseId");
ALTER TABLE "SupplyPurchase"
  ADD CONSTRAINT "SupplyPurchase_businessExpenseId_fkey"
  FOREIGN KEY ("businessExpenseId") REFERENCES "BusinessExpense"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
