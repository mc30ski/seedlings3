-- Short URL scheme for promo click tracking + per-campaign domain
-- override. Additive migration — existing data untouched. Old long-
-- form wrapper URLs (/api/public/promotion/click/d/<id>?t=<hmac>) keep
-- working forever; short URLs are opt-in per campaign via shortSlug.

-- Promotion: branded slug + optional per-campaign domain
ALTER TABLE "Promotion" ADD COLUMN "shortSlug" TEXT;
ALTER TABLE "Promotion" ADD COLUMN "baseDomain" TEXT;
CREATE UNIQUE INDEX "Promotion_shortSlug_key" ON "Promotion"("shortSlug");

-- PromotionDelivery: per-recipient short code, unique within a
-- promotion (different campaigns can reuse codes)
ALTER TABLE "PromotionDelivery" ADD COLUMN "shortCode" TEXT;
CREATE UNIQUE INDEX "PromotionDelivery_promotionId_shortCode_key" ON "PromotionDelivery"("promotionId", "shortCode");
