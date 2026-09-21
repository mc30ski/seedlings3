-- CreateEnum
CREATE TYPE "DisplayMode" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'DISPLAY';

-- AlterTable
ALTER TABLE "JobOccurrencePhoto" ADD COLUMN     "featuredById" TEXT,
ADD COLUMN     "featuredForDisplayAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Display" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "DisplayMode" NOT NULL DEFAULT 'PUBLIC',
    "tokenHash" TEXT NOT NULL,
    "farViewing" BOOLEAN NOT NULL DEFAULT true,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pairedById" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastSeenIp" TEXT,
    "lastSeenUserAgent" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Display_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisplayPairing" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "deviceSecretHash" TEXT NOT NULL,
    "requestedIp" TEXT,
    "requestedUserAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "displayId" TEXT,
    "issuedToken" TEXT,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisplayPairing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Display_tokenHash_key" ON "Display"("tokenHash");

-- CreateIndex
CREATE INDEX "Display_tokenHash_idx" ON "Display"("tokenHash");

-- CreateIndex
CREATE INDEX "Display_revokedAt_idx" ON "Display"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DisplayPairing_code_key" ON "DisplayPairing"("code");

-- CreateIndex
CREATE UNIQUE INDEX "DisplayPairing_deviceSecretHash_key" ON "DisplayPairing"("deviceSecretHash");

-- CreateIndex
CREATE INDEX "DisplayPairing_code_idx" ON "DisplayPairing"("code");

-- CreateIndex
CREATE INDEX "DisplayPairing_expiresAt_idx" ON "DisplayPairing"("expiresAt");

-- CreateIndex
CREATE INDEX "JobOccurrencePhoto_featuredForDisplayAt_idx" ON "JobOccurrencePhoto"("featuredForDisplayAt");

-- AddForeignKey
ALTER TABLE "JobOccurrencePhoto" ADD CONSTRAINT "JobOccurrencePhoto_featuredById_fkey" FOREIGN KEY ("featuredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_pairedById_fkey" FOREIGN KEY ("pairedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Display" ADD CONSTRAINT "Display_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
