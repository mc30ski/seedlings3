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
import { InstructionScope, JobKind, JobOccurrenceStatus, JobStatus, OccurrenceWorkflow, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereOn, areaWhereVia, withArea } from "../lib/areaScope";
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

export default async function occurrenceRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_estimatesAccept = requires("estimates.accept");
  const req_estimatesCreate = requires("estimates.create");
  const req_inventoryPull = requires("inventory.pull");
  const req_marketingManage = requires("marketing.manage");
  const req_materialsCharge = requires("materials.charge");
  const req_moneyAdjust = requires("money.adjust");
  const req_moneyApprove = requires("money.approve");
  const req_moneyRecord = requires("money.record");
  const req_scheduleContribute = requires("schedule.contribute");
  const req_scheduleManage = requires("schedule.manage");
  const req_scheduleView = requires("schedule.view");
  const req_timeApprove = requires("time.approve");
  const req_workClaim = requires("work.claim");
  const req_workComplete = requires("work.complete");

  app.put("/occurrences/:id/property-photos", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { propertyPhotoIds, guidanceNote } = (req.body || {}) as {
      propertyPhotoIds: string[];
      guidanceNote?: string | null;
    };
    if (!Array.isArray(propertyPhotoIds)) throw app.httpErrors.badRequest("propertyPhotoIds must be an array");
    await prisma.$transaction(async (tx) => {
      // Snapshot the replaced set + the guidance note this save overwrites.
      const before = await tx.occurrencePropertyPhoto.findMany({
        where: { occurrenceId },
        select: { propertyPhotoId: true },
      });
      const occBefore = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { jobId: true, guidanceNote: true },
      });
      await tx.occurrencePropertyPhoto.deleteMany({ where: { occurrenceId } });
      if (propertyPhotoIds.length > 0) {
        await tx.occurrencePropertyPhoto.createMany({
          data: propertyPhotoIds.map((propertyPhotoId) => ({ occurrenceId, propertyPhotoId })),
          skipDuplicates: true,
        });
      }
      // Optional overall guidance description — only touched when the caller
      // sends the field, so a photos-only save leaves it untouched.
      const nextGuidanceNote =
        guidanceNote !== undefined
          ? (guidanceNote ? String(guidanceNote).trim() || null : null)
          : undefined;
      if (nextGuidanceNote !== undefined) {
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: { guidanceNote: nextGuidanceNote },
        });
      }
      // Records the per-visit override of the reference photos + guidance
      // note the assigned crew sees.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occBefore?.jobId ?? null,
        action: "occurrence_property_photos_replaced",
        propertyPhotoIdsBefore: before.map((r) => r.propertyPhotoId),
        propertyPhotoIdsAfter: propertyPhotoIds,
        guidanceNoteChanged: nextGuidanceNote !== undefined,
        guidanceNoteBefore: occBefore?.guidanceNote ?? null,
        guidanceNoteAfter: nextGuidanceNote !== undefined ? nextGuidanceNote : (occBefore?.guidanceNote ?? null),
      });
    });
    return { ok: true, count: propertyPhotoIds.length };
  });
  // Re-price a completed visit. Admin+, and refused once a Payment row exists
  // — the service explains the reject/revert remedy rather than silently
  // rewriting money under a recorded payment.
  app.patch("/occurrences/:id/price", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const body = (req.body || {}) as { price?: number; reason?: string; laborDetail?: string | null };
    const { price, reason } = body;
    if (price == null || !Number.isFinite(Number(price)) || Number(price) < 0) {
      throw app.httpErrors.badRequest("price is required and must be zero or more");
    }
    return services.jobs.adjustOccurrencePrice(
      uid, String(req.params.id), Number(price), reason ?? null,
      // "in body" so an omitted field leaves the detail alone, while an
      // explicit null clears it.
      "laborDetail" in body ? (body.laborDetail ?? null) : undefined,
    );
  });
  // Replace assignees for an occurrence (workers-only enforced in service)
  app.put(
    "/occurrences/:occurrenceId/assignees",
    req_scheduleManage,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      const body = req.body || {};
      const ids = body.assigneeUserIds;

      if (!Array.isArray(ids)) {
        throw app.httpErrors.badRequest("assigneeUserIds must be an array");
      }

      return services.jobs.setOccurrenceAssignees(
        await currentUserId(req),
        occurrenceId,
        {
          assigneeUserIds: ids.map(String),
          assignedById: await currentUserId(req),
        }
      );
    }
  );
  // Set / clear a one-time date override for the next repeating occurrence.
  //
  // Body: { date: "YYYY-MM-DD" | null, forceApprove?: boolean }
  //   - date: null                → clears the override (silent, no gates)
  //   - date: valid YYYY-MM-DD    → sets the override; validates against
  //                                 range rules; may require forceApprove
  //
  // Validation rules (in order):
  //   1. Occurrence exists.
  //   2. Parent Job has frequencyDays set (repeating). Otherwise the
  //      override has no meaning — one-offs don't generate a next
  //      occurrence.
  //   3. Payment does not yet exist OR is not confirmed. Once confirmed
  //      the next occurrence has already been generated, so the override
  //      window has closed.
  //   4. Date is a valid YYYY-MM-DD.
  //   5. Date is STRICTLY after the source occurrence's ET calendar day.
  //      (The next visit cannot happen before or on today's visit.)
  //   6. If override date differs from the normal cadence date by more
  //      than 7 days OR collides with an existing SCHEDULED repeating
  //      occurrence for this job on the same ET day, respond 409 with
  //      { error: "NEEDS_APPROVE", reasons: [...] } so the UI can prompt
  //      the operator to type APPROVE. Client retries with forceApprove
  //      = true to bypass.
  //
  // Response: { ok: true, nextStartOverride: string | null,
  //             normalCadenceDate: string | null }
  app.post("/occurrences/:id/next-start-override", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { date?: string | null; forceApprove?: boolean };
    const rawDate = body.date;
    const forceApprove = !!body.forceApprove;

    const occ = await prisma.jobOccurrence.findUnique({
      where: { id },
      include: {
        job: { select: { id: true, frequencyDays: true } },
        payment: { select: { confirmed: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");

    // Payment already confirmed → next occurrence has been generated,
    // override window closed. Return 409 so the UI can surface a
    // sensible error (shouldn't happen since the affordance hides
    // after payment approval, but defense in depth).
    if (occ.payment?.confirmed) {
      throw app.httpErrors.conflict(
        "Payment has already been approved — the next occurrence has been generated and the override can no longer be set.",
      );
    }

    const freq = occ.frequencyDays ?? occ.job?.frequencyDays;
    if (!freq || freq <= 0) {
      throw app.httpErrors.badRequest(
        "This job does not repeat, so a next-visit override cannot be set.",
      );
    }

    // Clear path — sets the field to null. No range validation.
    if (rawDate == null || rawDate === "") {
      await prisma.$transaction(async (tx) => {
        await tx.jobOccurrence.update({
          where: { id },
          data: { nextStartOverride: null },
        });
        // Records dropping the override — the next visit reverts to normal
        // cadence, which is a client-visible date change.
        await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
          occurrenceId: id,
          jobId: occ.jobId ?? null,
          action: "next-start-override-cleared",
          dateBefore: occ.nextStartOverride ?? null,
          dateAfter: null,
        });
      });
      return { ok: true, nextStartOverride: null, normalCadenceDate: null };
    }

    if (typeof rawDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      throw app.httpErrors.badRequest("Date must be a YYYY-MM-DD string.");
    }

    // ET calendar-day comparisons throughout — same anchor the
    // computeNextOccurrenceStart helper uses at generation time.
    if (!occ.startAt) {
      throw app.httpErrors.badRequest(
        "This occurrence has no scheduled date; the override needs a source date to compare against.",
      );
    }
    const sourceKey = etFormatDate(occ.startAt);
    if (rawDate <= sourceKey) {
      throw app.httpErrors.badRequest(
        "The next-visit date must be after this visit's date.",
      );
    }

    // Normal cadence date: source + frequencyDays. Used to gauge how
    // far off the override is (>7 days requires APPROVE).
    const normalCadenceDate = etAddDays(sourceKey, freq);
    const daysOff = Math.abs(etDaysBetween(normalCadenceDate, rawDate as EtDateKey));

    // Collision check: any existing SCHEDULED repeating occurrence for
    // this job on the override's ET calendar day (excluding the source
    // itself, which shouldn't match anyway but belt-and-suspenders).
    const collision = occ.jobId
      ? await prisma.jobOccurrence.findFirst({
          where: {
            jobId: occ.jobId,
            id: { not: id },
            status: JobOccurrenceStatus.SCHEDULED,
            workflow: "STANDARD",
            isOneOff: false,
            startAt: {
              gte: etMidnight(rawDate as EtDateKey),
              lte: etEndOfDay(rawDate as EtDateKey),
            },
          },
          select: { id: true },
        })
      : null;

    const reasons: string[] = [];
    if (daysOff > 7) {
      reasons.push(
        `${daysOff} days away from the normal visit date (${normalCadenceDate}).`,
      );
    }
    if (collision) {
      reasons.push(
        `Another visit for this job is already scheduled on ${rawDate}.`,
      );
    }

    // "Needs APPROVE" path — return a soft-error response the UI can
    // catch and re-issue with forceApprove=true after the operator
    // types APPROVE. Not thrown as an HTTP 4xx because the operator's
    // input isn't invalid — it's just outside the "silent save"
    // window and needs the extra confirmation.
    if (reasons.length > 0 && !forceApprove) {
      return {
        ok: false,
        needsApprove: true,
        reasons,
        normalCadenceDate,
        collidingOccurrenceId: collision?.id ?? null,
      };
    }

    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id },
        data: { nextStartOverride: rawDate },
      });
      // Records the moved next-visit date — client-visible reschedule of the
      // following occurrence. Fires on BOTH the silent-save and the typed-
      // APPROVE path; `reasons` is non-empty only on the latter.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        action:
          forceApprove && reasons.length > 0
            ? "next-start-override-set-with-approve"
            : "next-start-override-set",
        dateBefore: occ.nextStartOverride ?? null,
        dateAfter: rawDate,
        normalCadenceDate,
        reasons,
      });
    });
    return {
      ok: true,
      nextStartOverride: rawDate,
      normalCadenceDate,
    };
  });
  // Link two occurrences (must share the same jobId)
  app.post("/occurrences/:id/link", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const targetId = String(req.body?.targetOccurrenceId ?? "");
    if (!targetId) throw app.httpErrors.badRequest("targetOccurrenceId is required");

    const [occ, target] = await Promise.all([
      prisma.jobOccurrence.findUnique({ where: { id: occId }, include: { job: { select: { propertyId: true } } } }),
      prisma.jobOccurrence.findUnique({ where: { id: targetId }, include: { job: { select: { propertyId: true } } } }),
    ]);
    if (!occ || !target) throw app.httpErrors.notFound("Occurrence not found");
    // Allow linking across jobs if they share the same property
    const occPropertyId = occ.job?.propertyId;
    const targetPropertyId = target.job?.propertyId;
    if (occPropertyId && targetPropertyId && occPropertyId !== targetPropertyId) {
      throw app.httpErrors.badRequest("Occurrences must belong to jobs on the same property");
    }
    if (occId === targetId) throw app.httpErrors.badRequest("Cannot link an occurrence to itself");

    // Determine group ID: merge existing groups or create new
    const crypto = require("crypto");
    let groupId = occ.linkGroupId ?? target.linkGroupId ?? crypto.randomUUID();

    await prisma.$transaction(async (tx) => {
      // If both have different groups, merge them (move target's group to occ's group)
      if (occ.linkGroupId && target.linkGroupId && occ.linkGroupId !== target.linkGroupId) {
        await tx.jobOccurrence.updateMany({
          where: { linkGroupId: target.linkGroupId },
          data: { linkGroupId: occ.linkGroupId },
        });
        groupId = occ.linkGroupId;
      }

      // Set groupId on both
      await tx.jobOccurrence.updateMany({
        where: { id: { in: [occId, targetId] } },
        data: { linkGroupId: groupId },
      });

      // Sync dates — the source occurrence's startAt becomes the group date
      const rescheduled: Array<{
        occurrenceId: string;
        startAtBefore: string | null;
        startAtAfter: string | null;
        endAtBefore: string | null;
        endAtAfter: string | null;
      }> = [];
      if (occ.startAt) {
        // Sync all other occurrences in the group to the source date
        const allInGroup = await tx.jobOccurrence.findMany({
          where: { linkGroupId: groupId, id: { not: occId } },
        });
        for (const l of allInGroup) {
          const updates: any = { startAt: occ.startAt };
          if (l.startAt && l.endAt) {
            const duration = l.endAt.getTime() - l.startAt.getTime();
            updates.endAt = new Date(occ.startAt.getTime() + duration);
          }
          await tx.jobOccurrence.update({ where: { id: l.id }, data: updates });
          rescheduled.push({
            occurrenceId: l.id,
            startAtBefore: l.startAt?.toISOString() ?? null,
            startAtAfter: occ.startAt.toISOString(),
            endAtBefore: l.endAt?.toISOString() ?? null,
            endAtAfter: updates.endAt ? (updates.endAt as Date).toISOString() : (l.endAt?.toISOString() ?? null),
          });
        }
      }

      // Records the link merge AND the client-visible reschedule it forces on
      // every other occurrence in the group (their startAt/endAt are rewritten
      // to the source occurrence's date).
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: occId,
        jobId: occ.jobId ?? null,
        action: "occurrences_linked",
        targetOccurrenceId: targetId,
        linkGroupIdBefore: occ.linkGroupId ?? null,
        targetLinkGroupIdBefore: target.linkGroupId ?? null,
        linkGroupIdAfter: groupId,
        affectedOccurrenceIds: rescheduled.map((r) => r.occurrenceId),
        rescheduled,
      });
    });

    return { ok: true, linkGroupId: groupId };
  });
  // Unlink an occurrence from its group
  app.post("/occurrences/:id/unlink", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occId } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occ.linkGroupId) return { ok: true };

    const groupId = occ.linkGroupId;
    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({ where: { id: occId }, data: { linkGroupId: null } });

      // If only 1 occurrence left in the group, remove the group from it too
      const remaining = await tx.jobOccurrence.count({ where: { linkGroupId: groupId } });
      let dissolvedGroup = false;
      if (remaining === 1) {
        await tx.jobOccurrence.updateMany({ where: { linkGroupId: groupId }, data: { linkGroupId: null } });
        dissolvedGroup = true;
      }
      // Records the occurrence leaving its link group (and the group being
      // dissolved when only one member would be left).
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: occId,
        jobId: occ.jobId ?? null,
        action: "occurrence_unlinked",
        linkGroupIdBefore: groupId,
        linkGroupIdAfter: null,
        dissolvedGroup,
      });
    });

    return { ok: true };
  });
  // Get linked occurrences for an occurrence
  app.get("/occurrences/:id/linked", req_scheduleView, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never area-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const occId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occId } });
    if (!occ?.linkGroupId) return [];
    return prisma.jobOccurrence.findMany({
      where: { linkGroupId: occ.linkGroupId, id: { not: occId } },
      select: {
        id: true, title: true, startAt: true, endAt: true, status: true, workflow: true, jobType: true, price: true,
        job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } },
      },
      orderBy: { startAt: "asc" },
    });
  });
  // Patch an occurrence (optional but very useful for admin UI)
  app.patch(
    "/occurrences/:occurrenceId",
    req_scheduleManage,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      const body = req.body || {};

      const patch: any = {};

      if (body.kind != null) {
        const kind = String(body.kind || "").toUpperCase();
        if (kind !== "ENTIRE_SITE" && kind !== "SINGLE_ADDRESS") {
          throw app.httpErrors.badRequest("Invalid kind");
        }
        patch.kind = kind as JobKind;
      }

      if (body.status != null) {
        const st = String(body.status || "").toUpperCase();
        const ok =
          st === "SCHEDULED" ||
          st === "IN_PROGRESS" ||
          st === "COMPLETED" ||
          st === "PENDING_PAYMENT" ||
          st === "PROPOSAL_SUBMITTED" ||
          st === "ACCEPTED" ||
          st === "REJECTED" ||
          st === "CLOSED" ||
          st === "CANCELED" ||
          st === "ARCHIVED" ||
          st === "PAUSED";
        if (!ok) throw app.httpErrors.badRequest("Invalid occurrence status");
        patch.status = st as JobOccurrenceStatus;
      }

      if ("startAt" in body) patch.startAt = body.startAt || null;
      if ("endAt" in body) patch.endAt = body.endAt || null;
      if ("notes" in body) patch.notes = body.notes;
      if ("price" in body) patch.price = body.price != null ? Number(body.price) : null;
      if ("estimatedMinutes" in body) patch.estimatedMinutes = body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null;
      if ("totalPausedMs" in body) patch.totalPausedMs = body.totalPausedMs != null ? Math.max(0, Math.round(Number(body.totalPausedMs))) : 0;
      if ("isTentative" in body) patch.isTentative = !!body.isTentative;
      if ("isEstimate" in body) patch.isEstimate = !!body.isEstimate;
      if ("mustBeAssigned" in body) patch.mustBeAssigned = !!body.mustBeAssigned;
      if ("isClientConfirmed" in body) patch.isClientConfirmed = !!body.isClientConfirmed;
      if ("pinnedNote" in body) patch.pinnedNote = body.pinnedNote ? String(body.pinnedNote).trim() : null;
      if ("pinnedNoteRepeats" in body) patch.pinnedNoteRepeats = !!body.pinnedNoteRepeats;
      if ("jobType" in body) patch.jobType = body.jobType || null;
      if ("jobTags" in body) patch.jobTags = body.jobTags ? JSON.stringify(body.jobTags) : null;
      if ("startedAt" in body) patch.startedAt = body.startedAt || null;
      if ("completedAt" in body) patch.completedAt = body.completedAt || null;
      if ("startLat" in body) patch.startLat = body.startLat != null ? Number(body.startLat) : null;
      if ("startLng" in body) patch.startLng = body.startLng != null ? Number(body.startLng) : null;
      if ("completeLat" in body) patch.completeLat = body.completeLat != null ? Number(body.completeLat) : null;
      if ("completeLng" in body) patch.completeLng = body.completeLng != null ? Number(body.completeLng) : null;
      if ("title" in body) patch.title = body.title || null;
      if ("contactName" in body) patch.contactName = body.contactName || null;
      if ("contactPhone" in body) patch.contactPhone = body.contactPhone || null;
      if ("contactEmail" in body) patch.contactEmail = body.contactEmail || null;
      if ("estimateAddress" in body) patch.estimateAddress = body.estimateAddress || null;
      Object.assign(patch, pickEstimateAddressParts(body));
      if ("proposalAmount" in body) patch.proposalAmount = body.proposalAmount != null ? Number(body.proposalAmount) : null;
      if ("frequencyDays" in body) {
        if (body.frequencyDays != null) {
          const fd = Math.round(Number(body.frequencyDays));
          if (!Number.isFinite(fd) || fd < 1) throw app.httpErrors.badRequest("frequencyDays must be a positive integer");
          patch.frequencyDays = fd;
        } else {
          patch.frequencyDays = null;
        }
      }

      if ("jobId" in body) patch.jobId = body.jobId || null;
      // Free-text reason captured by the Revert Payment dialog on the
      // Services tab. Only meaningful when this PATCH is taking the
      // occurrence from CLOSED back to PENDING_PAYMENT; ignored otherwise.
      if ("paymentRevertReason" in body) patch.paymentRevertReason = body.paymentRevertReason ? String(body.paymentRevertReason) : null;

      // You’ll want to implement services.jobs.updateOccurrence(...) OR do prisma here.
      return services.jobs.updateOccurrence(
        await currentUserId(req),
        occurrenceId,
        patch,
        { canManageSchedule: true }
      );
    }
  );
  // Archive a completed occurrence
  app.post(
    "/occurrences/:occurrenceId/archive",
    req_scheduleManage,
    async (req: any) => {
      return services.jobs.archiveOccurrence(
        await currentUserId(req),
        String(req.params.occurrenceId)
      );
    }
  );
  // Stream pause on a single recurring occurrence — pauses just the
  // stream (e.g. hedging) while other streams under the same Job (mow)
  // keep running. See services/occurrenceStreamPause.ts for semantics.
  // The pause-reason taxonomy, for the dropdown. Gated on `schedule.manage`
  // and nothing narrower: anyone who can pause a stream needs the list of
  // reasons to pause with.
  app.get("/pause-reasons", req_scheduleManage, async () => {
    const { listPauseReasons } = await import("../services/pauseReasons");
    const all = await listPauseReasons();
    // Retired reasons still resolve for historical rows but are not offered
    // for new pauses.
    return { reasons: all.filter((r) => !r.retired) };
  });
  app.post(
    "/occurrences/:occurrenceId/stream-pause",
    req_scheduleManage,
    async (req: any) => {
      const body = req.body || {};
      const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode.trim() : "";
      if (!reasonCode) {
        throw app.httpErrors.badRequest(
          "Pick a reason for pausing — it is what makes a paused service findable again.",
        );
      }
      const reason = typeof body.reason === "string" ? body.reason : null;
      const reminderAt = body.reminderAt ? new Date(body.reminderAt) : null;
      const { pauseStream } = await import("../services/occurrenceStreamPause");
      return pauseStream(
        await currentUserId(req),
        String(req.params.occurrenceId),
        { reasonCode, reason, reminderAt },
      );
    },
  );
  // Update the reason and/or reminder date on an already-paused
  // stream — the "extend the pause" workflow when a reminder arrives
  // and the operator wants to push it out further with a fresh note.
  app.patch(
    "/occurrences/:occurrenceId/stream-pause",
    req_scheduleManage,
    async (req: any) => {
      const body = req.body || {};
      // Distinguish "field absent" (leave alone) from "field null"
      // (clear). Match the service function's signature.
      const opts: { reasonCode?: string; reason?: string | null; reminderAt?: Date | null } = {};
      if (typeof body.reasonCode === "string" && body.reasonCode.trim()) {
        opts.reasonCode = body.reasonCode.trim();
      }
      if ("reason" in body) {
        opts.reason = typeof body.reason === "string" ? body.reason : null;
      }
      if ("reminderAt" in body) {
        opts.reminderAt = body.reminderAt ? new Date(body.reminderAt) : null;
      }
      const { updateStreamPause } = await import("../services/occurrenceStreamPause");
      return updateStreamPause(
        await currentUserId(req),
        String(req.params.occurrenceId),
        opts,
      );
    },
  );
  // Resume a paused stream — required newStartAt (defaults picked at
  // the UI layer to keep the service function unopinionated).
  app.post(
    "/occurrences/:occurrenceId/stream-resume",
    req_scheduleManage,
    async (req: any) => {
      const body = req.body || {};
      if (!body.newStartAt) {
        throw app.httpErrors.badRequest("newStartAt is required.");
      }
      const newStartAt = new Date(body.newStartAt);
      if (Number.isNaN(newStartAt.getTime())) {
        throw app.httpErrors.badRequest("newStartAt is not a valid date.");
      }
      const { resumeStream } = await import("../services/occurrenceStreamPause");
      return resumeStream(
        await currentUserId(req),
        String(req.params.occurrenceId),
        newStartAt,
      );
    },
  );
  // Count of stream pauses whose reminder date has arrived — feeds
  // the alerts dropdown + Tasks page shortcut card.
  app.get(
    "/stream-pauses/reminders/count",
    req_scheduleView,
    async (req: any) => {
      const { countDueStreamPauseReminders } = await import(
        "../services/occurrenceStreamPause"
      );
      return {
        count: await countDueStreamPauseReminders(
          areaWhere(req.principal, "schedule.view"),
        ),
      };
    },
  );
  // List of stream pauses whose reminder date has arrived — feeds
  // the Tasks page card body.
  app.get(
    "/stream-pauses/reminders",
    req_scheduleView,
    async (req: any) => {
      const { listDueStreamPauseReminders } = await import(
        "../services/occurrenceStreamPause"
      );
      return listDueStreamPauseReminders(
        areaWhere(req.principal, "schedule.view"),
      );
    },
  );
  // Delete a canceled occurrence permanently
  app.delete(
    "/occurrences/:occurrenceId",
    req_scheduleManage,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      return services.jobs.deleteOccurrence(occurrenceId, await currentUserId(req));
    }
  );
  // Recalculate payment splits based on current assignees
  app.post("/occurrences/:occurrenceId/recalculate-splits", req_moneyAdjust, async (req: any) => {
    return services.payments.recalculateSplits(String(req.params.occurrenceId), await currentUserId(req));
  });
  // Admin "Mark Invoice Paid" — closes out a PENDING_PAYMENT occurrence
  // when an invoice was sent but the client paid offline and never
  // self-reported. Creates a confirmed Payment row + runs the standard
  // approval downstream (next-occurrence creation for repeating jobs).
  app.post("/occurrences/:occurrenceId/mark-paid", req_moneyRecord, async (req: any) => {
    const body = req.body || {};
    const amountPaid = Number(body.amountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid < 0) {
      throw app.httpErrors.badRequest("amountPaid must be a non-negative number");
    }
    const method = String(body.method || "").trim();
    if (!method) {
      throw app.httpErrors.badRequest("method is required");
    }
    let processorFeeAmount: number | undefined;
    if (body.processorFeeAmount !== undefined && body.processorFeeAmount !== null) {
      processorFeeAmount = Number(body.processorFeeAmount);
      if (!Number.isFinite(processorFeeAmount) || processorFeeAmount < 0 || processorFeeAmount > amountPaid) {
        throw app.httpErrors.badRequest("processorFeeAmount must be between 0 and amountPaid");
      }
    }
    // Optional `paidAt` — YYYY-MM-DD in ET. When present, anchors
    // both `createdAt` and `confirmedAt` on the resulting Payment to
    // ET-noon of that date (DST-safe). Absent = fall back to now().
    let paidAt: Date | undefined;
    if (body.paidAt) {
      const key = String(body.paidAt);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        throw app.httpErrors.badRequest("paidAt must be YYYY-MM-DD");
      }
      paidAt = etInstantFromParts(key as EtDateKey, "12:00");
    }
    return services.payments.markInvoicePaidAsManager(
      await currentUserId(req),
      String(req.params.occurrenceId),
      {
        amountPaid,
        method,
        note: body.note != null ? String(body.note) : null,
        processorFeeAmount,
        paidAt,
      },
    );
  });
  // Force-create next occurrence (admin) — bypasses duplicate guard
  app.post("/occurrences/:occurrenceId/force-next", req_scheduleManage, async (req: any) => {
    return services.payments.forceCreateNextOccurrence(
      await currentUserId(req),
      String(req.params.occurrenceId)
    );
  });
  app.post("/occurrences/:occurrenceId/accept-proposal", req_estimatesAccept, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.occurrenceId);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { job: { select: { id: true, defaultPrice: true, estimatedMinutes: true } }, assignees: true },
    });

    const isEstimate = (occ as any).workflow === "ESTIMATE" || (occ as any).isEstimate;
    if (!isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be accepted.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be accepted after the team has completed them.");
    }

    // Accept the estimate with optional comment
    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          status: "ACCEPTED",
          notes: body.comment ? `${occ.notes ? occ.notes + "\n" : ""}Accepted: ${String(body.comment)}` : occ.notes,
        },
      });
      // Money: accepting locks in the quoted price as the amount the client
      // agreed to, and unblocks converting the estimate into billable work.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "estimate_proposal_accepted",
        statusBefore: occ.status,
        statusAfter: "ACCEPTED",
        priceBefore: occ.price ?? null,
        proposalAmount: (occ as any).proposalAmount ?? null,
        comment: body.comment ? String(body.comment) : null,
      });
    });

    // Return job info so frontend can prompt to create occurrence
    return {
      accepted: true,
      jobId: occ.jobId,
      occurrence: {
        kind: occ.kind,
        startAt: occ.startAt?.toISOString() ?? null,
        endAt: occ.endAt?.toISOString() ?? null,
        notes: (occ as any).proposalNotes ?? occ.notes ?? null,
        price: (occ as any).proposalAmount ?? occ.price ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? null,
        jobTags: (occ as any).jobTags ?? null,
        jobType: (occ as any).jobType ?? null,
        assignees: occ.assignees.map((a) => ({ userId: a.userId })),
      },
    };
  });
  app.post("/occurrences/:occurrenceId/reject-proposal", req_estimatesAccept, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.occurrenceId);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });

    const isEstimate = (occ as any).workflow === "ESTIMATE" || (occ as any).isEstimate;
    if (!isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be rejected.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be rejected after the team has completed them.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          status: "REJECTED",
          rejectionReason: body.reason ? String(body.reason) : null,
        },
      });
      // Money: rejecting kills the quoted work — the proposed amount will
      // never be billed and the visit won't convert into a job.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "estimate_proposal_rejected",
        statusBefore: occ.status,
        statusAfter: "REJECTED",
        priceBefore: occ.price ?? null,
        proposalAmount: (occ as any).proposalAmount ?? null,
        reason: body.reason ? String(body.reason) : null,
      });
    });

    return { rejected: true };
  });
  app.post("/occurrences/:occurrenceId/generate-estimate", req_estimatesCreate, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.occurrenceId);

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: {
        job: {
          include: {
            property: {
              include: {
                client: {
                  include: {
                    contacts: { where: { status: "ACTIVE" }, orderBy: { isPrimary: "desc" } },
                  },
                },
                pointOfContact: true,
              },
            },
          },
        },
        assignees: { include: { user: { select: { displayName: true } } } },
        invoiceCharges: true,
      },
    });

    const prop = occ.job?.property;
    const client = prop?.client;
    const contact = prop?.pointOfContact ?? client?.contacts?.[0];
    const contactName = contact?.firstName ?? client?.displayName ?? "Valued Customer";

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw app.httpErrors.serviceUnavailable("Estimate generation is not configured. Add ANTHROPIC_API_KEY.");
    }

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const ai = new Anthropic({ apiKey });

    const jobTypeLabel = occ.jobType
      ? occ.jobType.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase())
      : "Lawn Care Service";

    // Fetch pricing guide for AI context
    const pricingSettings = await prisma.setting.findMany({
      where: { key: { startsWith: "pricing_" } },
    });
    const pricingGuide = pricingSettings.map((s: any) => {
      try {
        const v = JSON.parse(s.value);
        return `- ${v.label}: $${v.amount} ${v.unit} — ${v.description}`;
      } catch { return null; }
    }).filter(Boolean).join("\n");

    const details = [
      `Client: ${contactName}`,
      `Property: ${prop?.displayName ?? "N/A"}`,
      `Address: ${[prop?.street1, prop?.city, prop?.state, prop?.postalCode].filter(Boolean).join(", ")}`,
      prop?.lotSize ? `Property size: ${prop.lotSize} ${prop.lotSizeUnit ?? "sqft"}` : null,
      `Service type: ${jobTypeLabel}`,
      occ.estimatedMinutes ? `Estimated time: ${occ.estimatedMinutes} minutes` : null,
      occ.price != null ? `Quoted price: $${occ.price.toFixed(2)}` : null,
      occ.job?.frequencyDays ? `Frequency: every ${occ.job.frequencyDays} days` : "One-time service",
      occ.notes ? `Notes: ${occ.notes}` : null,
      occ.proposalNotes ? `Team notes: ${occ.proposalNotes}` : null,
      occ.proposalAmount != null ? `Team proposed amount: $${occ.proposalAmount.toFixed(2)}` : null,
      // `e.amount` — a field InvoiceCharge has never had; it is `cost`. `e` is
      // `any`, so tsc never saw it and this threw a TypeError on every
      // estimate for a job carrying a charge. Predates the rename.
      occ.invoiceCharges?.length ? `Charges: ${occ.invoiceCharges.map((e: any) => `$${(e.cost ?? 0).toFixed(2)} (${e.description})`).join(", ")}` : null,
      prop?.accessNotes ? `Access notes: ${prop.accessNotes}` : null,
    ].filter(Boolean).join("\n");

    const prompt = `You are estimating a lawn care job for Seedlings Lawn Care. Produce two outputs as JSON.

Job info:
${details}
${pricingGuide ? `\nCompany pricing guide (use these rates as your baseline):\n${pricingGuide}\n` : ""}
STEP 1 — INTERNAL BREAKDOWN (for business eyes only):
- Use the company pricing guide rates as your baseline where applicable
- Use the address to determine local market rates for the area (materials, labor, delivery)
- If the notes contain measurements, square footage, material quantities (e.g. yards of mulch), use those exact numbers
- Itemize: materials (with per-unit costs), delivery, labor (hours × rate), additional services
- Show subtotal of costs
- Add 20% business margin (covers overhead, insurance, taxes, profit)
- Show final client-facing price
- If upgrade options are mentioned, calculate those too with the same margin
- Be specific with numbers and sources of rates

STEP 2 — CLIENT MESSAGE:
- Address client as ${contactName}
- Plain text only, no markdown, no subject line
- State the total price clearly as a single number — do NOT itemize costs or mention margin
- Briefly list what's included in the service
- If the notes mention upgrade options (e.g. thicker depth), mention the approximate price for that too
- Add one line: final price may vary slightly based on actual conditions on-site
- NEVER offer discounts or reduced pricing
- End with a short invite to confirm
- Sign off as "Seedlings Lawn Care"
- Keep it concise

Respond ONLY with valid JSON in this exact format:
{"breakdown": "the internal cost breakdown text", "message": "the client-facing message text"}
12. Do NOT use markdown formatting — plain text only`;

    try {
      const response = await ai.messages.create({
        model: "claude-sonnet-5",
        // Two prose fields (an internal breakdown plus a client-facing
        // message) wrapped in JSON. 1500 was tight enough that a wordy
        // estimate could truncate — the same failure that hit the route
        // planner in production on 2026-08-25, where the half-written JSON
        // was shown to the operator. Output is billed by what's produced,
        // so the higher ceiling costs nothing on a short reply.
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      });

      // Truncation is not a parse problem. Without this check the only
      // symptom is unparseable JSON, and the fallback below would quietly
      // send a half-written message to a CLIENT.
      if (response.stop_reason === "max_tokens") {
        throw new Error(
          "The estimate generator ran out of room before finishing. Try again, " +
            "or shorten the job notes it was given.",
        );
      }

      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      // Parse JSON response
      let message = text;
      let breakdown = "";
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          message = parsed.message || text;
          breakdown = parsed.breakdown || "";
        }
      } catch {}

      // Save to the occurrence
      await prisma.$transaction(async (tx) => {
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: {
            generatedEstimate: message,
            generatedEstimateBreakdown: breakdown,
          },
        });
        // Records that AI-authored estimate copy was written onto the
        // occurrence, overwriting whatever draft was there before.
        await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
          occurrenceId,
          jobId: occ.jobId ?? null,
          action: "estimate_text_generated",
          hadPreviousEstimate: !!(occ as any).generatedEstimate,
          estimateLength: message.length,
          breakdownLength: breakdown.length,
        });
      });

      return { estimate: message, breakdown };
    } catch (err: any) {
      throw app.httpErrors.internalServerError(`Estimate generation failed: ${err.message}`);
    }
  });
  // ── Events: shared occurrences. Created on `schedule.manage`, read
  //    on `timeline.view`. ──
  app.post("/events", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createEvent(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      frequencyDays: body.frequencyDays != null ? Number(body.frequencyDays) : null,
    });
  });
  app.patch("/events/:id", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Event not found");
    if (occ.workflow !== "EVENT") throw app.httpErrors.badRequest("Not an event");
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays != null ? Number(body.frequencyDays) : null;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({ where: { id }, data });
      // Records an edit to a shared calendar event every worker sees.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        action: "event_updated",
        changedFields: Object.keys(data),
        titleBefore: occ.title ?? null,
        titleAfter: updated.title ?? null,
        startAtBefore: occ.startAt?.toISOString() ?? null,
        startAtAfter: updated.startAt?.toISOString() ?? null,
        frequencyDaysBefore: (occ as any).frequencyDays ?? null,
        frequencyDaysAfter: (updated as any).frequencyDays ?? null,
      });
      return updated;
    });
  });
  app.post("/events/:id/complete", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.completeEvent(uid, String(req.params.id));
  });
  app.delete("/events/:id", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Event not found");
    if (occ.workflow !== "EVENT") throw app.httpErrors.badRequest("Not an event");
    return prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.delete({ where: { id } });
      // Destructive: hard-deletes a shared calendar event; this snapshot is
      // the only record it was ever on the schedule.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_DELETED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        action: "event_deleted",
        workflow: occ.workflow,
        status: occ.status,
        title: occ.title ?? null,
        notes: occ.notes ?? null,
        startAt: occ.startAt?.toISOString() ?? null,
        frequencyDays: (occ as any).frequencyDays ?? null,
      });
      return { deleted: true };
    });
  });
  // ── Followups, with optional client/job attachments. Created on
  //    `schedule.manage`; editing and completing one are OWNERSHIP
  //    routes scoped to the claimer. ──
  app.post("/followups", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createFollowup(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      frequencyDays: body.frequencyDays != null ? Number(body.frequencyDays) : null,
      clientIds: Array.isArray(body.clientIds) ? body.clientIds : [],
      jobIds: Array.isArray(body.jobIds) ? body.jobIds : [],
    });
  });
  // ── Announcements: posted on `marketing.manage`, visible to everyone. ──
  app.post("/announcements", req_marketingManage, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createAnnouncement(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      frequencyDays: body.frequencyDays != null ? Number(body.frequencyDays) : null,
    });
  });
  app.patch("/announcements/:id", req_marketingManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Announcement not found");
    if (occ.workflow !== "ANNOUNCEMENT") throw app.httpErrors.badRequest("Not an announcement");
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays != null ? Number(body.frequencyDays) : null;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({ where: { id }, data });
      // Records an edit to an announcement shown to every worker.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        action: "announcement_updated",
        changedFields: Object.keys(data),
        titleBefore: occ.title ?? null,
        titleAfter: updated.title ?? null,
        startAtBefore: occ.startAt?.toISOString() ?? null,
        startAtAfter: updated.startAt?.toISOString() ?? null,
        frequencyDaysBefore: (occ as any).frequencyDays ?? null,
        frequencyDaysAfter: (updated as any).frequencyDays ?? null,
      });
      return updated;
    });
  });
  app.post("/announcements/:id/complete", req_marketingManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.completeAnnouncement(uid, String(req.params.id));
  });
  app.delete("/announcements/:id", req_marketingManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id } });
    if (!occ) throw app.httpErrors.notFound("Announcement not found");
    if (occ.workflow !== "ANNOUNCEMENT") throw app.httpErrors.badRequest("Not an announcement");
    return prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.delete({ where: { id } });
      // Destructive: hard-deletes a company-wide announcement; this snapshot
      // is the only record of what it said.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_DELETED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        action: "announcement_deleted",
        workflow: occ.workflow,
        status: occ.status,
        title: occ.title ?? null,
        notes: occ.notes ?? null,
        startAt: occ.startAt?.toISOString() ?? null,
        frequencyDays: (occ as any).frequencyDays ?? null,
      });
      return { deleted: true };
    });
  });
  app.post("/occurrences/:id/link-to-job", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const jobId = String(req.body?.jobId ?? "");
    if (!jobId) throw app.httpErrors.badRequest("jobId is required");
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occId } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occId },
        data: { jobId, kind: "SINGLE_ADDRESS" },
      });
      // Money: re-parenting an orphan occurrence changes which job (and
      // therefore which client) the visit is billed under.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: occId,
        action: "occurrence_reparented_to_job",
        jobIdBefore: occ.jobId ?? null,
        jobIdAfter: jobId,
        jobId,
        kindBefore: occ.kind,
        kindAfter: "SINGLE_ADDRESS",
        priceBefore: occ.price ?? null,
      });
    });
    return { ok: true };
  });
  app.get("/change-requests", req_scheduleView, async (req: any) => {
    const status = (req.query?.status as string | undefined)?.toUpperCase();
    const where: any = {};
    if (status && ["PENDING", "APPROVED", "DENIED", "CANCELED"].includes(status)) {
      where.status = status;
    } else {
      where.status = "PENDING";
    }
    // Enriched payload for the Client Requests panel — surfaces everything
    // needed to handle the request without navigating away:
    //   - the occurrence + job + property (so they know what / where)
    //   - the job's cadence (so they can talk in concrete terms)
    //   - the primary contact's name/phone/email (for the call/text/email
    //     deep-links rendered on each request card)
    //   - the resolver (for resolved requests in history)
    // Territory via the visit the request is about. A change request is
    // only ever meaningful alongside its occurrence, so it narrows with it.
    Object.assign(where, withArea(where, areaWhereVia(req.principal, "schedule.view", "occurrence")));
    return prisma.occurrenceChangeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        occurrence: {
          select: {
            id: true,
            startAt: true,
            status: true,
            kind: true,
            jobType: true,
            workflow: true,
            isOneOff: true,
            frequencyDays: true,
            job: {
              select: {
                id: true,
                frequencyDays: true,
                property: {
                  select: {
                    id: true,
                    displayName: true,
                    street1: true,
                    city: true,
                    state: true,
                    client: {
                      select: {
                        id: true,
                        displayName: true,
                        contacts: {
                          where: { status: "ACTIVE", isPrimary: true },
                          select: { id: true, firstName: true, lastName: true, email: true, phone: true, normalizedPhone: true },
                          take: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        requestedBy: { select: { id: true, displayName: true, email: true } },
        resolvedBy: { select: { id: true, displayName: true } },
      },
    });
  });
  app.post("/change-requests/:id/approve", req_scheduleManage, async (req: any) => {
    const id = String(req.params.id);
    const uid = await currentUserId(req);
    const body = req.body || {};
    return prisma.$transaction(async (tx) => {
      const cr = await tx.occurrenceChangeRequest.findUnique({
        where: { id },
        include: {
          occurrence: {
            include: {
              job: {
                select: {
                  id: true,
                  status: true,
                  frequencyDays: true,
                  kind: true,
                  defaultPrice: true,
                  estimatedMinutes: true,
                  notes: true,
                  defaultGroupId: true,
                  defaultAssignees: { where: { active: true }, select: { userId: true, role: true } },
                },
              },
            },
          },
        },
      });
      if (!cr) throw app.httpErrors.notFound("Request not found.");
      if (cr.status !== "PENDING") throw app.httpErrors.badRequest("Already resolved.");
      // Captured for the audit entry below: SKIP approvals can silently
      // create the next occurrence in the recurring chain.
      let createdNextOccurrenceId: string | null = null;
      // Apply the change.
      if (cr.kind === "RESCHEDULE") {
        // RESCHEDULE is now a conversation-starter, not a command. The
        // admin handles the actual date change via the normal occurrence
        // editor after talking to the client. Approving here just marks
        // the request resolved — no auto-mutation of startAt.
      } else if (cr.kind === "SKIP") {
        const occ = cr.occurrence;
        await tx.jobOccurrence.update({
          where: { id: cr.occurrenceId },
          data: { status: "CANCELED" },
        });
        // Advance the recurring chain. Without this, skipping a
        // recurring visit would silently halt the schedule (the
        // next-occurrence chain normally runs on payment approval —
        // skipped visits have no payment). Mirrors the logic in
        // payments.ts:approvePayment for the auto-create-next path.
        const effectiveFreq = (occ as any).frequencyDays ?? occ.job?.frequencyDays ?? null;
        const isRecurring =
          !!effectiveFreq &&
          !(occ as any).isOneOff &&
          occ.workflow !== "ONE_OFF" &&
          occ.workflow !== "ESTIMATE" &&
          occ.job &&
          occ.job.status !== "ARCHIVED";
        if (isRecurring && effectiveFreq && occ.job) {
          const baseDate = occ.startAt ? new Date(occ.startAt) : new Date();
          const nextStart = new Date(baseDate);
          nextStart.setDate(nextStart.getDate() + effectiveFreq);
          const nextEnd = occ.endAt ? new Date(occ.endAt) : null;
          if (nextEnd) nextEnd.setDate(nextEnd.getDate() + effectiveFreq);
          // Dedupe: don't create a second occurrence on the same ET
          // calendar day. Exact-instant match used to miss occurrences
          // booked at slightly different times of day; the day-window
          // match in approvePayment uses the same approach (see
          // payments.ts).
          const nextDayKey = etFormatDate(nextStart);
          const existingNext = await tx.jobOccurrence.findFirst({
            where: {
              jobId: occ.jobId,
              status: "SCHEDULED",
              startAt: { gte: etMidnight(nextDayKey), lte: etEndOfDay(nextDayKey) },
              workflow: "STANDARD",
              isOneOff: false,
            },
          });
          if (!existingNext) {
            const nextAreaId = await resolveOccurrenceArea(tx, {
              jobId: occ.jobId!,
              previousOccurrenceId: occ.id,
            });
            const nextOcc = await tx.jobOccurrence.create({
              data: {
                jobId: occ.jobId!,
                areaId: nextAreaId,
                kind: occ.kind,
                startAt: nextStart,
                endAt: nextEnd,
                status: "SCHEDULED",
                source: "GENERATED",
                workflow: "STANDARD",
                mustBeAssigned: !!(occ as any).mustBeAssigned,
                jobType: occ.jobType ?? null,
                jobTags: (occ as any).jobTags ?? null,
                price: occ.price ?? occ.job.defaultPrice ?? null,
                estimatedMinutes: occ.estimatedMinutes ?? occ.job.estimatedMinutes ?? null,
                notes: occ.notes ?? occ.job.notes ?? null,
                frequencyDays: (occ as any).frequencyDays ?? null,
              } as any,
            });
            // Same carry every other next-visit path runs. See
            // lib/instructionCarry.ts.
            await carryInstructionsToNewOccurrence(tx as any, {
              jobId: occ.jobId!,
              sourceOccurrenceId: occ.id,
              newOccurrenceId: nextOcc.id,
            });
            createdNextOccurrenceId = nextOcc.id;
            // Copy default assignees from the job (group first, then
            // individual). The earlier occurrence's actual assignees are
            // ignored — the recurring chain restarts from the template.
            const assigneeSource: { userId: string; role: string | null }[] = [];
            if (occ.job.defaultGroupId) {
              const group = await tx.group.findUnique({
                where: { id: occ.job.defaultGroupId },
                include: { members: { select: { userId: true, role: true } } },
              });
              if (group && !group.archivedAt) {
                await tx.jobOccurrence.update({
                  where: { id: nextOcc.id },
                  data: { assignedGroupId: group.id } as any,
                });
                assigneeSource.push({ userId: group.claimerUserId, role: null });
                for (const m of group.members) {
                  assigneeSource.push({ userId: m.userId, role: m.role === "observer" ? "observer" : null });
                }
              }
            } else {
              for (const d of occ.job.defaultAssignees) {
                assigneeSource.push({ userId: d.userId, role: d.role ?? null });
              }
            }
            if (assigneeSource.length) {
              const claimerId = assigneeSource[0].userId;
              await tx.jobOccurrenceAssignee.createMany({
                data: assigneeSource.map((a, i) => ({
                  occurrenceId: nextOcc.id,
                  userId: a.userId,
                  role: a.role ?? null,
                  assignedById: i === 0 ? a.userId : claimerId,
                })),
                skipDuplicates: true,
              });
              await enforceAssigneeInvariants(tx, nextOcc.id, uid);
            }
          }
        }
      }
      const updated = await tx.occurrenceChangeRequest.update({
        where: { id },
        data: {
          status: "APPROVED",
          resolvedById: uid,
          resolvedAt: new Date(),
          resolutionNote: body.note ? String(body.note).trim() : null,
        },
      });
      // Records the approval and everything it cascaded into: a SKIP cancels
      // the visit (no payment will ever be collected on it) and advances the
      // recurring chain by creating the next occurrence + its crew.
      await writeAudit(tx, AUDIT.CHANGE_REQUEST.APPROVED, uid, {
        changeRequestId: id,
        occurrenceId: cr.occurrenceId,
        jobId: cr.occurrence?.jobId ?? null,
        kind: cr.kind,
        statusBefore: "PENDING",
        statusAfter: "APPROVED",
        occurrenceStatusBefore: cr.occurrence?.status ?? null,
        occurrenceStatusAfter: cr.kind === "SKIP" ? "CANCELED" : (cr.occurrence?.status ?? null),
        canceledOccurrencePrice: cr.kind === "SKIP" ? (cr.occurrence?.price ?? null) : null,
        createdNextOccurrenceId,
        resolutionNote: body.note ? String(body.note).trim() : null,
      });
      return updated;
    });
  });
  app.post("/change-requests/:id/deny", req_scheduleManage, async (req: any) => {
    const id = String(req.params.id);
    const uid = await currentUserId(req);
    const body = req.body || {};
    const cr = await prisma.occurrenceChangeRequest.findUnique({ where: { id } });
    if (!cr) throw app.httpErrors.notFound("Request not found.");
    if (cr.status !== "PENDING") throw app.httpErrors.badRequest("Already resolved.");
    return prisma.$transaction(async (tx) => {
      const updated = await tx.occurrenceChangeRequest.update({
        where: { id },
        data: {
          status: "DENIED",
          resolvedById: uid,
          resolvedAt: new Date(),
          resolutionNote: body.note ? String(body.note).trim() : null,
        },
      });
      // Records the denial — the worker's requested change to the visit does
      // not happen and the request is closed out.
      await writeAudit(tx, AUDIT.CHANGE_REQUEST.DENIED, uid, {
        changeRequestId: id,
        occurrenceId: cr.occurrenceId,
        kind: cr.kind,
        statusBefore: "PENDING",
        statusAfter: "DENIED",
        requestedById: cr.requestedById,
        resolutionNote: body.note ? String(body.note).trim() : null,
      });
      return updated;
    });
  });
  app.get("/change-requests/pending-count", req_scheduleView, async (req: any) => {
    // Must agree with GET /change-requests, which IS territorially filtered.
    // A badge that counts rows the list will not show sends people looking
    // for work that is not theirs, and reads as a bug in the list.
    const count = await prisma.occurrenceChangeRequest.count({
      where: withArea<Prisma.OccurrenceChangeRequestWhereInput>(
        { status: "PENDING" },
        areaWhereVia(req.principal, "schedule.view", "occurrence"),
      ),
    });
    return { count };
  });
  // Count of completed-but-unapproved-hours occurrences. Drives the
  // title-bar alert badge. Scoped to STANDARD + ONE_OFF workflows since
  // those are the only ones whose hours flow to payroll (estimates,
  // tasks, reminders, etc. auto-approve on completion regardless of
  // variance — see evaluateHoursApproval).
  app.get("/occurrences/unapproved-hours-count", req_timeApprove, async (req: any) => {
    // Same filter as GET /occurrences/unapproved-hours, for the same reason:
    // the badge and the queue it opens have to be the same number.
    const count = await prisma.jobOccurrence.count({
      where: withArea<Prisma.JobOccurrenceWhereInput>({
        completedAt: { not: null },
        hoursApprovedAt: null,
        workflow: { in: [OccurrenceWorkflow.STANDARD, OccurrenceWorkflow.ONE_OFF] },
      }, areaWhere(req.principal, "time.approve")),
    });
    return { count };
  });
  // Listing companion to the count endpoint above — same predicate,
  // returns the rows the Tasks page's inline UnapprovedHoursSection
  // needs to show variance vs. estimate and the Approve button. Kept
  // separate from /occurrences (which is the broad occurrence
  // listing) because the variance display wants worker labels +
  // start/pause math without pulling the heavier per-occurrence
  // include set the JobsTab uses.
  app.get("/occurrences/unapproved-hours", req_timeApprove, async (req: any) => {
    const rows = await prisma.jobOccurrence.findMany({
      // Approving hours is territorial: a district lead reviews their own
      // district's visits, not the whole company's.
      // The explicit type argument matters: as a bare object literal this
      // was contextually typed by `where`, and passing it through a generic
      // helper loses that — `workflow: { in: [...] }` then widens to
      // string[] and stops being checked against the enum.
      where: withArea<Prisma.JobOccurrenceWhereInput>({
        completedAt: { not: null },
        hoursApprovedAt: null,
        workflow: { in: [OccurrenceWorkflow.STANDARD, OccurrenceWorkflow.ONE_OFF] },
      }, areaWhere(req.principal, "time.approve")),
      orderBy: { completedAt: "asc" },
      select: {
        id: true,
        title: true,
        startedAt: true,
        completedAt: true,
        totalPausedMs: true,
        estimatedMinutes: true,
        job: {
          select: {
            id: true,
            property: {
              select: {
                displayName: true,
                client: { select: { displayName: true } },
              },
            },
          },
        },
        assignees: {
          where: { OR: [{ role: null }, { role: { not: "observer" } }] },
          select: {
            userId: true,
            user: { select: { displayName: true, email: true, workerType: true } },
          },
        },
      },
    });
    return rows;
  });
  // Approve payroll hours on a single occurrence. Idempotent — calling
  // when already approved is a no-op. Optional `note` is stored on the
  // audit trail; the occurrence row only carries the timestamp + approver.
  app.post("/occurrences/:id/approve-hours", req_timeApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const note = req.body?.note ? String(req.body.note).trim() : null;
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id },
      select: { id: true, hoursApprovedAt: true, completedAt: true },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found.");
    if (!occ.completedAt) {
      throw app.httpErrors.badRequest("Cannot approve hours on an incomplete occurrence.");
    }
    if (occ.hoursApprovedAt) {
      return { id: occ.id, hoursApprovedAt: occ.hoursApprovedAt };
    }
    const now = new Date();
    const updated = await prisma.jobOccurrence.update({
      where: { id },
      data: { hoursApprovedAt: now, hoursApprovedById: uid },
      select: { id: true, hoursApprovedAt: true, hoursApprovedById: true },
    });
    await writeAudit(prisma, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
      occurrenceId: id,
      hoursApproved: true,
      note,
    });
    return updated;
  });
  // Attach a group to an occurrence (admin pre-assignment). Rejects if the
  // occurrence already has individual assignees — admin must remove them first.
  app.post("/occurrences/:id/attach-group", req_scheduleManage, async (req: any) => {
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const groupId = String(body.groupId ?? "");
    if (!groupId) throw app.httpErrors.badRequest("groupId is required");

    const actorUserId = await currentUserId(req);
    return prisma.$transaction(async (tx) => {
      const existing = await tx.jobOccurrenceAssignee.count({ where: { occurrenceId } });
      if (existing > 0) {
        throw app.httpErrors.conflict("Detach existing assignees before attaching a group.");
      }
      await services.groups.attachGroupToOccurrence(tx, {
        occurrenceId,
        groupId,
        actorUserId,
        mode: "admin-assign",
      });
      return { attached: true };
    });
  });
  app.post("/occurrences/:id/detach-group", req_scheduleManage, async (req: any) => {
    const occurrenceId = String(req.params.id);
    // Resolve the actor OUTSIDE the transaction — detach deletes every
    // assignee row on the occurrence, and the audit needs to name who did
    // it. Mirrors the attach handler above.
    const actorUserId = await currentUserId(req);
    return prisma.$transaction(async (tx) => {
      await services.groups.detachGroupFromOccurrence(tx, actorUserId, occurrenceId);
      return { detached: true };
    });
  });
  // Occurrence-level skip — used from Outstanding Requests where no
  // Payment row exists yet (a request was sent, customer hasn't paid).
  // Materializes a $0/CASH Payment then skips it. Same Super + type-
  // APPROVE gate.
  app.post("/occurrences/:occurrenceId/skip", req_scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    return services.payments.skipOccurrence(uid, String(req.params.occurrenceId), reason);
  });
  // Occurrence-level write-off — used from Outstanding Requests when
  // the client has ghosted (payment request sent, never paid, never
  // going to pay). Materializes a $0/CASH Payment then writes it off,
  // which triggers employee top-up + contractor $0 + occurrence CLOSED
  // + next-occurrence generation + bad-debt visible on P&L. Same Super
  // + type-APPROVE gate as skipOccurrence.
  app.post("/occurrences/:occurrenceId/write-off", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    return services.payments.writeOffOccurrence(uid, String(req.params.occurrenceId), reason);
  });
  // Resend payment request for an occurrence already in PENDING_PAYMENT.
  // Reuses the existing token by default; passing `regenerate=true` rotates
  // it (use when a previous link was shared publicly or otherwise blown).
  app.post("/occurrences/:id/resend-payment-request", req_moneyRecord, async (req: any) => {
    const uid = await currentUserId(req);
    await services.paymentRequests.assertRequestPaymentAllowed(callerCanFn(req));
    const regenerate = !!req.body?.regenerate;
    return services.paymentRequests.sendForOccurrence(uid, String(req.params.id), { regenerateToken: regenerate });
  });
  app.get("/board", req_scheduleView, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Viewing as another worker requires schedule authority.");
    }
    return services.board.getBoard(areaWhere(req.principal, "schedule.view"));
  });
  app.get("/occurrences", req_scheduleView, async (req: any) => {
    const { from, to, includeOccId, viewAsUserId, selfScoped } = (req.query || {}) as { from?: string; to?: string; includeOccId?: string; viewAsUserId?: string; selfScoped?: string };
    // `?selfScoped=1` asks for the list as the caller's OWN work, so peek
    // redaction runs even for a caller who could otherwise bypass it.
    // Omitting it keeps the unredacted view — but only for someone who
    // holds `schedule.manage`, because the bypass below is ANDed with that
    // capability. The flag can only ever make the response stricter, which
    // is why it is safe for the client to choose it.
    const isSelfScopedRequest = selfScoped === "1";
    // Business Start Date cutoff is operator-only — applies to the worker /
    // admin JobsTab. Client-facing /client/jobs deliberately does not pass
    // this through (a client should always see their own service history
    // regardless of the operator's internal accounting cutoff).
    const cutoff = await resolveCutoff(req);
    const occs = await services.jobs.listAllOccurrences({ from, to, cutoff, areaWhere: areaWhere(req.principal, "schedule.view") });

    // Merge pinned occurrences that fall outside the date range (not reminders — those get ghost cards)
    const callerUid = await currentUserId(req);
    // View-as override: when a `schedule.manage` holder asks for the list
    // filtered to one person (the Home view-as picker hands JobsTab a
    // `viewAsUserId`), load THAT person's pins / likes / reminders /
    // observerships rather than the caller's. Otherwise the reminder ghosts
    // and attached-reminder badges belong to the caller and miss what the
    // person being viewed actually sees.
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({ where: { id: callerUid },  });
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Viewing another worker's occurrences requires schedule authority.");
      uid = viewAsUserId;
    }
    // Determine whether the effective user (after viewAsUserId override)
    // has management privileges. Drives whether Timeline events
    // (workflow=EVENT) are included in the returned feed. Non-holders of `schedule.manage`
    // never see events in their Jobs feed regardless of assignment.
    // Someone with `schedule.manage` viewing-as a non-admin gets the non-admin's feed.
    // Whose experience is being rendered? When viewing-as, it is the
    // TARGET's — someone with `schedule.manage` looking at a worker's dashboard must see the
    // worker's, including no event count. So the caller's own principal is
    // the wrong source here, and this is the one case where resolving
    // another user's capabilities is correct.
    const effectiveCanManageSchedule =
      uid === callerUid
        ? callerCan(req, "schedule.manage")
        : await userCan(prisma, uid, "schedule.manage");
    // Look up the effective user's worker classification — drives the
    // Trainee feed scope + payment-split redaction below. Trainees may
    // ONLY see occurrences they're assigned to (server-side scoping;
    // the frontend already filters, but a malicious trainee inspecting
    // network responses could see jobs they're not on without this
    // server-side guard).
    // Field clearance is `work.claim`, resolved from the person's roles.
    // It was guessed from a pay class first, then from a boolean column;
    // both of those are gone.
    //
    // NOT `inventory.pull`, which is what this read. The starter Field
    // Clearance role grants claim, complete and pull together, so the two
    // travelled as one and the wrong read never showed. Adding a grantable
    // "May pull inventory" role broke that coupling on purpose — it exists
    // for the office person who fetches supplies and never runs a visit.
    // Reading `inventory.pull` here treated that person as field-cleared and
    // handed them the uncleared-redaction BYPASS, i.e. other workers' splits,
    // promised payouts and processor fees. Third copy of this mistake; the
    // canonical answer is `isFieldCleared()` in apps/web/src/lib/scope.ts.
    //
    // Fails closed — an unresolvable user is uncleared.
    //
    // SAME TERNARY AS `effectiveCanManageSchedule` ABOVE, AND FOR THE SAME REASON.
    // This read used to be an unconditional `userCan(prisma, uid, …)`, which
    // is correct for the view-as case and WRONG for the ordinary one: with no
    // `?viewAsUserId`, `uid === callerUid`, so it fetched the caller's REAL
    // grant and ignored any active perspective. Someone working inside a
    // narrowed perspective still got the full team feed and every other worker's
    // payment splits, promised payouts and processor fees — the perspective showed
    // more than it claimed to. Resolve the CALLER from their principal; only
    // resolve somebody ELSE from the database.
    //
    // TWO WAYS TO SEE THE WHOLE BOARD, and they are different people.
    // `work.claim` is "you do this work, so you see the visits you are on
    // and the rest of the day around them". `schedule.view-all` is "you
    // watch the operation without working it" — a bookkeeper, an owner's
    // partner, anyone read-only. Before it existed, NOT being field-cleared
    // was taken to mean junior, so every oversight role was handed a feed
    // containing only its own assignments, which for somebody who works no
    // visits is an empty page. Resolved through the same caller/other
    // split as everything else here, so a narrowed perspective narrows it.
    const effectiveHolds = async (
      e: Parameters<typeof callerCan>[1],
    ): Promise<boolean> =>
      uid === callerUid ? callerCan(req, e) : await userCan(prisma, uid, e);
    // KEPT APART ON PURPOSE. Field clearance answers "whose pay may you
    // see" — the redaction below strips other workers' splits, promised
    // payouts and processor fees from anyone who is not cleared.
    // `schedule.view-all` answers a different question, "which visits
    // exist for you", and says nothing about money. Folding the two into
    // one flag would have handed every oversight reader the whole team's
    // pay as a side effect of being allowed to see the calendar.
    const effectiveFieldCleared = await effectiveHolds("work.claim");
    const effectiveSeesEveryVisit = await effectiveHolds("schedule.view-all");
    const effectiveNotCleared = !(effectiveFieldCleared || effectiveSeesEveryVisit);
    const [pins, likes, reminders, observedAssignments] = await Promise.all([
      prisma.pinnedOccurrence.findMany({ where: { userId: uid }, select: { occurrenceId: true } }),
      prisma.likedOccurrence.findMany({ where: { userId: uid }, select: { occurrenceId: true } }),
      prisma.reminder.findMany({ where: { userId: uid, dismissedAt: null }, select: { occurrenceId: true, remindAt: true, note: true } }),
      prisma.jobOccurrenceAssignee.findMany({ where: { userId: uid, role: "observer" }, select: { occurrenceId: true } }),
    ]);

    const loadedIds = new Set(occs.map((o: any) => o.id));

    // Merge pinned + liked + observed occurrences that fall outside the date range
    const extraIds = new Set<string>();
    for (const p of pins) if (!loadedIds.has(p.occurrenceId)) extraIds.add(p.occurrenceId);
    for (const l of likes) if (!loadedIds.has(l.occurrenceId)) extraIds.add(l.occurrenceId);
    for (const o of observedAssignments) if (!loadedIds.has(o.occurrenceId)) extraIds.add(o.occurrenceId);
    // Include a specific occurrence by ID (for deep links / share links)
    if (includeOccId && !loadedIds.has(includeOccId)) extraIds.add(includeOccId);

    if (extraIds.size > 0) {
      const extraOccs = await services.jobs.getOccurrencesByIds([...extraIds], cutoff);
      occs.push(...(extraOccs as any[]));
      for (const eo of extraOccs) loadedIds.add((eo as any).id);
    }

    // Attach reminder data to occurrences already in the list
    const reminderMap = new Map(reminders.map((r) => [r.occurrenceId, { remindAt: r.remindAt, note: r.note }]));
    for (const occ of occs) {
      const rem = reminderMap.get((occ as any).id);
      if (rem) (occ as any).reminder = rem;
    }

    // Build reminder ghosts: reminders whose occurrence is NOT in the loaded list
    // These will appear as ghost cards on the reminder's date
    const ghostReminderIds = reminders
      .map((r) => r.occurrenceId)
      .filter((id) => !loadedIds.has(id));

    let reminderGhosts: any[] = [];
    if (ghostReminderIds.length > 0) {
      const ghostOccs = await services.jobs.getOccurrencesByIds(ghostReminderIds, cutoff);
      reminderGhosts = ghostOccs.map((go: any) => {
        const rem = reminderMap.get(go.id);
        return { ...go, reminder: rem, _isReminderGhost: true, _ghostDate: rem?.remindAt };
      });
    }

    // Add ghost reminders to the list
    const allOccs = [...occs, ...reminderGhosts];

    // Generate download URLs for preview photos
    for (const occ of allOccs) {
      if ((occ as any).photos?.length) {
        (occ as any).photos = await Promise.all(
          (occ as any).photos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
      // Generate download URLs for property photo instructions
      if ((occ as any).propertyPhotos?.length) {
        for (const pp of (occ as any).propertyPhotos) {
          if (pp.propertyPhoto?.r2Key) {
            pp.propertyPhoto.url = await getDownloadUrl(pp.propertyPhoto.r2Key, 86400, "property-photos");
          }
        }
      }
      // Strip internal-only fields from client data
      const client = (occ as any).job?.property?.client;
      if (client) delete client.internalTags;
    }
    // Final gate: Timeline events (workflow=EVENT) are a `timeline.view`
    // concept. Non-admin effective users never see them in the feed,
    // even if they were previously assigned/pinned/observed. The
    // dashboard-summary endpoint applies the same rule to the Notices
    // count; both must stay in sync.
    const eventFiltered = effectiveCanManageSchedule
      ? allOccs
      : allOccs.filter((o: any) => o.workflow !== "EVENT");

    // Trainee scope clamp: trainees see ONLY occurrences they're
    // assigned to (no unassigned/claimable, no team-feed visibility).
    // The frontend already enforces this; the server-side filter
    // protects against DevTools/network inspection.
    const filtered = effectiveNotCleared
      ? eventFiltered.filter((o: any) => (o.assignees ?? []).some((a: any) => a.userId === uid))
      : eventFiltered;

    // Observer redaction: for occurrences where the effective user is
    // assigned as `role = "observer"`, strip payment/expense/price
    // fields. Observers see the basic job (where, when, who) so they
    // know where to show up, but never the financial detail. Holders of `schedule.manage`
    // viewing as themselves see everything; somebody viewing-as a
    // non-admin observer (via viewAsUserId) gets the same redaction
    // their target would see.
    redactObserverFieldsForCaller(filtered as any[], uid, effectiveCanManageSchedule);
    // Trainee redaction: for non-observer Trainee callers, strip OTHER
    // workers' payment splits / completion splits / promised payouts
    // (the trainee sees only their own), plus processor fees and
    // expense costs (business-internal financial data). Order matters
    // — observer redaction is heavier and runs first; trainee
    // redaction skips occurrences already observer-redacted.
    // TWO REASONS TO SEE A SPLIT, AND THEY ARE INDEPENDENT: you are on the
    // crew (`work.claim`), or the money is your job (`money.view`). Keyed
    // on clearance alone, the person whose entire role is the money was
    // the one person redacted — while every field worker saw it. NOT
    // `schedule.view-all`: seeing which visits exist says nothing about
    // whether you may see what people earn.
    const effectiveMaySeeCrewPay =
      effectiveFieldCleared || (await effectiveHolds("money.view"));
    redactUnclearedFieldsForCaller(
      filtered as any[],
      uid,
      effectiveMaySeeCrewPay,
      effectiveCanManageSchedule,
    );
    // Peek redaction: for the Worker Jobs "Team" toggle. Any occ that
    // has assignees but the caller isn't one of them gets financials
    // stripped (price, splits, payouts, expense costs, internal client
    // context). Holders of `schedule.manage` are bypassed by default,
    // because the management view needs full financials. When the request
    // asks for the self-scoped view (`?selfScoped=1`) the bypass is
    // disabled, so they see the same redacted teammate data anyone without
    // the capability would.
    const peekBypass = effectiveCanManageSchedule && !isSelfScopedRequest;
    redactPeekFieldsForCaller(filtered as any[], uid, peekBypass);

    // Ghost cards for repeating jobs whose next occurrence hasn't been
    // scheduled yet (usually because the prior occurrence hasn't been
    // paid). Self-scoped view narrows to jobs the caller was assigned to on
    // the blocking occurrence; management view returns all. Ghosts skip the
    // redaction pipeline above — they're synthesized cards with no
    // payment splits / observer status / financials to redact.
    const ghostAssigneeUserId =
      isSelfScopedRequest || viewAsUserId ? uid : null;
    try {
      const ghosts = await services.jobs.listNextOccurrenceGhosts({
        areaWhere: areaWhereOn(req.principal, "schedule.view", "defaultArea"),
        from, to, cutoff,
        assigneeUserId: ghostAssigneeUserId,
      });
      return [...filtered, ...ghosts];
    } catch (err: any) {
      // Ghost load failing should never break the main jobs list — log
      // and continue with just the real occurrences.
      req.log.warn({ where: "occurrences.ghosts", err: err?.message }, "ghost list failed");
      return filtered;
    }
  });
  app.get("/occurrences/:id/hourly-weather", req_scheduleView, async (req: any) => {
    // area-scope-allow: weather for a point in time and space — it reveals
    //   nothing about the visit, and the forecast is the same whoever asks
    return hourlyForecastForOccurrence(String(req.params.id), {
      refresh: String((req.query as any)?.refresh ?? "") === "1",
    });
  });
  app.get("/occurrences/ghost-expiry-counts", req_scheduleView, async (req: any) => {
    const callerUid = await currentUserId(req);
    const q = (req.query || {}) as Record<string, string>;
    const viewAsUserId = q.viewAsUserId || null;
    const isSelfScopedRequest = String(q.selfScoped ?? "") === "1";
    const cutoff = await resolveCutoff(req);
    // Admin override — the SAME one /occurrences applies, and it has to be
    // the same or the two disagree: this endpoint would count the manager’s
    // own assignments while the feed beside it shows the viewed worker's.
    // That's exactly how the chip went missing when someone with `schedule.manage` picked a
    // worker in "View as" — the ghost was in the feed, the count said 0.
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Viewing another worker's occurrences requires schedule authority.");
      uid = viewAsUserId;
    }
    try {
      return await services.jobs.countGhostExpiry({
        areaWhere: areaWhereOn(req.principal, "schedule.view", "defaultArea"),
        assigneeUserId: isSelfScopedRequest || viewAsUserId ? uid : null,
        cutoff,
      });
    } catch (err: any) {
      req.log.warn({ where: "occurrences.ghostExpiryCounts", err: err?.message }, "count failed");
      return { expiringSoon: 0, expired: 0 };
    }
  });
  app.get("/occurrences/mine", req_scheduleView, async (req: any) => {
    // area-scope-allow: already scoped to the caller's own assignments —
    //   area would narrow "my jobs" to "my jobs in my district", and a
    //   worker covering another district would lose sight of work they are
    //   on
    const uid = await currentUserId(req);
    // A `timeline.view` holder sees Timeline events (workflow=EVENT) in
    // their own assigned list; nobody else does. Mirrors the same gate
    // applied by /occurrences and dashboard-summary.
    const caller = await prisma.user.findUnique({
      where: { id: uid },
      
    });
    const canManageSchedule = callerCan(req, "schedule.manage");
    const occs = await services.jobs.listMyOccurrences(uid, { canManageSchedule });
    // Per-occurrence observer redaction — same gate as /occurrences.
    redactObserverFieldsForCaller(occs as any[], uid, canManageSchedule);
    // Per-occurrence trainee redaction — strip other workers' splits,
    // completion percentages, promised payouts, processor fees, and
    // expense costs. Keeps the caller's own split visible.
    // `inventory.pull` IS NOT FIELD CLEARANCE, and reading it here was the
    // FOURTH copy of that mistake — the sibling call in `GET /occurrences`
    // carries a comment naming the first three. The starter Field Clearance
    // role grants claim, complete and pull together, so the wrong read
    // never showed; the grantable "May pull inventory" role exists for the
    // office person who fetches supplies and runs no visits, and this
    // handed exactly that person the redaction bypass — other workers'
    // splits, promised payouts, processor fees and expense costs.
    //
    // Same rule as the sibling: on the crew (`work.claim`) or the money is
    // your job (`money.view`).
    redactUnclearedFieldsForCaller(
      occs as any[],
      uid,
      callerCan(req, "work.claim") || callerCan(req, "money.view"),
      canManageSchedule,
    );
    return occs;
  });
  app.get("/occurrences/available", req_scheduleView, async (req: any) => {
    return services.jobs.listAvailableOccurrences(areaWhere(req.principal, "schedule.view"));
  });
  app.post("/occurrences/:id/claim", req_workClaim, async (req: any) => {
    const uid = await currentUserId(req);
    const body = (req.body || {}) as { groupId?: string | null };
    return services.jobs.claimOccurrence(uid, callerCanFn(req), String(req.params.id), {
      groupId: body.groupId ?? null,
    });
  });
  // Pre-flight check for the team-workday gate. Returns the list of
  // non-observer assignees on this occurrence (excluding the caller)
  // who don't currently have an active workday. The Start flow calls
  // this BEFORE opening the time-of-day picker so it can surface the
  // team-not-ready dialog up front — the user shouldn't have to type
  // a start time only to be rejected after submitting.
  //
  // "Active" matches the gate definition in services/jobs.ts: today's
  // WorkerWorkday exists, endedAt IS NULL, and pausedAt IS NULL.
  // Mirrors the server-side gate so the client + server agree on
  // who counts as ready.
  app.get("/occurrences/:id/team-workday-check", req_scheduleView, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never area-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const assignees = await prisma.jobOccurrenceAssignee.findMany({
      where: {
        occurrenceId,
        // NULL-role rows are canonical "regular worker"; observers
        // are excluded since they don't do the work.
        OR: [{ role: null }, { role: { not: "observer" } }],
      },
      select: {
        userId: true,
        user: { select: { displayName: true, email: true } },
      },
    });
    // Exclude the caller themselves — their own workday is gated
    // separately by `assertWorkdayActiveOrPrompt` on the client side
    // and again on /start. This check is specifically for teammates.
    const others = assignees.filter((a) => a.userId !== uid);
    if (others.length === 0) return { notReady: [] };

    const todayKey = etFormatDate(new Date());
    const workdays = await prisma.workerWorkday.findMany({
      where: {
        userId: { in: others.map((a) => a.userId) },
        workdayDate: todayKey,
      },
      select: { userId: true, endedAt: true, pausedAt: true },
    });
    const wdByUser = new Map(workdays.map((w) => [w.userId, w]));

    const notReady = others
      .filter((a) => {
        const wd = wdByUser.get(a.userId);
        // Not ready = no row OR ended OR paused.
        return !wd || wd.endedAt != null || wd.pausedAt != null;
      })
      .map((a) => ({
        userId: a.userId,
        name: a.user?.displayName ?? a.user?.email ?? "(unnamed)",
      }));

    return { notReady };
  });
  // Property GPS hint — returns the most-recent known on-site GPS at the
  // occurrence's property. Used by the "start with location?" dialog to
  // decide whether the worker is currently near the job site (default to
  // "record with location") or far from it (default to "record without").
  // Falls back through startLat/completeLat across prior occurrences at
  // the same property; returns null when the property has no history yet
  // (new property) or the occurrence isn't tied to a property (light
  // estimates with only an address string).
  app.get("/occurrences/:id/site-hint", req_scheduleView, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never area-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const occurrenceId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { job: { select: { propertyId: true } } },
    });
    const propertyId = occ?.job?.propertyId ?? null;
    if (!propertyId) return { lat: null, lng: null };

    // Look at recent completed occurrences for this property and pick the
    // most recent that has any usable coordinate pair. Start coords are
    // strictly preferred (they represent "arrival" at the site) but fall
    // back to complete coords when no start coord was ever captured.
    const priors = await prisma.jobOccurrence.findMany({
      where: {
        job: { propertyId },
        OR: [
          { startLat: { not: null } },
          { completeLat: { not: null } },
        ],
      },
      select: {
        id: true,
        startLat: true,
        startLng: true,
        completeLat: true,
        completeLng: true,
        completedAt: true,
        startedAt: true,
      },
      orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
      take: 5,
    });

    for (const p of priors) {
      if (p.startLat != null && p.startLng != null) {
        return { lat: p.startLat, lng: p.startLng };
      }
      if (p.completeLat != null && p.completeLng != null) {
        return { lat: p.completeLat, lng: p.completeLng };
      }
    }
    return { lat: null, lng: null };
  });
  // in-handler-scoped: `updateOccurrenceStatus` requires the caller to be the
  // CLAIMER (or hold schedule.manage) and checks that before the existence
  // lookup, so work.complete alone is correctly 403.
  app.post("/occurrences/:id/start", req_workComplete, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};

    // Block starting unconfirmed job occurrences (applies to STANDARD, ONE_OFF, ESTIMATE workflows)
    const occCheck = await prisma.jobOccurrence.findUnique({ where: { id: String(req.params.id) } });
    if (occCheck) {
      const needsConfirmation = !occCheck.isClientConfirmed && occCheck.jobId &&
        (occCheck.workflow === "STANDARD" || occCheck.workflow === "ONE_OFF" || occCheck.workflow === "ESTIMATE" || !occCheck.workflow);
      if (needsConfirmation) {
        throw app.httpErrors.badRequest("Client confirmation required before starting this job");
      }
    }

    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;

    // Optionally update startAt to now when starting early
    if (body.updateStartAt) {
      const now = new Date();
      const occ = await prisma.jobOccurrence.findUnique({ where: { id: String(req.params.id) } });
      if (occ) {
        // Preserve the duration: shift endAt by the same delta
        const newStart = now;
        let newEnd: Date | undefined;
        if (occ.startAt && occ.endAt) {
          const duration = occ.endAt.getTime() - occ.startAt.getTime();
          newEnd = new Date(newStart.getTime() + duration);
        }
        await prisma.$transaction(async (tx) => {
          await tx.jobOccurrence.update({
            where: { id: occ.id },
            data: { startAt: newStart, ...(newEnd ? { endAt: newEnd } : {}) },
          });
          // Records the early-start shift of the scheduled window (startAt/endAt moved).
          await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
            occurrenceId: occ.id,
            jobId: occ.jobId ?? null,
            action: "start_time_shifted",
            beforeStartAt: occ.startAt?.toISOString() ?? null,
            afterStartAt: newStart.toISOString(),
            beforeEndAt: occ.endAt?.toISOString() ?? null,
            afterEndAt: newEnd ? newEnd.toISOString() : (occ.endAt?.toISOString() ?? null),
          });
        });
      }
    }

    return services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      String(req.params.id),
      JobOccurrenceStatus.IN_PROGRESS,
      undefined,
      location,
      body.startedAt ? { startedAt: String(body.startedAt) } : undefined
    );
  });
  // NOT `in-handler-scoped`, though it looks like it should be.
  //
  // This route does carry the same claimer rule as /start — it ends in
  // `updateOccurrenceStatus`. But it validates its BODY first, so a request
  // with no body gets a 400 and never reaches the ownership check. I
  // annotated it anyway and the e2e suite rejected the annotation: it asserts
  // an annotated route actually refuses a bare entitlement holder, and this
  // one answers 400. An annotation nothing can observe is an excuse waiting
  // to cover a real widening, so it is gone.
  app.post("/occurrences/:id/complete", req_workComplete, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const notes = body.notes != null ? String(body.notes) : undefined;
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    const timestamps: { startedAt?: string; completedAt?: string; totalPausedMs?: number } = {};
    if (body.completedAt) timestamps.completedAt = String(body.completedAt);
    if (body.startedAt) timestamps.startedAt = String(body.startedAt);
    if (body.totalPausedMs != null) timestamps.totalPausedMs = Math.max(0, Math.round(Number(body.totalPausedMs)));
    // Per-worker percentage allocation. Validation is permissive — the caller
    // owns the math; we just persist what comes in. The downstream
    // approvePayment normalizes to 100% before applying.
    const completionSplits: Array<{ userId: string; percent: number }> | undefined =
      Array.isArray(body.completionSplits)
        ? body.completionSplits
            .map((s: any) => ({ userId: String(s.userId), percent: Number(s.percent) }))
            .filter((s: any) => s.userId && Number.isFinite(s.percent))
        : undefined;

    // Gate: real jobs (not tasks/announcements/etc.) cannot transition into
    // PENDING_PAYMENT unless the client's primary contact is reachable —
    // invoice routing only ever targets the primary, so an unreachable or
    // missing primary blocks the payment request. The gate is silent for
    // non-job workflows since those don't accept payment.
    const occForGate = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        workflow: true,
        job: {
          select: {
            property: {
              select: {
                client: {
                  select: {
                    contacts: {
                      // Pull all primaries regardless of status so we
                      // can differentiate "no primary" vs "primary is
                      // paused/archived" in the error message. Filtering
                      // ACTIVE at the query silently masks paused
                      // primaries and misleads the operator.
                      where: { isPrimary: true },
                      select: {
                        firstName: true, status: true,
                        phone: true, normalizedPhone: true, email: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const isJobWorkflow = !occForGate?.workflow
      || occForGate.workflow === "STANDARD"
      || occForGate.workflow === "ONE_OFF"
      || occForGate.workflow === "ESTIMATE";
    if (isJobWorkflow) {
      const primaries = occForGate?.job?.property?.client?.contacts ?? [];
      const activePrimaries = primaries.filter((c) => c.status === "ACTIVE");
      if (activePrimaries.length === 0) {
        const inactive = primaries[0]; // any primary in a non-ACTIVE state
        if (inactive) {
          throw app.httpErrors.badRequest(
            `Can't complete — the primary contact (${inactive.firstName ?? "unnamed"}) is ${inactive.status.toLowerCase()}. Unpause them or promote a different contact to primary first.`,
          );
        }
        throw app.httpErrors.badRequest(
          "Can't complete — this client has no primary contact set. Open the client's contacts and mark one as Primary first.",
        );
      }
      const reachable = activePrimaries.some((c) => c.phone || c.normalizedPhone || c.email);
      if (!reachable) {
        throw app.httpErrors.badRequest(
          "Can't complete — the primary contact has no phone or email on file. Update their contact info first.",
        );
      }
    }

    const updated = await services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      occurrenceId,
      JobOccurrenceStatus.PENDING_PAYMENT,
      notes,
      location,
      Object.keys(timestamps).length ? timestamps : undefined,
      completionSplits ? { completionSplits } : undefined,
    );

    // Resolve effective comms mode for this occurrence.
    //   - Look up the claimer (first non-observer assignee, or null).
    //   - Their per-profile override wins; otherwise the org-wide setting.
    //   - When SERVER: best-effort Twilio/Resend send in the background.
    //   - When CLAIMER: mint the token synchronously so the JobsTab card can
    //     immediately render the Text/Email icons. No outbound send — the
    //     claimer dispatches from their own device.
    if (isJobWorkflow) {
      const claimerAssignee = await prisma.jobOccurrenceAssignee.findFirst({
        // SQL NULL-safety on role (see services/equipment.ts comment).
        where: { occurrenceId, OR: [{ role: null }, { role: { not: "observer" } }] },
        orderBy: { assignedAt: "asc" },
        select: { userId: true },
      });
      const claimerUserId = claimerAssignee?.userId ?? null;
      const mode = await services.paymentRequests.resolveCommsMode(claimerUserId);

      // The kill switch SKIPS the automatic request here — it never refuses
      // the completion. A visit must stay finishable with the switch off;
      // the operator just collects some other way.
      const mayRequest = await services.paymentRequests.requestPaymentAllowed(callerCanFn(req));

      if (!mayRequest) {
        // nothing to do — no token minted, no outbound message
      } else if (mode === "SERVER") {
        services.paymentRequests
          .sendForOccurrence(uid, occurrenceId)
          .catch((err) => {
            console.warn(`Payment request send failed for ${occurrenceId}:`, err?.message);
          });
      } else {
        try {
          await services.paymentRequests.generateTokenForOccurrence(occurrenceId, undefined, uid);
        } catch (err: any) {
          console.warn(`Payment token generation failed for ${occurrenceId}:`, err?.message);
        }
      }
    }

    return updated;
  });
  // Comms-handoff: returns the prepared payment-request payload the JobsTab
  // uses to render Text/Email shortcut icons in CLAIMER mode. Mints the token
  // on-demand if it doesn't exist yet (defensive — should already be there
  // from /complete).
  //
  // "Auth: any worker — the JobsTab decides visibility based on assignment /
  // role" is what this used to say, and it was the bug: the client decided.
  // The handler scopes it now; see the block comment inside.
  // in-handler-scoped: you must be ON this visit, or hold money.record /
  // schedule.manage — see the block comment inside the handler.
  app.get("/occurrences/:id/comms-handoff", req_scheduleView, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery — same reasoning as
    // `/clients/:id`. Lists narrow territorially; reaching one record you
    // already hold the id for does not, and the handler applies its own
    // on-this-visit-or-money-authority check below.
    const occurrenceId = String(req.params.id);
    // Minting the token IS requesting payment — the claimer's device sends
    // the link this returns. Gated like the server-send paths.
    await services.paymentRequests.assertRequestPaymentAllowed(callerCanFn(req));

    // ON THIS VISIT, OR WITH THE AUTHORITY TO HANDLE ANY VISIT'S MONEY.
    //
    // This is a GET with two side effects that make it nothing like a read:
    // it returns the client's phone and email, and it MINTS A PAYMENT TOKEN
    // that resolves `/public/pay/:token` — an unauthenticated page. Its own
    // comment used to say "Auth: any worker — the JobsTab decides visibility
    // based on assignment / role", i.e. the client decided. On
    // `schedule.view`, held by the baseline Trainee role and inherited by
    // every role, any worker could mint a payable link for any visit in the
    // company and read that client's contact details.
    //
    // Its POST twin is `approvedUser` and records who handed off, so the
    // write was already the stricter of the two. Scope the read the same way:
    // you are on this visit, or you are someone who handles payments.
    const callerId = await currentUserId(req);
    const callerOnVisit = await prisma.jobOccurrenceAssignee.findFirst({
      where: { occurrenceId, userId: callerId },
      select: { userId: true },
    });
    if (
      !callerOnVisit &&
      !callerCan(req, "money.record") &&
      !callerCan(req, "schedule.manage")
    ) {
      throw app.httpErrors.forbidden(
        "You can only prepare a payment handoff for a visit you are on.",
      );
    }

    const claimerAssignee = await prisma.jobOccurrenceAssignee.findFirst({
      // NULL-role rows are the canonical "regular worker." `NOT:
      // { role: 'observer' }` would silently exclude them via SQL
      // three-valued logic — use the OR pattern.
      where: {
        occurrenceId,
        OR: [{ role: null }, { role: { not: "observer" } }],
      },
      orderBy: { assignedAt: "asc" },
      select: { userId: true },
    });
    const mode = await services.paymentRequests.resolveCommsMode(claimerAssignee?.userId ?? null);
    // CLAIMER path: worker's device is about to open sms:/mailto: with the
    // returned body. Persist promo piggyback deliveries NOW as
    // claimer_pending so the wrapper URL embedded in that body resolves
    // to a real DB row on click. recordClaimerHandoff (POST below) flips
    // them to delivered when the worker acknowledges the handoff.
    // SERVER path doesn't need this flag — sendForOccurrence re-runs
    // piggyback selection per-contact during fanout.
    const prepared = await services.paymentRequests.generateTokenForOccurrence(occurrenceId, {
      writePendingPromoDeliveries: mode === "CLAIMER",
    }, await currentUserId(req));
    // Strip down the contacts to what the icons actually need. The service
    // layer already filtered to the primary contact only — anything that
    // shows up here is the primary.
    const handoffContacts = prepared.contacts.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      phone: c.normalizedPhone ?? c.phone ?? null,
      email: c.email ?? null,
    }));
    // Explicit data-invariant flag so the frontend can render a clear
    // "no primary contact set" error rather than silently showing
    // disabled icons.
    const missingPrimaryContact = handoffContacts.length === 0;
    return {
      mode,
      token: prepared.token,
      url: prepared.url,
      amountDue: prepared.amountDue,
      propertyLabel: prepared.propertyLabel,
      smsBody: prepared.smsBody,
      emailSubject: prepared.emailSubject,
      emailBody: prepared.emailBody,
      contacts: handoffContacts,
      missingPrimaryContact,
    };
  });
  // Record that the claimer tapped the SMS or Email shortcut. We can't
  // observe whether the device actually sent the message — this captures
  // intent for the audit log.
  app.post("/occurrences/:id/comms-handoff", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = (req.body || {}) as { channel?: string; completionSplits?: Array<{ userId: string; percent: number }> };
    const channel = body.channel;
    if (channel !== "sms" && channel !== "email") {
      throw app.httpErrors.badRequest('channel must be "sms" or "email"');
    }
    const splits = Array.isArray(body.completionSplits) ? body.completionSplits : undefined;
    await services.paymentRequests.recordClaimerHandoff(uid, occurrenceId, channel, splits);
    return { ok: true };
  });
  // Worker-callable server-send for a payment request. Used by the email
  // path of PaymentCommsButtons in CLAIMER mode: opening a mailto: link
  // routes through iOS Mail, which composes with inline `color:` styles
  // that Gmail's dark-mode logic can flip to white-on-white on the
  // recipient side. Server-sending via Resend emits proper plain text
  // that no mail client can misrender.
  //
  // SMS still fires the device sms: intent (unchanged) — Messages doesn't
  // have the HTML-composition problem.
  //
  // Reuses the same sendForOccurrence path holders of `schedule.manage` hit via
  // /occurrences/:id/resend-payment-request. Any assigned worker
  // can call this; the underlying service also stamps the request-sent
  // audit + rotates counters exactly as the `schedule.manage` resend does.
  app.post("/occurrences/:id/send-payment-request-email", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    await services.paymentRequests.assertRequestPaymentAllowed(callerCanFn(req));
    const occurrenceId = String(req.params.id);
    return services.paymentRequests.sendForOccurrence(uid, occurrenceId);
  });
  // Persist per-worker percent splits onto the occurrence + re-snapshot
  // promisedPayouts. Used by Take Payment in SERVER mode (where the comms
  // already fired automatically at completion, so we just need to save the
  // splits the claimer set in the dialog). Guarded server-side: rejects
  // when the occurrence isn't PENDING_PAYMENT or a confirmed Payment
  // already exists.
  app.post("/occurrences/:id/completion-splits", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = (req.body || {}) as { completionSplits?: Array<{ userId: string; percent: number }> };
    const splits = Array.isArray(body.completionSplits) ? body.completionSplits : [];
    // Auth: the claimer, or `schedule.manage`
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!canManageSchedule) {
      const assignee = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid },
      });
      if (!assignee) throw app.httpErrors.forbidden("You are not assigned to this job.");
      const isClaimer = assignee.assignedById === uid && assignee.role !== "observer";
      if (!isClaimer) throw app.httpErrors.forbidden("Only the claimer can set splits.");
    }
    await prisma.$transaction(async (tx: any) => {
      await persistCompletionSplits(tx, occurrenceId, splits, uid);
    });
    return { ok: true };
  });
  // Cancel an in-flight payment request. Regenerates the token (so the
  // client's old SMS/email link starts returning "Payment link not
  // valid") and clears paymentRequestSentAt so the worker can pick a
  // different path. Refuses if a Payment row already exists.
  app.post("/occurrences/:id/cancel-payment-request", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    // Gate mirrors /accept-payment (~1880). Only the claimer (or an
    // admin) can cancel an in-flight payment request, and Trainees are
    // explicitly blocked even if they somehow ended up as the claimer.
    // Without this check, any worker on the team could invalidate the
    // client's payment link out from under the claimer.
    const actUser = await prisma.user.findUniqueOrThrow({
      where: { id: uid },
      
    });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!canManageSchedule) {
      const assignee = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid },
      });
      if (!assignee) throw app.httpErrors.forbidden("You are not assigned to this job.");
      const isClaimer = assignee.assignedById === uid && assignee.role !== "observer";
      if (!isClaimer) {
        throw app.httpErrors.forbidden("Only the claimer can cancel payment requests.");
      }
      if (!callerCan(req, "inventory.pull")) {
        throw app.httpErrors.forbidden(
          "You are not cleared to cancel payment requests.",
        );
      }
    }
    try {
      await services.paymentRequests.cancelPaymentRequest(uid, occurrenceId);
    } catch (err: any) {
      if (err?.code === "PAYMENT_EXISTS") {
        throw app.httpErrors.conflict(err.message);
      }
      throw err;
    }
    return { ok: true };
  });
  // Pause job
  // in-handler-scoped: `updateOccurrenceStatus` requires the caller to be the
  // CLAIMER of this visit (or hold schedule.manage), and it checks that before
  // it checks the visit exists — so holding work.claim alone is correctly 403.
  app.post("/occurrences/:id/pause", req_workClaim, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    return services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      String(req.params.id),
      JobOccurrenceStatus.PAUSED,
      undefined,
      location
    );
  });
  // Resume job
  // in-handler-scoped: same claimer check as /pause — work.claim is the floor,
  // being the claimer is the actual rule.
  app.post("/occurrences/:id/resume", req_workClaim, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    return services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      String(req.params.id),
      JobOccurrenceStatus.IN_PROGRESS,
      undefined,
      location
    );
  });
  app.patch("/occurrences/:id/next-visit-warning", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const body = req.body || {};

    // Roles come from `req.user`, NOT a fresh DB read — a lookup here would
    // hand someone with `routes.plan` using "view as Worker" their real powers back.
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!canManageSchedule) {
      throw new ServiceError(
        "FORBIDDEN",
        "Only someone with schedule authority can suppress a next-visit warning.",
        403,
      );
    }

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occId },
      select: {
        id: true,
        jobId: true,
        startAt: true,
        nextVisitWarningSuppressedAt: true,
        nextVisitWarningSuppressedById: true,
      },
    });

    const suppressed = body.suppressed === true;
    const wasSuppressed = !!occ.nextVisitWarningSuppressedAt;

    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({
        where: { id: occId },
        data: {
          nextVisitWarningSuppressedAt: suppressed ? new Date() : null,
          nextVisitWarningSuppressedById: suppressed ? uid : null,
        },
        select: {
          id: true,
          nextVisitWarningSuppressedAt: true,
          nextVisitWarningSuppressedById: true,
        },
      });
      // Suppressing removes a visit from everyone's outstanding work
      // without anything happening to the visit itself. "Who decided we
      // stop chasing this, and when" is the question this row answers.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: occId,
        jobId: occ.jobId ?? null,
        action: suppressed
          ? "next_visit_warning_suppressed"
          : "next_visit_warning_restored",
        wasSuppressed,
        previousSuppressedById: occ.nextVisitWarningSuppressedById ?? null,
        blockingOccurrenceStartAt: occ.startAt ? occ.startAt.toISOString() : null,
      });
      return updated;
    });
  });
  app.patch("/occurrences/:id/customer-notes", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occId },
      select: { id: true, jobId: true, customerVisibleNotes: true, assignees: { select: { userId: true, role: true } } },
    });
    const isClaimer = occ.assignees?.some((a: any) => a.userId === uid && a.role === "CLAIMER");
    // Roles come from `req.user`, NOT a fresh DB read — a lookup here would
    // hand someone with `routes.plan` using "view as Worker" their real powers back.
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) {
      throw new ServiceError("FORBIDDEN", "Only the claimer or someone with schedule authority can edit customer notes.", 403);
    }

    const raw = body.customerVisibleNotes;
    const next = raw == null ? null : String(raw).trim() || null;
    const before = occ.customerVisibleNotes ?? null;

    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({
        where: { id: occId },
        data: { customerVisibleNotes: next },
        select: { id: true, customerVisibleNotes: true },
      });
      // This text reaches the customer, so the audit keeps both sides of the
      // change — "what did we tell them, and who decided that" is the
      // question this row exists to answer.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: occId,
        jobId: occ.jobId ?? null,
        action: "customer_notes_edited",
        byClaimer: !!isClaimer,
        byScheduleManager: !!canManageSchedule,
        customerVisible: true,
        before,
        after: updated.customerVisibleNotes ?? null,
      });
      return updated;
    });
  });
  // Invoice preview, worker-accessible.
  //
  // Workers can already SEND a payment request (see
  // /occurrences/:id/send-payment-request-email), so not being able to read
  // the invoice first was the odd part. This returns the client-facing
  // invoice and its payment state — and NOT `crewPool`, which is what the
  // crew is paid. That stays on the `schedule.manage` route.
  //
  // view-as-allow: the invoice is a property of the OCCURRENCE and is
  // identical for every caller; there is no per-worker state to impersonate.
  app.get("/occurrences/:id/invoice-preview", req_scheduleView, async (req: any) => {
    // area-scope-allow: by-id read, not discovery — see the same note on the
    //   sibling occurrence reads. Kept SHORT on purpose: the job-materials
    //   gate matches `callerCan(req, "money.view")` within a fixed window
    //   after this declaration, and a longer comment pushed it out of range.
    // `money.view` separates the full invoice from the worker's trimmed
    // preview. Both were reachable on `schedule.view` before — the URL was
    // the only thing deciding which you got.
    return callerCan(req, "money.view")
      ? services.paymentRequests.previewInvoice(String(req.params.id))
      : services.paymentRequests.previewInvoiceForWorker(String(req.params.id));
  });
  // Edit time tracking: start/end timestamps and off-the-clock (paused) ms.
  app.patch("/occurrences/:id/time", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const body = req.body || {};

    // Verify claimer or admin
    const occ = await prisma.jobOccurrence.findUniqueOrThrow({ where: { id: occId }, include: { assignees: true } });
    const isClaimer = occ.assignees?.some((a: any) => a.userId === uid && a.role === "CLAIMER");
    const user = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) throw new ServiceError("FORBIDDEN", "Editing time requires being the claimer or holding schedule authority.", 403);

    const data: any = {};
    if ("startedAt" in body) data.startedAt = body.startedAt ? new Date(String(body.startedAt)) : null;
    if ("completedAt" in body) data.completedAt = body.completedAt ? new Date(String(body.completedAt)) : null;
    if ("totalPausedMs" in body) data.totalPausedMs = body.totalPausedMs != null ? Math.max(0, Math.round(Number(body.totalPausedMs))) : 0;

    // Validate that duration stays non-negative when both timestamps present
    const newStart = data.startedAt ?? occ.startedAt;
    const newEnd = data.completedAt ?? occ.completedAt;
    const newPaused = "totalPausedMs" in data ? data.totalPausedMs : (occ.totalPausedMs ?? 0);
    if (newStart && newEnd) {
      const span = new Date(newEnd).getTime() - new Date(newStart).getTime();
      if (span < 0) throw new ServiceError("INVALID_RANGE", "End time cannot be before start time.", 400);
      if (newPaused > span) throw new ServiceError("INVALID_RANGE", "Off-the-clock time cannot exceed total span.", 400);
    }

    // Re-evaluate payroll hours approval against the new time values. If the
    // updated span is within the variance threshold of the estimate, stamp
    // it as approved automatically. Otherwise clear any prior approval so
    // it surfaces in the unapproved-hours queue. Only applies when the
    // occurrence has a completedAt (otherwise approval isn't meaningful yet).
    if (newEnd) {
      const activeAssignees = (occ.assignees ?? []).filter((a: any) => a.role !== "observer").length;
      const varianceThreshold = await loadHoursApprovalVarianceThreshold();
      const approval = evaluateHoursApproval({
        workflow: occ.workflow ?? "STANDARD",
        estimatedMinutes: occ.estimatedMinutes,
        startedAt: newStart ?? null,
        completedAt: new Date(newEnd),
        totalPausedMs: newPaused,
        workerCount: Math.max(1, activeAssignees),
        currentUserId: uid,
        varianceThreshold,
        // Judged against the job's own recent history once it has enough, the
        // same as a completion — otherwise correcting a timestamp would be
        // re-checked against the stale estimate and stay flagged forever.
        priorPersonMinutes: await loadPriorPersonMinutes(
          prisma,
          (occ as any).jobId ?? null,
          new Date(newEnd),
          occId,
        ),
      });
      data.hoursApprovedAt = approval.hoursApprovedAt;
      data.hoursApprovedById = approval.hoursApprovedById;
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({ where: { id: occId }, data });
      // Records a payroll-hours rewrite plus the hours-approval stamp it re-evaluated.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: occId,
        jobId: occ.jobId ?? null,
        action: "time_edited",
        byClaimer: !!isClaimer,
        byScheduleManager: !!canManageSchedule,
        beforeStartedAt: occ.startedAt?.toISOString() ?? null,
        afterStartedAt: updated.startedAt?.toISOString() ?? null,
        beforeCompletedAt: occ.completedAt?.toISOString() ?? null,
        afterCompletedAt: updated.completedAt?.toISOString() ?? null,
        beforeTotalPausedMs: occ.totalPausedMs ?? null,
        afterTotalPausedMs: updated.totalPausedMs ?? null,
        beforeHoursApprovedAt: occ.hoursApprovedAt?.toISOString() ?? null,
        afterHoursApprovedAt: updated.hoursApprovedAt?.toISOString() ?? null,
        beforeHoursApprovedById: occ.hoursApprovedById ?? null,
        afterHoursApprovedById: updated.hoursApprovedById ?? null,
      });
      return updated;
    });
  });
  // Estimate workflow: submit proposal
  // in-handler-scoped: ends in `updateOccurrenceStatus`, so the caller must be
  // assigned to the estimate — estimates.create is the floor, not the rule.
  app.post("/occurrences/:id/submit-proposal", req_estimatesCreate, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const notes = body.notes != null ? String(body.notes) : undefined;
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;

    // First update the proposal fields
    if (body.proposalAmount != null || body.proposalNotes != null) {
      const priorProposal = await prisma.jobOccurrence.findUnique({
        where: { id: String(req.params.id) },
        select: { id: true, jobId: true, proposalAmount: true, proposalNotes: true },
      });
      await prisma.$transaction(async (tx) => {
        const proposed = await tx.jobOccurrence.update({
          where: { id: String(req.params.id) },
          data: {
            ...(body.proposalAmount != null ? { proposalAmount: Number(body.proposalAmount) } : {}),
            ...(body.proposalNotes != null ? { proposalNotes: String(body.proposalNotes) } : {}),
          },
          select: { id: true, jobId: true, proposalAmount: true, proposalNotes: true },
        });
        // Records the quoted price the client is about to be asked to accept.
        await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
          occurrenceId: proposed.id,
          jobId: proposed.jobId ?? null,
          action: "proposal_priced",
          beforeProposalAmount: priorProposal?.proposalAmount ?? null,
          afterProposalAmount: proposed.proposalAmount ?? null,
          beforeProposalNotes: priorProposal?.proposalNotes ?? null,
          afterProposalNotes: proposed.proposalNotes ?? null,
        });
      });
    }

    // Then transition to PROPOSAL_SUBMITTED
    return services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      String(req.params.id),
      JobOccurrenceStatus.PROPOSAL_SUBMITTED,
      notes,
      location
    );
  });
  // Accept/reject estimate (assigned workers)
  app.post("/occurrences/:id/accept-estimate", req_estimatesAccept, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { assignees: true, job: { select: { id: true } } },
    });

    // Must be assigned or admin
    const acceptUser = await prisma.user.findUnique({ where: { id: uid },  });
    const canRecordPayment = callerCan(req, "money.record");
    if (!occ.assignees.some((a) => a.userId === uid) && !canRecordPayment) {
      throw app.httpErrors.forbidden("You are not assigned to this estimate.");
    }
    if ((occ as any).workflow !== "ESTIMATE" && !(occ as any).isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be accepted.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be accepted after completion.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          status: "ACCEPTED",
          notes: body.comment ? `${occ.notes ? occ.notes + "\n" : ""}Accepted: ${String(body.comment)}` : occ.notes,
        },
      });
      // Records the worker accepting the estimate on the client's behalf, which
      // authorizes the quoted price to become billable work.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "estimate_accepted",
        beforeStatus: occ.status,
        afterStatus: "ACCEPTED",
        beforePrice: occ.price ?? null,
        afterPrice: (occ as any).proposalAmount ?? occ.price ?? null,
        proposalAmount: (occ as any).proposalAmount ?? null,
        comment: body.comment ? String(body.comment) : null,
      });
    });

    return {
      accepted: true,
      jobId: occ.jobId,
      occurrence: {
        kind: occ.kind,
        startAt: occ.startAt?.toISOString() ?? null,
        endAt: occ.endAt?.toISOString() ?? null,
        notes: (occ as any).proposalNotes ?? occ.notes ?? null,
        price: (occ as any).proposalAmount ?? occ.price ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? null,
        jobTags: (occ as any).jobTags ?? null,
        jobType: (occ as any).jobType ?? null,
        assignees: occ.assignees.map((a) => ({ userId: a.userId })),
      },
    };
  });
  app.post("/occurrences/:id/reject-estimate", req_estimatesAccept, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { assignees: true },
    });

    const rejectUser = await prisma.user.findUnique({ where: { id: uid },  });
    const rejectCanManageSchedule = callerCan(req, "schedule.manage");
    if (!occ.assignees.some((a) => a.userId === uid) && !rejectCanManageSchedule) {
      throw app.httpErrors.forbidden("You are not assigned to this estimate.");
    }
    if ((occ as any).workflow !== "ESTIMATE" && !(occ as any).isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be rejected.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be rejected after completion.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          status: "REJECTED",
          rejectionReason: body.reason ? String(body.reason) : null,
        },
      });
      // Records the worker rejecting the estimate, which kills the quoted work.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "estimate_rejected",
        beforeStatus: occ.status,
        afterStatus: "REJECTED",
        beforeRejectionReason: (occ as any).rejectionReason ?? null,
        afterRejectionReason: body.reason ? String(body.reason) : null,
        proposalAmount: (occ as any).proposalAmount ?? null,
      });
    });

    return { rejected: true };
  });
  app.post("/occurrences/create-next", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const jobId = String(body.jobId || "");
    if (!jobId) throw app.httpErrors.badRequest("jobId is required");

    const input: any = {};
    if (body.isOneOff != null) input.isOneOff = !!body.isOneOff;
    if (body.startAt != null) input.startAt = body.startAt;
    if (body.endAt != null) input.endAt = body.endAt;
    if (body.notes != null) input.notes = body.notes;
    if (body.price != null) input.price = Number(body.price);

    return services.jobs.createOccurrence(uid, jobId, input);
  });
  // in-handler-scoped: the claimer check below runs before any occurrence
  // lookup, so work.complete alone is correctly 403. `schedule.manage` or
  // `money.record` is the other way in.
  app.post("/occurrences/:id/accept-payment", req_workComplete, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);

    // Only the claimer or someone with `schedule.manage` can accept payment
    const actUser = await prisma.user.findUniqueOrThrow({ where: { id: uid },  });
    // `money.record` is here because the deleted role-prefixed twin of this
    // route was gated on it and skipped the claimer check entirely. Both ways
    // in are preserved; neither depends on which URL was used.
    const canManageSchedule = callerCan(req, "schedule.manage") || callerCan(req, "money.record");

    if (!canManageSchedule) {
      const assignee = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid },
      });
      if (!assignee) throw app.httpErrors.forbidden("You are not assigned to this job.");
      const isClaimer = assignee.assignedById === uid && assignee.role !== "observer";
      if (!isClaimer) throw app.httpErrors.forbidden("Only the claimer can accept payments.");
      // `work.complete`, whose copy is "Start a visit, finish it, and take
      // payment at the door" — this is the door. It read `inventory.pull`,
      // the fifth copy of that mistake: invisible while Field Clearance
      // granted claim, complete and pull together, and wrong the moment an
      // operator grants the first two without the third, when the claimer
      // can finish the visit and then be refused the money. See G48.
      if (!callerCan(req, "work.complete"))
        throw app.httpErrors.forbidden("You are not cleared to accept payments.");
    }
    const body = req.body || {};
    return services.payments.createPayment(uid, {
      occurrenceId,
      amountPaid: Number(body.amountPaid),
      method: String(body.method || "CASH"),
      note: body.note ? String(body.note) : null,
      completionSplits: Array.isArray(body.completionSplits) ? body.completionSplits : [],
      context: canManageSchedule ? "BACK_OFFICE" : "ON_SITE",
    } as any);
  });
  // in-handler-scoped: `addOccurrenceAssignee` takes `callerCan` and scopes
  // itself — somebody already on the visit, or `schedule.manage` for any
  // visit. This was a ternary choosing between two service methods that had
  // become byte-identical, because the two implementations behind them had
  // collapsed into one. See services/jobs.ts.
  app.post("/occurrences/:id/add-assignee", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const targetUserId = String(body.userId ?? "");
    if (!targetUserId) throw app.httpErrors.badRequest("userId is required");
    const role = body.role ? String(body.role) : null;
    return services.jobs.addOccurrenceAssignee(
      uid, callerCanFn(req), String(req.params.id), targetUserId, role,
    );
  });
  // in-handler-scoped: `removeOccurrenceAssignee` takes `callerCan` and
  // scopes itself — the claimer, or `schedule.manage` for any visit. The
  // ternary this replaced passed FOUR arguments to a three-parameter
  // function on the non-manager branch, so `occurrenceId` received a
  // function instead of an id.
  app.delete("/occurrences/:id/assignees/:userId", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.removeOccurrenceAssignee(
      uid, callerCanFn(req), String(req.params.id), String(req.params.userId),
    );
  });
  // Claimer can reassign claimer role
  app.post("/occurrences/:id/reassign-claimer", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { userId } = req.body || {};
    if (!userId) throw app.httpErrors.badRequest("userId is required");
    // Verify current user is the claimer
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid && a.role !== "observer");
    if (!isClaimer && !callerCan(req, "schedule.manage")) {
      throw app.httpErrors.forbidden("Only the claimer, or someone who manages the schedule, can reassign it");
    }
    return services.jobs.reassignClaimer(uid, occurrenceId, String(userId));
  });
  // Claimer can toggle observer/worker role
  app.patch("/occurrences/:id/assignees/:userId/role", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const targetUserId = String(req.params.userId);
    const { role } = req.body || {};
    // Verify current user is the claimer
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    // THE CLAIMER, OR WHOEVER RUNS THE SCHEDULE. The deleted
    // the `/occurrences/:id/assignees/:userId/role` twin was the second
    // way in; now there is one route and the capability is the escape.
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid && a.role !== "observer");
    if (!isClaimer && !callerCan(req, "schedule.manage")) {
      throw app.httpErrors.forbidden("Only the claimer, or someone who manages the schedule, can change roles");
    }
    return services.jobs.changeAssigneeRole(uid, occurrenceId, targetUserId, role === "observer" ? "observer" : null);
  });
  // in-handler-scoped: only the person who claimed it (or schedule.manage) may
  // give it back, checked before the existence lookup.
  app.post("/occurrences/:id/unclaim", req_workClaim, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.unclaimOccurrence(uid, callerCanFn(req), String(req.params.id));
  });
  app.get("/occurrences/pinned", req_scheduleView, async (req: any) => {
    // area-scope-allow: returns only rows this caller pinned; a pin is
    //   personal, not territorial
    const uid = await currentUserId(req);
    const pins = await prisma.pinnedOccurrence.findMany({
      where: { userId: uid },
      select: { occurrenceId: true },
    });
    return pins.map((p: any) => p.occurrenceId);
  });
  app.post("/occurrences/:id/pin", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.pinnedOccurrence.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId },
      update: {},
    });
    return { ok: true };
  });
  app.post("/occurrences/:id/unpin", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.pinnedOccurrence.deleteMany({
      where: { userId: uid, occurrenceId },
    });
    return { ok: true };
  });
  app.get("/occurrences/liked", req_scheduleView, async (req: any) => {
    // area-scope-allow: returns only rows this caller liked; personal, not
    //   territorial
    const uid = await currentUserId(req);
    const likes = await prisma.likedOccurrence.findMany({
      where: { userId: uid },
      select: { occurrenceId: true },
    });
    return likes.map((l: any) => l.occurrenceId);
  });
  app.post("/occurrences/:id/like", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.likedOccurrence.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId },
      update: {},
    });
    return { ok: true };
  });
  app.post("/occurrences/:id/unlike", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.likedOccurrence.deleteMany({
      where: { userId: uid, occurrenceId },
    });
    return { ok: true };
  });
  app.post("/tasks", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createTask(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      linkedOccurrenceId: body.linkedOccurrenceId ? String(body.linkedOccurrenceId) : undefined,
    });
  });
  app.post("/tasks/:id/close", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      String(req.params.id),
      JobOccurrenceStatus.CLOSED,
    );
  });
  app.post("/tasks/:id/reopen", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(
      uid, callerCanFn(req),
      String(req.params.id),
      JobOccurrenceStatus.SCHEDULED,
    );
  });
  app.patch("/tasks/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Task not found");
    if (occ.workflow !== "TASK") throw app.httpErrors.badRequest("Only tasks can be edited this way");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Editing this task requires being its creator or holding schedule authority");
    }
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.linkedOccurrenceId !== undefined) data.linkedOccurrenceId = body.linkedOccurrenceId || null;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({ where: { id }, data });
      // Records an edit to a worker-created task (title / notes / when / link).
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "TASK",
        action: "task_edited",
        changedFields: Object.keys(data).join(","),
        beforeTitle: occ.title ?? null,
        afterTitle: updated.title ?? null,
        beforeStartAt: occ.startAt?.toISOString() ?? null,
        afterStartAt: updated.startAt?.toISOString() ?? null,
        beforeLinkedOccurrenceId: occ.linkedOccurrenceId ?? null,
        afterLinkedOccurrenceId: updated.linkedOccurrenceId ?? null,
      });
      return updated;
    });
  });
  app.delete("/tasks/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Task not found");
    if (occ.workflow !== "TASK") throw app.httpErrors.badRequest("Only tasks can be deleted this way");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Deleting this task requires being its creator or holding schedule authority");
    }
    await prisma.$transaction(async (tx) => {
      // Records the hard delete of a task; the row is gone, so the snapshot
      // below is the only surviving record of what it was.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_DELETED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "TASK",
        title: occ.title ?? null,
        notes: occ.notes ?? null,
        status: occ.status,
        startAt: occ.startAt?.toISOString() ?? null,
        linkedOccurrenceId: occ.linkedOccurrenceId ?? null,
        assigneeUserIds: occ.assignees.map((a: any) => a.userId).join(","),
      });
      await tx.jobOccurrence.delete({ where: { id } });
    });
    return { deleted: true };
  });
  app.post("/standalone-reminders", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createStandaloneReminder(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      linkedOccurrenceId: body.linkedOccurrenceId ? String(body.linkedOccurrenceId) : undefined,
      isHighPriority: !!body.isHighPriority,
    });
  });
  app.post("/standalone-reminders/:id/dismiss", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(uid, callerCanFn(req), String(req.params.id), JobOccurrenceStatus.CLOSED);
  });
  app.post("/standalone-reminders/:id/reopen", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(uid, callerCanFn(req), String(req.params.id), JobOccurrenceStatus.SCHEDULED);
  });
  app.patch("/standalone-reminders/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Reminder not found");
    if (occ.workflow !== "REMINDER") throw app.httpErrors.badRequest("Not a standalone reminder");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Editing this reminder requires being its creator or holding schedule authority");
    }
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.linkedOccurrenceId !== undefined) data.linkedOccurrenceId = body.linkedOccurrenceId || null;
    if (body.isHighPriority !== undefined) data.isHighPriority = !!body.isHighPriority;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.jobOccurrence.update({ where: { id }, data });
      // Records an edit to a standalone reminder (what fires, and when).
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "REMINDER",
        action: "reminder_edited",
        changedFields: Object.keys(data).join(","),
        beforeTitle: occ.title ?? null,
        afterTitle: updated.title ?? null,
        beforeStartAt: occ.startAt?.toISOString() ?? null,
        afterStartAt: updated.startAt?.toISOString() ?? null,
        beforeIsHighPriority: occ.isHighPriority ?? null,
        afterIsHighPriority: updated.isHighPriority ?? null,
      });
      return updated;
    });
  });
  app.delete("/standalone-reminders/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Reminder not found");
    if (occ.workflow !== "REMINDER") throw app.httpErrors.badRequest("Not a standalone reminder");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Deleting this reminder requires being its creator or holding schedule authority");
    }
    await prisma.$transaction(async (tx) => {
      // Records the hard delete of a standalone reminder; nothing else survives it.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_DELETED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "REMINDER",
        title: occ.title ?? null,
        notes: occ.notes ?? null,
        status: occ.status,
        startAt: occ.startAt?.toISOString() ?? null,
        isHighPriority: occ.isHighPriority ?? null,
        linkedOccurrenceId: occ.linkedOccurrenceId ?? null,
        assigneeUserIds: occ.assignees.map((a: any) => a.userId).join(","),
      });
      await tx.jobOccurrence.delete({ where: { id } });
    });
    return { deleted: true };
  });
  app.patch("/followups/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Followup not found");
    if (occ.workflow !== "FOLLOWUP") throw app.httpErrors.badRequest("Not a followup");
    const isActiveAssignee = occ.assignees.some((a: any) => a.userId === uid && a.role !== "observer");
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isActiveAssignee && !canManageSchedule) {
      throw app.httpErrors.forbidden("Only assignees or someone with schedule authority can edit this followup");
    }
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.frequencyDays !== undefined) data.frequencyDays = body.frequencyDays != null ? Number(body.frequencyDays) : null;
    const priorClientIds = Array.isArray(body.clientIds)
      ? (await prisma.followupClient.findMany({ where: { occurrenceId: id }, select: { clientId: true } })).map((r) => r.clientId)
      : null;
    const priorJobIds = Array.isArray(body.jobIds)
      ? (await prisma.followupJob.findMany({ where: { occurrenceId: id }, select: { jobId: true } })).map((r) => r.jobId)
      : null;
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.jobOccurrence.update({ where: { id }, data });
      }
      if (Array.isArray(body.clientIds)) {
        await tx.followupClient.deleteMany({ where: { occurrenceId: id } });
        if (body.clientIds.length > 0) {
          await tx.followupClient.createMany({
            data: body.clientIds.map((clientId: string) => ({ occurrenceId: id, clientId })),
          });
        }
      }
      if (Array.isArray(body.jobIds)) {
        await tx.followupJob.deleteMany({ where: { occurrenceId: id } });
        if (body.jobIds.length > 0) {
          await tx.followupJob.createMany({
            data: body.jobIds.map((jobId: string) => ({ occurrenceId: id, jobId })),
          });
        }
      }
      // Records a followup edit, including the wholesale replacement of which
      // clients / jobs the followup targets.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "FOLLOWUP",
        action: "followup_edited",
        changedFields: Object.keys(data).join(","),
        beforeTitle: occ.title ?? null,
        afterTitle: data.title !== undefined ? data.title : (occ.title ?? null),
        beforeStartAt: occ.startAt?.toISOString() ?? null,
        afterStartAt: data.startAt !== undefined ? new Date(data.startAt).toISOString() : (occ.startAt?.toISOString() ?? null),
        beforeFrequencyDays: occ.frequencyDays ?? null,
        afterFrequencyDays: data.frequencyDays !== undefined ? data.frequencyDays : (occ.frequencyDays ?? null),
        beforeClientIds: priorClientIds ? priorClientIds.join(",") : null,
        afterClientIds: Array.isArray(body.clientIds) ? body.clientIds.map(String).join(",") : null,
        beforeJobIds: priorJobIds ? priorJobIds.join(",") : null,
        afterJobIds: Array.isArray(body.jobIds) ? body.jobIds.map(String).join(",") : null,
      });
    });
    return prisma.jobOccurrence.findUnique({ where: { id } });
  });
  app.post("/followups/:id/complete", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Followup not found");
    if (occ.workflow !== "FOLLOWUP") throw app.httpErrors.badRequest("Not a followup");
    const isActiveAssignee = occ.assignees.some((a: any) => a.userId === uid && a.role !== "observer");
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isActiveAssignee && !canManageSchedule) {
      throw app.httpErrors.forbidden("Only assignees or someone with schedule authority can complete this followup");
    }
    return services.jobs.completeFollowup(uid, id);
  });
  app.delete("/followups/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Followup not found");
    if (occ.workflow !== "FOLLOWUP") throw app.httpErrors.badRequest("Not a followup");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isClaimer) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Deleting this followup requires being the claimer or holding schedule authority");
    }
    await prisma.$transaction(async (tx) => {
      // Records the hard delete of a followup; the row and its client/job
      // membership cascade away, so both are snapshotted here.
      const doomedClientIds = await tx.followupClient.findMany({ where: { occurrenceId: id }, select: { clientId: true } });
      const doomedJobIds = await tx.followupJob.findMany({ where: { occurrenceId: id }, select: { jobId: true } });
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_DELETED, uid, {
        occurrenceId: id,
        jobId: occ.jobId ?? null,
        workflow: "FOLLOWUP",
        title: occ.title ?? null,
        notes: occ.notes ?? null,
        status: occ.status,
        startAt: occ.startAt?.toISOString() ?? null,
        frequencyDays: occ.frequencyDays ?? null,
        clientIds: doomedClientIds.map((r) => r.clientId).join(","),
        jobIds: doomedJobIds.map((r) => r.jobId).join(","),
        assigneeUserIds: occ.assignees.map((a: any) => a.userId).join(","),
      });
      await tx.jobOccurrence.delete({ where: { id } });
    });
    return { deleted: true };
  });
  app.get("/reminders", req_scheduleView, async (req: any) => {
    // area-scope-allow: reminders are rows this caller set for themselves
    const uid = await currentUserId(req);
    return prisma.reminder.findMany({
      where: { userId: uid, dismissedAt: null },
      orderBy: { remindAt: "asc" },
    });
  });
  app.post("/occurrences/:id/reminder", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const remindAt = new Date(body.remindAt);
    if (isNaN(remindAt.getTime())) throw app.httpErrors.badRequest("Invalid remindAt date");
    const note = body.note ? String(body.note) : null;

    await prisma.reminder.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId, remindAt, note },
      update: { remindAt, note, dismissedAt: null },
    });
    return { ok: true };
  });
  app.post("/occurrences/:id/reminder/clear", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.reminder.updateMany({
      where: { userId: uid, occurrenceId },
      data: { dismissedAt: new Date() },
    });
    return { ok: true };
  });
  app.post("/occurrences/:id/reminder/snooze", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const remindAt = new Date(body.remindAt);
    if (isNaN(remindAt.getTime())) throw app.httpErrors.badRequest("Invalid remindAt date");

    await prisma.reminder.updateMany({
      where: { userId: uid, occurrenceId },
      data: { remindAt, dismissedAt: null },
    });
    return { ok: true };
  });
  app.get("/occurrences/:id/invoice-charges", req_materialsCharge, async (req: any) => {
    return services.invoiceCharges.listInvoiceChargesByOccurrence(String(req.params.id));
  });
  app.post("/occurrences/:id/invoice-charges", req_materialsCharge, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    // No category / vendor / date — there is no Schedule C line to file an
    // invoice charge against.
    return services.invoiceCharges.addInvoiceCharge(uid, callerCanFn(req), String(req.params.id), {
      cost: Number(body.cost),
      description: String(body.description ?? ""),
      actualCost:
        body.actualCost != null && body.actualCost !== "" ? Number(body.actualCost) : null,
      detail: body.detail != null ? String(body.detail) : null,
    });
  });
  // Worker-managed add-on services. Claimer of an active occurrence (or
  // management) can add and remove. Tasks/reminders/events don't carry
  // add-ons; the workflow check happens in the create path. Removed
  // add-ons are deleted outright — there's no carry-forward to next
  // occurrence so no audit-trail consideration here.
  app.post("/occurrences/:id/addons", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { tag, customLabel, price, detail } = (req.body || {}) as {
      tag?: string; customLabel?: string; price: number; detail?: string;
    };
    if (price == null || price <= 0) throw app.httpErrors.badRequest("price is required and must be positive");
    if (!tag && !customLabel) throw app.httpErrors.badRequest("Either tag or customLabel is required");

    // Authorization: claimer of this occurrence OR management.
    const me = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!canManageSchedule) {
      const claimer = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid, assignedById: uid },
      });
      if (!claimer) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can add services.");
    }

    // Add-ons stay editable through completion and unfinalized
    // PENDING_PAYMENT — frozen once payment is requested/accepted.
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        status: true,
        workflow: true,
        jobId: true,
        paymentRequestSentAt: true,
        payment: { select: { id: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occInEditableState(occ)) {
      throw app.httpErrors.conflict("Services can't be changed once payment has been requested or accepted.");
    }
    const w = occ.workflow ?? "STANDARD";
    if (w === "TASK" || w === "REMINDER" || w === "EVENT" || w === "FOLLOWUP" || w === "ANNOUNCEMENT") {
      throw app.httpErrors.badRequest("This workflow doesn't carry add-on services.");
    }

    return prisma.$transaction(async (tx) => {
      const addon = await tx.occurrenceAddon.create({
        data: {
          occurrenceId,
          tag: tag || null,
          customLabel: customLabel?.trim() || null,
          price: Number(price),
          // CLIENT-VISIBLE line detail, e.g. "5 bushes at $25.00 each". Same
          // shape an invoice charge carries — a service and a material line
          // are entered and rendered identically. This route used to drop it
          // on the floor while its management twin persisted it.
          detail: detail?.trim() || null,
          createdById: uid,
        },
      });
      // Records a new add-on service, which directly increases what the client is billed.
      await writeAudit(tx, AUDIT.JOB.ADDON_ADDED, uid, {
        addonId: addon.id,
        occurrenceId,
        jobId: occ.jobId ?? null,
        tag: addon.tag,
        customLabel: addon.customLabel,
        detail: addon.detail,
        beforePrice: null,
        afterPrice: addon.price,
        occurrenceStatus: occ.status,
      });
      return addon;
    });
  });
  app.patch("/occurrences/:id/addons/:addonId", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const addonId = String(req.params.addonId);
    const body = (req.body || {}) as {
      tag?: string | null; customLabel?: string | null; price?: number; detail?: string | null;
    };

    const me = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!canManageSchedule) {
      const claimer = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid, assignedById: uid },
      });
      if (!claimer) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can edit services.");
    }

    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        status: true, workflow: true, jobId: true,
        paymentRequestSentAt: true, payment: { select: { id: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occInEditableState(occ)) {
      throw app.httpErrors.conflict("Services can't be changed once payment has been requested or accepted.");
    }

    const before = await prisma.occurrenceAddon.findUnique({
      where: { id: addonId },
      select: { occurrenceId: true, tag: true, customLabel: true, price: true, detail: true },
    });
    if (!before) throw app.httpErrors.notFound("Add-on not found");
    if (before.occurrenceId !== occurrenceId) {
      throw app.httpErrors.notFound("Add-on not found on this occurrence");
    }

    const data: Record<string, any> = {};
    if (body.price !== undefined) {
      const n = Number(body.price);
      if (!Number.isFinite(n) || n <= 0) throw app.httpErrors.badRequest("price must be a positive number");
      data.price = n;
    }
    if (body.tag !== undefined) data.tag = body.tag || null;
    if (body.customLabel !== undefined) data.customLabel = body.customLabel?.trim() || null;
    const nextTag = "tag" in data ? data.tag : before.tag;
    const nextLabel = "customLabel" in data ? data.customLabel : before.customLabel;
    if (!nextTag && !nextLabel) throw app.httpErrors.badRequest("Either tag or customLabel is required");
    if (body.detail !== undefined) data.detail = body.detail?.trim() || null;
    if (Object.keys(data).length === 0) throw app.httpErrors.badRequest("Nothing to update");

    return prisma.$transaction(async (tx) => {
      const addon = await tx.occurrenceAddon.update({ where: { id: addonId }, data });
      await writeAudit(tx, AUDIT.JOB.ADDON_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        addonId,
        tag: addon.tag,
        customLabel: addon.customLabel,
        detail: addon.detail,
        detailBefore: before.detail,
        tagBefore: before.tag,
        customLabelBefore: before.customLabel,
        priceBefore: before.price,
        priceAfter: addon.price,
      });
      return addon;
    });
  });
  app.delete("/occurrences/:id/addons/:addonId", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const addonId = String(req.params.addonId);

    const me = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!canManageSchedule) {
      const claimer = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid, assignedById: uid },
      });
      if (!claimer) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can remove services.");
    }

    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        status: true,
        jobId: true,
        paymentRequestSentAt: true,
        payment: { select: { id: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occInEditableState(occ)) {
      throw app.httpErrors.conflict("Services can't be changed once payment has been requested or accepted.");
    }

    const doomedAddon = await prisma.occurrenceAddon.findUnique({ where: { id: addonId } });
    if (!doomedAddon) throw app.httpErrors.notFound("Service not found");

    await prisma.$transaction(async (tx) => {
      // Records removal of an add-on service, which lowers what the client is
      // billed; the row is hard-deleted so its price is snapshotted here.
      await writeAudit(tx, AUDIT.JOB.ADDON_REMOVED, uid, {
        addonId,
        occurrenceId,
        jobId: occ.jobId ?? null,
        tag: doomedAddon.tag,
        customLabel: doomedAddon.customLabel,
        beforePrice: doomedAddon.price,
        afterPrice: null,
        createdById: doomedAddon.createdById,
        createdAt: doomedAddon.createdAt.toISOString(),
        occurrenceStatus: occ.status,
      });
      await tx.occurrenceAddon.delete({ where: { id: addonId } });
    });
    return { deleted: true };
  });
  // ONE ROUTE. The deleted twin was gated on `supplies.hold` and this one on
  // `inventory.pull`, for the same service call — so the URL chose which
  // capability you needed. `services.supplies.addHold` already enforces the
  // real rule (hold-anywhere, or claimer of this visit and cleared to pull),
  // so the route only has to let both populations reach it; every role in the
  // shipped ladder holding `supplies.hold` also holds `inventory.pull`.
  app.post("/occurrences/:id/supply-holds", req_inventoryPull, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.addHold(uid, callerCanFn(req), String(req.params.id), {
      supplyId: String(b.supplyId ?? ""),
      quantity: Number(b.quantity),
      // Optional per-job price. The catalog value is only a default — the
      // same supply is billed differently to different clients.
      clientUnitPrice:
        b.clientUnitPrice == null || b.clientUnitPrice === ""
          ? null
          : Number(b.clientUnitPrice),
      // Same shape as any other invoice charge: a headline and an optional
      // client-visible detail.
      description: b.description == null ? null : String(b.description),
      detail: b.detail == null ? null : String(b.detail),
    });
  });
  app.post("/occurrences/:id/photos/upload-url", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);

    // Per-job cap is configurable via the MAX_PHOTOS_PER_JOB setting. Falls
    // back to 10 (the historical default) when the setting is missing or
    // unparseable. Existing photos above a lowered cap are preserved — the
    // check is only on new uploads.
    const setting = await prisma.setting.findUnique({ where: { key: "MAX_PHOTOS_PER_JOB" } });
    const parsed = Number(setting?.value);
    const max = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    const count = await prisma.jobOccurrencePhoto.count({ where: { occurrenceId } });
    if (count >= max) throw app.httpErrors.badRequest(`Maximum ${max} photos per occurrence`);

    const body = req.body || {};
    const fileName = String(body.fileName ?? "photo.jpg");
    const contentType = String(body.contentType ?? "image/jpeg");

    const key = `photos/${occurrenceId}/${uid}-${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType);

    return { uploadUrl, key, contentType };
  });
  app.post("/occurrences/:id/photos/confirm", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    if (!body.key) throw app.httpErrors.badRequest("key is required");
    const r2Key = String(body.key);

    // Idempotent: if a row already exists for this (occurrence, r2Key) pair,
    // return it instead of creating a duplicate. Retries from the offline
    // executor, page reloads mid-confirm, or network blips can fire confirm
    // multiple times for the same uploaded object — without this guard,
    // every retry creates another DB row pointing at the same R2 object,
    // inflating the visible photo count while the underlying image is one.
    const existing = await prisma.jobOccurrencePhoto.findFirst({
      where: { occurrenceId, r2Key },
    });
    if (existing) return existing;

    const photo = await prisma.$transaction(async (tx) => {
      const created = await tx.jobOccurrencePhoto.create({
        data: {
          occurrenceId,
          r2Key,
          fileName: body.fileName ? String(body.fileName) : null,
          contentType: body.contentType ? String(body.contentType) : null,
          uploadedById: uid,
        },
      });
      // Records a new piece of job evidence being attached to the occurrence.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        photoId: created.id,
        action: "photo_added",
        r2Key: created.r2Key,
        fileName: created.fileName,
        contentType: created.contentType,
      });
      return created;
    });

    return photo;
  });
  app.get("/occurrences/:id/photos", req_scheduleContribute, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never area-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const occurrenceId = String(req.params.id);

    const photos = await prisma.jobOccurrencePhoto.findMany({
      where: { occurrenceId },
      orderBy: { createdAt: "asc" },
      include: { uploadedBy: { select: { id: true, displayName: true } } },
    });

    const result = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        contentType: p.contentType,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        url: await getDownloadUrl(p.r2Key),
        // Whether this photo is held back from public wall displays. Read-only
        // to a worker — the toggle needs `displays.manage` — but carried here so the
        // viewer can show the state wherever the photo is looked at.
        hiddenFromDisplay: p.hiddenFromPublicAt != null,
      }))
    );

    return result;
  });
  app.delete("/occurrences/:id/photos/:photoId", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.photoId);

    const photo = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    if (photo.uploadedById !== uid) throw app.httpErrors.forbidden("You can only delete your own photos");

    await deleteObject(photo.r2Key);
    await prisma.$transaction(async (tx) => {
      // Records destruction of job evidence — the R2 object is already gone,
      // so this snapshot is the only remaining trace of the photo.
      await writeAudit(tx, AUDIT.JOB.PHOTO_DELETED, uid, {
        photoId,
        occurrenceId: photo.occurrenceId,
        r2Key: photo.r2Key,
        fileName: photo.fileName,
        contentType: photo.contentType,
        uploadedById: photo.uploadedById,
        uploadedAt: photo.createdAt.toISOString(),
      });
      await tx.jobOccurrencePhoto.delete({ where: { id: photoId } });
    });

    return { ok: true };
  });
  // ── Occurrence Property Photos (worker read) ──
  app.get("/occurrences/:id/property-photos", req_scheduleView, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never area-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const occurrenceId = String(req.params.id);
    const links = await prisma.occurrencePropertyPhoto.findMany({
      where: { occurrenceId },
      include: { propertyPhoto: true },
      orderBy: { propertyPhoto: { sortOrder: "asc" } },
    });
    const withUrls = await Promise.all(
      links.map(async (l) => ({
        id: l.propertyPhoto.id,
        url: await getDownloadUrl(l.propertyPhoto.r2Key, 86400, "property-photos"),
        fileName: l.propertyPhoto.fileName,
        description: l.propertyPhoto.description,
        sortOrder: l.propertyPhoto.sortOrder,
      }))
    );
    return withUrls;
  });
  app.patch("/occurrences/:id/pinned-note", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    // Only claimer or admin can set pinned note
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can set instructions");
    const body = req.body || {};
    const pinnedNote = body.pinnedNote != null ? String(body.pinnedNote).trim() || null : null;
    const data: any = { pinnedNote };
    if (body.pinnedNoteRepeats !== undefined) data.pinnedNoteRepeats = !!body.pinnedNoteRepeats;
    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data,
      });
      // Records a change to the pinned note shown to every worker on this job.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "pinned_note_updated",
        beforePinnedNote: occ.pinnedNote ?? null,
        afterPinnedNote: pinnedNote,
        beforePinnedNoteRepeats: occ.pinnedNoteRepeats ?? null,
        afterPinnedNoteRepeats: data.pinnedNoteRepeats !== undefined ? data.pinnedNoteRepeats : (occ.pinnedNoteRepeats ?? null),
      });
    });
    return { ok: true, pinnedNote, pinnedNoteRepeats: data.pinnedNoteRepeats };
  });
  // ── Occurrence Instructions (multiple) ──
  app.post("/occurrences/:id/instructions", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body0 = (req.body || {}) as { text: string; isPreset?: boolean; scope?: string; repeats?: boolean };
    const { text, isPreset } = body0;
    // `repeats` is still accepted so an older client keeps working: true was
    // EVERY_VISIT, false was THIS_VISIT. `scope` wins when both arrive.
    const scope: InstructionScope =
      body0.scope && (Object.values(InstructionScope) as string[]).includes(body0.scope)
        ? (body0.scope as InstructionScope)
        : body0.repeats === false
          ? InstructionScope.THIS_VISIT
          : InstructionScope.EVERY_VISIT;
    if (!text?.trim()) throw app.httpErrors.badRequest("text is required");
    // Permission: claimer or admin
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can manage instructions");
    const count = await prisma.occurrenceInstruction.count({ where: { occurrenceId } });
    return prisma.$transaction(async (tx) => {
      const instruction = await tx.occurrenceInstruction.create({
        data: { occurrenceId, text: text.trim(), isPreset: !!isPreset, scope, sortOrder: count },
      });
      // Records a new work instruction added to this occurrence.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        instructionId: instruction.id,
        action: "instruction_added",
        text: instruction.text,
        isPreset: instruction.isPreset,
        scope: instruction.scope,
      });
      return instruction;
    });
  });
  app.patch("/occurrences/:id/instructions/:instructionId", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const instructionId = String(req.params.instructionId);
    const body = req.body || {};
    // Permission: claimer or admin
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can manage instructions");
    const data: any = {};
    if ("text" in body) data.text = String(body.text).trim();
    if ("scope" in body && (Object.values(InstructionScope) as string[]).includes(body.scope)) {
      data.scope = body.scope as InstructionScope;
      // Re-pointing an already-delivered request at a new scope makes it
      // pending again; leaving the stamp would silently strand it.
      if (data.scope === InstructionScope.NEXT_VISIT_ONLY) {
        data.deliveredAt = null;
        data.deliveredToOccurrenceId = null;
      }
    } else if ("repeats" in body) {
      data.scope = body.repeats ? InstructionScope.EVERY_VISIT : InstructionScope.THIS_VISIT;
    }
    const priorInstruction = await prisma.occurrenceInstruction.findUnique({ where: { id: instructionId } });
    return prisma.$transaction(async (tx) => {
      const updated = await tx.occurrenceInstruction.update({ where: { id: instructionId }, data });
      // Records an edit to a work instruction other workers act on.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        instructionId,
        action: "instruction_edited",
        beforeText: priorInstruction?.text ?? null,
        afterText: updated.text,
        beforeScope: priorInstruction?.scope ?? null,
        afterScope: updated.scope,
      });
      return updated;
    });
  });
  app.delete("/occurrences/:id/instructions/:instructionId", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const instructionId = String(req.params.instructionId);
    // Permission: claimer or admin
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid },  });
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can manage instructions");
    const doomedInstruction = await prisma.occurrenceInstruction.findUnique({ where: { id: instructionId } });
    await prisma.$transaction(async (tx) => {
      // Records removal of a work instruction; the row is hard-deleted so its
      // text is snapshotted here.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        instructionId,
        action: "instruction_deleted",
        text: doomedInstruction?.text ?? null,
        isPreset: doomedInstruction?.isPreset ?? null,
        scope: doomedInstruction?.scope ?? null,
        deliveredAt: doomedInstruction?.deliveredAt?.toISOString() ?? null,
      });
      await tx.occurrenceInstruction.delete({ where: { id: instructionId } });
    });
    return { deleted: true };
  });
  app.post("/occurrences/:id/confirmation-requested", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    // Same authorization as /confirm — whoever may confirm may also chase.
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) {
      throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can request confirmation");
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          confirmationRequestedAt: now,
          // Set once and never moved, so "how long has this been unconfirmed"
          // survives every follow-up.
          ...(occ.confirmationFirstRequestedAt ? {} : { confirmationFirstRequestedAt: now }),
        },
        select: { confirmationRequestedAt: true, confirmationFirstRequestedAt: true },
      });
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "client_confirmation_requested",
        // Deliberately recorded as an ATTEMPT. The audit trail must not imply
        // the client received anything.
        previousRequestedAt: occ.confirmationRequestedAt ?? null,
        requestedAt: now.toISOString(),
        isRepeatAsk: !!occ.confirmationRequestedAt,
        byClaimer: !!isClaimer,
        byScheduleManager: !!canManageSchedule,
        occurrenceStatus: occ.status,
      });
      return row;
    });
    return updated;
  });
  app.post("/occurrences/:id/confirm", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (occ.status !== "SCHEDULED") throw app.httpErrors.badRequest("Only scheduled occurrences can be confirmed");
    // Only claimer or admin can confirm
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const canManageSchedule = callerCan(req, "schedule.manage");
    if (!isClaimer && !canManageSchedule) throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can confirm");
    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { isClientConfirmed: true },
      });
      // Records the worker asserting client consent — this flag is the gate
      // that permits /start on the occurrence.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        jobId: occ.jobId ?? null,
        action: "client_confirmed",
        beforeIsClientConfirmed: occ.isClientConfirmed ?? false,
        afterIsClientConfirmed: true,
        byClaimer: !!isClaimer,
        byScheduleManager: !!canManageSchedule,
        occurrenceStatus: occ.status,
      });
    });
    return { confirmed: true };
  });
  app.post("/occurrences/:id/reschedule", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { startAt, endAt, comment, source } = (req.body || {}) as { startAt?: string; endAt?: string; comment?: string; source?: string };

    if (!startAt) throw app.httpErrors.badRequest("startAt is required");

    // Comment is required unless triggered by the route planner
    const isRoutePlanner = source === "route-planner";
    const reason = (comment ?? "").trim();
    if (!isRoutePlanner && !reason) {
      throw app.httpErrors.badRequest("A comment explaining the reschedule is required");
    }

    // Verify occurrence exists and is SCHEDULED, not a task/reminder
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: { select: { userId: true, assignedById: true } } },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
      throw app.httpErrors.badRequest("Only scheduled jobs can be rescheduled");
    }
    if ((occ as any).workflow === "TASK" || (occ as any).workflow === "REMINDER") {
      throw app.httpErrors.badRequest("Tasks and reminders cannot be rescheduled");
    }

    // Only the claimer or admin can reschedule
    const reschedUser = await prisma.user.findUnique({ where: { id: uid },  });
    const reschedCanManageSchedule = callerCan(req, "schedule.manage");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isClaimer && !reschedCanManageSchedule) {
      throw app.httpErrors.forbidden("Only the claimer or someone with schedule authority can reschedule this job");
    }

    // Enforce 2-day window for non-holders of `schedule.manage` (ET calendar days, DST-safe).
    if (!reschedCanManageSchedule) {
      // Compare in ET calendar days. Previously used `startAt.slice(0, 10)`
      // which grabs the UTC day, not ET — for a late-UTC-evening instant
      // this rejected reschedule requests that were actually within the
      // 2-day window ET. etFormatDate converts to the correct ET day.
      const diffDays = Math.abs(etDaysBetween(etToday(), etFormatDate(new Date(startAt))));
      if (diffDays > 2) {
        throw app.httpErrors.badRequest("Workers can only reschedule within 2 days of today");
      }
    }

    // Update occurrence dates
    const patch: any = { startAt };
    if (endAt) patch.endAt = endAt;
    else if (occ.startAt && occ.endAt) {
      const duration = occ.endAt.getTime() - occ.startAt.getTime();
      const newStart = new Date(startAt);
      patch.endAt = new Date(newStart.getTime() + duration).toISOString();
    }

    const updated = await services.jobs.updateOccurrence(uid, occurrenceId, patch);

    // Post comment
    const commentBody = isRoutePlanner
      ? "Rescheduled via route planner"
      : `Rescheduled: ${reason}`;
    await prisma.occurrenceComment.create({
      data: { occurrenceId, authorId: uid, body: commentBody },
    });

    return updated;
  });
  app.get("/occurrences/:id/comments", req_scheduleContribute, async (req: any) => {
    // area-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never area-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const occurrenceId = String(req.params.id);
    const comments = await prisma.occurrenceComment.findMany({
      where: { occurrenceId },
      include: { author: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return comments;
  });
  app.post("/occurrences/:id/comments", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = (req.body?.body ?? "").trim();
    if (!body) throw app.httpErrors.badRequest("Comment body is required");

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.occurrenceComment.create({
        data: { occurrenceId, authorId: uid, body },
        include: { author: { select: { id: true, displayName: true, email: true } } },
      });
      // Records a comment being posted to the occurrence's shared thread.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId,
        commentId: created.id,
        action: "comment_created",
        authorId: uid,
        body: created.body,
      });
      return created;
    });
    return comment;
  });
  app.patch("/occurrences/comments/:commentId", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const commentId = String(req.params.commentId);
    const body = (req.body?.body ?? "").trim();
    if (!body) throw app.httpErrors.badRequest("Comment body is required");

    const comment = await prisma.occurrenceComment.findUnique({ where: { id: commentId } });
    if (!comment) throw app.httpErrors.notFound("Comment not found");
    if (comment.authorId !== uid) throw app.httpErrors.forbidden("Only the author can edit a comment");

    const updated = await prisma.$transaction(async (tx) => {
      const edited = await tx.occurrenceComment.update({
        where: { id: commentId },
        data: { body },
        include: { author: { select: { id: true, displayName: true, email: true } } },
      });
      // Records an author rewriting their own comment in the shared thread.
      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, uid, {
        occurrenceId: comment.occurrenceId,
        commentId,
        action: "comment_edited",
        authorId: comment.authorId,
        beforeBody: comment.body,
        afterBody: edited.body,
      });
      return edited;
    });
    return updated;
  });
  app.delete("/occurrences/comments/:commentId", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const commentId = String(req.params.commentId);

    const comment = await prisma.occurrenceComment.findUnique({
      where: { id: commentId },
      include: { occurrence: { include: { assignees: { select: { userId: true, role: true, assignedById: true } } } } },
    });
    if (!comment) throw app.httpErrors.notFound("Comment not found");

    // Can delete if: author, claimer of the job, or admin
    const isAuthor = comment.authorId === uid;
    const assignees = comment.occurrence.assignees ?? [];
    const isClaimer = assignees.some((a) => a.userId === uid && a.role !== "observer" && a.assignedById === uid);
    const canManageSchedule = callerCan(req, "schedule.manage");

    if (!isAuthor && !isClaimer && !canManageSchedule) {
      throw app.httpErrors.forbidden("You cannot delete this comment");
    }

    await prisma.$transaction(async (tx) => {
      // Records a comment being destroyed — a claimer or admin can delete
      // someone else's comment, so the original author and body are snapshotted.
      await writeAudit(tx, AUDIT.JOB.COMMENT_DELETED, uid, {
        commentId,
        occurrenceId: comment.occurrenceId,
        jobId: comment.occurrence.jobId ?? null,
        authorId: comment.authorId,
        body: comment.body,
        createdAt: comment.createdAt.toISOString(),
        deletedByAuthor: isAuthor,
        deletedByClaimer: isClaimer,
        deletedByScheduleManager: canManageSchedule,
      });
      await tx.occurrenceComment.delete({ where: { id: commentId } });
    });
    return { ok: true };
  });
}
