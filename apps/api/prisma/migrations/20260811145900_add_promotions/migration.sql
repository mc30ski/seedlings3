-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditScope" ADD VALUE 'PROMOTION';
ALTER TYPE "AuditScope" ADD VALUE 'PROMO_OPT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_STARTED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_PAUSED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_RESUMED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_RETIRED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_EDITED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_DUPLICATED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_DISPATCHED';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMOTION_TEST_SENT';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMO_OPTED_OUT';
ALTER TYPE "AuditVerb" ADD VALUE 'PROMO_OPTED_IN';

-- AlterTable
ALTER TABLE "ClientContact" ADD COLUMN     "promoEmailOptedOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promoSmsOptedOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "link" TEXT,
    "audienceSpec" JSONB NOT NULL DEFAULT '{"kind":"all"}',
    "dispatchChannels" JSONB NOT NULL DEFAULT '[]',
    "displaySurfaces" JSONB NOT NULL DEFAULT '[]',
    "triggerKind" TEXT,
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "offer" JSONB,
    "cooldownDays" INTEGER NOT NULL DEFAULT 7,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL DEFAULT '{}',
    "lastDispatchStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "startedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionDelivery" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "triggeredBy" TEXT,
    "dispatchId" TEXT,
    "contentSnapshot" JSONB NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "skippedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_status_idx" ON "Promotion"("status");

-- CreateIndex
CREATE INDEX "Promotion_triggerKind_status_idx" ON "Promotion"("triggerKind", "status");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionDelivery" ADD CONSTRAINT "PromotionDelivery_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionDelivery" ADD CONSTRAINT "PromotionDelivery_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionDelivery" ADD CONSTRAINT "PromotionDelivery_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ClientContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
