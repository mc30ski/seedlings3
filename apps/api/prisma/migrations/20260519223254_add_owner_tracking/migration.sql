-- Owner tracking: a single User can be flagged as the LLC owner. Their job
-- earnings are tracked exactly like any worker's, but PaymentSplit rows that
-- belong to the owner are marked so the Gusto payroll export can exclude
-- them (the owner takes a draw, not a paycheck) and audit can flag them.

-- 1. AuditVerb additions
ALTER TYPE "AuditVerb" ADD VALUE 'OWNER_EARNINGS_RECORDED';

-- 2. User: isOwner flag (nullable=false, default false). Enforced singleton
--    via a partial unique index — at most one row may have isOwner=true.
ALTER TABLE "User" ADD COLUMN "isOwner" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "User_isOwner_singleton" ON "User" ("isOwner") WHERE "isOwner" = true;

-- 3. PaymentSplit: ownerEarnings flag (stamped at write time when the split's
--    userId references the current owner). Excluded from Gusto/payroll exports.
ALTER TABLE "PaymentSplit" ADD COLUMN "ownerEarnings" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "PaymentSplit_ownerEarnings_createdAt_idx" ON "PaymentSplit" ("ownerEarnings", "createdAt");
