-- Area becomes Portfolio, and membership becomes many-to-many.
--
-- WHY THIS IS HAND-WRITTEN. To Prisma's schema differ a model rename looks
-- like "drop Area, create Portfolio" — a DROP TABLE that would take the
-- root node and the 93 properties hanging off it with it. Every structural
-- change below is a RENAME, so rows, indexes and foreign keys survive.
--
-- WHAT CHANGED CONCEPTUALLY. An "area" was never checked to be a place:
-- lat/lng were optional, `tier` was free text, and the tree was already
-- carrying nodes labelled "Route". A portfolio is a named grouping of
-- properties with an owner, geographic or not. A property may belong to
-- several, so the single `areaId` column becomes a join table.

-- ── 1. The tree ──────────────────────────────────────────────────────────
ALTER TABLE "Area" RENAME TO "Portfolio";
ALTER TABLE "AreaAssignment" RENAME TO "PortfolioAssignment";
ALTER TABLE "PortfolioAssignment" RENAME COLUMN "areaId" TO "portfolioId";

-- Indexes and constraints keep their old names through a table rename.
-- Renaming them too keeps the database matching what Prisma generates, so
-- a later `migrate diff` reports no drift and nobody has to wonder whether
-- the schema and the database have quietly parted company.
ALTER INDEX "Area_pkey"            RENAME TO "Portfolio_pkey";
ALTER INDEX "Area_parentId_idx"    RENAME TO "Portfolio_parentId_idx";
ALTER INDEX "Area_path_idx"        RENAME TO "Portfolio_path_idx";
ALTER INDEX "Area_retiredAt_idx"   RENAME TO "Portfolio_retiredAt_idx";
ALTER TABLE "Portfolio" RENAME CONSTRAINT "Area_parentId_fkey" TO "Portfolio_parentId_fkey";

ALTER INDEX "AreaAssignment_pkey"      RENAME TO "PortfolioAssignment_pkey";
ALTER INDEX "AreaAssignment_userId_idx" RENAME TO "PortfolioAssignment_userId_idx";
ALTER INDEX "AreaAssignment_areaId_idx" RENAME TO "PortfolioAssignment_portfolioId_idx";
ALTER INDEX "AreaAssignment_userId_areaId_customRoleId_key"
  RENAME TO "PortfolioAssignment_userId_portfolioId_customRoleId_key";
ALTER TABLE "PortfolioAssignment" RENAME CONSTRAINT "AreaAssignment_areaId_fkey"       TO "PortfolioAssignment_portfolioId_fkey";
ALTER TABLE "PortfolioAssignment" RENAME CONSTRAINT "AreaAssignment_customRoleId_fkey" TO "PortfolioAssignment_customRoleId_fkey";
ALTER TABLE "PortfolioAssignment" RENAME CONSTRAINT "AreaAssignment_grantedById_fkey"  TO "PortfolioAssignment_grantedById_fkey";
ALTER TABLE "PortfolioAssignment" RENAME CONSTRAINT "AreaAssignment_userId_fkey"       TO "PortfolioAssignment_userId_fkey";

-- ── 2. Audit scopes ──────────────────────────────────────────────────────
-- Renamed in place rather than added-and-migrated: the historical rows mean
-- exactly what they always meant, the thing they name just has a new name.
ALTER TYPE "AuditScope" RENAME VALUE 'AREA'            TO 'PORTFOLIO';
ALTER TYPE "AuditScope" RENAME VALUE 'AREA_ASSIGNMENT' TO 'PORTFOLIO_ASSIGNMENT';

-- ── 3. Membership becomes many-to-many ───────────────────────────────────
CREATE TABLE "PropertyPortfolio" (
    "propertyId"  TEXT NOT NULL,
    "portfolioId" TEXT NOT NULL,
    "addedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedById"   TEXT,
    CONSTRAINT "PropertyPortfolio_pkey" PRIMARY KEY ("propertyId","portfolioId")
);
CREATE INDEX "PropertyPortfolio_portfolioId_idx" ON "PropertyPortfolio"("portfolioId");
ALTER TABLE "PropertyPortfolio" ADD CONSTRAINT "PropertyPortfolio_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyPortfolio" ADD CONSTRAINT "PropertyPortfolio_portfolioId_fkey"
  FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "JobOccurrencePortfolio" (
    "occurrenceId" TEXT NOT NULL,
    "portfolioId"  TEXT NOT NULL,
    "frozenAt"     TIMESTAMP(3),
    CONSTRAINT "JobOccurrencePortfolio_pkey" PRIMARY KEY ("occurrenceId","portfolioId")
);
CREATE INDEX "JobOccurrencePortfolio_portfolioId_idx" ON "JobOccurrencePortfolio"("portfolioId");
ALTER TABLE "JobOccurrencePortfolio" ADD CONSTRAINT "JobOccurrencePortfolio_occurrenceId_fkey"
  FOREIGN KEY ("occurrenceId") REFERENCES "JobOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobOccurrencePortfolio" ADD CONSTRAINT "JobOccurrencePortfolio_portfolioId_fkey"
  FOREIGN KEY ("portfolioId") REFERENCES "Portfolio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. Carry the existing single memberships across ──────────────────────
-- One row each, so nothing moves and no rollup changes on the day of the
-- deploy. `frozenAt` takes the completion time, which is what froze it.
INSERT INTO "PropertyPortfolio" ("propertyId", "portfolioId")
  SELECT "id", "areaId" FROM "Property" WHERE "areaId" IS NOT NULL;

INSERT INTO "JobOccurrencePortfolio" ("occurrenceId", "portfolioId", "frozenAt")
  SELECT "id", "areaId", "completedAt" FROM "JobOccurrence" WHERE "areaId" IS NOT NULL;

-- ── 5. Retire the single columns ─────────────────────────────────────────
-- `Job.defaultAreaId` is dropped rather than renamed. It answered "where do
-- future occurrences land when the previous one cannot say", and the chain
-- it belonged to is gone: an open visit now follows its property's current
-- memberships directly, so there is no unanswerable case left to default.
ALTER TABLE "Property"      DROP COLUMN "areaId";
ALTER TABLE "JobOccurrence" DROP COLUMN "areaId";
ALTER TABLE "Job"           DROP COLUMN "defaultAreaId";

-- ── 6. Settings and entitlements ─────────────────────────────────────────
-- Keys and entitlement ids are plain strings, so both are data updates.
-- `value` is left alone: the operator's tier labels are their copy.
UPDATE "Setting" SET "key" = 'PORTFOLIO_TIER_NAMES' WHERE "key" = 'AREA_TIER_NAMES';
UPDATE "Setting" SET "key" = 'PORTFOLIO_TREE'       WHERE "key" = 'AREA_TREE';

UPDATE "RoleEntitlement" SET "entitlement" = 'portfolios.view'   WHERE "entitlement" = 'areas.view';
UPDATE "RoleEntitlement" SET "entitlement" = 'portfolios.manage' WHERE "entitlement" = 'areas.manage';
