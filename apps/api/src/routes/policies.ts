import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereVia } from "../lib/areaScope";
import { WORKER_TYPES, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate } from "./_shared";

export default async function policyRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_complianceManage = requires("compliance.manage");
  const req_complianceView = requires("compliance.view");

  app.get("/policies", req_complianceView, async (req: any) => {
    const q = (req.query || {}) as { includeArchived?: string };
    return services.policies.listPolicies({
      includeArchived: q.includeArchived === "true" || q.includeArchived === "1",
    });
  });
  app.get("/policies/pending-approvals", req_complianceView, async () => {
    return services.policies.listPendingApprovals();
  });
  app.get("/policies/pending-upload-reviews", req_complianceView, async () => {
    return services.policies.listPendingUploadReviews();
  });
  // Lightweight count endpoints for the alerts dropdown badge. Cheap to
  // load — bounded by the small number of pending admin actions in
  // practice. Returned as { pendingUploadReviews, pendingApprovals } so
  // the alerts dropdown can surface both without two round trips.
  app.get("/policies/counts", req_complianceView, async () => {
    const [pendingUploadReviews, pendingApprovals] = await Promise.all([
      prisma.policySignature.count({
        where: {
          uploadStatus: "PENDING_REVIEW",
          revokedAt: null,
          // Exclude archived policies — their pending uploads shouldn't
          // demand admin attention (mirrors listPendingUploadReviews).
          version: { policyDocument: { archivedAt: null } },
        },
      }),
      prisma.policyDocumentVersion.count({
        where: {
          status: "PENDING_APPROVAL",
          policyDocument: { archivedAt: null },
        },
      }),
    ]);
    return { pendingUploadReviews, pendingApprovals };
  });
  // Bulk per-user compliance summary. Powers the UsersTab chip so each
  // worker card can show "Compliance: OK" / "N pending" at a glance.
  app.get("/policies/user-compliance", req_complianceView, async () => {
    return services.policies.getAllUsersComplianceSummary();
  });
  app.get("/policies/sign-matrix", req_complianceView, async () => {
    return services.policies.getSignMatrix();
  });
  // Policies eligible to be attached to a piece of equipment — filtered to
  // non-archived BLOCK policies whose gatesServices includes RESERVE_EQUIPMENT.
  // Powers the EquipmentDialog's per-piece policy multi-select. `compliance.view`
  // (matches other equipment admin flows).
  app.get("/policies/attachable-to-equipment", req_complianceView, async () => {
    return services.policies.listEquipmentAttachablePolicies();
  });
  app.post("/policies/nudge", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.userId) throw new Error("userId required");
    return services.policies.nudgeWorker(uid, String(b.userId));
  });
  app.get("/policies/versions/:id/content-url", req_complianceView, async (req: any) => {
    const url = await services.policies.getAnyVersionContentUrl(String(req.params.id));
    return { url };
  });
  app.get("/policies/:id", req_complianceView, async (req: any) => {
    return services.policies.getPolicyDetail(String(req.params.id));
  });
  app.post("/policies", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.policies.createPolicy(uid, req.body);
  });
  app.patch("/policies/:id", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.policies.updatePolicy(uid, String(req.params.id), req.body || {});
  });
  app.post("/policies/:id/archive", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    await services.policies.archivePolicy(uid, String(req.params.id), String(b.reason ?? ""));
    return { ok: true };
  });
  app.post("/policies/:id/unarchive", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    await services.policies.unarchivePolicy(uid, String(req.params.id));
    return { ok: true };
  });
  // Permanent delete. Only valid on already-archived policies; the two-
  // step motion is enforced server-side. Destroys the policy + every
  // version, signature, exception, and reading-progress row. Audit log
  // preserves the destruction counts.
  app.delete("/policies/:id/permanent", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    await services.policies.deletePolicyPermanently(uid, String(req.params.id));
    return { ok: true };
  });
  app.post("/policies/:id/versions", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.policies.createVersion(uid, String(req.params.id), req.body);
  });
  app.patch("/policies/versions/:id", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.policies.updateDraft(uid, String(req.params.id), req.body || {});
  });
  app.post("/policies/versions/:id/pdf-upload-url", req_complianceManage, async (req: any) => {
    const b = req.body || {};
    const fileName = String(b.fileName ?? "content.pdf");
    const contentType = String(b.contentType ?? "application/pdf");
    return services.policies.getPdfUploadUrl(String(req.params.id), fileName, contentType);
  });
  app.post("/policies/versions/:id/confirm-pdf", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.r2Key) throw app.httpErrors.badRequest("r2Key is required");
    if (!b.contentDigest) throw app.httpErrors.badRequest("contentDigest is required");
    if (typeof b.pdfPageCount !== "number") throw app.httpErrors.badRequest("pdfPageCount is required");
    await services.policies.confirmPdfUpload(uid, String(req.params.id), {
      r2Key: String(b.r2Key),
      fileName: String(b.fileName ?? "content.pdf"),
      contentType: String(b.contentType ?? "application/pdf"),
      contentDigest: String(b.contentDigest),
      pdfPageCount: Number(b.pdfPageCount),
    });
    return { ok: true };
  });
  app.post("/policies/versions/:id/submit", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    await services.policies.submitVersionForApproval(uid, String(req.params.id));
    return { ok: true };
  });
  app.post("/policies/versions/:id/approve", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    await services.policies.approveVersion(uid, String(req.params.id));
    return { ok: true };
  });
  app.post("/policies/versions/:id/publish", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    await services.policies.publishVersion(uid, String(req.params.id), {
      graceHours: typeof b.graceHours === "number" ? b.graceHours : undefined,
      forcesResign: typeof b.forcesResign === "boolean" ? b.forcesResign : undefined,
    });
    return { ok: true };
  });
  app.post("/policies/versions/:id/rollback", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    await services.policies.rollbackVersion(uid, String(req.params.id), String(b.reason ?? ""));
    return { ok: true };
  });
  app.post("/policies/:id/force-resign", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.policies.forceResignAll(uid, String(req.params.id), String(b.reason ?? ""));
  });
  app.post("/policies/:id/exceptions", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.userId) throw app.httpErrors.badRequest("userId is required");
    if (!b.expiresAt) throw app.httpErrors.badRequest("expiresAt is required");
    if (!b.reason) throw app.httpErrors.badRequest("reason is required");
    // The GrantExceptionDialog's `<input type="date">` sends a bare
    // "YYYY-MM-DD" string. `new Date("YYYY-MM-DD")` parses as UTC
    // midnight — 8pm ET the PREVIOUS day during EDT — so an operator
    // who picked 7/11 would end up with an expiresAt of 2026-07-11T00:00Z
    // that displays via `fmtDate()` as "7/10". Route the string through
    // the canonical etEndOfDay helper so "picked 7/11" means "exception
    // is valid all day 7/11 in the business timezone." Matches the
    // operator's mental model AND the display date.
    return services.policies.grantException(uid, {
      userId: String(b.userId),
      policyId: String(req.params.id),
      expiresAt: etEndOfDay(String(b.expiresAt) as EtDateKey),
      reason: String(b.reason),
    });
  });
  app.delete("/policies/exceptions/:id", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    await services.policies.revokeException(uid, String(req.params.id), String(b.reason ?? ""));
    return { ok: true };
  });
  app.post("/policies/signatures/:id/review", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    const decision = String(b.decision ?? "").toUpperCase();
    if (decision !== "APPROVE" && decision !== "REJECT") {
      throw app.httpErrors.badRequest("decision must be APPROVE or REJECT");
    }
    await services.policies.reviewUpload(
      uid,
      String(req.params.id),
      decision as "APPROVE" | "REJECT",
      b.reason ? String(b.reason) : undefined,
    );
    return { ok: true };
  });
  app.post("/policies/signatures/:id/revoke", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    await services.policies.revokeSignature(uid, String(req.params.id), String(b.reason ?? ""));
    return { ok: true };
  });
  app.post("/policies/upload-on-behalf", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.userId) throw app.httpErrors.badRequest("userId is required");
    if (!b.policyId) throw app.httpErrors.badRequest("policyId is required");
    if (!b.uploadR2Key) throw app.httpErrors.badRequest("uploadR2Key is required");
    if (!b.uploadDigest) throw app.httpErrors.badRequest("uploadDigest is required");
    const created = await services.policies.uploadOnBehalf(uid, {
      userId: String(b.userId),
      policyId: String(b.policyId),
      uploadR2Key: String(b.uploadR2Key),
      uploadFileName: String(b.uploadFileName ?? ""),
      uploadContentType: String(b.uploadContentType ?? ""),
      uploadDigest: String(b.uploadDigest),
      // The upload-expiry picker is `<input type="date">` sending a
      // bare "YYYY-MM-DD" string. Route through etEndOfDay for the same
      // reason as grantException above: an insurance cert expiring
      // 2027-12-31 would otherwise be stored as 2027-12-31T00:00Z (= Dec
      // 30 20:00 ET) and lapse a day early against `UPLOAD_EXPIRED`.
      uploadExpiresAt: b.uploadExpiresAt ? etEndOfDay(String(b.uploadExpiresAt) as EtDateKey) : null,
      typeAcknowledgment: b.typeAcknowledgment ? String(b.typeAcknowledgment) : undefined,
      clientIp: (req.ip as string) ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
    });
    return { signatureId: created.id };
  });
  // Presigned R2 upload URL for the upload-on-behalf flow. Same
  // "docs" bucket + 5-min TTL as other document uploads.
  app.post("/policies/upload-on-behalf/upload-url", req_complianceManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.userId) throw app.httpErrors.badRequest("userId is required");
    if (!b.policyId) throw app.httpErrors.badRequest("policyId is required");
    const fileName = String(b.fileName ?? "artifact.pdf");
    const contentType = String(b.contentType ?? "application/pdf");
    const key = `policies/signatures/${String(b.policyId)}/${String(b.userId)}/${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType, 300, "docs");
    void uid; // audit happens on uploadOnBehalf finalization
    return { uploadUrl, key };
  });
  app.get("/me/policies", approvedUser, async (req: any) => {
    // ?viewAsUserId=<id> reads another person's compliance view — used by
    // the Home "View as" flow to render the target's ComplianceBanner
    // correctly. Mutations on /me/policies/*
    // (sign, acknowledge, upload) intentionally do NOT accept viewAsUserId:
    // those are self-service by design (worker must acknowledge / sign
    // in-person). Holders of `compliance.manage` act on someone else's compliance via
    // /policies/... routes.
    const callerUid = await currentUserId(req);
    const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
    let targetUid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid },
        
      });
      const canManagePeople = callerCan(req, "people.manage");
      if (!canManagePeople) {
        throw app.httpErrors.forbidden("Admin or Super role required to view another worker's compliance.");
      }
      targetUid = viewAsUserId;
    }
    return services.policies.getWorkerPoliciesView(targetUid);
  });
  // view-as-allow: drives the caller's own alerts-dropdown badge (their
  // own notifications feed). The view-as flow does not consume this — the
  // banner uses /me/policies with viewAsUserId instead.
  //
  // Cheap count for the alerts dropdown badge — same required list as
  // /me/policies but without loading the full history, description text,
  // or version content. Returned as { pendingCount } for symmetry with
  // the other alert endpoints.
  app.get("/me/policies/count", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const view = await services.policies.getWorkerPoliciesView(uid);
    return { pendingCount: view.required.length };
  });
  app.post("/me/policies/versions/:id/upload-url", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    const fileName = String(b.fileName ?? "artifact.pdf");
    const contentType = String(b.contentType ?? "application/pdf");
    return services.policies.getWorkerUploadUrl(uid, String(req.params.id), fileName, contentType);
  });
  app.post("/me/policies/versions/:id/page-view", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (typeof b.pageNumber !== "number") {
      throw app.httpErrors.badRequest("pageNumber is required");
    }
    await services.policies.recordPageView(
      uid,
      String(req.params.id),
      Number(b.pageNumber),
      (req.ip as string) ?? null,
      (req.headers["user-agent"] as string) ?? null,
    );
    return { ok: true };
  });
  app.post("/me/policies/versions/:id/sign", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.typedName) throw app.httpErrors.badRequest("typedName is required");
    const created = await services.policies.signPolicy(uid, String(req.params.id), {
      typedName: String(b.typedName),
      uploadR2Key: b.uploadR2Key ? String(b.uploadR2Key) : undefined,
      uploadFileName: b.uploadFileName ? String(b.uploadFileName) : undefined,
      uploadContentType: b.uploadContentType ? String(b.uploadContentType) : undefined,
      uploadDigest: b.uploadDigest ? String(b.uploadDigest) : undefined,
      // Worker's cert-expiry picker is `<input type="date">` sending
      // "YYYY-MM-DD". Route through etEndOfDay so an insurance cert
      // expiring 2027-12-31 lasts through end of 12/31 ET rather than
      // silently expiring at 8pm ET on 12/30 due to UTC-midnight parsing.
      // Same fix as the uploadOnBehalf route above.
      uploadExpiresAt: b.uploadExpiresAt ? etEndOfDay(String(b.uploadExpiresAt) as EtDateKey) : null,
      clientIp: (req.ip as string) ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
    });
    return { signatureId: created.id };
  });
  app.post("/me/policies/versions/:id/acknowledge", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const created = await services.policies.acknowledgePolicy(uid, String(req.params.id), {
      clientIp: (req.ip as string) ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
    });
    return { signatureId: created.id };
  });
  // Worker cancels their own PENDING_REVIEW signature. Soft-revokes the
  // row; audit trail preserved. Only usable while the upload is still
  // awaiting admin review — once approved or rejected, only someone with `compliance.manage` can
  // touch the record.
  app.post("/me/policies/signatures/:id/cancel", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    await services.policies.cancelPendingSignatureAsWorker(uid, String(req.params.id));
    return { ok: true };
  });
  // view-as-allow: presigned download URL for the CALLER's own signature
  // artifact / policy body. Admin equivalents live under
  // /policies/signatures/... for downloading someone else's upload.
  //
  // View-content presigned GET — worker downloads either the version's
  // published content (e.g., PDF policy body) or their own signature's
  // uploaded artifact for review.
  app.get("/me/policies/download", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const q = (req.query || {}) as { r2Key?: string };
    if (!q.r2Key) throw app.httpErrors.badRequest("r2Key query param required");
    const url = await services.policies.getWorkerContentDownloadUrl(uid, String(q.r2Key));
    return { url };
  });

}
