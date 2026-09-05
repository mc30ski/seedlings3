-- Guide assets become referenceable BY NAME.
--
-- Guide bodies stored `guide-asset:<cuid>` tokens, so an author could not write
-- an image reference without first uploading and copying an opaque id — and
-- content moved between environments carried ids that did not exist in the
-- target, rendering nothing with no error. The filename becomes the handle,
-- which means it has to be unique.

ALTER TABLE "GuideAsset" ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TABLE "GuideAsset" ADD COLUMN "supersededById" TEXT;

-- Names are matched case-insensitively, so fold them now. Done before the
-- dedupe below, or "Chart.png" and "chart.png" would survive as a collision
-- the unique index then rejects.
UPDATE "GuideAsset" SET "originalFilename" = lower("originalFilename");

-- Any pre-existing duplicate keeps its bytes but loses the bare name: oldest
-- row wins it, the rest are marked superseded and suffixed with their id.
-- Deleting them would destroy the record of what a published page once showed.
WITH ranked AS (
  SELECT "id", "originalFilename",
         ROW_NUMBER() OVER (PARTITION BY "originalFilename" ORDER BY "uploadedAt" ASC, "id" ASC) AS rn
    FROM "GuideAsset"
)
UPDATE "GuideAsset" a
   SET "originalFilename" = r."originalFilename" || '.superseded.' || a."id",
       "supersededAt" = NOW()
  FROM ranked r
 WHERE a."id" = r."id" AND r.rn > 1;

CREATE UNIQUE INDEX "GuideAsset_originalFilename_key" ON "GuideAsset"("originalFilename");
