-- CreateTable
CREATE TABLE "PinnedEquipment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PinnedEquipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LikedEquipment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "likedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LikedEquipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinnedEquipment_userId_idx" ON "PinnedEquipment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PinnedEquipment_userId_equipmentId_key" ON "PinnedEquipment"("userId", "equipmentId");

-- CreateIndex
CREATE INDEX "LikedEquipment_userId_idx" ON "LikedEquipment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LikedEquipment_userId_equipmentId_key" ON "LikedEquipment"("userId", "equipmentId");

-- AddForeignKey
ALTER TABLE "PinnedEquipment" ADD CONSTRAINT "PinnedEquipment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinnedEquipment" ADD CONSTRAINT "PinnedEquipment_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LikedEquipment" ADD CONSTRAINT "LikedEquipment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LikedEquipment" ADD CONSTRAINT "LikedEquipment_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
