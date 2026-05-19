-- Migration: add_payment_approval_lifecycle
--
-- Captures every payment-related schema change made via `prisma db push`
-- between the previous migration (20260512175839_add_home_banners) and
-- the introduction of the admin-approval payment workflow.
--
-- Covers:
--   * Payment row gains confirmed / confirmedAt / confirmedById /
--     selfReported, and `collectedById` becomes nullable (client
--     self-reports have no logged-in actor).
--   * JobOccurrence gains the payment-request token + lifecycle fields
--     (token, tokenCreatedAt, sentAt, completionSplits, last-reject /
--     last-revert reason+timestamp).
--   * User gains paymentCommsMode (per-user override of the org-wide
--     DEFAULT_PAYMENT_COMMUNICATIONS_MODE setting).
--   * ClientContact gains preferredPaymentMethod and the
--     clientAccountCreatedFromPaymentPageAt timestamp.
--   * New PaymentCommsMode enum.
--   * New AuditScope value PAYMENT and four AuditVerb values
--     (SELF_REPORTED, REJECTED, REQUEST_SENT, TOKEN_ACCESSED).

-- CreateEnum
CREATE TYPE "PaymentCommsMode" AS ENUM ('SERVER', 'CLAIMER');

-- AlterEnum
ALTER TYPE "AuditScope" ADD VALUE 'PAYMENT';

-- AlterEnum (multiple new verbs)
-- Each ADD VALUE must be in its own statement; cannot batch in a single
-- ALTER TYPE in older Postgres versions.
ALTER TYPE "AuditVerb" ADD VALUE 'SELF_REPORTED';
ALTER TYPE "AuditVerb" ADD VALUE 'REJECTED';
ALTER TYPE "AuditVerb" ADD VALUE 'REQUEST_SENT';
ALTER TYPE "AuditVerb" ADD VALUE 'TOKEN_ACCESSED';

-- AlterTable: Payment — confirmation/self-report metadata
ALTER TABLE "Payment" ADD COLUMN "confirmed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN "confirmedById" TEXT;
ALTER TABLE "Payment" ADD COLUMN "selfReported" BOOLEAN NOT NULL DEFAULT false;
-- Client self-reports have no logged-in actor — allow null.
ALTER TABLE "Payment" ALTER COLUMN "collectedById" DROP NOT NULL;

-- Index for the Pending Approvals queue (lists confirmed=false ordered by createdAt)
CREATE INDEX "Payment_confirmed_createdAt_idx" ON "Payment"("confirmed", "createdAt");

-- FK for confirmedById → User
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: JobOccurrence — payment-request lifecycle
ALTER TABLE "JobOccurrence" ADD COLUMN "paymentRequestToken" TEXT;
ALTER TABLE "JobOccurrence" ADD COLUMN "paymentRequestTokenCreatedAt" TIMESTAMP(3);
ALTER TABLE "JobOccurrence" ADD COLUMN "paymentRequestSentAt" TIMESTAMP(3);
ALTER TABLE "JobOccurrence" ADD COLUMN "completionSplits" JSONB;
ALTER TABLE "JobOccurrence" ADD COLUMN "lastPaymentRejectionReason" TEXT;
ALTER TABLE "JobOccurrence" ADD COLUMN "lastPaymentRejectedAt" TIMESTAMP(3);
ALTER TABLE "JobOccurrence" ADD COLUMN "lastPaymentRevertReason" TEXT;
ALTER TABLE "JobOccurrence" ADD COLUMN "lastPaymentRevertedAt" TIMESTAMP(3);

-- Unique index on the public token slug
CREATE UNIQUE INDEX "JobOccurrence_paymentRequestToken_key" ON "JobOccurrence"("paymentRequestToken");

-- AlterTable: User — per-user payment-comms override
ALTER TABLE "User" ADD COLUMN "paymentCommsMode" "PaymentCommsMode";

-- AlterTable: ClientContact — preferred method memory + signup tag
ALTER TABLE "ClientContact" ADD COLUMN "preferredPaymentMethod" "PaymentMethod";
ALTER TABLE "ClientContact" ADD COLUMN "clientAccountCreatedFromPaymentPageAt" TIMESTAMP(3);
