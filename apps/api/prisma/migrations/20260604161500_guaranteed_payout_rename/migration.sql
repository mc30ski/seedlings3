-- Rename make-whole → guaranteed payout. The concept is "guaranteed
-- payout period" (a Company-defined window during which contractor pay
-- is timing-decoupled from client payment), distinct from the existing
-- "made whole" accounting term that refers to absorbing client
-- underpayment shortfalls. Renames preserve any existing rows.

-- AlterTable User
ALTER TABLE "User" RENAME COLUMN "makeWholeUntil" TO "guaranteedPayoutUntil";
ALTER TABLE "User" RENAME COLUMN "makeWholeStartedAt" TO "guaranteedPayoutStartedAt";

-- AlterTable PaymentSplit
ALTER TABLE "PaymentSplit" RENAME COLUMN "advancePaidAt" TO "guaranteedPayoutPaidAt";

-- The existing index on the renamed column auto-follows the column rename.
-- (Postgres updates index column references; no DROP + CREATE INDEX needed.)

-- AlterEnum AuditVerb — rename the two values in place. Preserves any
-- existing AuditEvent rows referencing the old names.
ALTER TYPE "AuditVerb" RENAME VALUE 'MAKE_WHOLE_STARTED' TO 'GUARANTEED_PAYOUT_STARTED';
ALTER TYPE "AuditVerb" RENAME VALUE 'MAKE_WHOLE_ENDED' TO 'GUARANTEED_PAYOUT_ENDED';
