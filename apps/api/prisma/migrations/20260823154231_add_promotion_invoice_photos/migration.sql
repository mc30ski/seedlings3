-- CreateTable
CREATE TABLE "PromotionInvoicePhoto" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionInvoicePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionInvoicePhoto_promotionId_sortOrder_idx" ON "PromotionInvoicePhoto"("promotionId", "sortOrder");

-- AddForeignKey
ALTER TABLE "PromotionInvoicePhoto" ADD CONSTRAINT "PromotionInvoicePhoto_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: preserve what clients currently see.
--
-- Until now the invoice cover was DERIVED — "first photo of the first
-- landing-page item" (see loadInvoicePagePromos). That derivation is
-- being removed in the same change that adds this table, so without a
-- backfill every live invoice-page promo would lose its image the moment
-- this deploys, until an operator manually re-uploaded one.
--
-- Copy that exact derived cover into the new table as sortOrder 0, for
-- every promotion that targets invoice_page and has a landing page whose
-- items carry at least one photo. DISTINCT ON picks one row per
-- promotion, ordered the same way the old runtime query was
-- (item.ordinal, then photo.sortOrder) so the chosen image is
-- byte-identical to what was rendering before.
--
-- Included in THIS migration, before it has ever been applied, so the
-- table and its data land together — prod can never run the DDL without
-- the data (same reasoning as add_landing_item_photos).
--
-- gen_random_uuid() per row is correct: each photo needs its own id.
INSERT INTO "PromotionInvoicePhoto" ("id", "promotionId", "r2Key", "contentType", "sortOrder", "createdAt")
SELECT DISTINCT ON (p."id")
    gen_random_uuid()::text,
    p."id",
    ph."r2Key",
    ph."contentType",
    0,
    CURRENT_TIMESTAMP
FROM "Promotion" p
JOIN "PromotionLandingPageItem" i  ON i."pageId" = p."landingPageId"
JOIN "PromotionLandingPageItemPhoto" ph ON ph."itemId" = i."id"
WHERE p."landingPageId" IS NOT NULL
  -- displaySurfaces is a JSON array column; only promos that actually
  -- render on an invoice need a cover carried over.
  AND p."displaySurfaces" @> '["invoice_page"]'::jsonb
ORDER BY p."id", i."ordinal" ASC, ph."sortOrder" ASC;
