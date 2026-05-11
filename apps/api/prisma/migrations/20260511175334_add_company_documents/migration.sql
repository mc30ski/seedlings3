-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'DOCUMENT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'VERSION_ADDED';
ALTER TYPE "AuditVerb" ADD VALUE 'VERSION_RESTORED';
ALTER TYPE "AuditVerb" ADD VALUE 'VERSION_DELETED';
ALTER TYPE "AuditVerb" ADD VALUE 'VIEWED';
ALTER TYPE "AuditVerb" ADD VALUE 'DOWNLOADED';

-- CreateTable
CREATE TABLE "CompanyDocument" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "expiresAt" TIMESTAMP(3),
    "adminHidden" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionId" TEXT,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDocument_currentVersionId_key" ON "CompanyDocument"("currentVersionId");

-- CreateIndex
CREATE INDEX "CompanyDocument_type_archivedAt_idx" ON "CompanyDocument"("type", "archivedAt");

-- CreateIndex
CREATE INDEX "CompanyDocument_expiresAt_idx" ON "CompanyDocument"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyDocumentVersion_r2Key_key" ON "CompanyDocumentVersion"("r2Key");

-- CreateIndex
CREATE INDEX "CompanyDocumentVersion_documentId_uploadedAt_idx" ON "CompanyDocumentVersion"("documentId", "uploadedAt");

-- AddForeignKey
ALTER TABLE "CompanyDocument" ADD CONSTRAINT "CompanyDocument_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "CompanyDocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDocument" ADD CONSTRAINT "CompanyDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDocumentVersion" ADD CONSTRAINT "CompanyDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "CompanyDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyDocumentVersion" ADD CONSTRAINT "CompanyDocumentVersion_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
