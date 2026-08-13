-- DropForeignKey
ALTER TABLE "public"."PromotionDelivery" DROP CONSTRAINT "PromotionDelivery_clientId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PromotionDelivery" DROP CONSTRAINT "PromotionDelivery_contactId_fkey";

-- AlterTable
ALTER TABLE "PromotionDelivery" ALTER COLUMN "clientId" DROP NOT NULL,
ALTER COLUMN "contactId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "PromotionDelivery" ADD CONSTRAINT "PromotionDelivery_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionDelivery" ADD CONSTRAINT "PromotionDelivery_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ClientContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
