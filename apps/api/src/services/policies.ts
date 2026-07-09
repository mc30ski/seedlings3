/**
 * Compliance policies service.
 *
 * Admin-facing CRUD + version lifecycle + exception management + upload
 * review for the PolicyDocument system. Every state transition uses
 * compare-and-swap (`updateMany` with expected-status guards) so two
 * concurrent admins can't race each other into an inconsistent state.
 * Every write is inside a transaction with an audit event.
 *
 * Slice 1 delivers admin CRUD only — the worker-facing sign / acknowledge /
 * upload / page-view endpoints live in Slice 2. Gate integration (which
 * calls assertPoliciesSigned from workday / jobs / equipment services)
 * lands in Slice 3.
 *
 * All pure-logic predicates ("is this signature current?", "what's the
 * user's compliance state?") live in lib/policyPredicate.ts. This file
 * loads the right rows out of Prisma and hands them to the predicate.
 */

import { createHash } from "crypto";
import { Prisma, PolicyVersionStatus, PolicyEnforcement, PolicyWorkerAction, PolicyResignTrigger, PolicyContentFormat, PolicyGateService, PolicyNotifyChannel, PolicyUploadStatus, WorkerType } from "@prisma/client";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";
import { getUploadUrl } from "../lib/r2";
import { etAddDays, etFormatDate, etMidnight } from "../lib/dates";
import {
  isSignatureCurrent,
  computeComplianceState,
  normalizeName,
  type PolicyEvaluation,
  type PolicyForPredicate,
  type VersionForPredicate,
  type SignatureForPredicate,
  type ExceptionForPredicate,
  type ComplianceState,
} from "../lib/policyPredicate";

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Range-check an MM-DD string used by the ANNUAL_ON_DATE resign trigger.
 * Format check + month 01-12 + day 01-31 (leap-year 02-29 allowed; the
 * predicate handles the non-leap-year fallback to 02-28).
 *
 * The predicate at policyPredicate.ts silently ignores malformed values —
 * a bad string would make the trigger look like it never fires. Rejecting
 * at write time prevents that silent-failure land mine.
 */
export function isValidPolicyMonthDay(input: string): boolean {
  if (!/^\d{2}-\d{2}$/.test(input)) return false;
  const [monthStr, dayStr] = input.split("-");
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (month < 1 || month > 12) return false;
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= maxDay;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CreatePolicyInput = {
  key: string;
  title: string;
  description?: string | null;
  targetWorkerTypes: WorkerType[];
  enforcement: PolicyEnforcement;
  workerAction: PolicyWorkerAction;
  adminCanUploadOnBehalf?: boolean;
  requiresWorkerUpload?: boolean;
  workerUploadLabel?: string | null;
  workerUploadAcceptedTypes?: string | null;
  workerUploadRequiresExpiry?: boolean;
  workerUploadRequiresApproval?: boolean;
  resignTrigger: PolicyResignTrigger;
  resignParamDays?: number | null;
  resignParamMonthDay?: string | null;
  gatesServices?: PolicyGateService[];
  gatesJobsAbovePrice?: number | null;
  sortOrder?: number;
  notifyOnPublish?: PolicyNotifyChannel;
  graceHoursOverride?: number | null;
};

export type UpdatePolicyInput = Partial<Omit<CreatePolicyInput, "key">>;

export type CreateVersionInput = {
  contentFormat: PolicyContentFormat;
  contentMarkdown?: string | null;
  changeNote: string;
  forcesResign?: boolean;
};

export type UpdateDraftInput = {
  contentMarkdown?: string | null;
  changeNote?: string;
  forcesResign?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 hex digest for content-integrity. Used for both markdown text
 *  and PDF bytes. */
export function computeContentDigest(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Compare-and-swap version status transition. Prevents lost updates when
 * two admins act on the same version at once (fix #19 in the policy
 * design memo). Split into two steps because Prisma's updateMany doesn't
 * accept FK-scalar fields like `submittedById` in its update payload:
 *
 *   1. Atomic CAS via updateMany({ where: { id, status: expected } })
 *      — this is the actual race-free status swap.
 *   2. Follow-up .update() to set actor + timestamp fields.
 *
 * Both writes happen inside the caller's transaction so the two-step
 * appears atomic to any other observer.
 */
async function transitionVersionStatus(
  tx: Prisma.TransactionClient,
  versionId: string,
  expected: PolicyVersionStatus,
  next: PolicyVersionStatus,
  actorFields: Prisma.PolicyDocumentVersionUpdateInput = {},
): Promise<void> {
  const swap = await tx.policyDocumentVersion.updateMany({
    where: { id: versionId, status: expected },
    data: { status: next },
  });
  if (swap.count === 0) {
    throw new ServiceError(
      "VERSION_STATE_CHANGED",
      `Version state changed by another admin. Refresh and try again.`,
      409,
    );
  }
  if (Object.keys(actorFields).length > 0) {
    await tx.policyDocumentVersion.update({
      where: { id: versionId },
      data: actorFields,
    });
  }
}

/** Fetch a Setting number value with default fallback. */
async function getSettingNumber(key: string, fallback: number): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Fetch a Setting boolean value with default fallback. */
async function getSettingBool(key: string, fallback: boolean): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  return row.value === "true" || row.value === "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export const policies = {
  // ── Admin: Policy template CRUD ──────────────────────────────────────────

  async createPolicy(currentUserId: string, input: CreatePolicyInput) {
    // Validation — enforce the invariants the schema alone can't express.
    if (input.workerAction === PolicyWorkerAction.NONE && !input.adminCanUploadOnBehalf) {
      throw new ServiceError(
        "INVALID_POLICY_CONFIG",
        "Policies with workerAction=NONE must set adminCanUploadOnBehalf=true (admin is the only path).",
        400,
      );
    }
    if (input.resignTrigger === PolicyResignTrigger.DAYS_SINCE_SIGN) {
      const n = input.resignParamDays;
      if (!(typeof n === "number" && Number.isInteger(n) && n > 0)) {
        throw new ServiceError(
          "INVALID_POLICY_CONFIG",
          "Every-N-days trigger requires a positive whole number of days.",
          400,
        );
      }
    }
    if (input.resignTrigger === PolicyResignTrigger.ANNUAL_ON_DATE) {
      if (!input.resignParamMonthDay || !isValidPolicyMonthDay(input.resignParamMonthDay)) {
        throw new ServiceError(
          "INVALID_POLICY_CONFIG",
          "Yearly trigger requires a valid MM-DD date like 01-15.",
          400,
        );
      }
    }
    if (input.requiresWorkerUpload && !input.workerUploadLabel) {
      throw new ServiceError(
        "INVALID_POLICY_CONFIG",
        "Policies with requiresWorkerUpload=true must have a workerUploadLabel.",
        400,
      );
    }
    if (
      input.graceHoursOverride !== undefined &&
      input.graceHoursOverride !== null &&
      !(Number.isInteger(input.graceHoursOverride) && input.graceHoursOverride >= 0)
    ) {
      throw new ServiceError(
        "INVALID_POLICY_CONFIG",
        "Grace hours override must be a non-negative whole number, or null to fall back to the default.",
        400,
      );
    }

    return prisma.$transaction(async (tx) => {
      const existing = await tx.policyDocument.findUnique({ where: { key: input.key } });
      if (existing) {
        throw new ServiceError("KEY_CONFLICT", `Policy key "${input.key}" already exists.`, 409);
      }
      const created = await tx.policyDocument.create({
        data: {
          key: input.key,
          title: input.title,
          description: input.description ?? null,
          targetWorkerTypes: input.targetWorkerTypes,
          enforcement: input.enforcement,
          workerAction: input.workerAction,
          adminCanUploadOnBehalf: input.adminCanUploadOnBehalf ?? false,
          requiresWorkerUpload: input.requiresWorkerUpload ?? false,
          workerUploadLabel: input.workerUploadLabel ?? null,
          workerUploadAcceptedTypes: input.workerUploadAcceptedTypes ?? null,
          workerUploadRequiresExpiry: input.workerUploadRequiresExpiry ?? false,
          workerUploadRequiresApproval: input.workerUploadRequiresApproval ?? false,
          resignTrigger: input.resignTrigger,
          resignParamDays: input.resignParamDays ?? null,
          resignParamMonthDay: input.resignParamMonthDay ?? null,
          gatesServices: input.gatesServices ?? [],
          gatesJobsAbovePrice: input.gatesJobsAbovePrice ?? null,
          sortOrder: input.sortOrder ?? 0,
          notifyOnPublish: input.notifyOnPublish ?? PolicyNotifyChannel.PUSH_ONLY,
          graceHoursOverride: input.graceHoursOverride ?? null,
          createdById: currentUserId,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.CREATED, currentUserId, {
        policyId: created.id,
        key: created.key,
      });
      return created;
    });
  },

  async updatePolicy(currentUserId: string, id: string, patch: UpdatePolicyInput) {
    return prisma.$transaction(async (tx) => {
      const before = await tx.policyDocument.findUnique({ where: { id } });
      if (!before) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      if (before.archivedAt) throw new ServiceError("POLICY_ARCHIVED", "Cannot edit an archived policy.", 409);

      // Compute the effective trigger + MM-DD after applying the patch and
      // validate. Blocks bad MM-DD strings (99-99, "abcd") from ever hitting
      // the DB; the predicate silently ignores malformed values so a bad
      // save would look like the trigger never fires.
      const effectiveTrigger = patch.resignTrigger ?? before.resignTrigger;
      const effectiveMonthDay =
        patch.resignParamMonthDay !== undefined ? patch.resignParamMonthDay : before.resignParamMonthDay;
      const effectiveDays =
        patch.resignParamDays !== undefined ? patch.resignParamDays : before.resignParamDays;
      if (effectiveTrigger === PolicyResignTrigger.DAYS_SINCE_SIGN) {
        if (!(typeof effectiveDays === "number" && Number.isInteger(effectiveDays) && effectiveDays > 0)) {
          throw new ServiceError(
            "INVALID_POLICY_CONFIG",
            "Every-N-days trigger requires a positive whole number of days.",
            400,
          );
        }
      }
      if (effectiveTrigger === PolicyResignTrigger.ANNUAL_ON_DATE) {
        if (!effectiveMonthDay || !isValidPolicyMonthDay(effectiveMonthDay)) {
          throw new ServiceError(
            "INVALID_POLICY_CONFIG",
            "Yearly trigger requires a valid MM-DD date like 01-15.",
            400,
          );
        }
      }

      const data: Prisma.PolicyDocumentUpdateInput = {};
      if (patch.title !== undefined) data.title = patch.title;
      if (patch.description !== undefined) data.description = patch.description;
      if (patch.targetWorkerTypes !== undefined) data.targetWorkerTypes = patch.targetWorkerTypes;
      if (patch.enforcement !== undefined) data.enforcement = patch.enforcement;
      if (patch.workerAction !== undefined) data.workerAction = patch.workerAction;
      if (patch.adminCanUploadOnBehalf !== undefined) data.adminCanUploadOnBehalf = patch.adminCanUploadOnBehalf;
      if (patch.requiresWorkerUpload !== undefined) data.requiresWorkerUpload = patch.requiresWorkerUpload;
      if (patch.workerUploadLabel !== undefined) data.workerUploadLabel = patch.workerUploadLabel;
      if (patch.workerUploadAcceptedTypes !== undefined) data.workerUploadAcceptedTypes = patch.workerUploadAcceptedTypes;
      if (patch.workerUploadRequiresExpiry !== undefined) data.workerUploadRequiresExpiry = patch.workerUploadRequiresExpiry;
      if (patch.workerUploadRequiresApproval !== undefined) data.workerUploadRequiresApproval = patch.workerUploadRequiresApproval;
      if (patch.resignTrigger !== undefined) data.resignTrigger = patch.resignTrigger;
      if (patch.resignParamDays !== undefined) data.resignParamDays = patch.resignParamDays;
      if (patch.resignParamMonthDay !== undefined) data.resignParamMonthDay = patch.resignParamMonthDay;
      if (patch.gatesServices !== undefined) data.gatesServices = patch.gatesServices;
      if (patch.gatesJobsAbovePrice !== undefined) data.gatesJobsAbovePrice = patch.gatesJobsAbovePrice;
      if (patch.sortOrder !== undefined) data.sortOrder = patch.sortOrder;
      if (patch.notifyOnPublish !== undefined) data.notifyOnPublish = patch.notifyOnPublish;
      if (patch.graceHoursOverride !== undefined) {
        const g = patch.graceHoursOverride;
        if (g !== null && !(Number.isInteger(g) && g >= 0)) {
          throw new ServiceError(
            "INVALID_POLICY_CONFIG",
            "Grace hours override must be a non-negative whole number, or null to fall back to the default.",
            400,
          );
        }
        data.graceHoursOverride = g;
      }

      const updated = await tx.policyDocument.update({ where: { id }, data });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.UPDATED, currentUserId, {
        policyId: id,
        before: {
          title: before.title,
          enforcement: before.enforcement,
          workerAction: before.workerAction,
        },
        after: {
          title: updated.title,
          enforcement: updated.enforcement,
          workerAction: updated.workerAction,
        },
      });
      return updated;
    });
  },

  async archivePolicy(currentUserId: string, id: string, reason: string) {
    if (!reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Archive reason is required.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const before = await tx.policyDocument.findUnique({ where: { id } });
      if (!before) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      if (before.archivedAt) throw new ServiceError("ALREADY_ARCHIVED", "Policy already archived.", 409);
      // Referential-integrity guard. Any equipment currently referencing
      // this policy must have it removed first — otherwise reservation
      // would silently stop enforcing the requirement (archived policies
      // are skipped by the predicate). Surface the blocking equipment by
      // name so the admin knows what to detach.
      const blockingEquipment = await tx.equipment.findMany({
        where: { requiredPolicyIds: { has: id } },
        select: { id: true, shortDesc: true, brand: true, model: true, qrSlug: true },
      });
      if (blockingEquipment.length > 0) {
        const names = blockingEquipment
          .map((e) => e.shortDesc || [e.brand, e.model].filter(Boolean).join(" ") || e.qrSlug || e.id)
          .join(", ");
        throw new ServiceError(
          "POLICY_IN_USE_BY_EQUIPMENT",
          `Cannot archive — still required by equipment: ${names}. Detach from each piece first, then archive.`,
          409,
          { equipmentIds: blockingEquipment.map((e) => e.id) },
        );
      }
      await tx.policyDocument.update({
        where: { id },
        data: {
          archivedAt: new Date(),
          archivedById: currentUserId,
          archivedReason: reason.trim(),
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.ARCHIVED, currentUserId, {
        policyId: id,
        reason: reason.trim(),
      });
    });
  },

  async unarchivePolicy(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      const before = await tx.policyDocument.findUnique({ where: { id } });
      if (!before) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      if (!before.archivedAt) throw new ServiceError("NOT_ARCHIVED", "Policy is not archived.", 409);
      await tx.policyDocument.update({
        where: { id },
        data: {
          archivedAt: null,
          archivedById: null,
          archivedReason: null,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.UNARCHIVED, currentUserId, {
        policyId: id,
      });
    });
  },

  // ── Admin: Version lifecycle ─────────────────────────────────────────────

  async createVersion(currentUserId: string, policyId: string, input: CreateVersionInput) {
    return prisma.$transaction(async (tx) => {
      const policy = await tx.policyDocument.findUnique({ where: { id: policyId } });
      if (!policy) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      if (policy.archivedAt) throw new ServiceError("POLICY_ARCHIVED", "Cannot add a version to an archived policy.", 409);

      // Version numbers are sequential per policy — take (max + 1). Ok to
      // read-then-write here because the outer tx serializes concurrent
      // creates on the same policy via the tx transaction.
      const latest = await tx.policyDocumentVersion.findFirst({
        where: { policyDocumentId: policyId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      const versionNumber = (latest?.versionNumber ?? 0) + 1;

      // Content-digest is required at draft creation for MARKDOWN so the
      // predicate has a stable value even before publish. For PDF, digest
      // will be re-computed on confirmPdfUpload (the byte hash), and the
      // markdown-derived digest here is just a placeholder ("draft-<v>").
      let contentDigest: string;
      if (input.contentFormat === PolicyContentFormat.MARKDOWN) {
        contentDigest = computeContentDigest(input.contentMarkdown ?? "");
      } else {
        contentDigest = `pending-pdf-upload-v${versionNumber}`;
      }

      const created = await tx.policyDocumentVersion.create({
        data: {
          policyDocumentId: policyId,
          versionNumber,
          contentFormat: input.contentFormat,
          contentMarkdown: input.contentFormat === PolicyContentFormat.MARKDOWN
            ? (input.contentMarkdown ?? "")
            : null,
          contentDigest,
          changeNote: input.changeNote,
          forcesResign: input.forcesResign ?? false,
          status: PolicyVersionStatus.DRAFT,
          createdById: currentUserId,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.VERSION_DRAFTED, currentUserId, {
        policyId,
        versionId: created.id,
        versionNumber,
      });
      return created;
    });
  },

  async updateDraft(currentUserId: string, versionId: string, patch: UpdateDraftInput) {
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      if (version.status !== PolicyVersionStatus.DRAFT) {
        throw new ServiceError(
          "VERSION_NOT_DRAFT",
          `Cannot edit — version status is ${version.status}. Only DRAFT versions are editable.`,
          409,
        );
      }
      const data: Prisma.PolicyDocumentVersionUpdateInput = {};
      if (patch.contentMarkdown !== undefined && version.contentFormat === PolicyContentFormat.MARKDOWN) {
        data.contentMarkdown = patch.contentMarkdown;
        data.contentDigest = computeContentDigest(patch.contentMarkdown ?? "");
      }
      if (patch.changeNote !== undefined) data.changeNote = patch.changeNote;
      if (patch.forcesResign !== undefined) data.forcesResign = patch.forcesResign;

      const updated = await tx.policyDocumentVersion.update({ where: { id: versionId }, data });
      // No audit event on draft edit — too noisy, and the DRAFT itself
      // isn't user-facing. Audit fires at submit / approve / publish.
      return updated;
    });
  },

  /**
   * Confirms a completed R2 upload for a PDF version, capturing the byte
   * digest + page count computed by the caller (Slice 2 will add a
   * pdf-lib-based page counter; for Slice 1 the admin submits both).
   */
  async confirmPdfUpload(
    currentUserId: string,
    versionId: string,
    input: {
      r2Key: string;
      fileName: string;
      contentType: string;
      contentDigest: string;
      pdfPageCount: number;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      if (version.status !== PolicyVersionStatus.DRAFT) {
        throw new ServiceError("VERSION_NOT_DRAFT", "PDF can only be attached to a DRAFT version.", 409);
      }
      if (version.contentFormat !== PolicyContentFormat.PDF) {
        throw new ServiceError("NOT_PDF_VERSION", "This version is not a PDF version.", 409);
      }
      await tx.policyDocumentVersion.update({
        where: { id: versionId },
        data: {
          contentR2Key: input.r2Key,
          contentFileName: input.fileName,
          contentContentType: input.contentType,
          contentDigest: input.contentDigest,
          pdfPageCount: input.pdfPageCount,
        },
      });
    });
  },

  /**
   * Presigned upload URL for a draft version's PDF content. Called by the
   * admin Compliance tab when uploading the PDF for a new version.
   */
  async getPdfUploadUrl(versionId: string, fileName: string, contentType: string) {
    const version = await prisma.policyDocumentVersion.findUnique({
      where: { id: versionId },
      select: { id: true, status: true, contentFormat: true, policyDocumentId: true },
    });
    if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    if (version.status !== PolicyVersionStatus.DRAFT) {
      throw new ServiceError("VERSION_NOT_DRAFT", "PDF can only be attached to a DRAFT version.", 409);
    }
    if (version.contentFormat !== PolicyContentFormat.PDF) {
      throw new ServiceError("NOT_PDF_VERSION", "This version is not a PDF version.", 409);
    }
    const key = `policies/${version.policyDocumentId}/${versionId}/${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType, 300, "docs");
    return { uploadUrl, key };
  },

  async submitVersionForApproval(currentUserId: string, versionId: string) {
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      // Guard: PDF versions must have their content attached before submit.
      if (version.contentFormat === PolicyContentFormat.PDF && !version.contentR2Key) {
        throw new ServiceError("PDF_NOT_UPLOADED", "Attach the PDF content before submitting for approval.", 400);
      }
      await transitionVersionStatus(
        tx,
        versionId,
        PolicyVersionStatus.DRAFT,
        PolicyVersionStatus.PENDING_APPROVAL,
        {
          submittedAt: new Date(),
          submittedBy: { connect: { id: currentUserId } },
        },
      );
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.VERSION_SUBMITTED_FOR_APPROVAL, currentUserId, {
        policyId: version.policyDocumentId,
        versionId,
      });
    });
  },

  async approveVersion(currentUserId: string, versionId: string) {
    const strictTwoEyes = await getSettingBool("POLICY_STRICT_TWO_EYES", false);
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      if (strictTwoEyes && version.createdById === currentUserId) {
        throw new ServiceError(
          "SELF_APPROVAL_FORBIDDEN",
          "Strict two-eyes mode is on. A different super must approve this version.",
          403,
        );
      }
      await transitionVersionStatus(
        tx,
        versionId,
        PolicyVersionStatus.PENDING_APPROVAL,
        PolicyVersionStatus.APPROVED,
        {
          approvedAt: new Date(),
          approvedBy: { connect: { id: currentUserId } },
        },
      );
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.VERSION_APPROVED, currentUserId, {
        policyId: version.policyDocumentId,
        versionId,
        strictTwoEyes,
      });
    });
  },

  async publishVersion(
    currentUserId: string,
    versionId: string,
    opts?: { graceHours?: number; forcesResign?: boolean },
  ) {
    const defaultGraceHours = await getSettingNumber("POLICY_DEFAULT_GRACE_HOURS", 24);
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({
        where: { id: versionId },
        include: { policyDocument: { select: { graceHoursOverride: true } } },
      });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      const now = new Date();
      // Precedence: caller-supplied override → per-document override → global
      // default. Per-document `graceHoursOverride = 0` explicitly opts out of
      // any grace (federally-mandated docs where an uncovered window is
      // unacceptable). null falls through to the setting.
      const perDocOverride = version.policyDocument.graceHoursOverride;
      const graceHours =
        opts?.graceHours ??
        (perDocOverride !== null ? perDocOverride : defaultGraceHours);
      const graceUntil = new Date(now.getTime() + graceHours * 60 * 60 * 1000);
      const forcesResign = opts?.forcesResign ?? version.forcesResign;

      await transitionVersionStatus(
        tx,
        versionId,
        PolicyVersionStatus.APPROVED,
        PolicyVersionStatus.PUBLISHED,
        {
          publishedAt: now,
          publishedBy: { connect: { id: currentUserId } },
          graceUntil,
          forcesResign,
        },
      );
      // Atomically point the policy's currentVersionId at this version.
      await tx.policyDocument.update({
        where: { id: version.policyDocumentId },
        data: { currentVersionId: versionId },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.VERSION_PUBLISHED, currentUserId, {
        policyId: version.policyDocumentId,
        versionId,
        forcesResign,
        graceHours,
      });
    });
  },

  async rollbackVersion(currentUserId: string, versionId: string, reason: string) {
    if (!reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Rollback reason is required.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({ where: { id: versionId } });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      // Only PUBLISHED versions can be rolled back.
      await transitionVersionStatus(
        tx,
        versionId,
        PolicyVersionStatus.PUBLISHED,
        PolicyVersionStatus.ROLLED_BACK,
        {
          rolledBackAt: new Date(),
          rolledBackBy: { connect: { id: currentUserId } },
          rolledBackReason: reason.trim(),
        },
      );
      // Restore currentVersionId to the most recent still-PUBLISHED version
      // of this policy (excluding the one we just rolled back).
      const priorPublished = await tx.policyDocumentVersion.findFirst({
        where: {
          policyDocumentId: version.policyDocumentId,
          status: PolicyVersionStatus.PUBLISHED,
          id: { not: versionId },
        },
        orderBy: { publishedAt: "desc" },
        select: { id: true },
      });
      await tx.policyDocument.update({
        where: { id: version.policyDocumentId },
        data: { currentVersionId: priorPublished?.id ?? null },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.VERSION_ROLLED_BACK, currentUserId, {
        policyId: version.policyDocumentId,
        versionId,
        reason: reason.trim(),
        newCurrentVersionId: priorPublished?.id ?? null,
      });
    });
  },

  // ── Admin: Exceptions ────────────────────────────────────────────────────

  async grantException(
    currentUserId: string,
    input: { userId: string; policyId: string; expiresAt: Date; reason: string },
  ) {
    if (!input.reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Exception reason is required.", 400);
    }
    const now = new Date();
    // 90-day exception cap. ET-anchored (DST-safe) via etAddDays on the
    // string form, then converted back to a Date at ET midnight of the
    // 90th day for comparison against caller-provided expiresAt.
    const maxExpiry = etMidnight(etAddDays(etFormatDate(now), 90));
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new ServiceError("INVALID_EXPIRY", "Exception expiry must be in the future.", 400);
    }
    if (input.expiresAt.getTime() > maxExpiry.getTime()) {
      throw new ServiceError("INVALID_EXPIRY", "Exception expiry cannot be more than 90 days out.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const policy = await tx.policyDocument.findUnique({ where: { id: input.policyId } });
      if (!policy) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      if (policy.archivedAt) throw new ServiceError("POLICY_ARCHIVED", "Cannot grant exception on archived policy.", 409);
      const created = await tx.policyException.create({
        data: {
          userId: input.userId,
          policyDocumentId: input.policyId,
          grantedById: currentUserId,
          expiresAt: input.expiresAt,
          reason: input.reason.trim(),
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.EXCEPTION_GRANTED, currentUserId, {
        exceptionId: created.id,
        userId: input.userId,
        policyId: input.policyId,
        expiresAt: input.expiresAt.toISOString(),
        reason: input.reason.trim(),
      });
      return created;
    });
  },

  async revokeException(currentUserId: string, exceptionId: string, reason: string) {
    if (!reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Revoke reason is required.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const before = await tx.policyException.findUnique({ where: { id: exceptionId } });
      if (!before) throw new ServiceError("NOT_FOUND", "Exception not found.", 404);
      if (before.revokedAt) throw new ServiceError("ALREADY_REVOKED", "Exception already revoked.", 409);
      await tx.policyException.update({
        where: { id: exceptionId },
        data: {
          revokedAt: new Date(),
          revokedById: currentUserId,
          revokedReason: reason.trim(),
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.EXCEPTION_REVOKED, currentUserId, {
        exceptionId,
        userId: before.userId,
        policyId: before.policyDocumentId,
        reason: reason.trim(),
      });
    });
  },

  // ── Admin: Force resign (bulk revoke) ────────────────────────────────────

  async forceResignAll(currentUserId: string, policyId: string, reason: string) {
    if (!reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Force-resign reason is required.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const policy = await tx.policyDocument.findUnique({ where: { id: policyId } });
      if (!policy) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      const now = new Date();
      const result = await tx.policySignature.updateMany({
        where: {
          version: { policyDocumentId: policyId },
          revokedAt: null,
        },
        data: {
          revokedAt: now,
          revokedById: currentUserId,
          revokedReason: `Force resign: ${reason.trim()}`,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.FORCE_RESIGN, currentUserId, {
        policyId,
        revokedCount: result.count,
        reason: reason.trim(),
      });
      return { revokedCount: result.count };
    });
  },

  /**
   * Bulk compliance summary — one row per active user with a workerType,
   * summarizing whether they're current + how many BLOCK policies they
   * still owe. Used by the admin UsersTab chip and any admin surface that
   * wants to answer "who's out of compliance?" at a glance.
   *
   * Loads every applicable policy, signature, and exception once, then
   * runs the pure predicate per user in-memory. O(users × policies) work
   * done in Node rather than N+1 DB queries.
   */
  async getAllUsersComplianceSummary(): Promise<Array<{
    userId: string;
    workerType: string | null;
    current: boolean;
    pendingCount: number;
  }>> {
    const users = await prisma.user.findMany({
      where: { workerType: { not: null } },
      select: { id: true, workerType: true },
    });
    if (users.length === 0) return [];

    const now = new Date();
    const policies = await prisma.policyDocument.findMany({
      where: { archivedAt: null },
      include: { versions: true },
    });
    if (policies.length === 0) {
      return users.map((u) => ({
        userId: u.id,
        workerType: u.workerType,
        current: true,
        pendingCount: 0,
      }));
    }

    const userIds = users.map((u) => u.id);
    const policyIds = policies.map((p) => p.id);
    const signatures = await prisma.policySignature.findMany({
      where: {
        userId: { in: userIds },
        version: { policyDocumentId: { in: policyIds } },
      },
    });
    const exceptions = await prisma.policyException.findMany({
      where: {
        userId: { in: userIds },
        policyDocumentId: { in: policyIds },
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });

    // Index by user for cheap per-user filtering below.
    const sigsByUser = new Map<string, typeof signatures>();
    for (const s of signatures) {
      const arr = sigsByUser.get(s.userId) ?? [];
      arr.push(s);
      sigsByUser.set(s.userId, arr);
    }
    const exceptionsByUser = new Map<string, typeof exceptions>();
    for (const e of exceptions) {
      const arr = exceptionsByUser.get(e.userId) ?? [];
      arr.push(e);
      exceptionsByUser.set(e.userId, arr);
    }

    return users.map((user) => {
      const targetedPolicies = policies.filter((p) =>
        user.workerType && p.targetWorkerTypes.includes(user.workerType as any),
      );
      if (targetedPolicies.length === 0) {
        return {
          userId: user.id,
          workerType: user.workerType,
          current: true,
          pendingCount: 0,
        };
      }
      const userSigs = sigsByUser.get(user.id) ?? [];
      const userExceptions = exceptionsByUser.get(user.id) ?? [];
      const evaluations: PolicyEvaluation[] = targetedPolicies.map((policy) => {
        const versionsById = new Map<string, VersionForPredicate>();
        for (const v of policy.versions) {
          versionsById.set(v.id, {
            id: v.id,
            policyDocumentId: v.policyDocumentId,
            status: v.status,
            contentDigest: v.contentDigest,
            publishedAt: v.publishedAt,
            graceUntil: v.graceUntil,
            forcesResign: v.forcesResign,
          });
        }
        const currentVersion = policy.currentVersionId
          ? (versionsById.get(policy.currentVersionId) ?? null)
          : null;
        return {
          policy: {
            id: policy.id,
            targetWorkerTypes: policy.targetWorkerTypes,
            enforcement: policy.enforcement,
            workerAction: policy.workerAction,
            requiresWorkerUpload: policy.requiresWorkerUpload,
            workerUploadRequiresExpiry: policy.workerUploadRequiresExpiry,
            workerUploadRequiresApproval: policy.workerUploadRequiresApproval,
            resignTrigger: policy.resignTrigger,
            resignParamDays: policy.resignParamDays,
            resignParamMonthDay: policy.resignParamMonthDay,
            currentVersionId: policy.currentVersionId,
            archivedAt: policy.archivedAt,
          },
          currentVersion,
          signatures: userSigs
            .filter((s) => policy.versions.some((v) => v.id === s.policyDocumentVersionId))
            .map((s) => ({
              id: s.id,
              userId: s.userId,
              policyDocumentVersionId: s.policyDocumentVersionId,
              contentDigestAtSign: s.contentDigestAtSign,
              signedAt: s.signedAt,
              uploadStatus: s.uploadStatus,
              uploadExpiresAt: s.uploadExpiresAt,
              revokedAt: s.revokedAt,
            })),
          activeException: (() => {
            const e = userExceptions.find((x) => x.policyDocumentId === policy.id);
            return e
              ? {
                  id: e.id,
                  userId: e.userId,
                  policyDocumentId: e.policyDocumentId,
                  expiresAt: e.expiresAt,
                  revokedAt: e.revokedAt,
                }
              : null;
          })(),
          versionsById,
        };
      });
      const state = computeComplianceState(evaluations, now);
      return {
        userId: user.id,
        workerType: user.workerType,
        current: state.current,
        pendingCount: state.pendingPolicyIds.length,
      };
    });
  },

  // ── Admin: Nudge worker ─────────────────────────────────────────────────
  //
  // Send a push notification to a worker with pending policies, prompting
  // them to open the Compliance tab and finish signing. Silent no-op if the
  // worker has no push subscriptions or no pending policies.

  async nudgeWorker(currentUserId: string, targetUserId: string) {
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, displayName: true, workerType: true },
    });
    if (!target) throw new ServiceError("NOT_FOUND", "User not found.", 404);
    if (!target.workerType) {
      throw new ServiceError("NOT_A_WORKER", "User has no worker type.", 400);
    }

    const view = await this.getWorkerPoliciesView(targetUserId);
    const pendingCount = view.required.length;
    if (pendingCount === 0) {
      throw new ServiceError(
        "NOTHING_PENDING",
        "This worker has no pending policies to sign.",
        400,
      );
    }

    const titles = view.required.slice(0, 3).map((p) => p.title);
    const body =
      titles.length === pendingCount
        ? `Please sign: ${titles.join(", ")}.`
        : `${pendingCount} policies pending: ${titles.join(", ")}${pendingCount > titles.length ? ", …" : ""}.`;

    const { sendPushToUser } = await import("../lib/push");
    const result = await sendPushToUser(targetUserId, {
      title: "Compliance reminder",
      body,
      url: "/#compliance",
      tag: `policy-nudge-${targetUserId}`,
    });

    await writeAudit(prisma, AUDIT.NOTIFICATION.SENT, currentUserId, {
      targetUserId,
      kind: "POLICY_NUDGE",
      pendingCount,
      pushAttempted: result.attempted,
      pushDelivered: result.delivered,
    });

    return {
      pendingCount,
      pushAttempted: result.attempted,
      pushDelivered: result.delivered,
    };
  },


  // ── Admin: Sign matrix ───────────────────────────────────────────────────
  //
  // Grid view — every non-archived worker × every non-archived policy, with
  // per-cell status. Used by the Sign Matrix admin UI + CSV export. Uses the
  // same predicate as getAllUsersComplianceSummary so the numbers reconcile.
  //
  // Status semantics:
  //   NOT_TARGETED — worker's workerType is not in policy.targetWorkerTypes
  //   EXCEPTION    — active exception overrides the signature requirement
  //   CURRENT      — has a current signature (any published/rolled-back version)
  //   PENDING      — targeted, no exception, no current signature
  async getSignMatrix(): Promise<{
    users: Array<{
      id: string;
      displayName: string | null;
      email: string | null;
      workerType: string | null;
    }>;
    policies: Array<{
      id: string;
      key: string;
      title: string;
      enforcement: string;
      workerAction: string;
      targetWorkerTypes: string[];
    }>;
    cells: Array<{
      userId: string;
      policyId: string;
      status: "CURRENT" | "PENDING" | "EXCEPTION" | "NOT_TARGETED";
      signedAt: string | null;
      expiresAt: string | null;
    }>;
  }> {
    const users = await prisma.user.findMany({
      where: { workerType: { not: null } },
      select: { id: true, displayName: true, email: true, workerType: true },
      orderBy: { displayName: "asc" },
    });
    const policies = await prisma.policyDocument.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      include: { versions: true },
    });
    if (users.length === 0 || policies.length === 0) {
      return {
        users: users.map((u) => ({ ...u })),
        policies: policies.map((p) => ({
          id: p.id,
          key: p.key,
          title: p.title,
          enforcement: p.enforcement,
          workerAction: p.workerAction,
          targetWorkerTypes: p.targetWorkerTypes,
        })),
        cells: [],
      };
    }

    const now = new Date();
    const userIds = users.map((u) => u.id);
    const policyIds = policies.map((p) => p.id);
    const [signatures, exceptions] = await Promise.all([
      prisma.policySignature.findMany({
        where: {
          userId: { in: userIds },
          version: { policyDocumentId: { in: policyIds } },
        },
      }),
      prisma.policyException.findMany({
        where: {
          userId: { in: userIds },
          policyDocumentId: { in: policyIds },
          revokedAt: null,
          expiresAt: { gt: now },
        },
      }),
    ]);

    const sigsByUser = new Map<string, typeof signatures>();
    for (const s of signatures) {
      const arr = sigsByUser.get(s.userId) ?? [];
      arr.push(s);
      sigsByUser.set(s.userId, arr);
    }
    const exceptionsByUser = new Map<string, typeof exceptions>();
    for (const e of exceptions) {
      const arr = exceptionsByUser.get(e.userId) ?? [];
      arr.push(e);
      exceptionsByUser.set(e.userId, arr);
    }

    const cells: Array<{
      userId: string;
      policyId: string;
      status: "CURRENT" | "PENDING" | "EXCEPTION" | "NOT_TARGETED";
      signedAt: string | null;
      expiresAt: string | null;
    }> = [];

    for (const user of users) {
      const userSigs = sigsByUser.get(user.id) ?? [];
      const userExceptions = exceptionsByUser.get(user.id) ?? [];
      for (const policy of policies) {
        if (!user.workerType || !policy.targetWorkerTypes.includes(user.workerType as any)) {
          cells.push({
            userId: user.id,
            policyId: policy.id,
            status: "NOT_TARGETED",
            signedAt: null,
            expiresAt: null,
          });
          continue;
        }
        const exception = userExceptions.find((e) => e.policyDocumentId === policy.id) ?? null;
        if (exception) {
          cells.push({
            userId: user.id,
            policyId: policy.id,
            status: "EXCEPTION",
            signedAt: null,
            expiresAt: exception.expiresAt.toISOString(),
          });
          continue;
        }
        const versionsById = new Map<string, VersionForPredicate>();
        for (const v of policy.versions) {
          versionsById.set(v.id, {
            id: v.id,
            policyDocumentId: v.policyDocumentId,
            status: v.status,
            contentDigest: v.contentDigest,
            publishedAt: v.publishedAt,
            graceUntil: v.graceUntil,
            forcesResign: v.forcesResign,
          });
        }
        const policyForPredicate: PolicyForPredicate = {
          id: policy.id,
          targetWorkerTypes: policy.targetWorkerTypes,
          enforcement: policy.enforcement,
          workerAction: policy.workerAction,
          requiresWorkerUpload: policy.requiresWorkerUpload,
          workerUploadRequiresExpiry: policy.workerUploadRequiresExpiry,
          workerUploadRequiresApproval: policy.workerUploadRequiresApproval,
          resignTrigger: policy.resignTrigger,
          resignParamDays: policy.resignParamDays,
          resignParamMonthDay: policy.resignParamMonthDay,
          currentVersionId: policy.currentVersionId,
          archivedAt: policy.archivedAt,
        };
        const relevantSigs = userSigs.filter((s) =>
          policy.versions.some((v) => v.id === s.policyDocumentVersionId),
        );
        let currentSig: (typeof signatures)[number] | null = null;
        for (const sig of [...relevantSigs].sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime())) {
          const version = versionsById.get(sig.policyDocumentVersionId);
          if (!version) continue;
          const sigForPredicate: SignatureForPredicate = {
            id: sig.id,
            userId: sig.userId,
            policyDocumentVersionId: sig.policyDocumentVersionId,
            contentDigestAtSign: sig.contentDigestAtSign,
            signedAt: sig.signedAt,
            uploadStatus: sig.uploadStatus,
            uploadExpiresAt: sig.uploadExpiresAt,
            revokedAt: sig.revokedAt,
          };
          const result = isSignatureCurrent(
            sigForPredicate,
            policyForPredicate,
            version,
            versionsById,
            now,
          );
          if (result.current) {
            currentSig = sig;
            break;
          }
        }
        if (currentSig) {
          cells.push({
            userId: user.id,
            policyId: policy.id,
            status: "CURRENT",
            signedAt: currentSig.signedAt.toISOString(),
            expiresAt: currentSig.uploadExpiresAt?.toISOString() ?? null,
          });
        } else {
          cells.push({
            userId: user.id,
            policyId: policy.id,
            status: "PENDING",
            signedAt: null,
            expiresAt: null,
          });
        }
      }
    }

    return {
      users: users.map((u) => ({ ...u })),
      policies: policies.map((p) => ({
        id: p.id,
        key: p.key,
        title: p.title,
        enforcement: p.enforcement,
        workerAction: p.workerAction,
        targetWorkerTypes: p.targetWorkerTypes,
      })),
      cells,
    };
  },

  // ── Admin: Signature review + revoke + upload-on-behalf ─────────────────

  async reviewUpload(
    currentUserId: string,
    signatureId: string,
    decision: "APPROVE" | "REJECT",
    reason?: string,
  ) {
    if (decision === "REJECT" && !reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Rejection reason is required.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const sig = await tx.policySignature.findUnique({ where: { id: signatureId } });
      if (!sig) throw new ServiceError("NOT_FOUND", "Signature not found.", 404);
      if (sig.uploadStatus === PolicyUploadStatus.APPROVED || sig.uploadStatus === PolicyUploadStatus.REJECTED) {
        throw new ServiceError("ALREADY_REVIEWED", `Upload already ${sig.uploadStatus}.`, 409);
      }
      await tx.policySignature.update({
        where: { id: signatureId },
        data: {
          uploadStatus: decision === "APPROVE" ? PolicyUploadStatus.APPROVED : PolicyUploadStatus.REJECTED,
          uploadReviewedAt: new Date(),
          uploadReviewedById: currentUserId,
          uploadRejectionReason: decision === "REJECT" ? reason!.trim() : null,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_SIGNATURE.UPLOAD_REVIEWED, currentUserId, {
        signatureId,
        userId: sig.userId,
        decision,
        reason: reason?.trim() ?? null,
      });
    });
  },

  async revokeSignature(currentUserId: string, signatureId: string, reason: string) {
    if (!reason?.trim()) {
      throw new ServiceError("REASON_REQUIRED", "Revoke reason is required.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const sig = await tx.policySignature.findUnique({ where: { id: signatureId } });
      if (!sig) throw new ServiceError("NOT_FOUND", "Signature not found.", 404);
      if (sig.revokedAt) throw new ServiceError("ALREADY_REVOKED", "Signature already revoked.", 409);
      await tx.policySignature.update({
        where: { id: signatureId },
        data: {
          revokedAt: new Date(),
          revokedById: currentUserId,
          revokedReason: reason.trim(),
        },
      });
      await writeAudit(tx, AUDIT.POLICY_SIGNATURE.REVOKED, currentUserId, {
        signatureId,
        userId: sig.userId,
        reason: reason.trim(),
      });
    });
  },

  /**
   * Admin uploads an artifact on behalf of a worker, bypassing the worker
   * sign wizard entirely. Requires the policy to have
   * adminCanUploadOnBehalf = true. For SIGN-type policies the client-side
   * "type APPROVE" dialog gates this — the route layer trusts that gate
   * happened, but writes an especially detailed audit record so the
   * override is discoverable.
   */
  async adminUploadOnBehalf(
    currentUserId: string,
    input: {
      userId: string;
      policyId: string;
      uploadR2Key: string;
      uploadFileName: string;
      uploadContentType: string;
      uploadDigest: string;
      uploadExpiresAt: Date | null;
      typeAcknowledgment?: string; // Set to "APPROVE" for SIGN-type override.
      clientIp: string | null;
      userAgent: string | null;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const policy = await tx.policyDocument.findUnique({
        where: { id: input.policyId },
        include: { currentVersion: true },
      });
      if (!policy) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
      if (policy.archivedAt) throw new ServiceError("POLICY_ARCHIVED", "Policy is archived.", 409);
      if (!policy.adminCanUploadOnBehalf) {
        throw new ServiceError(
          "UPLOAD_ON_BEHALF_NOT_ALLOWED",
          "This policy doesn't allow admin upload on behalf.",
          403,
        );
      }
      if (!policy.currentVersion) {
        throw new ServiceError("NO_PUBLISHED_VERSION", "Policy has no published version yet.", 409);
      }
      if (policy.workerUploadRequiresExpiry && !input.uploadExpiresAt) {
        throw new ServiceError("EXPIRY_REQUIRED", "This policy requires an upload expiry.", 400);
      }
      // For SIGN-type policies, admin must have typed APPROVE at the UI.
      // Server double-checks so the confirmation can't be bypassed.
      if (policy.workerAction === PolicyWorkerAction.SIGN && input.typeAcknowledgment !== "APPROVE") {
        throw new ServiceError(
          "APPROVE_TYPE_REQUIRED",
          "This is a SIGN-type policy. Admin must confirm by typing APPROVE.",
          403,
        );
      }
      const created = await tx.policySignature.create({
        data: {
          userId: input.userId,
          policyDocumentVersionId: policy.currentVersion.id,
          workerActionAtSign: PolicyWorkerAction.NONE,
          signedByUserId: currentUserId,
          onBehalfOfUserId: input.userId,
          contentDigestAtSign: policy.currentVersion.contentDigest,
          uploadR2Key: input.uploadR2Key,
          uploadFileName: input.uploadFileName,
          uploadContentType: input.uploadContentType,
          uploadDigest: input.uploadDigest,
          uploadExpiresAt: input.uploadExpiresAt,
          // Admin upload is trusted — pre-approved. Skips the review queue.
          uploadStatus: policy.workerUploadRequiresApproval
            ? PolicyUploadStatus.APPROVED
            : PolicyUploadStatus.NONE,
          uploadReviewedAt: policy.workerUploadRequiresApproval ? new Date() : null,
          uploadReviewedById: policy.workerUploadRequiresApproval ? currentUserId : null,
          signatureIp: input.clientIp,
          signatureUserAgent: input.userAgent,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_SIGNATURE.ADMIN_UPLOADED_ON_BEHALF, currentUserId, {
        signatureId: created.id,
        userId: input.userId,
        policyId: input.policyId,
        versionId: policy.currentVersion.id,
        wasSignTypeOverride: policy.workerAction === PolicyWorkerAction.SIGN,
      });
      return created;
    });
  },

  // ── Read: admin surfaces ────────────────────────────────────────────────

  async listPolicies(opts?: { includeArchived?: boolean }) {
    const policies = await prisma.policyDocument.findMany({
      where: opts?.includeArchived ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      include: {
        currentVersion: true,
        _count: { select: { versions: true, exceptions: true } },
      },
    });
    // Attach per-status version counts so the list can surface "N drafts,
    // N approved" at a glance — no need to open each drawer to see pending
    // work. Single query, grouped for O(1) per-policy lookup.
    if (policies.length === 0) {
      return policies.map((p) => ({
        ...p,
        draftCount: 0,
        pendingApprovalCount: 0,
        approvedCount: 0,
      }));
    }
    const grouped = await prisma.policyDocumentVersion.groupBy({
      by: ["policyDocumentId", "status"],
      where: { policyDocumentId: { in: policies.map((p) => p.id) } },
      _count: { _all: true },
    });
    const countsById = new Map<string, { draft: number; pending: number; approved: number }>();
    for (const g of grouped) {
      const bucket = countsById.get(g.policyDocumentId) ?? { draft: 0, pending: 0, approved: 0 };
      if (g.status === PolicyVersionStatus.DRAFT) bucket.draft = g._count._all;
      else if (g.status === PolicyVersionStatus.PENDING_APPROVAL) bucket.pending = g._count._all;
      else if (g.status === PolicyVersionStatus.APPROVED) bucket.approved = g._count._all;
      countsById.set(g.policyDocumentId, bucket);
    }
    return policies.map((p) => {
      const c = countsById.get(p.id) ?? { draft: 0, pending: 0, approved: 0 };
      return { ...p, draftCount: c.draft, pendingApprovalCount: c.pending, approvedCount: c.approved };
    });
  },

  async getPolicyDetail(id: string) {
    const policy = await prisma.policyDocument.findUnique({
      where: { id },
      include: {
        currentVersion: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          include: {
            createdBy: { select: { id: true, displayName: true } },
            approvedBy: { select: { id: true, displayName: true } },
            publishedBy: { select: { id: true, displayName: true } },
          },
        },
        exceptions: {
          where: { revokedAt: null, expiresAt: { gt: new Date() } },
          include: { user: { select: { id: true, displayName: true } } },
        },
      },
    });
    if (!policy) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
    return policy;
  },

  /**
   * List all policies that admin is allowed to attach to a piece of
   * equipment (i.e., appear in the EquipmentDialog picker). Filters:
   *   - Not archived (archived policies never fire gates)
   *   - Enforcement = BLOCK (only BLOCK actually stops a reservation)
   *   - `gatesServices` includes RESERVE_EQUIPMENT (the policy has opted
   *     into equipment attachment via that gate toggle)
   */
  async listEquipmentAttachablePolicies() {
    return prisma.policyDocument.findMany({
      where: {
        archivedAt: null,
        enforcement: PolicyEnforcement.BLOCK,
        gatesServices: { has: PolicyGateService.RESERVE_EQUIPMENT },
      },
      orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
      select: {
        id: true,
        key: true,
        title: true,
        description: true,
        enforcement: true,
        workerAction: true,
        targetWorkerTypes: true,
      },
    });
  },

  async listPendingApprovals() {
    return prisma.policyDocumentVersion.findMany({
      where: { status: PolicyVersionStatus.PENDING_APPROVAL },
      orderBy: { submittedAt: "asc" },
      include: {
        policyDocument: { select: { id: true, title: true, key: true } },
        createdBy: { select: { id: true, displayName: true } },
        submittedBy: { select: { id: true, displayName: true } },
      },
    });
  },

  async listPendingUploadReviews() {
    return prisma.policySignature.findMany({
      where: {
        uploadStatus: PolicyUploadStatus.PENDING_REVIEW,
        revokedAt: null,
        // Exclude archived policies — their pending uploads are orphans
        // (the policy doesn't gate anything anymore) and shouldn't demand
        // admin attention. Approve/reject on an archived policy is a no-op
        // for compliance state.
        version: { policyDocument: { archivedAt: null } },
      },
      orderBy: { signedAt: "asc" },
      include: {
        user: { select: { id: true, displayName: true, email: true } },
        signedBy: { select: { id: true, displayName: true } },
        version: {
          select: {
            id: true,
            versionNumber: true,
            policyDocument: { select: { id: true, title: true, key: true } },
          },
        },
      },
    });
  },

  /**
   * Permanently delete an archived policy AND every row that references
   * it — versions, signatures, exceptions, reading progress. Only allowed
   * on already-archived policies so the two-step (archive-then-delete)
   * motion is enforced, giving the operator a natural pause. The frontend
   * layers a typed-DELETE confirmation on top for a third check.
   *
   * The audit log preserves the destruction counts even though the
   * underlying rows are gone. Wrapped in a transaction so a partial
   * cleanup can't leave the DB in a broken state (dangling versions
   * without a parent policy, etc.).
   */
  async deletePolicyPermanently(currentUserId: string, id: string) {
    const policy = await prisma.policyDocument.findUnique({ where: { id } });
    if (!policy) throw new ServiceError("NOT_FOUND", "Policy not found.", 404);
    if (!policy.archivedAt) {
      throw new ServiceError(
        "MUST_ARCHIVE_FIRST",
        "Archive the policy before deleting it permanently.",
        409,
      );
    }

    return prisma.$transaction(async (tx) => {
      // Collect version ids up front so we can delete signatures + reading
      // progress before we lose the ability to look them up.
      const versionIds = (
        await tx.policyDocumentVersion.findMany({
          where: { policyDocumentId: id },
          select: { id: true },
        })
      ).map((v) => v.id);

      const [signatureCount, exceptionCount, readingProgressCount] = await Promise.all([
        tx.policySignature.count({
          where: { policyDocumentVersionId: { in: versionIds } },
        }),
        tx.policyException.count({ where: { policyDocumentId: id } }),
        tx.policyReadingProgress.count({
          where: { policyDocumentVersionId: { in: versionIds } },
        }),
      ]);

      // 1. Break the currentVersionId back-reference so we can delete versions.
      await tx.policyDocument.update({
        where: { id },
        data: { currentVersionId: null },
      });
      // 2. Delete signatures — PolicySignature → PolicyDocumentVersion is
      //    Restrict, so this must come before deleting versions.
      await tx.policySignature.deleteMany({
        where: { policyDocumentVersionId: { in: versionIds } },
      });
      // 3. Delete versions. Reading-progress rows cascade automatically
      //    because PolicyReadingProgress → PolicyDocumentVersion is Cascade.
      await tx.policyDocumentVersion.deleteMany({
        where: { policyDocumentId: id },
      });
      // 4. Delete exceptions. Would also cascade from PolicyDocument.delete,
      //    but explicit here so the audit-count above matches what's
      //    actually gone at this point in the transaction.
      await tx.policyException.deleteMany({ where: { policyDocumentId: id } });
      // 5. Delete the policy itself.
      await tx.policyDocument.delete({ where: { id } });

      await writeAudit(tx, AUDIT.POLICY_DOCUMENT.DELETED, currentUserId, {
        policyId: id,
        key: policy.key,
        title: policy.title,
        versionsDestroyed: versionIds.length,
        signaturesDestroyed: signatureCount,
        exceptionsDestroyed: exceptionCount,
        readingProgressDestroyed: readingProgressCount,
      });
    });
  },

  // ── Predicate helpers (for gate integration in Slice 3) ─────────────────

  /**
   * Compute the compliance state for a specific user against every active
   * policy that targets their worker type. Slice 3 uses this on the getMe
   * payload + inside assertPoliciesSigned. Slice 2 uses it on the worker's
   * Compliance tab.
   *
   * Loads all the rows the pure predicate needs and hands them off — this
   * function contains no compliance logic itself, so the invariants tested
   * in policies-build-gate.test.ts remain the only source of truth.
   */
  async computeUserComplianceState(userId: string): Promise<ComplianceState> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { workerType: true },
    });
    if (!user) throw new ServiceError("NOT_FOUND", "User not found.", 404);

    const now = new Date();

    // All non-archived policies targeting this worker's type. Owners with
    // null workerType see nothing — no compliance requirements apply.
    const workerTypeFilter = user.workerType
      ? { targetWorkerTypes: { has: user.workerType } }
      : { id: "__no_match__" };

    const policies = await prisma.policyDocument.findMany({
      where: {
        archivedAt: null,
        ...workerTypeFilter,
      },
      include: {
        versions: true,
      },
    });

    if (policies.length === 0) {
      return { current: true, pendingPolicyIds: [], nextExpiryAt: null };
    }

    const policyIds = policies.map((p) => p.id);
    const signatures = await prisma.policySignature.findMany({
      where: {
        userId,
        version: { policyDocumentId: { in: policyIds } },
      },
    });
    const exceptions = await prisma.policyException.findMany({
      where: {
        userId,
        policyDocumentId: { in: policyIds },
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });

    const evaluations: PolicyEvaluation[] = policies.map((policy) => {
      const policyForPredicate: PolicyForPredicate = {
        id: policy.id,
        targetWorkerTypes: policy.targetWorkerTypes,
        enforcement: policy.enforcement,
        workerAction: policy.workerAction,
        requiresWorkerUpload: policy.requiresWorkerUpload,
        workerUploadRequiresExpiry: policy.workerUploadRequiresExpiry,
        workerUploadRequiresApproval: policy.workerUploadRequiresApproval,
        resignTrigger: policy.resignTrigger,
        resignParamDays: policy.resignParamDays,
        resignParamMonthDay: policy.resignParamMonthDay,
        currentVersionId: policy.currentVersionId,
        archivedAt: policy.archivedAt,
      };
      const versionsById = new Map<string, VersionForPredicate>();
      for (const v of policy.versions) {
        versionsById.set(v.id, {
          id: v.id,
          policyDocumentId: v.policyDocumentId,
          status: v.status,
          contentDigest: v.contentDigest,
          publishedAt: v.publishedAt,
          graceUntil: v.graceUntil,
          forcesResign: v.forcesResign,
        });
      }
      const currentVersion = policy.currentVersionId
        ? (versionsById.get(policy.currentVersionId) ?? null)
        : null;
      const relevantSigs: SignatureForPredicate[] = signatures
        .filter((s) => policy.versions.some((v) => v.id === s.policyDocumentVersionId))
        .map((s) => ({
          id: s.id,
          userId: s.userId,
          policyDocumentVersionId: s.policyDocumentVersionId,
          contentDigestAtSign: s.contentDigestAtSign,
          signedAt: s.signedAt,
          uploadStatus: s.uploadStatus,
          uploadExpiresAt: s.uploadExpiresAt,
          revokedAt: s.revokedAt,
        }));
      const activeException = exceptions.find((e) => e.policyDocumentId === policy.id);
      const exceptionForPredicate: ExceptionForPredicate | null = activeException
        ? {
            id: activeException.id,
            userId: activeException.userId,
            policyDocumentId: activeException.policyDocumentId,
            expiresAt: activeException.expiresAt,
            revokedAt: activeException.revokedAt,
          }
        : null;
      return {
        policy: policyForPredicate,
        currentVersion,
        signatures: relevantSigs,
        activeException: exceptionForPredicate,
        versionsById,
      };
    });

    return computeComplianceState(evaluations, now);
  },

  /**
   * Gate helper called by workday-start, job-claim, and vehicle-reserve
   * services (Slice 3). Given a service key and optional context, throws
   * POLICIES_REQUIRED if any BLOCK-level policy targeting the user's type
   * — plus any per-object requiredPolicyIds — isn't currently satisfied.
   *
   * Context is used to apply per-policy filters:
   *   - `effectivePrice` gates policies with `gatesJobsAbovePrice`
   *   - `equipmentRequiredPolicyIds` adds per-equipment requirements to the
   *     resolution set
   */
  async assertPoliciesSigned(
    userId: string,
    service: PolicyGateService,
    ctx?: {
      effectivePrice?: number;
      equipmentRequiredPolicyIds?: string[];
    },
  ): Promise<void> {
    const state = await this.computeUserComplianceState(userId);
    if (state.current) return;

    // Not every pending policy applies to this specific service call — a
    // policy is only a gate for THIS action when either (a) its
    // gatesServices includes `service`, or (b) it's in the
    // equipment-required list.
    const applicableIds = new Set<string>(ctx?.equipmentRequiredPolicyIds ?? []);
    if (state.pendingPolicyIds.length > 0) {
      const pending = await prisma.policyDocument.findMany({
        where: { id: { in: state.pendingPolicyIds } },
        select: {
          id: true,
          gatesServices: true,
          gatesJobsAbovePrice: true,
        },
      });
      for (const p of pending) {
        // Generic per-service gate. RESERVE_EQUIPMENT is intentionally
        // excluded here — its presence in gatesServices is an eligibility
        // flag (marks the policy as attachable to equipment via
        // Equipment.requiredPolicyIds), NOT a global gate. Equipment-level
        // requirements are collected via ctx.equipmentRequiredPolicyIds and
        // pre-loaded into applicableIds above.
        if (service === PolicyGateService.RESERVE_EQUIPMENT) continue;
        if (p.gatesServices.includes(service)) {
          if (service === PolicyGateService.JOB_CLAIM && p.gatesJobsAbovePrice != null) {
            // Only apply when the job's price meets the threshold. Missing
            // context = safe fallback (apply gate).
            if ((ctx?.effectivePrice ?? Infinity) >= p.gatesJobsAbovePrice) {
              applicableIds.add(p.id);
            }
          } else {
            applicableIds.add(p.id);
          }
        }
      }
    }

    // Filter to only policies that actually gate this call.
    const trulyPending = state.pendingPolicyIds.filter((id) => applicableIds.has(id));
    if (trulyPending.length === 0) return;

    throw new ServiceError(
      "POLICIES_REQUIRED",
      "Compliance policies must be signed before this action.",
      403,
      { pendingPolicyIds: trulyPending },
    );
  },

  /**
   * Utility exported for downstream callers that need name normalization
   * matching what the sign wizard applies. Slice 2 uses this in the sign
   * endpoint; exposed here so future callers don't reach into the pure
   * predicate module directly.
   */
  normalizeName,

  // ═══════════════════════════════════════════════════════════════════════
  // Worker-facing methods (Slice 2)
  //
  // These power the worker sign wizard: list what a worker still needs to
  // sign, upload their artifact, record per-page reading progress, and
  // commit the final signature (SIGN) or acknowledgment (ACKNOWLEDGE).
  // Every write is inside a transaction with a CAS guard on the target
  // version's status so a signature can't land against a rolled-back or
  // draft version even if the client raced with an admin action.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Everything a worker needs on their Compliance tab: the outstanding
   * items ordered by admin-controlled sortOrder, plus their full history
   * of signatures across all policies. Called by GET /me/policies.
   */
  async getWorkerPoliciesView(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { workerType: true, displayName: true },
    });
    if (!user) throw new ServiceError("NOT_FOUND", "User not found.", 404);

    const now = new Date();
    // All non-archived policies targeting this worker's type. Owner or
    // admin-only users with workerType=null still see policies with an
    // empty targetWorkerTypes only — but those don't exist in practice, so
    // in that case they see nothing.
    const workerTypeFilter = user.workerType
      ? { targetWorkerTypes: { has: user.workerType } }
      : { id: "__no_match__" };
    const policies = await prisma.policyDocument.findMany({
      where: {
        archivedAt: null,
        ...workerTypeFilter,
      },
      include: {
        currentVersion: true,
        versions: true,
      },
      orderBy: { sortOrder: "asc" },
    });

    // Auto-dormancy grace extension: if this worker's grace period expired
    // recently (within the last 7 days) on any published version, grant a
    // one-time 24h catch-up window so a dormant returner isn't hard-blocked
    // the instant they open the app. Idempotent per (user, policy) — the
    // marker in reason keeps re-runs from stacking exceptions.
    await this._maybeGrantAutoGraceExtensions(userId, policies, now);

    if (policies.length === 0) {
      return {
        displayName: user.displayName ?? null,
        required: [],
        awaitingReview: [],
        history: [],
        state: { current: true, pendingPolicyIds: [], nextExpiryAt: null },
      };
    }

    const policyIds = policies.map((p) => p.id);
    const signatures = await prisma.policySignature.findMany({
      where: {
        userId,
        version: { policyDocumentId: { in: policyIds } },
      },
      orderBy: { signedAt: "desc" },
      include: {
        version: {
          select: {
            id: true,
            versionNumber: true,
            contentDigest: true,
            status: true,
            policyDocumentId: true,
          },
        },
        signedBy: { select: { id: true, displayName: true } },
        onBehalfOf: { select: { id: true, displayName: true } },
      },
    });
    const exceptions = await prisma.policyException.findMany({
      where: {
        userId,
        policyDocumentId: { in: policyIds },
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });

    // Reuse the pure predicate to decide which policies need attention.
    const evaluations = policies.map((policy) => {
      const versionsById = new Map<string, VersionForPredicate>();
      for (const v of policy.versions) {
        versionsById.set(v.id, {
          id: v.id,
          policyDocumentId: v.policyDocumentId,
          status: v.status,
          contentDigest: v.contentDigest,
          publishedAt: v.publishedAt,
          graceUntil: v.graceUntil,
          forcesResign: v.forcesResign,
        });
      }
      const currentVersion = policy.currentVersionId
        ? (versionsById.get(policy.currentVersionId) ?? null)
        : null;
      const relevantSigs: SignatureForPredicate[] = signatures
        .filter((s) => s.version.policyDocumentId === policy.id)
        .map((s) => ({
          id: s.id,
          userId: s.userId,
          policyDocumentVersionId: s.policyDocumentVersionId,
          contentDigestAtSign: s.contentDigestAtSign,
          signedAt: s.signedAt,
          uploadStatus: s.uploadStatus,
          uploadExpiresAt: s.uploadExpiresAt,
          revokedAt: s.revokedAt,
        }));
      const activeException = exceptions.find((e) => e.policyDocumentId === policy.id);
      const exceptionForPredicate: ExceptionForPredicate | null = activeException
        ? {
            id: activeException.id,
            userId: activeException.userId,
            policyDocumentId: activeException.policyDocumentId,
            expiresAt: activeException.expiresAt,
            revokedAt: activeException.revokedAt,
          }
        : null;
      return {
        policy: {
          id: policy.id,
          targetWorkerTypes: policy.targetWorkerTypes,
          enforcement: policy.enforcement,
          workerAction: policy.workerAction,
          requiresWorkerUpload: policy.requiresWorkerUpload,
          workerUploadRequiresExpiry: policy.workerUploadRequiresExpiry,
          workerUploadRequiresApproval: policy.workerUploadRequiresApproval,
          resignTrigger: policy.resignTrigger,
          resignParamDays: policy.resignParamDays,
          resignParamMonthDay: policy.resignParamMonthDay,
          currentVersionId: policy.currentVersionId,
          archivedAt: policy.archivedAt,
        },
        currentVersion,
        signatures: relevantSigs,
        activeException: exceptionForPredicate,
        versionsById,
      };
    });

    const state = computeComplianceState(evaluations, now);

    // Split the response into three lists:
    //   1. `required`      — worker can act NOW (open the sign wizard)
    //   2. `awaitingReview` — worker already did their part; admin has a
    //                          pending upload review. Read-only from the
    //                          worker's POV (aside from an opt-in re-upload).
    //   3. `history`       — everything signed / rejected / revoked
    //
    // A policy lands in `awaitingReview` when the newest non-revoked
    // signature on its CURRENT version is PENDING_REVIEW and the policy
    // requires admin approval. If the current version has moved past the
    // signed one (e.g. admin published v2 with forcesResign), the sig no
    // longer covers current and the policy goes back into `required`.
    const awaitingReviewIds = new Set<string>();
    for (const policy of policies) {
      if (!policy.workerUploadRequiresApproval) continue;
      if (!policy.currentVersionId) continue;
      const sigsForCurrent = signatures
        .filter(
          (s) =>
            s.version.policyDocumentId === policy.id &&
            s.policyDocumentVersionId === policy.currentVersionId &&
            !s.revokedAt,
        )
        .sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime());
      const newest = sigsForCurrent[0];
      if (newest?.uploadStatus === "PENDING_REVIEW") {
        awaitingReviewIds.add(policy.id);
      }
    }

    const required = policies
      .filter((p) => {
        // Anything in the admin's queue is not a worker action right now.
        if (awaitingReviewIds.has(p.id)) return false;
        // Active exception overrides the entire "required" state — the
        // worker is explicitly excused for now regardless of whether they
        // ever signed. Guarded here so the "no signature yet" fallback
        // below doesn't re-add exception-covered policies.
        const hasActiveException = exceptions.some((e) => e.policyDocumentId === p.id);
        if (hasActiveException) return false;
        // BLOCK-level policies that are pending drive the sign wizard.
        // WARN-level ones show as banners; INFO as informational cards.
        if (state.pendingPolicyIds.includes(p.id)) return true;
        // Even non-BLOCK: if a signature is missing entirely, show it in
        // the required list so the worker can complete it. Exception:
        // NONE policies (worker never touches — admin uploads on behalf).
        const hasSig = signatures.some(
          (s) => s.version.policyDocumentId === p.id && !s.revokedAt,
        );
        if (p.workerAction !== "NONE" && !hasSig) return true;
        return false;
      })
      .map((p) => ({
        policyId: p.id,
        key: p.key,
        title: p.title,
        description: p.description,
        enforcement: p.enforcement,
        workerAction: p.workerAction,
        requiresWorkerUpload: p.requiresWorkerUpload,
        workerUploadLabel: p.workerUploadLabel,
        workerUploadAcceptedTypes: p.workerUploadAcceptedTypes,
        workerUploadRequiresExpiry: p.workerUploadRequiresExpiry,
        currentVersion: p.currentVersion
          ? {
              id: p.currentVersion.id,
              versionNumber: p.currentVersion.versionNumber,
              contentFormat: p.currentVersion.contentFormat,
              contentMarkdown: p.currentVersion.contentMarkdown,
              contentR2Key: p.currentVersion.contentR2Key,
              contentFileName: p.currentVersion.contentFileName,
              contentContentType: p.currentVersion.contentContentType,
              pdfPageCount: p.currentVersion.pdfPageCount,
              contentDigest: p.currentVersion.contentDigest,
            }
          : null,
        sortOrder: p.sortOrder,
      }));

    const awaitingReview = policies
      .filter((p) => awaitingReviewIds.has(p.id))
      .map((p) => {
        const newest = signatures
          .filter(
            (s) =>
              s.version.policyDocumentId === p.id &&
              s.policyDocumentVersionId === p.currentVersionId &&
              !s.revokedAt,
          )
          .sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime())[0];
        return {
          policyId: p.id,
          key: p.key,
          title: p.title,
          description: p.description,
          signatureId: newest?.id ?? null,
          uploadFileName: newest?.uploadFileName ?? null,
          uploadExpiresAt: newest?.uploadExpiresAt ?? null,
          uploadedAt: newest?.signedAt ?? null,
          sortOrder: p.sortOrder,
          // Wizard-material for the opt-in "Replace upload" affordance.
          workerAction: p.workerAction,
          requiresWorkerUpload: p.requiresWorkerUpload,
          workerUploadLabel: p.workerUploadLabel,
          workerUploadAcceptedTypes: p.workerUploadAcceptedTypes,
          workerUploadRequiresExpiry: p.workerUploadRequiresExpiry,
          enforcement: p.enforcement,
          currentVersion: p.currentVersion
            ? {
                id: p.currentVersion.id,
                versionNumber: p.currentVersion.versionNumber,
                contentFormat: p.currentVersion.contentFormat,
                contentMarkdown: p.currentVersion.contentMarkdown,
                contentR2Key: p.currentVersion.contentR2Key,
                contentFileName: p.currentVersion.contentFileName,
                contentContentType: p.currentVersion.contentContentType,
                pdfPageCount: p.currentVersion.pdfPageCount,
                contentDigest: p.currentVersion.contentDigest,
              }
            : null,
        };
      });

    // History: all signatures the worker has, plus the parent policy info
    // so the UI can render "Signed [title] v3 on [date]" cards.
    const history = signatures.map((s) => {
      const policy = policies.find((p) => p.id === s.version.policyDocumentId);
      return {
        signatureId: s.id,
        policyId: policy?.id ?? s.version.policyDocumentId,
        policyKey: policy?.key ?? null,
        policyTitle: policy?.title ?? "(archived policy)",
        versionNumber: s.version.versionNumber,
        signedAt: s.signedAt,
        signedByUserId: s.signedByUserId,
        signedByDisplayName: s.signedBy?.displayName ?? null,
        onBehalfOf: s.onBehalfOfUserId ?? null,
        workerActionAtSign: s.workerActionAtSign,
        uploadStatus: s.uploadStatus,
        uploadExpiresAt: s.uploadExpiresAt,
        uploadRejectionReason: s.uploadRejectionReason,
        revokedAt: s.revokedAt,
        revokedReason: s.revokedReason,
      };
    });

    return {
      displayName: user.displayName ?? null,
      required,
      awaitingReview,
      history,
      state,
    };
  },

  // Reason marker used to identify auto-grace exceptions so we never grant a
  // second one for the same (user, policy). Exported implicitly via the
  // reason string being human-readable.
  _AUTO_GRACE_REASON_PREFIX: "AUTO_GRACE_EXTENSION_24H",

  /**
   * If a policy's current version has published grace that expired within
   * the last 7 days, and the worker hasn't already received an auto-grace
   * extension for this policy, grant them a 24h catch-up window as an
   * exception. Silent — no user-facing message, just prevents an immediate
   * hard block for a dormant returner. Returns the number of extensions
   * granted so the caller can decide whether to re-query exceptions.
   */
  async _maybeGrantAutoGraceExtensions(
    userId: string,
    policies: Array<{
      id: string;
      currentVersion: { graceUntil: Date | null } | null;
    }>,
    now: Date,
  ): Promise<number> {
    // date-handling-allow: elapsed-time
    const GRACE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
    // date-handling-allow: elapsed-time
    const EXTENSION_MS = 24 * 60 * 60 * 1000;

    // Filter to policies where auto-grace is potentially applicable.
    const candidatePolicyIds = policies
      .filter((p) => {
        const graceUntil = p.currentVersion?.graceUntil;
        if (!graceUntil) return false;
        const expiredMs = now.getTime() - graceUntil.getTime();
        return expiredMs > 0 && expiredMs <= GRACE_LOOKBACK_MS;
      })
      .map((p) => p.id);
    if (candidatePolicyIds.length === 0) return 0;

    // Idempotency lookup — one query for all candidate policies.
    const existing = await prisma.policyException.findMany({
      where: {
        userId,
        policyDocumentId: { in: candidatePolicyIds },
        reason: { startsWith: this._AUTO_GRACE_REASON_PREFIX },
      },
      select: { policyDocumentId: true },
    });
    const alreadyGranted = new Set(existing.map((e) => e.policyDocumentId));
    const toGrant = candidatePolicyIds.filter((id) => !alreadyGranted.has(id));
    if (toGrant.length === 0) return 0;

    const expiresAt = new Date(now.getTime() + EXTENSION_MS);
    const reason = `${this._AUTO_GRACE_REASON_PREFIX} — dormant worker returning after grace end`;

    // Self-granted (grantedById = userId) so the required FK stays valid
    // without needing a synthetic system user. The reason marker + the fact
    // that grantedById === userId are together sufficient to distinguish
    // auto-grace exceptions in audit and reporting.
    await prisma.$transaction(async (tx) => {
      for (const policyId of toGrant) {
        await tx.policyException.create({
          data: {
            userId,
            policyDocumentId: policyId,
            grantedById: userId,
            expiresAt,
            reason,
          },
        });
        await writeAudit(tx, AUDIT.POLICY_DOCUMENT.EXCEPTION_GRANTED, userId, {
          policyId,
          targetUserId: userId,
          autoGrace: true,
          expiresAt: expiresAt.toISOString(),
        });
      }
    });
    return toGrant.length;
  },

  /**
   * Presigned R2 upload URL for a worker's personal artifact (e.g. their
   * insurance certificate). Called before submitting the signature so the
   * client can direct-PUT the file, then include the resulting r2Key in
   * the sign payload.
   */
  async getWorkerUploadUrl(
    userId: string,
    versionId: string,
    fileName: string,
    contentType: string,
  ) {
    const version = await prisma.policyDocumentVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        status: true,
        policyDocumentId: true,
        policyDocument: { select: { requiresWorkerUpload: true, archivedAt: true } },
      },
    });
    if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    if (version.status !== PolicyVersionStatus.PUBLISHED) {
      throw new ServiceError("VERSION_NOT_PUBLISHED", "Version is not currently published.", 409);
    }
    if (version.policyDocument.archivedAt) {
      throw new ServiceError("POLICY_ARCHIVED", "Policy is archived.", 409);
    }
    if (!version.policyDocument.requiresWorkerUpload) {
      throw new ServiceError("UPLOAD_NOT_REQUIRED", "This policy doesn't accept a worker upload.", 400);
    }
    const key = `policies/signatures/${version.policyDocumentId}/${userId}/${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType, 300, "docs");
    return { uploadUrl, key };
  },

  /**
   * Worker cancels their own PENDING_REVIEW signature — e.g. they realized
   * they uploaded the wrong file and want to bail before admin reviews. The
   * signature is soft-revoked with an inline reason so it stays in the
   * audit trail. Only PENDING_REVIEW rows owned by the caller can be
   * cancelled; APPROVED / REJECTED / already-revoked rows throw.
   */
  async cancelPendingSignatureAsWorker(userId: string, signatureId: string) {
    return prisma.$transaction(async (tx) => {
      const sig = await tx.policySignature.findUnique({
        where: { id: signatureId },
      });
      if (!sig) throw new ServiceError("NOT_FOUND", "Signature not found.", 404);
      if (sig.userId !== userId) {
        throw new ServiceError("FORBIDDEN", "That signature isn't yours to cancel.", 403);
      }
      if (sig.revokedAt) {
        throw new ServiceError("ALREADY_REVOKED", "Signature is already cancelled.", 409);
      }
      if (sig.uploadStatus !== PolicyUploadStatus.PENDING_REVIEW) {
        throw new ServiceError(
          "NOT_PENDING_REVIEW",
          "Only pending-review uploads can be cancelled from the worker side. Contact an admin if you need to change an approved record.",
          409,
        );
      }
      await tx.policySignature.update({
        where: { id: signatureId },
        data: {
          revokedAt: new Date(),
          revokedById: userId,
          revokedReason: "Cancelled by worker before admin review.",
        },
      });
      await writeAudit(tx, AUDIT.POLICY_SIGNATURE.REVOKED, userId, {
        signatureId,
        userId,
        selfCancel: true,
      });
    });
  },

  /**
   * Per-page reading-progress log — one row per page view. Called by the
   * client after each dwell timer expires. Server logs IP + UA + timestamp
   * so the audit trail can prove which pages the worker actually viewed
   * before signing (fix for #11 in the policy design memo).
   */
  async recordPageView(
    userId: string,
    versionId: string,
    pageNumber: number,
    clientIp: string | null,
    userAgent: string | null,
  ) {
    const version = await prisma.policyDocumentVersion.findUnique({
      where: { id: versionId },
      select: { id: true, status: true, pdfPageCount: true, contentFormat: true },
    });
    if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    if (version.status !== PolicyVersionStatus.PUBLISHED) {
      throw new ServiceError("VERSION_NOT_PUBLISHED", "Version is not currently published.", 409);
    }
    if (version.contentFormat !== PolicyContentFormat.PDF) {
      throw new ServiceError("NOT_PDF_VERSION", "Page-view logging only applies to PDF versions.", 400);
    }
    if (!version.pdfPageCount || pageNumber < 1 || pageNumber > version.pdfPageCount) {
      throw new ServiceError("INVALID_PAGE", "Invalid page number.", 400);
    }
    await prisma.policyReadingProgress.create({
      data: {
        userId,
        policyDocumentVersionId: versionId,
        pageNumber,
        ipAddress: clientIp,
        userAgent,
      },
    });
  },

  /**
   * Full SIGN — worker typed their legal name, checked the acknowledgment,
   * viewed all pages (if PDF), and optionally uploaded an artifact.
   * Server-side checks:
   *   1. Version is still PUBLISHED (CAS guard on write)
   *   2. Typed name normalizes to the user's displayName
   *   3. For PDF: all pdfPageCount pages have a PolicyReadingProgress row
   *      for this user × version (any age — client won't advance the
   *      wizard without them, but we double-check server-side)
   *   4. If policy requires upload: uploadR2Key + uploadDigest present,
   *      uploadExpiresAt present when the policy requires expiry
   *   5. Content digest for the signature is copied from the version's
   *      current contentDigest — pins the signed content immutably
   */
  async signPolicy(
    userId: string,
    versionId: string,
    input: {
      typedName: string;
      uploadR2Key?: string;
      uploadFileName?: string;
      uploadContentType?: string;
      uploadDigest?: string;
      uploadExpiresAt?: Date | null;
      clientIp: string | null;
      userAgent: string | null;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      // Load version + policy inside the tx so any race with a rollback
      // is detected atomically.
      const version = await tx.policyDocumentVersion.findUnique({
        where: { id: versionId },
        include: { policyDocument: true },
      });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      if (version.status !== PolicyVersionStatus.PUBLISHED) {
        throw new ServiceError("VERSION_NOT_PUBLISHED", "Version is not currently published.", 409);
      }
      const policy = version.policyDocument;
      if (policy.archivedAt) {
        throw new ServiceError("POLICY_ARCHIVED", "Policy is archived.", 409);
      }
      if (policy.workerAction !== PolicyWorkerAction.SIGN) {
        throw new ServiceError(
          "NOT_SIGN_POLICY",
          `Use ${policy.workerAction === PolicyWorkerAction.ACKNOWLEDGE ? "acknowledgePolicy" : "an admin upload"} for this policy.`,
          400,
        );
      }

      // Typed-name normalization vs user.displayName.
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, displayName: true },
      });
      const displayName = user.displayName ?? "";
      const normalizedInput = normalizeName(input.typedName);
      const normalizedDisplay = normalizeName(displayName);
      if (!normalizedInput || normalizedInput !== normalizedDisplay) {
        throw new ServiceError(
          "TYPED_NAME_MISMATCH",
          `Please enter your name exactly as: ${displayName}`,
          400,
          { acceptedName: displayName },
        );
      }

      // Page-view check for PDF versions.
      if (version.contentFormat === PolicyContentFormat.PDF && version.pdfPageCount && version.pdfPageCount > 0) {
        const viewedPages = await tx.policyReadingProgress.findMany({
          where: {
            userId,
            policyDocumentVersionId: versionId,
          },
          distinct: ["pageNumber"],
          select: { pageNumber: true },
        });
        const seen = new Set(viewedPages.map((v) => v.pageNumber));
        for (let n = 1; n <= version.pdfPageCount; n++) {
          if (!seen.has(n)) {
            throw new ServiceError(
              "PAGES_NOT_VIEWED",
              `You must view every page of the document before signing (missing page ${n}).`,
              400,
            );
          }
        }
      }

      // Upload requirements.
      if (policy.requiresWorkerUpload) {
        if (!input.uploadR2Key || !input.uploadDigest) {
          throw new ServiceError("UPLOAD_REQUIRED", "This policy requires a document upload.", 400);
        }
        if (policy.workerUploadRequiresExpiry && !input.uploadExpiresAt) {
          throw new ServiceError("EXPIRY_REQUIRED", "This policy requires an upload expiry date.", 400);
        }
      }

      // Create the signature. Content digest is copied atomically inside
      // the tx from the version's current digest.
      const created = await tx.policySignature.create({
        data: {
          userId,
          policyDocumentVersionId: versionId,
          workerActionAtSign: PolicyWorkerAction.SIGN,
          signedByUserId: userId,
          onBehalfOfUserId: null,
          contentDigestAtSign: version.contentDigest,
          typedNameRaw: input.typedName,
          typedNameNormalized: normalizedInput,
          signatureIp: input.clientIp,
          signatureUserAgent: input.userAgent,
          uploadR2Key: input.uploadR2Key ?? null,
          uploadFileName: input.uploadFileName ?? null,
          uploadContentType: input.uploadContentType ?? null,
          uploadDigest: input.uploadDigest ?? null,
          uploadExpiresAt: input.uploadExpiresAt ?? null,
          uploadStatus: policy.requiresWorkerUpload && policy.workerUploadRequiresApproval
            ? PolicyUploadStatus.PENDING_REVIEW
            : PolicyUploadStatus.NONE,
        },
      });

      // Link the reading-progress rows to this signature so the audit
      // record has the full "worker viewed page N at time T" chain.
      await tx.policyReadingProgress.updateMany({
        where: {
          userId,
          policyDocumentVersionId: versionId,
          policySignatureId: null,
        },
        data: { policySignatureId: created.id },
      });

      await writeAudit(tx, AUDIT.POLICY_SIGNATURE.SIGNED, userId, {
        signatureId: created.id,
        policyId: policy.id,
        versionId,
        hadUpload: !!input.uploadR2Key,
        uploadRequiresReview: policy.workerUploadRequiresApproval,
      });
      return created;
    });
  },

  /**
   * Click-through ACKNOWLEDGE — worker checked "I've read this" but
   * didn't type a legal name. Same as signPolicy but skips the name
   * check, PDF page-view check, and upload flow (ACKNOWLEDGE policies
   * shouldn't require uploads by design; enforced here).
   */
  async acknowledgePolicy(
    userId: string,
    versionId: string,
    input: {
      clientIp: string | null;
      userAgent: string | null;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const version = await tx.policyDocumentVersion.findUnique({
        where: { id: versionId },
        include: { policyDocument: true },
      });
      if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
      if (version.status !== PolicyVersionStatus.PUBLISHED) {
        throw new ServiceError("VERSION_NOT_PUBLISHED", "Version is not currently published.", 409);
      }
      const policy = version.policyDocument;
      if (policy.archivedAt) {
        throw new ServiceError("POLICY_ARCHIVED", "Policy is archived.", 409);
      }
      if (policy.workerAction !== PolicyWorkerAction.ACKNOWLEDGE) {
        throw new ServiceError(
          "NOT_ACKNOWLEDGE_POLICY",
          "Use signPolicy for SIGN-type policies.",
          400,
        );
      }
      const created = await tx.policySignature.create({
        data: {
          userId,
          policyDocumentVersionId: versionId,
          workerActionAtSign: PolicyWorkerAction.ACKNOWLEDGE,
          signedByUserId: userId,
          onBehalfOfUserId: null,
          contentDigestAtSign: version.contentDigest,
          signatureIp: input.clientIp,
          signatureUserAgent: input.userAgent,
          uploadStatus: PolicyUploadStatus.NONE,
        },
      });
      await writeAudit(tx, AUDIT.POLICY_SIGNATURE.SIGNED, userId, {
        signatureId: created.id,
        policyId: policy.id,
        versionId,
        acknowledgeOnly: true,
      });
      return created;
    });
  },

  /**
   * View-content download URL for a worker to (re)view a signature's
   * uploaded artifact (or a PDF version's content). 1-hour presigned GET
   * per Slice 2 defense-in-depth pattern.
   */
  async getWorkerContentDownloadUrl(userId: string, r2Key: string) {
    // Access control: worker can download an artifact only when it's on a
    // signature owned by them, OR the r2Key belongs to a policy version's
    // published content and the worker's workerType is targeted.
    const sig = await prisma.policySignature.findFirst({
      where: { userId, uploadR2Key: r2Key },
      select: { id: true },
    });
    const versionAsContent = await prisma.policyDocumentVersion.findFirst({
      where: { contentR2Key: r2Key, status: PolicyVersionStatus.PUBLISHED },
      select: { id: true },
    });
    if (!sig && !versionAsContent) {
      throw new ServiceError("NOT_FOUND", "Object not found or not accessible.", 404);
    }
    const { getDownloadUrl } = await import("../lib/r2");
    return getDownloadUrl(r2Key, 3600, "docs");
  },

  /**
   * Admin-only presigned GET for any version's content (any status).
   * Used by the preview dialog to render PDF versions inline before publish.
   * Returns null if the version has no PDF content (markdown-only versions).
   */
  async getVersionContentUrlForAdmin(versionId: string): Promise<string | null> {
    const version = await prisma.policyDocumentVersion.findUnique({
      where: { id: versionId },
      select: { contentR2Key: true, contentFormat: true },
    });
    if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
    if (!version.contentR2Key) return null;
    const { getDownloadUrl } = await import("../lib/r2");
    return getDownloadUrl(version.contentR2Key, 3600, "docs");
  },
};
