-- ═════════════════════════════════════════════════════════════════════════════
-- Compliance policy system
--
-- Introduces the PolicyDocument / PolicyDocumentVersion / PolicySignature /
-- PolicyException / PolicyReadingProgress model chain that replaces the old
-- per-user insurance / W-9 / contractor-agreement columns. See
-- apps/api/src/services/policies.ts + apps/api/src/lib/policyPredicate.ts.
--
-- Also seeds three "on Day 1" policy rows for the current concepts being
-- retired (Contractor Agreement, IRS W-9, Contractor Liability Insurance).
-- Every environment (dev + prod) gets these three rows on migrate so the
-- gates that used to fire against User.* columns keep firing against the
-- new policy system. Dev-only example policies (Safety SOP, Vehicle
-- Policy, Photo Release) live in seed.ts instead.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── Historic audit rows must be re-labeled before the AuditVerb enum can
--    drop the three retired values. Rewrite in-place to the generic UPDATED
--    verb so the trail is preserved without holding onto the enum labels.
--    Guarded so re-running (post partial failure) on an env where the enum
--    already swapped is a no-op — otherwise the literal 'INSURANCE_UPLOADED'
--    would fail to cast to the new enum type.
DO $migrate_audit$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel IN ('INSURANCE_UPLOADED', 'CONTRACTOR_AGREED', 'W9_COLLECTED')
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditVerb')
  ) THEN
    UPDATE "AuditEvent"
    SET "verb" = 'UPDATED', "action" = 'USER_UPDATED'
    WHERE "verb"::text IN ('INSURANCE_UPLOADED', 'CONTRACTOR_AGREED', 'W9_COLLECTED');
  END IF;
END
$migrate_audit$;

-- CreateEnum
CREATE TYPE "PolicyWorkerAction" AS ENUM ('SIGN', 'ACKNOWLEDGE', 'NONE');

-- CreateEnum
CREATE TYPE "PolicyEnforcement" AS ENUM ('BLOCK', 'WARN', 'INFO');

-- CreateEnum
CREATE TYPE "PolicyResignTrigger" AS ENUM ('ONE_TIME', 'DAYS_SINCE_SIGN', 'ANNIVERSARY', 'ANNUAL_ON_DATE');

-- CreateEnum
CREATE TYPE "PolicyGateService" AS ENUM ('WORKDAY_START', 'JOB_CLAIM', 'VEHICLE_RESERVE');

-- CreateEnum
CREATE TYPE "PolicyContentFormat" AS ENUM ('MARKDOWN', 'PDF');

-- CreateEnum
CREATE TYPE "PolicyNotifyChannel" AS ENUM ('PUSH_ONLY', 'ALL_CHANNELS');

-- CreateEnum
CREATE TYPE "PolicyVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "PolicyUploadStatus" AS ENUM ('NONE', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditScope" ADD VALUE 'POLICY_DOCUMENT';
ALTER TYPE "AuditScope" ADD VALUE 'POLICY_SIGNATURE';

-- AlterEnum
BEGIN;
CREATE TYPE "AuditVerb_new" AS ENUM ('APPROVED', 'ROLE_ASSIGNED', 'ROLE_REMOVED', 'CREATED', 'UPDATED', 'RETIRED', 'UNRETIRED', 'DELETED', 'CHECKED_OUT', 'RELEASED', 'MAINTENANCE_START', 'MAINTENANCE_END', 'RESERVED', 'RESERVATION_CANCELLED', 'RETURNED', 'FORCE_RELEASED', 'PRIMARY_CONTACT_SET', 'SETTING_UPDATED', 'WORKER_TYPE_SET', 'SENT', 'VERSION_ADDED', 'VERSION_RESTORED', 'VERSION_DELETED', 'VIEWED', 'DOWNLOADED', 'COMPLETED', 'SELF_REPORTED', 'REJECTED', 'REQUEST_SENT', 'TOKEN_ACCESSED', 'WRITTEN_OFF', 'SKIPPED', 'UNSKIPPED', 'ADJUSTED', 'OWNER_EARNINGS_RECORDED', 'FEE_APPLIED', 'PAYMENT_METHOD_UPDATED', 'GUARANTEED_PAYOUT_STARTED', 'GUARANTEED_PAYOUT_ENDED', 'SIGN_IN', 'POLICY_VERSION_DRAFTED', 'POLICY_VERSION_SUBMITTED_FOR_APPROVAL', 'POLICY_VERSION_APPROVED', 'POLICY_VERSION_PUBLISHED', 'POLICY_VERSION_ROLLED_BACK', 'POLICY_SIGNED', 'POLICY_SIGNATURE_REVOKED', 'POLICY_UPLOAD_REVIEWED', 'POLICY_FORCE_RESIGN', 'POLICY_EXCEPTION_GRANTED', 'POLICY_EXCEPTION_REVOKED', 'POLICY_ARCHIVED', 'POLICY_UNARCHIVED', 'POLICY_ADMIN_UPLOADED_ON_BEHALF');
ALTER TABLE "AuditEvent" ALTER COLUMN "verb" TYPE "AuditVerb_new" USING ("verb"::text::"AuditVerb_new");
ALTER TYPE "AuditVerb" RENAME TO "AuditVerb_old";
ALTER TYPE "AuditVerb_new" RENAME TO "AuditVerb";
DROP TYPE "public"."AuditVerb_old";
COMMIT;

-- AlterTable
ALTER TABLE "Equipment" DROP COLUMN "requiresInsurance",
ADD COLUMN     "requiredPolicyIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" DROP COLUMN "contractorAgreedAt",
DROP COLUMN "insuranceCertContentType",
DROP COLUMN "insuranceCertFileName",
DROP COLUMN "insuranceCertR2Key",
DROP COLUMN "insuranceExpiresAt",
DROP COLUMN "w9Collected",
DROP COLUMN "w9CollectedAt";

-- CreateTable
CREATE TABLE "PolicyDocument" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "targetWorkerTypes" "WorkerType"[],
    "enforcement" "PolicyEnforcement" NOT NULL,
    "workerAction" "PolicyWorkerAction" NOT NULL,
    "adminCanUploadOnBehalf" BOOLEAN NOT NULL DEFAULT false,
    "requiresWorkerUpload" BOOLEAN NOT NULL DEFAULT false,
    "workerUploadLabel" TEXT,
    "workerUploadAcceptedTypes" TEXT,
    "workerUploadRequiresExpiry" BOOLEAN NOT NULL DEFAULT false,
    "workerUploadRequiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "resignTrigger" "PolicyResignTrigger" NOT NULL,
    "resignParamDays" INTEGER,
    "resignParamMonthDay" TEXT,
    "gatesServices" "PolicyGateService"[],
    "gatesJobsAbovePrice" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "currentVersionId" TEXT,
    "notifyOnPublish" "PolicyNotifyChannel" NOT NULL DEFAULT 'PUSH_ONLY',
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolicyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDocumentVersion" (
    "id" TEXT NOT NULL,
    "policyDocumentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "contentFormat" "PolicyContentFormat" NOT NULL,
    "contentMarkdown" TEXT,
    "contentR2Key" TEXT,
    "contentFileName" TEXT,
    "contentContentType" TEXT,
    "pdfPageCount" INTEGER,
    "contentDigest" TEXT NOT NULL,
    "changeNote" TEXT NOT NULL,
    "forcesResign" BOOLEAN NOT NULL DEFAULT false,
    "graceUntil" TIMESTAMP(3),
    "status" "PolicyVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "rolledBackById" TEXT,
    "rolledBackReason" TEXT,

    CONSTRAINT "PolicyDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicySignature" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyDocumentVersionId" TEXT NOT NULL,
    "workerActionAtSign" "PolicyWorkerAction" NOT NULL,
    "signedByUserId" TEXT NOT NULL,
    "onBehalfOfUserId" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "typedNameRaw" TEXT,
    "typedNameNormalized" TEXT,
    "signatureIp" TEXT,
    "signatureUserAgent" TEXT,
    "contentDigestAtSign" TEXT NOT NULL,
    "uploadR2Key" TEXT,
    "uploadFileName" TEXT,
    "uploadContentType" TEXT,
    "uploadDigest" TEXT,
    "uploadExpiresAt" TIMESTAMP(3),
    "uploadStatus" "PolicyUploadStatus" NOT NULL DEFAULT 'NONE',
    "uploadReviewedAt" TIMESTAMP(3),
    "uploadReviewedById" TEXT,
    "uploadRejectionReason" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedReason" TEXT,

    CONSTRAINT "PolicySignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyException" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyDocumentId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedReason" TEXT,

    CONSTRAINT "PolicyException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyReadingProgress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyDocumentVersionId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policySignatureId" TEXT,

    CONSTRAINT "PolicyReadingProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocument_key_key" ON "PolicyDocument"("key");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocument_currentVersionId_key" ON "PolicyDocument"("currentVersionId");

-- CreateIndex
CREATE INDEX "PolicyDocument_archivedAt_idx" ON "PolicyDocument"("archivedAt");

-- CreateIndex
CREATE INDEX "PolicyDocument_sortOrder_idx" ON "PolicyDocument"("sortOrder");

-- CreateIndex
CREATE INDEX "PolicyDocumentVersion_status_idx" ON "PolicyDocumentVersion"("status");

-- CreateIndex
CREATE INDEX "PolicyDocumentVersion_policyDocumentId_status_idx" ON "PolicyDocumentVersion"("policyDocumentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocumentVersion_policyDocumentId_versionNumber_key" ON "PolicyDocumentVersion"("policyDocumentId", "versionNumber");

-- CreateIndex
CREATE INDEX "PolicySignature_userId_signedAt_idx" ON "PolicySignature"("userId", "signedAt");

-- CreateIndex
CREATE INDEX "PolicySignature_policyDocumentVersionId_idx" ON "PolicySignature"("policyDocumentVersionId");

-- CreateIndex
CREATE INDEX "PolicySignature_userId_policyDocumentVersionId_idx" ON "PolicySignature"("userId", "policyDocumentVersionId");

-- CreateIndex
CREATE INDEX "PolicySignature_uploadStatus_idx" ON "PolicySignature"("uploadStatus");

-- CreateIndex
CREATE INDEX "PolicySignature_revokedAt_idx" ON "PolicySignature"("revokedAt");

-- CreateIndex
CREATE INDEX "PolicyException_userId_policyDocumentId_idx" ON "PolicyException"("userId", "policyDocumentId");

-- CreateIndex
CREATE INDEX "PolicyException_expiresAt_idx" ON "PolicyException"("expiresAt");

-- CreateIndex
CREATE INDEX "PolicyReadingProgress_userId_policyDocumentVersionId_idx" ON "PolicyReadingProgress"("userId", "policyDocumentVersionId");

-- CreateIndex
CREATE INDEX "PolicyReadingProgress_policySignatureId_idx" ON "PolicyReadingProgress"("policySignatureId");

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "PolicyDocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_policyDocumentId_fkey" FOREIGN KEY ("policyDocumentId") REFERENCES "PolicyDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_rolledBackById_fkey" FOREIGN KEY ("rolledBackById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicySignature" ADD CONSTRAINT "PolicySignature_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicySignature" ADD CONSTRAINT "PolicySignature_policyDocumentVersionId_fkey" FOREIGN KEY ("policyDocumentVersionId") REFERENCES "PolicyDocumentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicySignature" ADD CONSTRAINT "PolicySignature_signedByUserId_fkey" FOREIGN KEY ("signedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicySignature" ADD CONSTRAINT "PolicySignature_onBehalfOfUserId_fkey" FOREIGN KEY ("onBehalfOfUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicySignature" ADD CONSTRAINT "PolicySignature_uploadReviewedById_fkey" FOREIGN KEY ("uploadReviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicySignature" ADD CONSTRAINT "PolicySignature_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyException" ADD CONSTRAINT "PolicyException_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyException" ADD CONSTRAINT "PolicyException_policyDocumentId_fkey" FOREIGN KEY ("policyDocumentId") REFERENCES "PolicyDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyException" ADD CONSTRAINT "PolicyException_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyException" ADD CONSTRAINT "PolicyException_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyReadingProgress" ADD CONSTRAINT "PolicyReadingProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyReadingProgress" ADD CONSTRAINT "PolicyReadingProgress_policyDocumentVersionId_fkey" FOREIGN KEY ("policyDocumentVersionId") REFERENCES "PolicyDocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- Prod seed: three PolicyDocument rows + one PUBLISHED v1 each
--
-- These rows preserve the compliance concepts that existed on User columns
-- pre-migration. Admin can edit / rename / archive them freely after
-- deploy, but they exist on Day 1 so the gate infrastructure (Slice 3)
-- has something to reference immediately.
--
-- Seed admin resolved at migration-run time: first SUPER, else first ADMIN,
-- else first user by createdAt. Guards against a totally-empty user table.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  seed_admin_id       TEXT;
  policy_agreement_id TEXT;
  policy_w9_id        TEXT;
  policy_insurance_id TEXT;
  version_agreement_id TEXT;
  version_w9_id        TEXT;
  version_insurance_id TEXT;
  now_ts               TIMESTAMP := NOW();
BEGIN
  SELECT u.id INTO seed_admin_id
  FROM "User" u
  LEFT JOIN "UserRole" ur ON ur."userId" = u.id
  ORDER BY
    CASE WHEN ur.role = 'SUPER' THEN 0
         WHEN ur.role = 'ADMIN' THEN 1
         ELSE 2 END,
    u."createdAt" ASC
  LIMIT 1;

  IF seed_admin_id IS NULL THEN
    -- Empty DB (fresh install with no users yet) — skip seed. Admin will
    -- create policies manually via the Compliance tab once they onboard.
    RAISE NOTICE 'Compliance policy seed: no users found, skipping seed rows.';
    RETURN;
  END IF;

  -- Contractor Agreement.
  -- FK note: PolicyDocument.currentVersionId → PolicyDocumentVersion.id AND
  -- PolicyDocumentVersion.policyDocumentId → PolicyDocument.id form a
  -- circular reference. Both FKs are validated at row-insert time, so the
  -- Policy row goes in with NULL currentVersionId, then the Version row,
  -- then an UPDATE sets currentVersionId. Same pattern for W-9 + Insurance.
  policy_agreement_id  := gen_random_uuid()::text;
  version_agreement_id := gen_random_uuid()::text;
  INSERT INTO "PolicyDocument" (
    id, key, title, description, "targetWorkerTypes", enforcement, "workerAction",
    "adminCanUploadOnBehalf", "requiresWorkerUpload", "workerUploadLabel",
    "workerUploadAcceptedTypes", "workerUploadRequiresExpiry", "workerUploadRequiresApproval",
    "resignTrigger", "resignParamDays", "resignParamMonthDay",
    "gatesServices", "gatesJobsAbovePrice", "sortOrder",
    "currentVersionId", "notifyOnPublish",
    "createdById", "createdAt", "updatedAt"
  ) VALUES (
    policy_agreement_id, 'CONTRACTOR_AGREEMENT',
    'Contractor Agreement',
    'Terms of service between the company and independent contractors. Must be signed before claiming any jobs.',
    ARRAY['CONTRACTOR']::"WorkerType"[], 'BLOCK', 'SIGN',
    FALSE, FALSE, NULL,
    NULL, FALSE, FALSE,
    'ONE_TIME', NULL, NULL,
    ARRAY['WORKDAY_START']::"PolicyGateService"[], NULL, 10,
    NULL, 'ALL_CHANNELS',
    seed_admin_id, now_ts, now_ts
  );
  INSERT INTO "PolicyDocumentVersion" (
    id, "policyDocumentId", "versionNumber", "contentFormat", "contentMarkdown",
    "contentDigest", "changeNote", "forcesResign", "graceUntil", status,
    "createdById", "createdAt", "publishedAt", "publishedById"
  ) VALUES (
    version_agreement_id, policy_agreement_id, 1, 'MARKDOWN',
    E'# Contractor Agreement\n\n_Placeholder content — edit via the Compliance tab and publish a new version._\n\nBy signing below, I agree to the terms of engagement as an independent contractor with the company.',
    -- SHA-256 of the placeholder markdown. Not the real digest; overwritten
    -- when admin publishes v2 with real content.
    'placeholder-contractor-agreement-v1',
    'Initial placeholder — replace with real content on first publish.',
    FALSE, NULL, 'PUBLISHED',
    seed_admin_id, now_ts, now_ts, seed_admin_id
  );
  UPDATE "PolicyDocument"
  SET "currentVersionId" = version_agreement_id
  WHERE id = policy_agreement_id;

  -- IRS W-9
  policy_w9_id  := gen_random_uuid()::text;
  version_w9_id := gen_random_uuid()::text;
  INSERT INTO "PolicyDocument" (
    id, key, title, description, "targetWorkerTypes", enforcement, "workerAction",
    "adminCanUploadOnBehalf", "requiresWorkerUpload", "workerUploadLabel",
    "workerUploadAcceptedTypes", "workerUploadRequiresExpiry", "workerUploadRequiresApproval",
    "resignTrigger", "resignParamDays", "resignParamMonthDay",
    "gatesServices", "gatesJobsAbovePrice", "sortOrder",
    "currentVersionId", "notifyOnPublish",
    "createdById", "createdAt", "updatedAt"
  ) VALUES (
    policy_w9_id, 'W9_FORM',
    'IRS Form W-9',
    'Tax identification form required for 1099 contractors. Admin uploads a scanned PDF on behalf of the contractor.',
    ARRAY['CONTRACTOR']::"WorkerType"[], 'BLOCK', 'NONE',
    TRUE, TRUE, 'IRS Form W-9 (PDF)',
    'application/pdf,image/*', FALSE, TRUE,
    'ONE_TIME', NULL, NULL,
    ARRAY['WORKDAY_START']::"PolicyGateService"[], NULL, 20,
    NULL, 'PUSH_ONLY',
    seed_admin_id, now_ts, now_ts
  );
  INSERT INTO "PolicyDocumentVersion" (
    id, "policyDocumentId", "versionNumber", "contentFormat", "contentMarkdown",
    "contentDigest", "changeNote", "forcesResign", "graceUntil", status,
    "createdById", "createdAt", "publishedAt", "publishedById"
  ) VALUES (
    version_w9_id, policy_w9_id, 1, 'MARKDOWN',
    E'# IRS Form W-9\n\nAdmin uploads the contractor''s W-9 on file. Worker doesn''t interact with this policy.',
    'placeholder-w9-v1',
    'Initial placeholder.',
    FALSE, NULL, 'PUBLISHED',
    seed_admin_id, now_ts, now_ts, seed_admin_id
  );
  UPDATE "PolicyDocument"
  SET "currentVersionId" = version_w9_id
  WHERE id = policy_w9_id;

  -- Contractor Liability Insurance
  policy_insurance_id  := gen_random_uuid()::text;
  version_insurance_id := gen_random_uuid()::text;
  INSERT INTO "PolicyDocument" (
    id, key, title, description, "targetWorkerTypes", enforcement, "workerAction",
    "adminCanUploadOnBehalf", "requiresWorkerUpload", "workerUploadLabel",
    "workerUploadAcceptedTypes", "workerUploadRequiresExpiry", "workerUploadRequiresApproval",
    "resignTrigger", "resignParamDays", "resignParamMonthDay",
    "gatesServices", "gatesJobsAbovePrice", "sortOrder",
    "currentVersionId", "notifyOnPublish",
    "createdById", "createdAt", "updatedAt"
  ) VALUES (
    policy_insurance_id, 'INSURANCE_CERT',
    'Contractor Liability Insurance',
    'Certificate of Insurance for contractors. Required for high-value jobs and any equipment reservation flagged with this policy id.',
    ARRAY['CONTRACTOR']::"WorkerType"[], 'BLOCK', 'SIGN',
    TRUE, TRUE, 'Certificate of Insurance',
    'application/pdf,image/*', TRUE, TRUE,
    'DAYS_SINCE_SIGN', 3650, NULL,
    ARRAY['JOB_CLAIM', 'VEHICLE_RESERVE']::"PolicyGateService"[], 200.00, 30,
    NULL, 'ALL_CHANNELS',
    seed_admin_id, now_ts, now_ts
  );
  INSERT INTO "PolicyDocumentVersion" (
    id, "policyDocumentId", "versionNumber", "contentFormat", "contentMarkdown",
    "contentDigest", "changeNote", "forcesResign", "graceUntil", status,
    "createdById", "createdAt", "publishedAt", "publishedById"
  ) VALUES (
    version_insurance_id, policy_insurance_id, 1, 'MARKDOWN',
    E'# Contractor Liability Insurance\n\nUpload your current Certificate of Insurance below, then sign to attest that:\n\n1. The certificate is genuine and current.\n2. Coverage is at or above the minimum coverage limits the company requires.\n3. You will notify the company within 24 hours if your coverage lapses.\n\nAdmin will review your uploaded certificate before it counts as valid.',
    'placeholder-insurance-v1',
    'Initial placeholder.',
    FALSE, NULL, 'PUBLISHED',
    seed_admin_id, now_ts, now_ts, seed_admin_id
  );
  UPDATE "PolicyDocument"
  SET "currentVersionId" = version_insurance_id
  WHERE id = policy_insurance_id;
END $$;

-- POLICY_STRICT_TWO_EYES setting — off by default (single-super orgs
-- can still approve own drafts). Flip on when a second SUPER onboards.
INSERT INTO "Setting" (id, key, value, "updatedAt")
VALUES (gen_random_uuid()::text, 'POLICY_STRICT_TWO_EYES', 'false', NOW())
ON CONFLICT (key) DO NOTHING;

-- POLICY_DEFAULT_GRACE_HOURS — how long BLOCK policies wait before
-- enforcing on a fresh publish. 24h default gives workers time to sign
-- before mid-workday disruption.
INSERT INTO "Setting" (id, key, value, "updatedAt")
VALUES (gen_random_uuid()::text, 'POLICY_DEFAULT_GRACE_HOURS', '24', NOW())
ON CONFLICT (key) DO NOTHING;
