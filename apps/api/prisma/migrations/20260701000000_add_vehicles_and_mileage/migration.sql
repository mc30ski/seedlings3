-- Dual-use vehicles + business mileage tracking.
-- Three new tables. All additive; no changes to existing rows.
-- See schema.prisma for the design notes.

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "make" TEXT,
    "vehicleModel" TEXT,
    "year" INTEGER,
    "plate" TEXT,
    "inServiceDate" TEXT,
    "currentOdometer" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vehicle_archivedAt_idx" ON "Vehicle"("archivedAt");

-- CreateTable
CREATE TABLE "VehicleAssignment" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "VehicleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehicleAssignment_vehicleId_userId_key" ON "VehicleAssignment"("vehicleId", "userId");

-- CreateIndex
CREATE INDEX "VehicleAssignment_userId_archivedAt_idx" ON "VehicleAssignment"("userId", "archivedAt");

-- AddForeignKey
ALTER TABLE "VehicleAssignment" ADD CONSTRAINT "VehicleAssignment_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleAssignment" ADD CONSTRAINT "VehicleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "MileageEntry" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "driverUserId" TEXT NOT NULL,
    "entryDate" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "startOdometer" INTEGER NOT NULL,
    "endOdometer" INTEGER,
    "miles" DOUBLE PRECISION,
    "notes" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MileageEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MileageEntry_driverUserId_entryDate_idx" ON "MileageEntry"("driverUserId", "entryDate");

-- CreateIndex
CREATE INDEX "MileageEntry_vehicleId_entryDate_idx" ON "MileageEntry"("vehicleId", "entryDate");

-- CreateIndex
CREATE INDEX "MileageEntry_entryDate_approvedAt_idx" ON "MileageEntry"("entryDate", "approvedAt");

-- AddForeignKey
ALTER TABLE "MileageEntry" ADD CONSTRAINT "MileageEntry_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MileageEntry" ADD CONSTRAINT "MileageEntry_driverUserId_fkey" FOREIGN KEY ("driverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MileageEntry" ADD CONSTRAINT "MileageEntry_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
