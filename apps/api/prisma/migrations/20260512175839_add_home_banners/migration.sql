-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'BANNER';

-- CreateTable
CREATE TABLE "BannerNotification" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BannerNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BannerRecipient" (
    "id" TEXT NOT NULL,
    "bannerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "BannerRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BannerDismissal" (
    "id" TEXT NOT NULL,
    "bannerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BannerDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BannerNotification_createdAt_idx" ON "BannerNotification"("createdAt");

-- CreateIndex
CREATE INDEX "BannerNotification_expiresAt_idx" ON "BannerNotification"("expiresAt");

-- CreateIndex
CREATE INDEX "BannerRecipient_userId_idx" ON "BannerRecipient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BannerRecipient_bannerId_userId_key" ON "BannerRecipient"("bannerId", "userId");

-- CreateIndex
CREATE INDEX "BannerDismissal_userId_idx" ON "BannerDismissal"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BannerDismissal_bannerId_userId_key" ON "BannerDismissal"("bannerId", "userId");

-- AddForeignKey
ALTER TABLE "BannerNotification" ADD CONSTRAINT "BannerNotification_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerRecipient" ADD CONSTRAINT "BannerRecipient_bannerId_fkey" FOREIGN KEY ("bannerId") REFERENCES "BannerNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerRecipient" ADD CONSTRAINT "BannerRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerDismissal" ADD CONSTRAINT "BannerDismissal_bannerId_fkey" FOREIGN KEY ("bannerId") REFERENCES "BannerNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerDismissal" ADD CONSTRAINT "BannerDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
