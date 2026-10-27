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
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereVia } from "../lib/areaScope";
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

export default async function equipmentRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_equipmentCapital = requires("equipment.capital");
  const req_equipmentManage = requires("equipment.manage");
  const req_equipmentView = requires("equipment.view");
  const req_inventoryPull = requires("inventory.pull");

  // Create + hard-delete are `equipment.manage` — bringing new equipment
  // onto the books (or wiping it) is a capital-account decision, not
  // someone with `equipment.manage` day-to-day. Edit/retire/release stay equipment.manage so
  // holders of `equipment.manage` can still manage the existing fleet.
  app.post("/equipment", req_equipmentCapital, async (req: any) =>
    services.equipment.create(await currentUserId(req), req.body)
  );
  app.patch("/equipment/:id", req_equipmentManage, async (req: any) =>
    services.equipment.update(await currentUserId(req), req.params.id, req.body)
  );
  app.post("/equipment/:id/retire", req_equipmentManage, async (req: any) =>
    services.equipment.retire(await currentUserId(req), req.params.id)
  );
  app.post("/equipment/:id/unretire", req_equipmentManage, async (req: any) =>
    services.equipment.unretire(await currentUserId(req), req.params.id)
  );
  app.delete("/equipment/:id", req_equipmentCapital, async (req: any) =>
    services.equipment.hardDelete(await currentUserId(req), req.params.id)
  );
  app.post("/equipment/:id/release", req_equipmentManage, async (req: any) =>
    services.equipment.release(await currentUserId(req), req.params.id)
  );
  app.post(
    "/equipment/:id/maintenance/start",
    req_equipmentManage,
    async (req: any) =>
      services.equipment.maintenanceStart(
        await currentUserId(req),
        req.params.id
      )
  );
  app.post(
    "/equipment/:id/maintenance/end",
    req_equipmentManage,
    async (req: any) =>
      services.equipment.maintenanceEnd(await currentUserId(req), req.params.id)
  );
  // `services.users.listHoldings()` returns equipment CHECKOUTS, not anything
  // from the books. It sat on a books entitlement, so "see who has which
  // mower" was gated on reading the P&L.
  app.get("/holdings", req_equipmentView, async () => {
    return services.users.listHoldings();
  });
  // ─── "Act on behalf" equipment routes (`equipment.manage`) ───────────────
  // There is one Inventory tab; what it offers is the capability set plus the
  // ability for someone with `equipment.manage` to perform any worker action (reserve, cancel,
  // checkout, return) on behalf of a worker who's stuck or doesn't know
  // the flow. The userId of the worker being acted FOR is passed in the
  // request body. The audit actor remains the calling user so the trail
  // shows who pulled the lever.
  // Act-on-behalf-of endpoints — admin+ can drive equipment actions
  // for a stuck worker (reserve / cancel / checkout / return). The
  // audit actor is the caller; the target worker is in the body.
  // Route was originally split by role; one path now, guarded by
  // the Inventory tab's view-as picker.
  app.post("/equipment/:id/reserve-for", req_equipmentManage, async (req: any) => {
    const id = String(req.params.id);
    const b = (req.body || {}) as { userId?: string; groupId?: string | null };
    if (!b.userId) throw app.httpErrors.badRequest("userId is required.");
    return services.equipment.reserve(
      await currentUserId(req),
      id,
      String(b.userId),
      { groupId: b.groupId ?? null },
    );
  });
  app.post("/equipment/:id/reserve-for/cancel", req_equipmentManage, async (req: any) => {
    const id = String(req.params.id);
    const b = (req.body || {}) as { userId?: string };
    if (!b.userId) throw app.httpErrors.badRequest("userId is required.");
    return services.equipment.cancelReservation(
      await currentUserId(req),
      id,
      String(b.userId),
    );
  });
  app.post("/equipment/:id/checkout-for/verify", req_equipmentManage, async (req: any) => {
    const id = String(req.params.id);
    const b = (req.body || {}) as { userId?: string; slug?: string };
    if (!b.userId) throw app.httpErrors.badRequest("userId is required.");
    const slug = String(b.slug ?? "").trim();
    return services.equipment.checkoutWithQr(
      await currentUserId(req),
      id,
      String(b.userId),
      slug,
    );
  });
  app.post("/equipment/:id/return-for/verify", req_equipmentManage, async (req: any) => {
    const id = String(req.params.id);
    const b = (req.body || {}) as { userId?: string; slug?: string };
    if (!b.userId) throw app.httpErrors.badRequest("userId is required.");
    const slug = String(b.slug ?? "").trim();
    return services.equipment.returnWithQr(
      await currentUserId(req),
      id,
      String(b.userId),
      slug,
    );
  });
  app.post("/equipment/:id/photos/upload-url", req_equipmentManage, async (req: any) => {
    const equipmentId = String(req.params.id);
    const { fileName, contentType } = (req.body || {}) as { fileName?: string; contentType?: string };
    const name = fileName || `photo-${Date.now()}.jpg`;
    const ct = contentType || "image/jpeg";
    const key = `equipment/${equipmentId}/${Date.now()}-${name}`;
    const uploadUrl = await getUploadUrl(key, ct, 300, "equipment-photos");
    return { uploadUrl, key, contentType: ct };
  });
  app.post("/equipment/:id/photos/confirm", req_equipmentManage, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    const { key, fileName, contentType, description } = (req.body || {}) as {
      key: string; fileName?: string; contentType?: string; description?: string;
    };
    if (!key) throw app.httpErrors.badRequest("key is required");
    const count = await prisma.equipmentPhoto.count({ where: { equipmentId } });
    if (count >= 10) throw app.httpErrors.badRequest("Maximum 10 photos per equipment");
    return prisma.$transaction(async (tx) => {
      const photo = await tx.equipmentPhoto.create({
        data: {
          equipmentId,
          r2Key: key,
          fileName: fileName ?? null,
          contentType: contentType ?? null,
          description: description?.trim() || null,
          sortOrder: count,
          uploadedById: uid,
        },
      });
      // Records a new photo joining the equipment gallery.
      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, uid, {
        equipmentId,
        photoId: photo.id,
        action: "photo_added",
        fileName: photo.fileName,
        r2Key: photo.r2Key,
      });
      return photo;
    });
  });
  app.patch("/equipment/:id/photos/:photoId", req_equipmentManage, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    const photoId = String(req.params.photoId);
    const body = req.body || {};
    const data: any = {};
    if ("description" in body) data.description = body.description?.trim() || null;
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    return prisma.$transaction(async (tx) => {
      const photo = await tx.equipmentPhoto.update({ where: { id: photoId }, data });
      // Records a caption / ordering edit on an equipment photo.
      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, uid, {
        equipmentId,
        photoId,
        action: "photo_updated",
        changedFields: Object.keys(data),
        description: photo.description,
        sortOrder: photo.sortOrder,
      });
      return photo;
    });
  });
  app.delete("/equipment/:id/photos/:photoId", req_equipmentManage, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.photoId);
    const photo = await prisma.equipmentPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    await deleteObject(photo.r2Key, "equipment-photos");
    await prisma.$transaction(async (tx) => {
      await tx.equipmentPhoto.delete({ where: { id: photoId } });
      // Destructive: row + R2 object both gone; this snapshot is the only
      // surviving record of the photo.
      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, uid, {
        equipmentId: photo.equipmentId,
        photoId: photo.id,
        action: "photo_deleted",
        fileName: photo.fileName,
        contentType: photo.contentType,
        description: photo.description,
        sortOrder: photo.sortOrder,
        r2Key: photo.r2Key,
        uploadedById: photo.uploadedById,
      });
    });
    return { deleted: true };
  });
  app.post("/equipment/:id/instructions", req_equipmentManage, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    const { text, isPreset } = (req.body || {}) as { text: string; isPreset?: boolean };
    if (!text?.trim()) throw app.httpErrors.badRequest("text is required");
    const count = await prisma.equipmentInstruction.count({ where: { equipmentId } });
    return prisma.$transaction(async (tx) => {
      const instruction = await tx.equipmentInstruction.create({
        data: { equipmentId, text: text.trim(), isPreset: !!isPreset, sortOrder: count },
      });
      // Records a new safe-use instruction workers are expected to follow.
      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, uid, {
        equipmentId,
        instructionId: instruction.id,
        action: "instruction_added",
        text: instruction.text,
        isPreset: instruction.isPreset,
        sortOrder: instruction.sortOrder,
      });
      return instruction;
    });
  });
  app.patch("/equipment/:id/instructions/:instructionId", req_equipmentManage, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    const instructionId = String(req.params.instructionId);
    const body = req.body || {};
    const data: any = {};
    if ("text" in body) data.text = String(body.text).trim();
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    const before = await prisma.equipmentInstruction.findUnique({
      where: { id: instructionId },
      select: { text: true, sortOrder: true },
    });
    return prisma.$transaction(async (tx) => {
      const instruction = await tx.equipmentInstruction.update({ where: { id: instructionId }, data });
      // Records a reword / reorder of a safe-use instruction.
      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, uid, {
        equipmentId,
        instructionId,
        action: "instruction_updated",
        changedFields: Object.keys(data),
        textBefore: before?.text ?? null,
        textAfter: instruction.text,
        sortOrderBefore: before?.sortOrder ?? null,
        sortOrderAfter: instruction.sortOrder,
      });
      return instruction;
    });
  });
  app.delete("/equipment/:id/instructions/:instructionId", req_equipmentManage, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    const instructionId = String(req.params.instructionId);
    // Snapshot before the row is gone — the audit entry becomes the only
    // evidence the instruction ever existed.
    const before = await prisma.equipmentInstruction.findUnique({
      where: { id: instructionId },
      select: { text: true, isPreset: true, sortOrder: true },
    });
    return prisma.$transaction(async (tx) => {
      await tx.equipmentInstruction.delete({ where: { id: instructionId } });
      // Destructive: removes a safe-use instruction from the equipment.
      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, uid, {
        equipmentId,
        instructionId,
        action: "instruction_deleted",
        text: before?.text ?? null,
        isPreset: before?.isPreset ?? null,
        sortOrder: before?.sortOrder ?? null,
      });
      return { deleted: true };
    });
  });
  app.get("/equipment/all", req_equipmentView, async () => {
    return services.equipment.listAllUnscoped();
  });
  // Workers can see all non-retired (includes MAINTENANCE / CHECKED_OUT)
  app.get("/equipment", req_equipmentView, async (req: any) => {
    // `equipment.manage` is what the old `/equipment` surface meant:
    // whoever maintains the fleet sees the full record, everyone else sees
    // what they need to take something out.
    return callerCan(req, "equipment.manage")
      ? services.equipment.listAllUnscoped()
      : services.equipment.listForWorkers();
  });
  // Workers can see what THEY currently have checked out
  app.get("/equipment/mine", req_equipmentView, async (req: any) => {
    return services.equipment.listMine(req.user.id);
  });
  // Equipment-usage dashboard — scoped to the requesting worker's own checkouts.
  app.get("/equipment-usage", req_equipmentView, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    const cutoff = await resolveCutoff(req);
    // Unscoped for whoever maintains the fleet; your own rows otherwise.
    // Both twins required only `equipment.view` — the URL decided the scope.
    return services.equipment.listUsage({
      from,
      to,
      ...(callerCan(req, "equipment.manage") ? {} : { userId: req.user.id }),
      cutoff,
    });
  });
  app.post("/equipment/:id/reserve", req_inventoryPull, async (req: any) => {
    const id = req.params.id as string;
    const body = (req.body || {}) as { groupId?: string | null };
    return services.equipment.reserve(
      await currentUserId(req),
      id,
      req.user.id,
      { groupId: body.groupId ?? null },
    );
  });
  app.post("/equipment/:id/reserve/cancel", req_inventoryPull, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.cancelReservation(
      await currentUserId(req),
      id,
      req.user.id
    );
  });
  // Enforce QR slug verification before finishing checkout
  app.post("/equipment/:id/checkout/verify", req_inventoryPull, async (req: any) => {
    const id = req.params.id as string;
    const slug = String(req.body?.slug ?? "").trim();
    return services.equipment.checkoutWithQr(
      await currentUserId(req),
      id,
      req.user.id,
      slug
    );
  });
  // Legacy “available” list (still fine to keep)
  app.get("/equipment/available", req_equipmentView, async () => {
    return services.equipment.listAvailable();
  });
  // Unavailable equipment (maintenance / reserved / checked out)
  app.get("/equipment/unavailable", req_equipmentView, async () =>
    services.equipment.listUnavailableWithHolder()
  );
  app.post("/equipment/:id/return/verify", req_inventoryPull, async (req: any) => {
    const id = req.params.id as string;
    const slug = String(req.body?.slug ?? "").trim();
    return services.equipment.returnWithQr(
      await currentUserId(req),
      id,
      req.user.id,
      slug
    );
  });
  app.get("/equipment/pinned", req_equipmentView, async (req: any) => {
    const uid = await currentUserId(req);
    const pins = await prisma.pinnedEquipment.findMany({
      where: { userId: uid },
      select: { equipmentId: true },
    });
    return pins.map((p: any) => p.equipmentId);
  });
  app.post("/equipment/:id/pin", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.pinnedEquipment.upsert({
      where: { userId_equipmentId: { userId: uid, equipmentId } },
      create: { userId: uid, equipmentId },
      update: {},
    });
    return { ok: true };
  });
  app.post("/equipment/:id/unpin", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.pinnedEquipment.deleteMany({
      where: { userId: uid, equipmentId },
    });
    return { ok: true };
  });
  app.get("/equipment/liked", req_equipmentView, async (req: any) => {
    const uid = await currentUserId(req);
    const likes = await prisma.likedEquipment.findMany({
      where: { userId: uid },
      select: { equipmentId: true },
    });
    return likes.map((l: any) => l.equipmentId);
  });
  app.post("/equipment/:id/like", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.likedEquipment.upsert({
      where: { userId_equipmentId: { userId: uid, equipmentId } },
      create: { userId: uid, equipmentId },
      update: {},
    });
    return { ok: true };
  });
  app.post("/equipment/:id/unlike", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.likedEquipment.deleteMany({
      where: { userId: uid, equipmentId },
    });
    return { ok: true };
  });
  // ── Equipment Photos (worker read) ──
  // The full row (r2Key and all) only for whoever maintains the fleet.
  // The deleted `/equipment/:id/photos` twin returned `...p`, so the
  // storage key was one URL away for anyone holding `equipment.view`.
  app.get("/equipment/:id/photos", req_equipmentView, async (req: any) => {
    const equipmentId = String(req.params.id);
    const photos = await prisma.equipmentPhoto.findMany({
      where: { equipmentId },
      orderBy: { sortOrder: "asc" },
    });
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        ...(callerCan(req, "equipment.manage")
          ? p
          : {
              id: p.id,
              fileName: p.fileName,
              description: p.description,
              sortOrder: p.sortOrder,
            }),
        url: await getDownloadUrl(p.r2Key, 86400, "equipment-photos"),
      }))
    );
    return withUrls;
  });
}
