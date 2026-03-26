import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
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
    return services.properties.list({
      q,
      clientId,
      status: status as any,
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
    });
  });

  app.get("/properties/:id", workerGuard, async (req: any) => {
    const id = String(req.params.id);
    return services.properties.get(id);
  });

  // Worker occurrence routes
  app.get("/occurrences", workerGuard, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    return services.jobs.listAllOccurrences({ from, to });
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
    const { prisma } = await import("../db/prisma");
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
    const { prisma } = await import("../db/prisma");
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

  // ── Expenses (claimer only) ──

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

    const { prisma } = await import("../db/prisma");
    const count = await prisma.jobOccurrencePhoto.count({ where: { occurrenceId } });
    if (count >= 10) throw app.httpErrors.badRequest("Maximum 10 photos per occurrence");

    const body = req.body || {};
    const fileName = String(body.fileName ?? "photo.jpg");
    const contentType = String(body.contentType ?? "image/jpeg");

    const { getUploadUrl } = await import("../lib/r2");
    const key = `photos/${occurrenceId}/${uid}-${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType);

    return { uploadUrl, key, contentType };
  });

  app.post("/occurrences/:id/photos/confirm", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    if (!body.key) throw app.httpErrors.badRequest("key is required");

    const { prisma } = await import("../db/prisma");
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
    const { prisma } = await import("../db/prisma");
    const { getDownloadUrl } = await import("../lib/r2");

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
    const { prisma } = await import("../db/prisma");
    const { deleteObject } = await import("../lib/r2");

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

    const { getUploadUrl } = await import("../lib/r2");
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
    const { prisma } = await import("../db/prisma");
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
      const { getDownloadUrl } = await import("../lib/r2");
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

  // List of approved workers (for co-worker selection)
  app.get("/workers", workerGuard, async () => {
    const list = await services.users.list({ approved: true, role: "WORKER" });
    return list.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, workerType: u.workerType }));
  });
}
