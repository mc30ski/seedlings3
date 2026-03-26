-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'SETTING';
ALTER TYPE "AuditVerb" ADD VALUE 'SETTING_UPDATED';

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- AddForeignKey
ALTER TABLE "Setting" ADD CONSTRAINT "Setting_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed initial settings
INSERT INTO "Setting" ("id", "key", "value", "description", "updatedAt")
VALUES (
    'setting_high_value_threshold',
    'HIGH_VALUE_JOB_THRESHOLD',
    '200',
    'Dollar amount at or above which jobs require an employee or insured contractor to claim',
    NOW()
);
