-- Add ALIAS kind and sortOrder column to VanityPage.
--
-- ALIAS = a vanity URL that mirrors the CONTENT of another (target)
-- vanity page, but keeps its own slug in the URL bar. Lets the operator
-- expose the same landing under multiple branded shortcuts without
-- duplicating the copy across rows.
--
-- sortOrder = operator-defined display order for the Vanity URLs tab.
-- Reserved for a follow-on feature that surfaces vanity URLs in a
-- specific order (e.g. an in-app navigation list).

ALTER TYPE "VanityPageKind" ADD VALUE 'ALIAS';

ALTER TABLE "VanityPage"
  ADD COLUMN "aliasTargetId" TEXT,
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill sortOrder so existing rows have a stable, non-zero order
-- (alphabetical by slug — matches the pre-existing list order).
UPDATE "VanityPage" v
   SET "sortOrder" = ordered.rn * 10
  FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY slug ASC) AS rn
      FROM "VanityPage"
  ) ordered
 WHERE v.id = ordered.id;

-- FK: alias target is a soft link. If the target is deleted, blank out
-- this row's link (row will render nothing until the operator fixes it,
-- but doesn't cascade-delete the alias itself).
ALTER TABLE "VanityPage"
  ADD CONSTRAINT "VanityPage_aliasTargetId_fkey"
  FOREIGN KEY ("aliasTargetId") REFERENCES "VanityPage"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "VanityPage_sortOrder_idx" ON "VanityPage" ("sortOrder");
CREATE INDEX "VanityPage_aliasTargetId_idx" ON "VanityPage" ("aliasTargetId");
