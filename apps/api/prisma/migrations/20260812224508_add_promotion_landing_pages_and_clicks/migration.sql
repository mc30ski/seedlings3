-- CreateEnum
CREATE TYPE "PromotionLinkKind" AS ENUM ('EXTERNAL', 'LANDING_PAGE');

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "landingPageId" TEXT,
ADD COLUMN     "linkKind" "PromotionLinkKind" NOT NULL DEFAULT 'EXTERNAL';

-- CreateTable
CREATE TABLE "PromotionLandingPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "headline" TEXT,
    "intro" TEXT,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PromotionLandingPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionLandingPageItem" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "imageR2Key" TEXT,
    "imageMimeType" TEXT,
    "ordinal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionLandingPageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionClick" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "contactId" TEXT,
    "clientId" TEXT,
    "destination" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "anonymousReason" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionClick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromotionLandingPage_slug_key" ON "PromotionLandingPage"("slug");

-- CreateIndex
CREATE INDEX "PromotionLandingPageItem_pageId_ordinal_idx" ON "PromotionLandingPageItem"("pageId", "ordinal");

-- CreateIndex
CREATE INDEX "PromotionClick_promotionId_createdAt_idx" ON "PromotionClick"("promotionId", "createdAt");

-- CreateIndex
CREATE INDEX "PromotionClick_contactId_createdAt_idx" ON "PromotionClick"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "PromotionClick_deliveryId_idx" ON "PromotionClick"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_landingPageId_key" ON "Promotion"("landingPageId");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_landingPageId_fkey" FOREIGN KEY ("landingPageId") REFERENCES "PromotionLandingPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionLandingPage" ADD CONSTRAINT "PromotionLandingPage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionLandingPage" ADD CONSTRAINT "PromotionLandingPage_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionLandingPageItem" ADD CONSTRAINT "PromotionLandingPageItem_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "PromotionLandingPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionClick" ADD CONSTRAINT "PromotionClick_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionClick" ADD CONSTRAINT "PromotionClick_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "PromotionDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionClick" ADD CONSTRAINT "PromotionClick_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "ClientContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionClick" ADD CONSTRAINT "PromotionClick_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

