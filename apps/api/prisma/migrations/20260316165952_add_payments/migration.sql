-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHECK', 'VENMO', 'ZELLE', 'OTHER');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "note" TEXT,
    "collectedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSplit" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_occurrenceId_key" ON "Payment"("occurrenceId");

-- CreateIndex
CREATE INDEX "Payment_collectedById_createdAt_idx" ON "Payment"("collectedById", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_method_createdAt_idx" ON "Payment"("method", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentSplit_userId_createdAt_idx" ON "PaymentSplit"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSplit_paymentId_userId_key" ON "PaymentSplit"("paymentId", "userId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_collectedById_fkey" FOREIGN KEY ("collectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSplit" ADD CONSTRAINT "PaymentSplit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
