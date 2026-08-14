-- Vanity URLs: configurable branded shortcuts served only on satellite
-- marketing domains (currently seedlings.pro). Two kinds:
--   LANDING  — renders an in-app marketing page
--   REDIRECT — 302s to a configured URL
-- One row can be marked isDefault=true and serves as the fallback for
-- visitors hitting an unknown slug.

-- Add VANITY to AuditScope enum
ALTER TYPE "AuditScope" ADD VALUE IF NOT EXISTS 'VANITY';

-- New enum for vanity kind
CREATE TYPE "VanityPageKind" AS ENUM ('LANDING', 'REDIRECT');

CREATE TABLE "VanityPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "VanityPageKind" NOT NULL DEFAULT 'LANDING',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT '',
    "headline" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "ctaText" TEXT,
    "ctaUrl" TEXT,
    "imageR2Key" TEXT,
    "redirectUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "VanityPage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VanityPage_slug_key" ON "VanityPage"("slug");
CREATE INDEX "VanityPage_enabled_slug_idx" ON "VanityPage"("enabled", "slug");
CREATE INDEX "VanityPage_isDefault_idx" ON "VanityPage"("isDefault");

ALTER TABLE "VanityPage" ADD CONSTRAINT "VanityPage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VanityPage" ADD CONSTRAINT "VanityPage_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
