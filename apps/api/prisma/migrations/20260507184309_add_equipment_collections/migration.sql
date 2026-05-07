-- CreateTable
CREATE TABLE "EquipmentCollection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentCollectionItem" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentCollectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRecommendedCollection" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRecommendedCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentCollection_sortOrder_name_idx" ON "EquipmentCollection"("sortOrder", "name");

-- CreateIndex
CREATE INDEX "EquipmentCollectionItem_equipmentId_idx" ON "EquipmentCollectionItem"("equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentCollectionItem_collectionId_sortOrder_idx" ON "EquipmentCollectionItem"("collectionId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentCollectionItem_collectionId_equipmentId_key" ON "EquipmentCollectionItem"("collectionId", "equipmentId");

-- CreateIndex
CREATE INDEX "JobRecommendedCollection_jobId_sortOrder_idx" ON "JobRecommendedCollection"("jobId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "JobRecommendedCollection_jobId_collectionId_key" ON "JobRecommendedCollection"("jobId", "collectionId");

-- AddForeignKey
ALTER TABLE "EquipmentCollectionItem" ADD CONSTRAINT "EquipmentCollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "EquipmentCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentCollectionItem" ADD CONSTRAINT "EquipmentCollectionItem_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRecommendedCollection" ADD CONSTRAINT "JobRecommendedCollection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRecommendedCollection" ADD CONSTRAINT "JobRecommendedCollection_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "EquipmentCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
