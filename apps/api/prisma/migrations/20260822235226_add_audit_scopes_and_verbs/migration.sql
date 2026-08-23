-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditScope" ADD VALUE 'EXPENSE';
ALTER TYPE "AuditScope" ADD VALUE 'SUPPLY';
ALTER TYPE "AuditScope" ADD VALUE 'MILEAGE';
ALTER TYPE "AuditScope" ADD VALUE 'GROUP';
ALTER TYPE "AuditScope" ADD VALUE 'VEHICLE';
ALTER TYPE "AuditScope" ADD VALUE 'CHANGE_REQUEST';
ALTER TYPE "AuditScope" ADD VALUE 'EQUIPMENT_COLLECTION';
ALTER TYPE "AuditScope" ADD VALUE 'CALENDAR_FEED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditVerb" ADD VALUE 'PURCHASE_RECORDED';
ALTER TYPE "AuditVerb" ADD VALUE 'HOLD_CREATED';
ALTER TYPE "AuditVerb" ADD VALUE 'HOLD_REMOVED';
ALTER TYPE "AuditVerb" ADD VALUE 'HOLD_ADJUSTED';
ALTER TYPE "AuditVerb" ADD VALUE 'UNAPPROVED';
ALTER TYPE "AuditVerb" ADD VALUE 'RECONCILED';
ALTER TYPE "AuditVerb" ADD VALUE 'RECEIPT_ATTACHED';
ALTER TYPE "AuditVerb" ADD VALUE 'RECEIPT_DELETED';
ALTER TYPE "AuditVerb" ADD VALUE 'ADDON_ADDED';
ALTER TYPE "AuditVerb" ADD VALUE 'ADDON_REMOVED';
ALTER TYPE "AuditVerb" ADD VALUE 'OCCURRENCE_DELETED';
ALTER TYPE "AuditVerb" ADD VALUE 'PHOTO_DELETED';
ALTER TYPE "AuditVerb" ADD VALUE 'COMMENT_DELETED';
ALTER TYPE "AuditVerb" ADD VALUE 'DENIED';
ALTER TYPE "AuditVerb" ADD VALUE 'SPLITS_UPDATED';
ALTER TYPE "AuditVerb" ADD VALUE 'WAGE_UPDATED';
ALTER TYPE "AuditVerb" ADD VALUE 'MEMBER_ADDED';
ALTER TYPE "AuditVerb" ADD VALUE 'MEMBER_REMOVED';
ALTER TYPE "AuditVerb" ADD VALUE 'MEMBER_UPDATED';
ALTER TYPE "AuditVerb" ADD VALUE 'ASSIGNED';
ALTER TYPE "AuditVerb" ADD VALUE 'UNASSIGNED';
ALTER TYPE "AuditVerb" ADD VALUE 'CANCELED';
