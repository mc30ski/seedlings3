-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('EXPENSE', 'CAPITAL_CONTRIBUTION', 'OWNER_DRAW');

-- AlterTable
ALTER TABLE "BusinessExpense" ADD COLUMN     "type" "EntryType" NOT NULL DEFAULT 'EXPENSE';

-- CreateIndex
CREATE INDEX "BusinessExpense_type_idx" ON "BusinessExpense"("type");
