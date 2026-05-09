-- MVP-step-3: inventory-tracked supplies.
-- Decouples purchase (BusinessExpense at buy time) from consumption
-- (Expense at use time, against a SupplyHold reservation).

-- Enum
CREATE TYPE "SupplyHoldStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- Supply (catalog)
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL,
    "upc" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Supplies',
    "businessCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "jobPayoutCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Supply_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Supply_archivedAt_idx" ON "Supply"("archivedAt");
CREATE INDEX "Supply_upc_idx" ON "Supply"("upc");
CREATE INDEX "Supply_name_idx" ON "Supply"("name");

ALTER TABLE "Supply" ADD CONSTRAINT "Supply_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SupplyPurchase (buy event, paired 1:1 with BusinessExpense)
CREATE TABLE "SupplyPurchase" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL,
    "totalCost" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vendor" TEXT,
    "invoiceNumber" TEXT,
    "notes" TEXT,
    "businessExpenseId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplyPurchase_businessExpenseId_key" ON "SupplyPurchase"("businessExpenseId");
CREATE INDEX "SupplyPurchase_supplyId_date_idx" ON "SupplyPurchase"("supplyId", "date");
CREATE INDEX "SupplyPurchase_date_idx" ON "SupplyPurchase"("date");

ALTER TABLE "SupplyPurchase" ADD CONSTRAINT "SupplyPurchase_supplyId_fkey"
    FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplyPurchase" ADD CONSTRAINT "SupplyPurchase_businessExpenseId_fkey"
    FOREIGN KEY ("businessExpenseId") REFERENCES "BusinessExpense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplyPurchase" ADD CONSTRAINT "SupplyPurchase_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SupplyHold (consumption reservation against a JobOccurrence)
CREATE TABLE "SupplyHold" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "occurrenceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "jobPayoutCost" DOUBLE PRECISION NOT NULL,
    "status" "SupplyHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "expenseId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplyHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupplyHold_expenseId_key" ON "SupplyHold"("expenseId");
CREATE INDEX "SupplyHold_supplyId_status_idx" ON "SupplyHold"("supplyId", "status");
CREATE INDEX "SupplyHold_occurrenceId_idx" ON "SupplyHold"("occurrenceId");
CREATE INDEX "SupplyHold_status_idx" ON "SupplyHold"("status");

ALTER TABLE "SupplyHold" ADD CONSTRAINT "SupplyHold_supplyId_fkey"
    FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplyHold" ADD CONSTRAINT "SupplyHold_occurrenceId_fkey"
    FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplyHold" ADD CONSTRAINT "SupplyHold_expenseId_fkey"
    FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplyHold" ADD CONSTRAINT "SupplyHold_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SupplyAdjustment (manual count corrections; no tax effect)
CREATE TABLE "SupplyAdjustment" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplyAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplyAdjustment_supplyId_createdAt_idx" ON "SupplyAdjustment"("supplyId", "createdAt");

ALTER TABLE "SupplyAdjustment" ADD CONSTRAINT "SupplyAdjustment_supplyId_fkey"
    FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplyAdjustment" ADD CONSTRAINT "SupplyAdjustment_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
