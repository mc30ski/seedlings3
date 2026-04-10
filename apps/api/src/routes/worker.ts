import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../lib/r2";
import { etMidnight, etEndOfDay } from "../lib/dates";
import { Role as RoleVal, JobOccurrenceStatus } from "@prisma/client";

async function currentUserId(req: any) {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

export default async function workerRoutes(app: FastifyInstance) {
  const workerGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.WORKER),
  };

  app.get("/equipment/all", workerGuard, async () => {
    return services.equipment.listAllAdmin();
  });

  // Workers can see all non-retired (includes MAINTENANCE / CHECKED_OUT)
  app.get("/equipment", workerGuard, async () => {
    return services.equipment.listForWorkers();
  });

  // Workers can see what THEY currently have checked out
  app.get("/equipment/mine", workerGuard, async (req: any) => {
    return services.equipment.listMine(req.user.id);
  });

  app.post("/equipment/:id/reserve", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.reserve(
      await currentUserId(req),
      id,
      req.user.id
    );
  });

  app.post("/equipment/:id/reserve/cancel", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.cancelReservation(
      await currentUserId(req),
      id,
      req.user.id
    );
  });

  // Enforce QR slug verification before finishing checkout
  app.post("/equipment/:id/checkout/verify", workerGuard, async (req: any) => {
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
  app.get("/equipment/available", workerGuard, async () => {
    return services.equipment.listAvailable();
  });

  // Unavailable equipment (maintenance / reserved / checked out)
  app.get("/equipment/unavailable", workerGuard, async () =>
    services.equipment.listUnavailableWithHolder()
  );

  app.post("/equipment/:id/return/verify", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    const slug = String(req.body?.slug ?? "").trim();
    return services.equipment.returnWithQr(
      await currentUserId(req),
      id,
      req.user.id,
      slug
    );
  });

  app.get("/clients", workerGuard, async (req: any) => {
    const { q, status, limit } = (req.query || {}) as {
      q?: string;
      status?: "ACTIVE" | "PAUSED" | "ARCHIVED" | "ALL";
      limit?: string;
    };
    return services.clients.list({
      q,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
    });
  });

  app.get("/clients/:id", workerGuard, async (req: any) => {
    const id = String(req.params.id);
    return services.clients.get(id);
  });

  app.get("/properties", workerGuard, async (req: any) => {
    const { q, clientId, status, kind, limit } = (req.query || {}) as {
      q?: string;
      clientId?: string;
      status?: "ACTIVE" | "PAUSED" | "ARCHIVED" | "ALL";
      kind?: string | "ALL";
      limit?: string;
    };
    const props = await services.properties.list({
      q,
      clientId,
      status: status as any,
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
    });
    // Attach last 3 photos from most recent occurrence for each property
    const propIds = (Array.isArray(props) ? props : []).map((p: any) => p.id);
    if (propIds.length > 0) {
      const photos = await prisma.jobOccurrencePhoto.findMany({
        where: {
          occurrence: { job: { propertyId: { in: propIds } } },
        },
        select: {
          id: true, r2Key: true, contentType: true, createdAt: true,
          occurrence: { select: { job: { select: { propertyId: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      // Group by property, take last 3 per property
      const byProperty = new Map<string, any[]>();
      for (const p of photos) {
        const pid = p.occurrence.job.propertyId;
        if (!byProperty.has(pid)) byProperty.set(pid, []);
        const arr = byProperty.get(pid)!;
        if (arr.length < 3) arr.push(p);
      }
      // Generate URLs and attach
      for (const prop of (Array.isArray(props) ? props : []) as any[]) {
        const propPhotos = byProperty.get(prop.id) ?? [];
        prop.lastPhotos = await Promise.all(
          propPhotos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
    }
    return props;
  });

  app.get("/properties/:id", workerGuard, async (req: any) => {
    const id = String(req.params.id);
    return services.properties.get(id);
  });

  // Worker occurrence routes
  app.get("/occurrences", workerGuard, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    const occs = await services.jobs.listAllOccurrences({ from, to });

    // Merge pinned & reminded occurrences that fall outside the date range
    const uid = await currentUserId(req);
    const [pins, reminders] = await Promise.all([
      prisma.pinnedOccurrence.findMany({ where: { userId: uid }, select: { occurrenceId: true } }),
      prisma.reminder.findMany({ where: { userId: uid, dismissedAt: null }, select: { occurrenceId: true, remindAt: true, note: true } }),
    ]);

    const loadedIds = new Set(occs.map((o: any) => o.id));
    const extraIds = new Set<string>();
    for (const p of pins) if (!loadedIds.has(p.occurrenceId)) extraIds.add(p.occurrenceId);
    for (const r of reminders) if (!loadedIds.has(r.occurrenceId)) extraIds.add(r.occurrenceId);

    if (extraIds.size > 0) {
      const extraOccs = await services.jobs.getOccurrencesByIds([...extraIds]);
      occs.push(...(extraOccs as any[]));
    }

    // Attach reminder data to occurrences
    if (reminders.length > 0) {
      const reminderMap = new Map(reminders.map((r) => [r.occurrenceId, { remindAt: r.remindAt, note: r.note }]));
      for (const occ of occs) {
        const rem = reminderMap.get((occ as any).id);
        if (rem) (occ as any).reminder = rem;
      }
    }

    // Generate download URLs for preview photos
    for (const occ of occs) {
      if ((occ as any).photos?.length) {
        (occ as any).photos = await Promise.all(
          (occ as any).photos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
    }
    return occs;
  });

  app.get("/occurrences/mine", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.listMyOccurrences(uid);
  });

  app.get("/occurrences/available", workerGuard, async () => {
    return services.jobs.listAvailableOccurrences();
  });

  app.post("/occurrences/:id/claim", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.claimOccurrence(uid, String(req.params.id));
  });

  app.post("/occurrences/:id/start", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
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
        await prisma.jobOccurrence.update({
          where: { id: occ.id },
          data: { startAt: newStart, ...(newEnd ? { endAt: newEnd } : {}) },
        });
      }
    }

    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.IN_PROGRESS,
      undefined,
      location
    );
  });

  app.post("/occurrences/:id/complete", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const notes = body.notes != null ? String(body.notes) : undefined;
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.PENDING_PAYMENT,
      notes,
      location
    );
  });

  // Estimate workflow: submit proposal
  app.post("/occurrences/:id/submit-proposal", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const notes = body.notes != null ? String(body.notes) : undefined;
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;

    // First update the proposal fields
    if (body.proposalAmount != null || body.proposalNotes != null) {
      await prisma.jobOccurrence.update({
        where: { id: String(req.params.id) },
        data: {
          ...(body.proposalAmount != null ? { proposalAmount: Number(body.proposalAmount) } : {}),
          ...(body.proposalNotes != null ? { proposalNotes: String(body.proposalNotes) } : {}),
        },
      });
    }

    // Then transition to PROPOSAL_SUBMITTED
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.PROPOSAL_SUBMITTED,
      notes,
      location
    );
  });

  // Accept/reject estimate (assigned workers)
  app.post("/occurrences/:id/accept-estimate", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { assignees: true, job: { select: { id: true } } },
    });

    // Must be assigned
    if (!occ.assignees.some((a) => a.userId === uid)) {
      throw app.httpErrors.forbidden("You are not assigned to this estimate.");
    }
    if ((occ as any).workflow !== "ESTIMATE" && !(occ as any).isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be accepted.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be accepted after completion.");
    }

    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "ACCEPTED",
        notes: body.comment ? `${occ.notes ? occ.notes + "\n" : ""}Accepted: ${String(body.comment)}` : occ.notes,
      },
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
        assignees: occ.assignees.map((a) => ({ userId: a.userId })),
      },
    };
  });

  app.post("/occurrences/:id/reject-estimate", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { assignees: true },
    });

    if (!occ.assignees.some((a) => a.userId === uid)) {
      throw app.httpErrors.forbidden("You are not assigned to this estimate.");
    }
    if ((occ as any).workflow !== "ESTIMATE" && !(occ as any).isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be rejected.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be rejected after completion.");
    }

    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "REJECTED",
        rejectionReason: body.reason ? String(body.reason) : null,
      },
    });

    return { rejected: true };
  });

  app.post("/occurrences/create-next", workerGuard, async (req: any) => {
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

  app.post("/occurrences/:id/accept-payment", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const actUser = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    if (actUser.workerType === "TRAINEE") throw app.httpErrors.forbidden("Trainees cannot accept payments. The team lead must take this action.");
    const body = req.body || {};
    return services.payments.createPayment(uid, {
      occurrenceId: String(req.params.id),
      amountPaid: Number(body.amountPaid),
      method: String(body.method || "CASH"),
      note: body.note ? String(body.note) : null,
      splits: Array.isArray(body.splits) ? body.splits : [],
    });
  });

  app.get("/payments/mine", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    return services.payments.listMyPayments(uid, { from, to });
  });

  app.get("/payments/equipment-charges", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    return services.equipment.listEquipmentCharges({ userId: uid, from, to });
  });

  app.post("/occurrences/:id/add-assignee", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const targetUserId = String(req.body?.userId ?? "");
    if (!targetUserId) throw app.httpErrors.badRequest("userId is required");
    return services.jobs.addOccurrenceAssignee(uid, String(req.params.id), targetUserId);
  });

  app.delete("/occurrences/:id/assignees/:userId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.removeOccurrenceAssignee(uid, String(req.params.id), String(req.params.userId));
  });

  app.post("/occurrences/:id/unclaim", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.unclaimOccurrence(uid, String(req.params.id));
  });

  // ── Pin / Unpin occurrences ──

  app.get("/occurrences/pinned", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const pins = await prisma.pinnedOccurrence.findMany({
      where: { userId: uid },
      select: { occurrenceId: true },
    });
    return pins.map((p: any) => p.occurrenceId);
  });

  app.post("/occurrences/:id/pin", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.pinnedOccurrence.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/occurrences/:id/unpin", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.pinnedOccurrence.deleteMany({
      where: { userId: uid, occurrenceId },
    });
    return { ok: true };
  });

  // ── Reminders ──

  app.get("/reminders", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return prisma.reminder.findMany({
      where: { userId: uid, dismissedAt: null },
      orderBy: { remindAt: "asc" },
    });
  });

  app.post("/occurrences/:id/reminder", workerGuard, async (req: any) => {
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

  app.post("/occurrences/:id/reminder/clear", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.reminder.updateMany({
      where: { userId: uid, occurrenceId },
      data: { dismissedAt: new Date() },
    });
    return { ok: true };
  });

  app.post("/occurrences/:id/reminder/snooze", workerGuard, async (req: any) => {
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

  // ── Expenses (claimer only) ──

  app.get("/occurrences/:id/expenses", workerGuard, async (req: any) => {
    return services.expenses.listExpensesByOccurrence(String(req.params.id));
  });

  app.post("/occurrences/:id/expenses", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    return services.expenses.addExpense(uid, String(req.params.id), {
      cost: Number(body.cost),
      description: String(body.description ?? ""),
    });
  });

  app.patch("/expenses/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const input: any = {};
    if (body.cost !== undefined) input.cost = Number(body.cost);
    if (body.description !== undefined) input.description = String(body.description);
    return services.expenses.updateExpense(uid, String(req.params.id), input);
  });

  app.delete("/expenses/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.expenses.deleteExpense(uid, String(req.params.id));
  });

  // ── Photos ──

  app.post("/occurrences/:id/photos/upload-url", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);

    const count = await prisma.jobOccurrencePhoto.count({ where: { occurrenceId } });
    if (count >= 10) throw app.httpErrors.badRequest("Maximum 10 photos per occurrence");

    const body = req.body || {};
    const fileName = String(body.fileName ?? "photo.jpg");
    const contentType = String(body.contentType ?? "image/jpeg");

    const key = `photos/${occurrenceId}/${uid}-${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType);

    return { uploadUrl, key, contentType };
  });

  app.post("/occurrences/:id/photos/confirm", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    if (!body.key) throw app.httpErrors.badRequest("key is required");

    const photo = await prisma.jobOccurrencePhoto.create({
      data: {
        occurrenceId,
        r2Key: String(body.key),
        fileName: body.fileName ? String(body.fileName) : null,
        contentType: body.contentType ? String(body.contentType) : null,
        uploadedById: uid,
      },
    });

    return photo;
  });

  app.get("/occurrences/:id/photos", workerGuard, async (req: any) => {
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
      }))
    );

    return result;
  });

  app.delete("/occurrences/:id/photos/:photoId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.photoId);

    const photo = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    if (photo.uploadedById !== uid) throw app.httpErrors.forbidden("You can only delete your own photos");

    await deleteObject(photo.r2Key);
    await prisma.jobOccurrencePhoto.delete({ where: { id: photoId } });

    return { ok: true };
  });

  // ── Insurance ──

  app.post("/insurance/upload-url", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const fileName = String(body.fileName ?? "certificate.pdf");
    const contentType = String(body.contentType ?? "application/pdf");

    const key = `insurance/${uid}/${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType, 300, "docs");

    return { uploadUrl, key, contentType };
  });

  app.post("/insurance/confirm", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.key) throw app.httpErrors.badRequest("key is required");
    if (!body.expiresAt) throw app.httpErrors.badRequest("expiresAt is required");

    await services.users.updateInsuranceCert(
      uid,
      String(body.key),
      body.fileName ? String(body.fileName) : null,
      body.contentType ? String(body.contentType) : null,
      String(body.expiresAt),
    );

    return { ok: true };
  });

  app.get("/insurance", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: uid },
      select: {
        insuranceCertR2Key: true,
        insuranceCertFileName: true,
        insuranceExpiresAt: true,
      },
    });

    let url: string | null = null;
    if (user.insuranceCertR2Key) {
        url = await getDownloadUrl(user.insuranceCertR2Key, 3600, "docs");
    }

    return {
      hasCert: !!user.insuranceCertR2Key,
      fileName: user.insuranceCertFileName,
      expiresAt: user.insuranceExpiresAt,
      url,
    };
  });

  // ── Contractor Agreement ──

  app.post("/contractor-agreement", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    await services.users.recordContractorAgreement(uid);
    return { ok: true };
  });

  // Settings (read-only for workers)
  app.get("/settings", workerGuard, async () => {
    return services.settings.getAll();
  });

  // Worker statistics (proxies to admin statistics endpoint logic, scoped to self)
  app.get("/me/statistics", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    // Redirect internally to the admin statistics logic but we'll inline it here
    const from = req.query?.from as string | undefined;
    const to = req.query?.to as string | undefined;

    const dateFilter: any = {};
    if (from) dateFilter.gte = etMidnight(from);
    if (to) dateFilter.lte = etEndOfDay(to);
    const hasDate = from || to;

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        assignees: { some: { userId: uid } },
        ...(hasDate ? { completedAt: dateFilter } : {}),
      },
      select: {
        id: true, status: true, kind: true, startedAt: true, completedAt: true,
        estimatedMinutes: true, price: true, workflow: true, isEstimate: true, startAt: true,
        assignees: { select: { userId: true, user: { select: { id: true, displayName: true, email: true, workerType: true } } } },
        payment: { select: { amountPaid: true, method: true, platformFeeAmount: true, businessMarginAmount: true, splits: { select: { userId: true, amount: true } } } },
        expenses: { select: { cost: true } },
        job: { select: { property: { select: { id: true, displayName: true, city: true } } } },
      },
      orderBy: { completedAt: "desc" },
    });

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { id: true, displayName: true, email: true, workerType: true },
    });
    if (!user) return { workers: [], totalOccurrences: 0, daysInRange: 0 };

    // Build stats for just this user
    let jobsCompleted = 0, totalEarnings = 0, totalExpenses = 0, totalActualMinutes = 0,
      totalEstimatedMinutes = 0, jobsWithTiming = 0;
    const paymentMethods: Record<string, number> = {};
    const jobsByDay: Record<string, number> = {};
    const propertySet = new Set<string>();

    for (const occ of occurrences) {
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) continue;
      jobsCompleted++;
      const actualMinutes = occ.startedAt && occ.completedAt
        ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000) : null;
      const expenseTotal = occ.expenses.reduce((s, e) => s + e.cost, 0);
      const split = occ.payment?.splits.find((s) => s.userId === uid);
      if (split) {
        const splitRatio = occ.payment && occ.payment.splits.length > 0
          ? split.amount / occ.payment.splits.reduce((s, sp) => s + sp.amount, 0) : 1;
        totalEarnings += split.amount;
        totalExpenses += expenseTotal * splitRatio;
      }
      if (actualMinutes != null && actualMinutes > 0) { totalActualMinutes += actualMinutes; jobsWithTiming++; }
      if (occ.estimatedMinutes) totalEstimatedMinutes += occ.estimatedMinutes;
      if (occ.payment?.method) paymentMethods[occ.payment.method] = (paymentMethods[occ.payment.method] || 0) + 1;
      const dayKey = occ.completedAt ? occ.completedAt.toISOString().slice(0, 10) : null;
      if (dayKey) jobsByDay[dayKey] = (jobsByDay[dayKey] || 0) + 1;
      if (occ.job?.property?.id) propertySet.add(occ.job.property.id);
    }

    const netEarnings = totalEarnings - totalExpenses;
    const allDays = new Set(Object.keys(jobsByDay));

    return {
      workers: [{
        userId: user.id,
        displayName: user.displayName ?? user.email ?? user.id,
        workerType: user.workerType,
        jobsCompleted,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netEarnings: Math.round(netEarnings * 100) / 100,
        totalActualMinutes,
        totalEstimatedMinutes,
        jobsWithTiming,
        avgActualMinutes: jobsWithTiming > 0 ? Math.round(totalActualMinutes / jobsWithTiming) : 0,
        avgEstimatedMinutes: jobsCompleted > 0 && totalEstimatedMinutes > 0 ? Math.round(totalEstimatedMinutes / jobsCompleted) : 0,
        efficiencyPercent: totalActualMinutes > 0 && totalEstimatedMinutes > 0 ? Math.round((totalEstimatedMinutes / totalActualMinutes) * 100) : null,
        propertiesServiced: propertySet.size,
        paymentMethods,
        jobsByDay,
      }],
      totalOccurrences: jobsCompleted,
      daysInRange: allDays.size,
    };
  });

  // Set own home base address
  app.patch("/me/home-base", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    await prisma.user.update({
      where: { id: uid },
      data: { homeBaseAddress: body.address != null ? String(body.address).trim() || null : null },
    });
    return { ok: true };
  });

  // Update own profile (availability)
  app.patch("/me/profile", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const data: any = {};
    if (body.homeBaseAddress !== undefined) data.homeBaseAddress = body.homeBaseAddress ? String(body.homeBaseAddress).trim() : null;
    if (body.availableDays !== undefined) data.availableDays = Array.isArray(body.availableDays) ? JSON.stringify(body.availableDays) : null;
    if (body.availableHoursPerDay !== undefined) data.availableHoursPerDay = body.availableHoursPerDay != null ? Number(body.availableHoursPerDay) : null;
    if (body.phone !== undefined) data.phone = body.phone ? String(body.phone).trim() : null;
    if (body.firstName !== undefined) data.firstName = body.firstName ? String(body.firstName).trim() : null;
    if (body.lastName !== undefined) data.lastName = body.lastName ? String(body.lastName).trim() : null;
    if (body.displayName !== undefined) data.displayName = body.displayName ? String(body.displayName).trim() : null;
    await prisma.user.update({ where: { id: uid }, data });
    return { ok: true };
  });

  // List of approved workers (for co-worker selection)
  app.get("/workers", workerGuard, async () => {
    const list = await services.users.list({ approved: true, role: "WORKER" });
    return list.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, workerType: u.workerType }));
  });
}
