-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'NOTIFICATION';

-- AlterEnum
ALTER TYPE "AuditVerb" ADD VALUE 'SENT';

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationTemplate_sortOrder_name_idx" ON "NotificationTemplate"("sortOrder", "name");
