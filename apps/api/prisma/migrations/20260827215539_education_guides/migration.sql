-- CreateEnum
CREATE TYPE "GuideVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REJECTED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "GuideAssetKind" AS ENUM ('IMAGE', 'VIDEO');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditScope" ADD VALUE 'GUIDE';
ALTER TYPE "AuditScope" ADD VALUE 'GUIDE_ASSET';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'SUBMITTED';
ALTER TYPE "AuditVerb" ADD VALUE 'PUBLISHED';
ALTER TYPE "AuditVerb" ADD VALUE 'UNPUBLISHED';
ALTER TYPE "AuditVerb" ADD VALUE 'ROLLED_BACK';
ALTER TYPE "AuditVerb" ADD VALUE 'PURGED';
ALTER TYPE "AuditVerb" ADD VALUE 'SIZE_LIMIT_OVERRIDDEN';

-- CreateTable
CREATE TABLE "Guide" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "categoryKey" TEXT NOT NULL,
    "tags" TEXT[],
    "currentVersionId" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Guide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuideVersion" (
    "id" TEXT NOT NULL,
    "guideId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "contentMarkdown" TEXT NOT NULL,
    "contentDigest" TEXT NOT NULL,
    "changeNote" TEXT NOT NULL,
    "status" "GuideVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectionNote" TEXT,

    CONSTRAINT "GuideVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuideAsset" (
    "id" TEXT NOT NULL,
    "kind" "GuideAssetKind" NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "altText" TEXT,
    "sizeOverride" BOOLEAN NOT NULL DEFAULT false,
    "guideId" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuideAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Guide_slug_key" ON "Guide"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Guide_currentVersionId_key" ON "Guide"("currentVersionId");

-- CreateIndex
CREATE INDEX "Guide_categoryKey_archivedAt_idx" ON "Guide"("categoryKey", "archivedAt");

-- CreateIndex
CREATE INDEX "Guide_archivedAt_idx" ON "Guide"("archivedAt");

-- CreateIndex
CREATE INDEX "GuideVersion_status_idx" ON "GuideVersion"("status");

-- CreateIndex
CREATE INDEX "GuideVersion_guideId_status_idx" ON "GuideVersion"("guideId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GuideVersion_guideId_versionNumber_key" ON "GuideVersion"("guideId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GuideAsset_r2Key_key" ON "GuideAsset"("r2Key");

-- CreateIndex
CREATE INDEX "GuideAsset_kind_uploadedAt_idx" ON "GuideAsset"("kind", "uploadedAt");

-- CreateIndex
CREATE INDEX "GuideAsset_guideId_idx" ON "GuideAsset"("guideId");

-- CreateIndex
CREATE INDEX "GuideAsset_uploadedById_idx" ON "GuideAsset"("uploadedById");

-- AddForeignKey
ALTER TABLE "Guide" ADD CONSTRAINT "Guide_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "GuideVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guide" ADD CONSTRAINT "Guide_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guide" ADD CONSTRAINT "Guide_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideVersion" ADD CONSTRAINT "GuideVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideVersion" ADD CONSTRAINT "GuideVersion_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideVersion" ADD CONSTRAINT "GuideVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideVersion" ADD CONSTRAINT "GuideVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideVersion" ADD CONSTRAINT "GuideVersion_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideVersion" ADD CONSTRAINT "GuideVersion_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "Guide"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideAsset" ADD CONSTRAINT "GuideAsset_guideId_fkey" FOREIGN KEY ("guideId") REFERENCES "Guide"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuideAsset" ADD CONSTRAINT "GuideAsset_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
