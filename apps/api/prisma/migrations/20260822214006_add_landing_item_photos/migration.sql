-- CreateTable
CREATE TABLE "PromotionLandingPageItemPhoto" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionLandingPageItemPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromotionLandingPageItemPhoto_itemId_sortOrder_idx" ON "PromotionLandingPageItemPhoto"("itemId", "sortOrder");

-- AddForeignKey
ALTER TABLE "PromotionLandingPageItemPhoto" ADD CONSTRAINT "PromotionLandingPageItemPhoto_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PromotionLandingPageItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every item that already had a single image becomes that
-- item's first photo. Included in THIS migration (before it has ever
-- been applied) rather than as a later edit, so the table and its data
-- land together and prod can never run the DDL without the data.
--
-- gen_random_uuid() per row is correct here: each photo needs its own
-- distinct id. (The "don't generate ids in SQL" lesson applies to cases
-- needing one shared id across a group — the opposite of this.)
INSERT INTO "PromotionLandingPageItemPhoto" ("id", "itemId", "r2Key", "contentType", "sortOrder", "createdAt")
SELECT
    gen_random_uuid()::text,
    i."id",
    i."imageR2Key",
    i."imageMimeType",
    0,
    COALESCE(i."createdAt", CURRENT_TIMESTAMP)
FROM "PromotionLandingPageItem" i
WHERE i."imageR2Key" IS NOT NULL;
