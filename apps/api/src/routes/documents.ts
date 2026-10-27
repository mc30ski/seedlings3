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

export default async function documentRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_documentsManage = requires("documents.manage");
  const req_documentsView = requires("documents.view");

  // ── Company documents ────────────────────────────────────────────────
  //
  // ONE ROUTE PER RESOURCE. There used to be two of each — an `admin`-prefixed
  // with `restrictedVisible: false` and `/documents` with `true` —
  // GATED ON THE SAME ENTITLEMENT. The URL prefix was the only thing
  // separating them, and a path is not a check: anyone holding
  // `documents.view` could call the `/super` twin and read documents
  // deliberately hidden from holders of `documents.manage`.
  //
  // Now the route decides WHO MAY ASK (`documents.view`) and the payload
  // decides HOW MUCH THEY SEE (`documents.manage`). That is the three-system
  // split working as designed — entitlement gates the route, redaction trims
  // the response — instead of the client picking its own privilege level by
  // choosing a URL.
  app.get("/documents", req_documentsView, async (req: any) => {
    const { type, status, q } = (req.query || {}) as Record<string, string>;
    return services.companyDocuments.list({
      restrictedVisible: callerCan(req, "documents.manage"),
      type,
      status: (status as any) || undefined,
      q,
    });
  });
  app.get("/documents/expiration-counts", req_documentsView, async (req: any) => {
    return services.companyDocuments.expirationCounts({ restrictedVisible: callerCan(req, "documents.manage") });
  });
  app.get("/documents/:id", req_documentsView, async (req: any) => {
    return services.companyDocuments.get(String(req.params.id), {
      restrictedVisible: callerCan(req, "documents.manage"),
    });
  });
  app.get(
    "/documents/:id/versions/:versionId/url",
    req_documentsView,
    async (req: any) => {
      const mode = (req.query?.mode === "download" ? "download" : "view") as
        | "view"
        | "download";
      return services.companyDocuments.getVersionUrl(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.versionId),
        mode,
        { restrictedVisible: callerCan(req, "documents.manage") },
      );
    },
  );
  // Raw text content of a version — for in-app markdown/plain-text rendering.
  app.get(
    "/documents/:id/versions/:versionId/text",
    req_documentsView,
    async (req: any) => {
      return services.companyDocuments.getVersionText(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.versionId),
        { restrictedVisible: callerCan(req, "documents.manage") },
      );
    },
  );
  app.post("/documents", req_documentsManage, async (req: any) => {
    return services.companyDocuments.create(
      await currentUserId(req),
      req.body || {},
    );
  });
  app.patch("/documents/:id", req_documentsManage, async (req: any) => {
    return services.companyDocuments.update(
      await currentUserId(req),
      String(req.params.id),
      req.body || {},
    );
  });
  app.post("/documents/:id/archive", req_documentsManage, async (req: any) => {
    return services.companyDocuments.archive(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  app.post("/documents/:id/unarchive", req_documentsManage, async (req: any) => {
    return services.companyDocuments.unarchive(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  // Hard delete — requires the document to be archived first.
  app.delete("/documents/:id", req_documentsManage, async (req: any) => {
    return services.companyDocuments.hardDelete(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  // Versions
  app.post("/documents/:id/versions/init", req_documentsManage, async (req: any) => {
    return services.companyDocuments.initVersion(
      await currentUserId(req),
      String(req.params.id),
      req.body || {},
    );
  });
  app.post(
    "/documents/:id/versions/:versionId/confirm",
    req_documentsManage,
    async (req: any) => {
      return services.companyDocuments.confirmVersion(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.versionId),
        req.body || {},
      );
    },
  );
  app.post(
    "/documents/:id/versions/:versionId/restore",
    req_documentsManage,
    async (req: any) => {
      return services.companyDocuments.restoreVersion(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.versionId),
      );
    },
  );
  app.delete(
    "/documents/:id/versions/:versionId",
    req_documentsManage,
    async (req: any) => {
      return services.companyDocuments.deleteVersion(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.versionId),
      );
    },
  );
  app.get("/documents/sync/status", req_documentsView, async () => {
    const [
      enabledSetting,
      pendingCount,
      inProgressCount,
      failingCount,
      terminatedCount,
      newestPending,
      newestDone,
      recentFailures,
    ] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "DOCUMENT_SYNC_ENABLED" } }),
      prisma.documentSyncQueue.count({ where: { state: "PENDING" } }),
      prisma.documentSyncQueue.count({ where: { state: "IN_PROGRESS" } }),
      // "Failing" = pending row with attempts >= 3 that keeps getting
      // retried. These are the ones that should surface to the operator.
      prisma.documentSyncQueue.count({
        where: { state: "PENDING", attempts: { gte: 3 } },
      }),
      // Terminal FAILED — worker has given up (attempts >= 10) or
      // operator dismissed. Needs manual retry or dismiss to move out.
      prisma.documentSyncQueue.count({ where: { state: "FAILED" } }),
      prisma.documentSyncQueue.findFirst({
        where: { state: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.documentSyncQueue.findFirst({
        where: { state: "DONE" },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      }),
      prisma.documentSyncQueue.findMany({
        where: { state: "PENDING", attempts: { gte: 3 } },
        orderBy: { updatedAt: "desc" },
        take: 10,
        select: {
          id: true,
          taskType: true,
          documentId: true,
          attempts: true,
          lastError: true,
          nextAttemptAt: true,
        },
      }),
    ]);
    const enabled = enabledSetting?.value === "true";
    // Health rollup — red when there are terminal-failed OR pending-with-repeated-failures
    // (both mean human attention needed); amber when backlog exists but no red flags;
    // green when everything is drained.
    const health = (failingCount + terminatedCount) > 0
      ? "red"
      : (pendingCount + inProgressCount > 0 ? "amber" : "green");
    return {
      enabled,
      health,
      counts: {
        pending: pendingCount,
        inProgress: inProgressCount,
        failing: failingCount,
        terminated: terminatedCount,
      },
      oldestPendingAt: newestPending?.createdAt ?? null,
      lastSuccessAt: newestDone?.updatedAt ?? null,
      recentFailures,
    };
  });
  // Full FAILED (terminal) list for the panel's "Failed tasks" section.
  // Same shape as the /pending endpoint with document titles resolved.
  app.get("/documents/sync/failed", req_documentsView, async () => {
    const rows = await prisma.documentSyncQueue.findMany({
      where: { state: "FAILED" },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    return enrichSyncTasks(rows);
  });
  // Reset a task back to PENDING for immediate retry. Works on any
  // task state; resets attempts to 0 and clears the backoff so the
  // next worker run picks it up right away.
  app.post("/documents/sync/tasks/:id/retry", req_documentsManage, async (req: any) => {
    const id = String(req.params.id);
    const task = await prisma.documentSyncQueue.findUnique({ where: { id } });
    if (!task) throw app.httpErrors.notFound("Task not found.");
    const updated = await prisma.documentSyncQueue.update({
      where: { id },
      data: {
        state: "PENDING",
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });
    return { ok: true, task: updated };
  });
  // Move a task to the terminal FAILED state — worker will never
  // retry it. Use when the underlying issue is unfixable OR when the
  // task is stale (e.g. the doc was recreated elsewhere and we no
  // longer care about this queue row).
  app.post("/documents/sync/tasks/:id/dismiss", req_documentsManage, async (req: any) => {
    const id = String(req.params.id);
    const task = await prisma.documentSyncQueue.findUnique({ where: { id } });
    if (!task) throw app.httpErrors.notFound("Task not found.");
    const updated = await prisma.documentSyncQueue.update({
      where: { id },
      data: {
        state: "FAILED",
        lastError: task.lastError ?? "Dismissed by operator.",
      },
    });
    return { ok: true, task: updated };
  });
  app.get("/documents/sync/pending", req_documentsView, async () => {
    // Full pending + in-progress backlog for the expandable panel view.
    // Capped at 500 rows — larger backlogs would indicate a hung worker
    // and the row-level detail stops being useful.
    const rows = await prisma.documentSyncQueue.findMany({
      where: { state: { in: ["PENDING", "IN_PROGRESS"] } },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: 500,
    });
    return enrichSyncTasks(rows);
  });
  app.post("/documents/sync/run", req_documentsManage, async (req: any) => {
    const { runSync } = await import("../services/documentSyncWorker");
    const body = (req.body ?? {}) as { maxTasks?: number };
    const maxTasks = Math.min(500, Math.max(1, Number(body.maxTasks ?? 100)));
    const result = await runSync({ maxTasks });
    return result;
  });
  app.post("/documents/sync/backfill", req_documentsManage, async () => {
    // Enqueue one SYNC_DOCUMENT_METADATA per existing (non-hard-deleted)
    // document + one UPLOAD_DOCUMENT_VERSION per existing version.
    // Idempotent: the metadata task no-ops if state already exists, and
    // uploadVersion checks DocumentSyncState before uploading (avoids
    // re-uploading files that are already in Drive).
    const docs = await prisma.companyDocument.findMany({
      select: { id: true, versions: { select: { id: true } } },
    });
    const rows: Array<{
      taskType: string;
      documentId: string | null;
      versionId: string | null;
    }> = [];
    for (const d of docs) {
      rows.push({ taskType: "SYNC_DOCUMENT_METADATA", documentId: d.id, versionId: null });
      for (const v of d.versions) {
        rows.push({ taskType: "UPLOAD_DOCUMENT_VERSION", documentId: d.id, versionId: v.id });
      }
    }
    // Also seed the taxonomy snapshot.
    rows.push({ taskType: "SYNC_TAXONOMY", documentId: null, versionId: null });
    if (rows.length > 0) {
      await prisma.documentSyncQueue.createMany({ data: rows });
    }
    return { enqueued: rows.length, docCount: docs.length };
  });
}
