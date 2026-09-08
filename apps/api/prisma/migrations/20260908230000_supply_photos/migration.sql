-- Optional images of a supply, so the right bag/roll/jug gets bought and pulled.
--
-- Mirrors EquipmentPhoto: bytes in R2, the row holds only the key, URLs are
-- presigned on read. Shares the equipment-photos bucket under a `supply/<id>/`
-- prefix — catalog-item imagery is one lifecycle, and a dedicated bucket would
-- need a Cloudflare bucket plus two Vercel env vars set by hand before uploads
-- worked (R2_GUIDE_MEDIA_BUCKET_NAME is unset in production today and Guides
-- media 503s for exactly that reason).
--
-- Cascade from Supply: a photo of a thing that no longer exists is not a
-- record of anything. Supplies are archived rather than deleted in normal use,
-- so this fires only on a real hard delete.
CREATE TABLE "SupplyPhoto" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "fileName" TEXT,
    "contentType" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplyPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplyPhoto_supplyId_idx" ON "SupplyPhoto"("supplyId");

ALTER TABLE "SupplyPhoto" ADD CONSTRAINT "SupplyPhoto_supplyId_fkey"
  FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupplyPhoto" ADD CONSTRAINT "SupplyPhoto_uploadedById_fkey"
  FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
