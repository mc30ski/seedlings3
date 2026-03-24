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

  // List of approved workers (for co-worker selection)
  app.get("/workers", workerGuard, async () => {
    const list = await services.users.list({ approved: true, role: "WORKER" });
    return list.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email }));
  });
}
