-- CreateTable
CREATE TABLE "CacheEntry" (
    "key" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CacheEntry_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "CacheEntry_namespace_idx" ON "CacheEntry"("namespace");

-- CreateIndex
CREATE INDEX "CacheEntry_expiresAt_idx" ON "CacheEntry"("expiresAt");
