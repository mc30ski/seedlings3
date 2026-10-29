import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt, evaluateHoursApproval, loadHoursApprovalVarianceThreshold, loadPriorPersonMinutes } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import * as displays from "../services/displays";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, etTomorrow, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { InstructionScope, JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { portfolioWhere, portfolioWhereVia, withPortfolio } from "../lib/portfolioScope";
import { WORKER_TYPES, classify, isFeeable, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate, occInEditableState } from "./_shared";
import { fetchWeatherAlerts } from "../services/weatherAlerts";
import { cached } from "../lib/cache";
import { businessLatLng } from "../lib/businessLocation";
import { hourlyForecastForOccurrence } from "../services/hourlyForecast";
import { ServiceError } from "../lib/errors";
import { persistCompletionSplits } from "../services/payments";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { redactObserverFieldsForCaller, redactPeekFieldsForCaller, redactUnclearedFieldsForCaller } from "../lib/observerRedaction";
import { capabilitiesForUsers, userCan } from "../lib/userCapabilities";

export default async function jobRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_estimatesCreate = requires("estimates.create");
  const req_scheduleManage = requires("schedule.manage");
  const req_scheduleView = requires("schedule.view");

  app.get("/jobs/:id/property-photos", req_scheduleView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const jobId = String(req.params.id);
    const links = await prisma.jobPropertyPhoto.findMany({
      where: { jobId },
      include: { propertyPhoto: true },
    });
    const withUrls = await Promise.all(
      links.map(async (l) => ({
        ...l,
        propertyPhoto: {
          ...l.propertyPhoto,
          url: await getDownloadUrl(l.propertyPhoto.r2Key, 86400, "property-photos"),
        },
      }))
    );
    return withUrls;
  });
  app.put("/jobs/:id/property-photos", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const { propertyPhotoIds } = (req.body || {}) as { propertyPhotoIds: string[] };
    if (!Array.isArray(propertyPhotoIds)) throw app.httpErrors.badRequest("propertyPhotoIds must be an array");
    await prisma.$transaction(async (tx) => {
      // Snapshot the replaced set — this is a wholesale replace, so the
      // previous selection is otherwise unrecoverable.
      const before = await tx.jobPropertyPhoto.findMany({
        where: { jobId },
        select: { propertyPhotoId: true },
      });
      await tx.jobPropertyPhoto.deleteMany({ where: { jobId } });
      if (propertyPhotoIds.length > 0) {
        await tx.jobPropertyPhoto.createMany({
          data: propertyPhotoIds.map((propertyPhotoId) => ({ jobId, propertyPhotoId })),
          skipDuplicates: true,
        });
      }
      // Records which reference photos workers see by default on this job.
      await writeAudit(tx, AUDIT.JOB.UPDATED, uid, {
        jobId,
        action: "default_property_photos_replaced",
        propertyPhotoIdsBefore: before.map((r) => r.propertyPhotoId),
        propertyPhotoIdsAfter: propertyPhotoIds,
        countBefore: before.length,
        countAfter: propertyPhotoIds.length,
      });
    });
    return { ok: true, count: propertyPhotoIds.length };
  });
  app.get("/jobs/:id", req_scheduleView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    // BSD cutoff applies to the embedded occurrences (and their nested money
    // includes) so the Services job-detail view matches every other operator
    // surface. the reveal flows through resolveCutoff.
    const cutoff = await resolveCutoff(req);
    return services.jobs.get(String(req.params.id), cutoff);
  });
  app.post("/jobs", req_scheduleManage, async (req: any) => {
    const body = req.body || {};
    const propertyId = String(body.propertyId || "");
    const kind = String(body.kind || "").toUpperCase();
    const status = String(body.status || "").toUpperCase();

    if (!propertyId) throw app.httpErrors.badRequest("propertyId is required");
    if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
      throw app.httpErrors.badRequest("Invalid kind");
    }
    if (status && status !== "PROPOSED" && status !== "ACCEPTED" && status !== "PAUSED") {
      throw app.httpErrors.badRequest("Invalid status");
    }

    let frequencyDays: number | null = null;
    if (body.frequencyDays != null) {
      frequencyDays = Math.round(Number(body.frequencyDays));
      if (!Number.isFinite(frequencyDays) || frequencyDays < 1) {
        throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
      }
    }

    return services.jobs.create(await currentUserId(req), {
      propertyId,
      kind: kind as JobKind,
      status: (status as JobStatus) || undefined,
      frequencyDays,
      description: body.description != null ? String(body.description) : null,
      notes: body.notes != null ? String(body.notes) : null,
      guidanceNote: body.guidanceNote != null ? String(body.guidanceNote) : null,
      defaultPrice: body.defaultPrice != null ? Number(body.defaultPrice) : null,
      estimatedMinutes: body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null,
    } as any);
  });
  app.get("/jobs/:id/pause-preview", req_scheduleView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const jobId = String(req.params.id);
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { id: true, status: true, frequencyDays: true },
    });

    const scheduled = await prisma.jobOccurrence.findMany({
      where: {
        jobId,
        status: "SCHEDULED",
        workflow: "STANDARD",
      },
      select: { startAt: true },
      orderBy: { startAt: "asc" },
    });

    // Mirrors rebuildRecurringChainInTx's anchor: the most recent
    // STANDARD, non-one-off occurrence, whatever its status.
    const lastOcc = await prisma.jobOccurrence.findFirst({
      where: { jobId, workflow: "STANDARD", isOneOff: false },
      orderBy: { startAt: "desc" },
      select: { startAt: true },
    });

    const freq = job.frequencyDays ?? 0;
    const resumeWouldScheduleAt =
      freq > 0 && lastOcc?.startAt
        ? computeResumeStartAt(lastOcc.startAt, freq).toISOString()
        : null;

    return {
      status: job.status,
      frequencyDays: job.frequencyDays ?? null,
      scheduledToRemove: scheduled.length,
      nextScheduledAt: scheduled[0]?.startAt?.toISOString() ?? null,
      resumeWouldScheduleAt,
    };
  });
  app.patch("/jobs/:id", req_scheduleManage, async (req: any) => {
    const id = String(req.params.id);
    const body = req.body || {};

    const patch: any = {};
    if (body.propertyId != null) patch.propertyId = String(body.propertyId);

    if (body.kind != null) {
      const kind = String(body.kind || "").toUpperCase();
      if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
        throw app.httpErrors.badRequest("Invalid kind");
      }
      patch.kind = kind as JobKind;
    }

    if (body.status != null) {
      const status = String(body.status || "").toUpperCase();
      if (status !== "PROPOSED" && status !== "ACCEPTED" && status !== "PAUSED") {
        throw app.httpErrors.badRequest("Invalid status");
      }
      patch.status = status as JobStatus;
    }

    if ("frequencyDays" in body) {
      if (body.frequencyDays != null) {
        const fd = Math.round(Number(body.frequencyDays));
        if (!Number.isFinite(fd) || fd < 1) throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
        patch.frequencyDays = fd;
      } else {
        patch.frequencyDays = null;
      }
    }
    if ("description" in body) patch.description = body.description != null ? String(body.description) : null;
    if ("notes" in body) patch.notes = body.notes != null ? String(body.notes) : null;
    if ("guidanceNote" in body) patch.guidanceNote = body.guidanceNote != null ? String(body.guidanceNote) : null;
    if ("defaultPrice" in body) patch.defaultPrice = body.defaultPrice != null ? Number(body.defaultPrice) : null;
    if ("estimatedMinutes" in body) patch.estimatedMinutes = body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null;

    return services.jobs.update(await currentUserId(req), id, patch);
  });
  // Default assignees for a job
  // Legacy bulk-replace (kept for backwards compatibility)
  app.put("/jobs/:id/default-assignees", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const body = req.body || {};
    const userIds: string[] = Array.isArray(body.userIds) ? body.userIds.map(String) : [];

    await prisma.$transaction(async (tx) => {
      // Snapshot the crew being replaced — deleteMany wipes it wholesale, so
      // without this the previous roster (and its claimer) is unrecoverable.
      const before = await tx.jobAssigneeDefault.findMany({
        where: { jobId },
        orderBy: { sortOrder: "asc" },
        select: { userId: true, role: true, active: true },
      });
      await tx.jobAssigneeDefault.deleteMany({ where: { jobId } });
      if (userIds.length > 0) {
        await tx.jobAssigneeDefault.createMany({
          data: userIds.map((u) => ({ jobId, userId: u })),
          skipDuplicates: true,
        });
      }
      // Records a wholesale replacement of the job's default crew — the
      // first entry becomes the claimer, which drives payout routing.
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
        jobId,
        action: "default_assignees_replaced",
        userIdsBefore: before.map((r) => r.userId),
        rolesBefore: before.map((r) => r.role ?? null),
        userIdsAfter: userIds,
        claimerBefore: before[0]?.userId ?? null,
        claimerAfter: userIds[0] ?? null,
      });
    });

    return { updated: true };
  });
  app.post("/jobs/:id/default-assignees/add", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const { userId, role } = (req.body || {}) as { userId?: string; role?: string | null };
    if (!userId) throw app.httpErrors.badRequest("userId is required");

    const validRole = role === "observer" ? "observer" : null;

    return prisma.$transaction(async (tx) => {
      // Switching into individuals mode clears any default group on the
      // job so the two modes stay mutually exclusive. Without this the
      // job would carry both, and occurrence generation would prefer the
      // group (silently ignoring the individual a caller with `routes.plan` just added).
      const job = await tx.job.findUnique({ where: { id: jobId }, select: { defaultGroupId: true } });
      const clearedGroupId = job?.defaultGroupId ?? null;
      if (job?.defaultGroupId) {
        await tx.job.update({ where: { id: jobId }, data: { defaultGroupId: null } });
      }

      const existing = await tx.jobAssigneeDefault.findUnique({
        where: { jobId_userId: { jobId, userId } },
      });
      if (existing) {
        // Reactivate if inactive, or update role if it changed
        if (!existing.active || existing.role !== validRole) {
          await tx.jobAssigneeDefault.update({
            where: { id: existing.id },
            data: { active: true, role: validRole },
          });
        }
        // Records the re-add / role flip, plus the silent switch out of
        // crew mode (clearedGroupId) that comes with it.
        await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
          jobId,
          action: "default_assignee_reactivated",
          userId,
          roleBefore: existing.role ?? null,
          roleAfter: validRole,
          activeBefore: existing.active,
          activeAfter: true,
          clearedDefaultGroupId: clearedGroupId,
        });
        return { added: true };
      }

      const created = await tx.jobAssigneeDefault.create({
        data: { jobId, userId, role: validRole, active: true },
      });
      // Records a worker joining the job's default crew — and the silent
      // switch out of group mode when clearedDefaultGroupId is non-null.
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
        jobId,
        action: "default_assignee_added",
        userId,
        assigneeDefaultId: created.id,
        roleBefore: null,
        roleAfter: validRole,
        clearedDefaultGroupId: clearedGroupId,
      });
      return { added: true };
    });
  });
  app.delete("/jobs/:id/default-assignees/:userId", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const userId = String(req.params.userId);

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (!existing) throw app.httpErrors.notFound("Not found");

    return prisma.$transaction(async (tx) => {
      await tx.jobAssigneeDefault.delete({ where: { id: existing.id } });
      // Destructive: the membership row is gone, so this snapshot is the
      // only record of the worker's place (and sortOrder) in the crew.
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
        jobId,
        action: "default_assignee_removed",
        userId,
        assigneeDefaultId: existing.id,
        roleBefore: existing.role ?? null,
        activeBefore: existing.active,
        sortOrderBefore: existing.sortOrder,
      });
      return { removed: true };
    });
  });
  app.patch("/jobs/:id/default-assignees/:userId/role", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const userId = String(req.params.userId);
    const { role } = (req.body || {}) as { role?: string | null };

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (!existing) throw app.httpErrors.notFound("Not found");

    const validRole = role === "observer" ? "observer" : null;
    return prisma.$transaction(async (tx) => {
      await tx.jobAssigneeDefault.update({
        where: { id: existing.id },
        data: { role: validRole },
      });
      // Records the observer flip — observers don't count as the claimer,
      // so this changes who the job pays out through.
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
        jobId,
        action: "default_assignee_role_changed",
        userId,
        assigneeDefaultId: existing.id,
        roleBefore: existing.role ?? null,
        roleAfter: validRole,
      });
      return { updated: true };
    });
  });
  // Reassign the default-team claimer. Promotes the chosen user to first
  // (lowest sortOrder). If they were an observer, also clears that role so
  // they qualify as the claimer.
  app.post("/jobs/:id/default-assignees/:userId/make-claimer", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const userId = String(req.params.userId);

    const existing = await prisma.jobAssigneeDefault.findUnique({
      where: { jobId_userId: { jobId, userId } },
    });
    if (!existing) throw app.httpErrors.notFound("Not found");

    // Find the lowest sortOrder currently in this job's defaults; we want
    // the claimer strictly less.
    const lowest = await prisma.jobAssigneeDefault.findFirst({
      where: { jobId },
      orderBy: { sortOrder: "asc" },
      select: { sortOrder: true },
    });
    const newSortOrder = (lowest?.sortOrder ?? 100) - 1;

    return prisma.$transaction(async (tx) => {
      // Snapshot who held the claimer slot before the promotion.
      const priorClaimer = await tx.jobAssigneeDefault.findFirst({
        where: { jobId, active: true, role: null },
        orderBy: { sortOrder: "asc" },
        select: { userId: true },
      });
      await tx.jobAssigneeDefault.update({
        where: { id: existing.id },
        data: { sortOrder: newSortOrder, role: null, active: true },
      });
      // Money: the claimer is who the job's payment routes through, so a
      // reassignment moves the payout to a different worker.
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
        jobId,
        action: "default_claimer_changed",
        userId,
        assigneeDefaultId: existing.id,
        claimerBefore: priorClaimer?.userId ?? null,
        claimerAfter: userId,
        roleBefore: existing.role ?? null,
        roleAfter: null,
        sortOrderBefore: existing.sortOrder,
        sortOrderAfter: newSortOrder,
      });
      return { updated: true };
    });
  });
  // Default crew: choose between the per-user default-assignees list OR
  // a single Group. Setting a groupId clears the per-user list so the two
  // modes stay mutually exclusive. Clearing groupId (passing null) leaves
  // the per-user list intact — holders of `routes.plan` can move between modes without
  // re-entering data each time.
  app.put("/jobs/:id/default-group", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const jobId = String(req.params.id);
    const body = (req.body || {}) as { groupId?: string | null };
    const groupId = body.groupId ?? null;
    return prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) throw app.httpErrors.notFound("Job not found.");
      // Snapshot the per-user list BEFORE the group swap wipes it — the
      // deleteMany below is unrecoverable otherwise.
      const wipedAssignees = groupId
        ? await tx.jobAssigneeDefault.findMany({
            where: { jobId },
            orderBy: { sortOrder: "asc" },
            select: { userId: true, role: true, active: true },
          })
        : [];
      if (groupId) {
        const group = await tx.group.findUnique({ where: { id: groupId } });
        if (!group) throw app.httpErrors.badRequest("Group not found.");
        if (group.archivedAt) throw app.httpErrors.badRequest("Group is archived.");
        await tx.jobAssigneeDefault.deleteMany({ where: { jobId } });
      }
      const updated = await tx.job.update({
        where: { id: jobId },
        data: { defaultGroupId: groupId },
        select: { id: true, defaultGroupId: true },
      });
      // Records the crew-mode swap (individuals <-> group). Setting a group
      // destroys the per-user list, which changes who is assigned AND who
      // claims — the wiped roster is captured here.
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, uid, {
        jobId,
        action: "default_group_changed",
        defaultGroupIdBefore: job.defaultGroupId ?? null,
        defaultGroupIdAfter: groupId,
        wipedAssigneeUserIds: wipedAssignees.map((r) => r.userId),
        wipedAssigneeRoles: wipedAssignees.map((r) => r.role ?? null),
      });
      return updated;
    });
  });
  // Create a one-off occurrence from a job template
  app.post("/jobs/:id/occurrences", req_scheduleManage, async (req: any) => {
    const jobId = String(req.params.id);
    const body = req.body || {};

    const input: any = {};

    if (body.kind != null) {
      const kind = String(body.kind || "").toUpperCase();
      if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
        throw app.httpErrors.badRequest("Invalid kind");
      }
      input.kind = kind as JobKind;
    }

    if (body.workflow != null) {
      const wf = String(body.workflow).toUpperCase();
      if (wf === "STANDARD" || wf === "ONE_OFF" || wf === "ESTIMATE") input.workflow = wf;
    }
    if (body.isOneOff != null) input.isOneOff = !!body.isOneOff;
    if (body.isTentative != null) input.isTentative = !!body.isTentative;
    if (body.isEstimate != null) input.isEstimate = !!body.isEstimate;
    if (body.mustBeAssigned != null) input.mustBeAssigned = !!body.mustBeAssigned;
    if ("jobType" in body) input.jobType = body.jobType || null;
    if ("jobTags" in body) input.jobTags = body.jobTags ? JSON.stringify(body.jobTags) : null;
    if ("pinnedNote" in body) input.pinnedNote = body.pinnedNote ? String(body.pinnedNote).trim() : null;
    if ("pinnedNoteRepeats" in body) input.pinnedNoteRepeats = !!body.pinnedNoteRepeats;
    // Explicit null = the New Occurrence dialog opted this instance out of the
    // job's default guidance description; absent = inherit the job default.
    if ("guidanceNote" in body) input.guidanceNote = body.guidanceNote ? String(body.guidanceNote) : null;
    // Dates: accept ISO strings; service should parse/validate
    if (body.startAt != null) input.startAt = body.startAt;
    if (body.endAt != null) input.endAt = body.endAt;
    if (body.notes != null) input.notes = body.notes;
    if (body.price != null) input.price = Number(body.price);
    if (body.estimatedMinutes != null) input.estimatedMinutes = Math.round(Number(body.estimatedMinutes));

    if (body.frequencyDays != null) {
      const fd = Math.round(Number(body.frequencyDays));
      if (!Number.isFinite(fd) || fd < 1) throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
      input.frequencyDays = fd;
    }

    if (body.title != null) input.title = String(body.title).trim() || null;

    if (body.assigneeUserIds != null) {
      if (!Array.isArray(body.assigneeUserIds)) {
        throw app.httpErrors.badRequest("assigneeUserIds must be an array");
      }
      input.assigneeUserIds = body.assigneeUserIds.map(String);
    }

    // Validate: repeating occurrences must have a frequency somewhere
    if (input.workflow === "STANDARD") {
      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { frequencyDays: true } });
      const effectiveFreq = input.frequencyDays ?? job?.frequencyDays;
      if (!effectiveFreq) {
        throw app.httpErrors.badRequest("Repeating job occurrence requires a frequency. Set it on the job or on this occurrence.");
      }
    }

    return services.jobs.createOccurrence(
      await currentUserId(req),
      jobId,
      input
    );
  });
  // List archived jobs (paginated)
  app.get("/jobs/archived", req_scheduleView, async (req: any) => {
    const { page, pageSize } = (req.query || {}) as {
      page?: string;
      pageSize?: string;
    };
    return services.jobs.listArchivedJobs({
      portfolioWhere: portfolioWhereVia(req.principal, "schedule.view", "property"),
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  });
  // Archive a Job. Precondition relaxed to "any non-archived Job" so
  // Client/Property cascade doesn't blow up on PROPOSED or PAUSED rows.
  app.post("/jobs/:id/archive", req_scheduleManage, async (req: any) => {
    return services.jobs.archiveJob(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  // Symmetric unarchive — brings an archived Job back to ACCEPTED so
  // it's ready for the recurring generator + payment flows again.
  app.post("/jobs/:id/unarchive", req_scheduleManage, async (req: any) => {
    return services.jobs.unarchiveJob(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  // Delete a proposed job permanently
  app.delete("/jobs/:id", req_scheduleManage, async (req: any) => {
    return services.jobs.deleteJob(String(req.params.id), await currentUserId(req));
  });
  app.post("/light-estimates", req_estimatesCreate, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createLightEstimate(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      contactName: body.contactName ? String(body.contactName).trim() : undefined,
      contactPhone: body.contactPhone ? String(body.contactPhone).trim() : undefined,
      contactEmail: body.contactEmail ? String(body.contactEmail).trim() : undefined,
      estimateAddress: body.estimateAddress ? String(body.estimateAddress).trim() : undefined,
      // Structured parts. The service derives the one-line form from these and
      // ignores the string above when they are present.
      ...pickEstimateAddressParts(body),
      proposalAmount: body.proposalAmount != null ? Number(body.proposalAmount) : undefined,
      proposalNotes: body.proposalNotes ? String(body.proposalNotes) : undefined,
      jobTags: Array.isArray(body.jobTags) ? JSON.stringify(body.jobTags) : undefined,
      jobType: body.jobType ? String(body.jobType).trim() : undefined,
      assigneeUserIds: Array.isArray(body.assigneeUserIds) ? body.assigneeUserIds.map(String) : undefined,
      jobId: body.jobId ? String(body.jobId) : undefined,
    });
  });
  app.post("/convert-light-estimate", req_estimatesCreate, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const occurrenceId = String(body.occurrenceId ?? "");
    if (!occurrenceId) throw app.httpErrors.badRequest("occurrenceId is required");

    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (occ.jobId) throw app.httpErrors.badRequest("This estimate is already linked to a job");

    return prisma.$transaction(async (tx) => {
      // Create client
      const client = await tx.client.create({
        data: {
          type: body.clientType ?? "PERSON",
          displayName: String(body.clientName ?? occ.contactName ?? "New Client").trim(),
          notesInternal: body.clientNotes ? String(body.clientNotes) : null,
        },
      });

      // Create primary contact
      const nameParts = (occ.contactName ?? "").trim().split(/\s+/);
      const firstName = body.contactFirstName ?? nameParts[0] ?? "";
      const lastName = body.contactLastName ?? nameParts.slice(1).join(" ") ?? "";
      const contact = await tx.clientContact.create({
        data: {
          clientId: client.id,
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          email: body.contactEmail ?? occ.contactEmail ?? null,
          phone: body.contactPhone ?? occ.contactPhone ?? null,
          role: "OWNER",
          isPrimary: true,
        },
      });

      // Create property
      const property = await tx.property.create({
        data: {
          clientId: client.id,
          displayName: body.propertyName ?? "Property",
          // The dialog normally sends these, prefilled from the estimate's
          // own columns. Falling back to those columns directly means a
          // conversion driven by anything else still lands the address the
          // operator typed, rather than a blank property nobody notices until
          // a worker tries to navigate to it.
          street1: body.street1 ?? (occ as any).estimateStreet1 ?? null,
          street2: body.street2 ?? (occ as any).estimateStreet2 ?? null,
          city: body.city ?? (occ as any).estimateCity ?? null,
          state: body.state ?? (occ as any).estimateState ?? null,
          postalCode: body.postalCode ?? (occ as any).estimatePostalCode ?? null,
          country: body.country ?? "US",
          kind: body.propertyKind ?? "SINGLE",
          pointOfContactId: contact.id,
        },
      });

      // Create job
      const job = await tx.job.create({
        data: {
          propertyId: property.id,
          kind: body.jobKind ?? "SINGLE_ADDRESS",
          status: "ACCEPTED",
          defaultPrice: occ.proposalAmount ?? body.defaultPrice ?? null,
          estimatedMinutes: occ.estimatedMinutes ?? body.estimatedMinutes ?? null,
          notes: occ.proposalNotes ?? body.jobNotes ?? null,
          frequencyDays: body.frequencyDays ?? null,
        },
      });

      // Link the job to client
      await tx.jobClient.create({ data: { jobId: job.id, clientId: client.id, role: "owner" } });
      await tx.jobContact.create({ data: { jobId: job.id, clientContactId: contact.id, role: "decision_maker" } });

      // Link the occurrence to the new job
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { jobId: job.id, kind: body.jobKind ?? "SINGLE_ADDRESS" },
      });

      // Audit
      await tx.auditEvent.create({
        data: {
          scope: "JOB",
          verb: "CREATED",
          actorUserId: uid,
          metadata: {
            jobId: job.id,
            clientId: client.id,
            propertyId: property.id,
            convertedFrom: occurrenceId,
            note: "Converted from light estimate",
          },
        },
      });

      return {
        ok: true,
        clientId: client.id,
        propertyId: property.id,
        jobId: job.id,
        contactId: contact.id,
      };
    });
  });
  // Estimate follow-up count for the title-bar alert. Surfaces estimates
  // whose proposal was sent to the client but hasn't been ACCEPTED or
  // REJECTED within 1–4 weeks of the visit date.
  //   - workflow = ESTIMATE
  //   - status   = PROPOSAL_SUBMITTED (visit done, client decision pending)
  //   - startAt  ∈ [now − 28 days, now − 7 days]
  // Older than 4 weeks the estimate has effectively lapsed and shouldn't
  // keep nagging us forever; the alert helps us follow up while there's
  // still a reasonable window, then lets it fall off.
  app.get("/estimates/stale-followup-count", req_estimatesCreate, async (req: any) => {
    // ET-anchored: setDate() on a UTC Date drops the window by ~4-5 hours
    // at the ET-day boundary, which can include/exclude an estimate
    // whose proposal was sent right at the cutoff.
    const todayKey = etToday();
    const oneWeekAgo = etMidnight(etAddDays(todayKey, -7));
    const fourWeeksAgo = etMidnight(etAddDays(todayKey, -28));
    const count = await prisma.jobOccurrence.count({
      where: withPortfolio<Prisma.JobOccurrenceWhereInput>(
        {
          workflow: "ESTIMATE",
          status: "PROPOSAL_SUBMITTED",
          startAt: { gte: fourWeeksAgo, lte: oneWeekAgo },
        },
        // The badge counts what this caller could actually follow up on. A
        // district lead chasing a company-wide number would be chasing
        // estimates in territories they cannot open.
        portfolioWhere(req.principal, "estimates.create"),
      ),
    });
    return { count };
  });
  // Jobs (lightweight list for task association — only jobs the worker is assigned to)
  app.get("/jobs", req_scheduleView, async (req: any) => {
    const uid = await currentUserId(req);
    if (callerCan(req, "schedule.manage")) {
      // The filter set the deleted `/jobs` twin accepted. It was lost
      // when this branch hard-coded `{ limit: 200 }`, so merging the routes
      // restores q / propertyId / status / kind / from / to for holders of `routes.plan`.
      const { q, propertyId, status, kind, limit, from, to } = (req.query || {}) as {
        q?: string; propertyId?: string;
        status?: "PROPOSED" | "ACCEPTED" | "ALL";
        kind?: "ENTIRE_SITE" | "SINGLE_ADDRESS" | "ALL";
        limit?: string; from?: string; to?: string;
      };
      return services.jobs.list({
        q, propertyId,
        status: (status as any) ?? "ALL",
        kind: (kind as any) ?? "ALL",
        limit: limit ? Number(limit) : 200,
        from, to,
        portfolioWhere: portfolioWhereVia(req.principal, "schedule.view", "property"),
      });
    }
    // Workers see only jobs they are assigned to (via occurrence assignees)
    const myOccurrences = await prisma.jobOccurrence.findMany({
      where: { assignees: { some: { userId: uid } } },
      select: { jobId: true },
      distinct: ["jobId"],
    });
    const myJobIds = myOccurrences.map((o) => o.jobId).filter(Boolean) as string[];
    if (myJobIds.length === 0) return [];
    const jobs = await prisma.job.findMany({
      where: { id: { in: myJobIds } },
      include: { property: { select: { id: true, displayName: true, client: { select: { displayName: true } } } } },
      take: 200,
    });
    return jobs;
  });
  app.patch("/light-estimates/:id", req_estimatesCreate, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Estimate not found");
    if (occ.workflow !== "ESTIMATE" || occ.jobId) throw app.httpErrors.badRequest("Not a stand-alone estimate");
    const isActiveAssignee = occ.assignees.some((a: any) => a.userId === uid && a.role !== "observer");
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isActiveAssignee && !canManageSchedule) {
      throw app.httpErrors.forbidden("Only assignees or someone with route planning can edit this estimate");
    }
    return services.jobs.updateLightEstimate(uid, id, req.body ?? {}, { canManageSchedule });
  });
  app.delete("/light-estimates/:id", req_estimatesCreate, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Estimate not found");
    if (occ.workflow !== "ESTIMATE" || occ.jobId) throw app.httpErrors.badRequest("Not a stand-alone estimate");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isClaimer) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Deleting this estimate requires being the claimer or holding schedule authority");
    }
    await prisma.$transaction(async (tx) => {
      // Records the hard delete of a priced standalone estimate — the quoted
      // price disappears with the row, so it is snapshotted here.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_DELETED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "ESTIMATE",
        title: occ.title ?? null,
        notes: occ.notes ?? null,
        status: occ.status,
        startAt: occ.startAt?.toISOString() ?? null,
        price: occ.price ?? null,
        proposalAmount: occ.proposalAmount ?? null,
        proposalNotes: occ.proposalNotes ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? null,
        assigneeUserIds: occ.assignees.map((a: any) => a.userId).join(","),
      });
      await tx.jobOccurrence.delete({ where: { id } });
    });
    return { deleted: true };
  });
}
