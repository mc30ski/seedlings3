-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_RESERVED';
ALTER TYPE "AuditAction" ADD VALUE 'RESERVATION_CANCELLED';
ALTER TYPE "AuditAction" ADD VALUE 'EQUIPMENT_RETURNED';
ALTER TYPE "AuditAction" ADD VALUE 'FORCE_RELEASED';
