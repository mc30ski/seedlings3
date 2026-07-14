-- CreateTable
CREATE TABLE "DocumentSyncQueue" (
    "id" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "documentId" TEXT,
    "versionId" TEXT,
    "payload" JSONB,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSyncQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSyncState" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT,
    "driveId" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentSyncQueue_state_nextAttemptAt_idx" ON "DocumentSyncQueue"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DocumentSyncQueue_documentId_state_idx" ON "DocumentSyncQueue"("documentId", "state");

-- CreateIndex
CREATE INDEX "DocumentSyncQueue_taskType_state_idx" ON "DocumentSyncQueue"("taskType", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSyncState_entityId_key" ON "DocumentSyncState"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSyncState_driveId_key" ON "DocumentSyncState"("driveId");

-- CreateIndex
CREATE INDEX "DocumentSyncState_kind_idx" ON "DocumentSyncState"("kind");

-- CreateIndex
CREATE INDEX "DocumentSyncState_documentId_idx" ON "DocumentSyncState"("documentId");
