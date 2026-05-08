-- AlterTable
ALTER TABLE "BusinessExpense" ADD COLUMN     "equipmentId" TEXT;

-- CreateIndex
CREATE INDEX "BusinessExpense_equipmentId_idx" ON "BusinessExpense"("equipmentId");

-- AddForeignKey
ALTER TABLE "BusinessExpense" ADD CONSTRAINT "BusinessExpense_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
