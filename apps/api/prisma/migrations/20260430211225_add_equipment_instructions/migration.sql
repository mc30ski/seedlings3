-- CreateTable
CREATE TABLE "EquipmentInstruction" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EquipmentInstruction_equipmentId_idx" ON "EquipmentInstruction"("equipmentId");

-- AddForeignKey
ALTER TABLE "EquipmentInstruction" ADD CONSTRAINT "EquipmentInstruction_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
