import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { getDownloadUrl, deleteObject } from "../lib/r2";
import { Role as RoleVal } from "@prisma/client";
import {
  JobKind,
  JobStatus,
  Cadence,
  JobOccurrenceStatus,
} from "@prisma/client";

async function currentUserId(req: any) {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

export default async function adminRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  app.get("/admin/equipment", adminGuard, async () =>
    services.equipment.listAllAdmin()
  );

  app.post("/admin/equipment", adminGuard, async (req: any) =>
    services.equipment.create(await currentUserId(req), req.body)
  );

  app.patch("/admin/equipment/:id", adminGuard, async (req: any) =>
    services.equipment.update(await currentUserId(req), req.params.id, req.body)
  );

  app.post("/admin/equipment/:id/retire", adminGuard, async (req: any) =>
    services.equipment.retire(await currentUserId(req), req.params.id)
  );

  app.post("/admin/equipment/:id/unretire", adminGuard, async (req: any) =>
    services.equipment.unretire(await currentUserId(req), req.params.id)
  );

  app.delete("/admin/equipment/:id", adminGuard, async (req: any) =>
    services.equipment.hardDelete(await currentUserId(req), req.params.id)
  );

  app.post("/admin/equipment/:id/release", adminGuard, async (req: any) =>
    services.equipment.release(await currentUserId(req), req.params.id)
  );

  app.post(
    "/admin/equipment/:id/maintenance/start",
    adminGuard,
    async (req: any) =>
      services.equipment.maintenanceStart(
        await currentUserId(req),
        req.params.id
      )
  );

  app.post(
    "/admin/equipment/:id/maintenance/end",
    adminGuard,
    async (req: any) =>
      services.equipment.maintenanceEnd(await currentUserId(req), req.params.id)
  );

  app.get("/admin/holdings", adminGuard, async () => {
    return services.users.listHoldings();
  });

  app.get("/admin/audit", adminGuard, async (req: any) => {
    const q = (req.query || {}) as {
      page?: string;
      pageSize?: string;
      actorUserId?: string;
      action?: string;
      from?: string;
      to?: string;
    };
    const page = q.page ? Number(q.page) : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 50;

    return services.audit.list({
      actorUserId: q.actorUserId || undefined,
      action: q.action || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      page,
      pageSize,
    });
  });

  app.get("/admin/users", adminGuard, async (req: any) => {
    const q = (req.query || {}) as {
      approved?: string; // "true" | "false"
      role?: RoleVal;
    };
    const approved =
      q.approved === "true" ? true : q.approved === "false" ? false : undefined;

    return services.users.list({
      approved,
      role: q.role,
    });
  });

  app.post("/admin/users/:id/approve", adminGuard, async (req: any) =>
    services.users.approve(await currentUserId(req), req.params.id)
  );

  app.post("/admin/users/:id/roles", adminGuard, async (req: any) => {
    const id = req.params.id as string;
    const role = String(req.body?.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "WORKER") {
      throw app.httpErrors.badRequest("Invalid role");
    }
    return services.users.addRole(
      await currentUserId(req),
      id,
      role as "ADMIN" | "WORKER"
    );
  });

  app.delete("/admin/users/:id/roles/:role", adminGuard, async (req: any) => {
    const id = req.params.id as string;
    const role = String(req.params.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "WORKER") {
      throw app.httpErrors.badRequest("Invalid role");
    }
    return services.users.removeRole(
      await currentUserId(req),
      id,
      role as "ADMIN" | "WORKER"
    );
  });

  app.delete("/admin/users/:id", adminGuard, async (req: any) => {
    // Hard delete a user (DB + Clerk)
    const targetId = String(req.params.id);
    const actorId = String(req.user?.id || "");
    return services.users.remove(await currentUserId(req), targetId, actorId);
  });

  app.get("/admin/users/pendingCount", adminGuard, async () => {
    return services.users.pendingApprovalCount();
  });

  app.get("/admin/activity", adminGuard, async (req: any) => {
    return services.activity.listUserActivity();
  });

  app.get("/admin/clients", adminGuard, async (req: any) => {
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

  app.get("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.get(String(req.params.id));
  });

  app.post("/admin/clients", adminGuard, async (req: any) => {
    return services.clients.create(await currentUserId(req), req.body);
  });

  app.patch("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.update(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });

  app.post("/admin/clients/:id/pause", adminGuard, async (req: any) => {
    return services.clients.pause(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/unpause", adminGuard, async (req: any) => {
    return services.clients.unpause(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/archive", adminGuard, async (req: any) => {
    return services.clients.archive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/unarchive", adminGuard, async (req: any) => {
    return services.clients.unarchive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.delete("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.delete(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/clients/:id/contacts", adminGuard, async (req: any) => {
    return services.clients.addContact(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });

  app.patch(
    "/admin/clients/:id/contacts/:contactId",
    adminGuard,
    async (req: any) => {
      return services.clients.updateContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId),
        req.body
      );
    }
  );

  app.post("/admin/contacts/:id/pause", adminGuard, async (req: any) => {
    return services.clients.pauseContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/contacts/:id/unpause", adminGuard, async (req: any) => {
    return services.clients.unpauseContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/contacts/:id/archive", adminGuard, async (req: any) => {
    return services.clients.archiveContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/contacts/:id/unarchive", adminGuard, async (req: any) => {
    return services.clients.unarchiveContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.delete(
    "/admin/clients/:id/contacts/:contactId",
    adminGuard,
    async (req: any) => {
      return services.clients.deleteContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId)
      );
    }
  );

  app.post(
    "/admin/clients/:id/contacts/:contactId/primary",
    adminGuard,
    async (req: any) => {
      return services.clients.setPrimaryContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId)
      );
    }
  );

  app.get("/admin/properties", adminGuard, async (req: any) => {
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

  app.get("/admin/properties/:id", adminGuard, async (req: any) => {
    return services.properties.get(String(req.params.id));
  });

  app.post("/admin/properties", adminGuard, async (req: any) => {
    return services.properties.create(await currentUserId(req), req.body);
  });

  app.patch("/admin/properties/:id", adminGuard, async (req: any) => {
    return services.properties.update(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });

  app.post("/admin/properties/:id/archive", adminGuard, async (req: any) => {
    return services.properties.archive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.post("/admin/properties/:id/unarchive", adminGuard, async (req: any) => {
    return services.properties.unarchive(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  app.delete("/admin/properties/:id", adminGuard, async (req: any) => {
    return services.properties.hardDelete(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  // Primary contact for the property (optional)
  app.post(
    "/admin/properties/:id/primary-contact",
    adminGuard,
    async (req: any) => {
      const { contactId } = (req.body || {}) as { contactId?: string | null };
      return services.properties.setPrimaryContact(
        await currentUserId(req),
        String(req.params.id),
        contactId ?? null
      );
    }
  );

  // Jobs: list / get / create / update

  app.get("/admin/jobs", adminGuard, async (req: any) => {
    const { q, propertyId, status, kind, limit, from, to } = (req.query || {}) as {
      q?: string;
      propertyId?: string;
      status?: "PROPOSED" | "ACCEPTED" | "ALL";
      kind?: "ENTIRE_SITE" | "SINGLE_ADDRESS" | "ALL";
      limit?: string;
      from?: string;
      to?: string;
    };

    return services.jobs.list({
      q,
      propertyId,
      status: (status as any) ?? "ALL",
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
      from,
      to,
    });
  });

  app.get("/admin/jobs/:id", adminGuard, async (req: any) => {
    return services.jobs.get(String(req.params.id));
  });

  app.post("/admin/jobs", adminGuard, async (req: any) => {
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
      notes: body.notes != null ? String(body.notes) : null,
      defaultPrice: body.defaultPrice != null ? Number(body.defaultPrice) : null,
      estimatedMinutes: body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null,
    } as any);
  });

  app.patch("/admin/jobs/:id", adminGuard, async (req: any) => {
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
    if ("notes" in body) patch.notes = body.notes != null ? String(body.notes) : null;
    if ("defaultPrice" in body) patch.defaultPrice = body.defaultPrice != null ? Number(body.defaultPrice) : null;
    if ("estimatedMinutes" in body) patch.estimatedMinutes = body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null;

    return services.jobs.update(await currentUserId(req), id, patch);
  });

  // Default assignees for a job
  app.put("/admin/jobs/:id/default-assignees", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const body = req.body || {};
    const userIds: string[] = Array.isArray(body.userIds) ? body.userIds.map(String) : [];

    await prisma.$transaction(async (tx) => {
      // Remove existing
      await tx.jobAssigneeDefault.deleteMany({ where: { jobId } });
      // Add new
      if (userIds.length > 0) {
        await tx.jobAssigneeDefault.createMany({
          data: userIds.map((uid) => ({ jobId, userId: uid })),
          skipDuplicates: true,
        });
      }
    });

    return { updated: true };
  });

  // Job schedule: upsert schedule + generate occurrences

  app.put("/admin/jobs/:id/schedule", adminGuard, async (req: any) => {
    const jobId = String(req.params.id);
    const body = req.body || {};

    // autoRenew required for upsert in our service plan
    const autoRenew = !!body.autoRenew;

    const patch: any = { autoRenew };

    if (body.cadence != null) {
      const cadence = String(body.cadence || "").toUpperCase();
      if (
        cadence !== "WEEKLY" &&
        cadence !== "BIWEEKLY" &&
        cadence !== "MONTHLY"
      ) {
        throw app.httpErrors.badRequest("Invalid cadence");
      }
      patch.cadence = cadence as Cadence;
    }

    if (body.interval != null) {
      const interval = Number(body.interval);
      if (!Number.isFinite(interval) || interval < 1) {
        throw app.httpErrors.badRequest("interval must be >= 1");
      }
      patch.interval = interval;
    }

    if (body.dayOfWeek != null) {
      const dayOfWeek = Number(body.dayOfWeek);
      if (!Number.isFinite(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
        throw app.httpErrors.badRequest("dayOfWeek must be 0-6");
      }
      patch.dayOfWeek = dayOfWeek;
    }

    if (body.dayOfMonth != null) {
      const dayOfMonth = Number(body.dayOfMonth);
      if (!Number.isFinite(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
        throw app.httpErrors.badRequest("dayOfMonth must be 1-31");
      }
      patch.dayOfMonth = dayOfMonth;
    }

    if (body.preferredStartHour != null) {
      const h = Number(body.preferredStartHour);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        throw app.httpErrors.badRequest("preferredStartHour must be 0-23");
      }
      patch.preferredStartHour = h;
    }

    if (body.preferredEndHour != null) {
      const h = Number(body.preferredEndHour);
      if (!Number.isFinite(h) || h < 0 || h > 23) {
        throw app.httpErrors.badRequest("preferredEndHour must be 0-23");
      }
      patch.preferredEndHour = h;
    }

    if (body.horizonDays != null) {
      const d = Number(body.horizonDays);
      if (!Number.isFinite(d) || d < 1 || d > 365) {
        throw app.httpErrors.badRequest("horizonDays must be 1-365");
      }
      patch.horizonDays = d;
    }

    if (body.active != null) patch.active = !!body.active;

    return services.jobs.upsertSchedule(await currentUserId(req), jobId, patch);
  });

  app.post(
    "/admin/jobs/:id/occurrences/generate",
    adminGuard,
    async (req: any) => {
      return services.jobs.generateOccurrences(
        await currentUserId(req),
        String(req.params.id)
      );
    }
  );

  // Occurrences: create one-off + set assignees + patch occurrence (kind/status/times)

  // Create a one-off occurrence from a job template
  app.post("/admin/jobs/:id/occurrences", adminGuard, async (req: any) => {
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
    if (body.isAdminOnly != null) input.isAdminOnly = !!body.isAdminOnly;
    if ("jobType" in body) input.jobType = body.jobType || null;
    // Dates: accept ISO strings; service should parse/validate
    if (body.startAt != null) input.startAt = body.startAt;
    if (body.endAt != null) input.endAt = body.endAt;
    if (body.notes != null) input.notes = body.notes;
    if (body.price != null) input.price = Number(body.price);
    if (body.estimatedMinutes != null) input.estimatedMinutes = Math.round(Number(body.estimatedMinutes));

    if (body.assigneeUserIds != null) {
      if (!Array.isArray(body.assigneeUserIds)) {
        throw app.httpErrors.badRequest("assigneeUserIds must be an array");
      }
      input.assigneeUserIds = body.assigneeUserIds.map(String);
    }

    return services.jobs.createOccurrence(
      await currentUserId(req),
      jobId,
      input
    );
  });

  // Replace assignees for an occurrence (workers-only enforced in service)
  app.put(
    "/admin/occurrences/:occurrenceId/assignees",
    adminGuard,
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

  // Admin: add individual assignee
  app.post("/admin/occurrences/:id/add-assignee", adminGuard, async (req: any) => {
    const targetUserId = String(req.body?.userId ?? "");
    if (!targetUserId) throw app.httpErrors.badRequest("userId is required");
    return services.jobs.adminAddOccurrenceAssignee(
      await currentUserId(req),
      String(req.params.id),
      targetUserId
    );
  });

  // Admin: remove individual assignee
  app.delete("/admin/occurrences/:id/assignees/:userId", adminGuard, async (req: any) => {
    return services.jobs.adminRemoveOccurrenceAssignee(
      await currentUserId(req),
      String(req.params.id),
      String(req.params.userId)
    );
  });

  // Patch an occurrence (optional but very useful for admin UI)
  app.patch(
    "/admin/occurrences/:occurrenceId",
    adminGuard,
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
          st === "CLOSED" ||
          st === "CANCELED" ||
          st === "ARCHIVED";
        if (!ok) throw app.httpErrors.badRequest("Invalid occurrence status");
        patch.status = st as JobOccurrenceStatus;
      }

      if ("startAt" in body) patch.startAt = body.startAt || null;
      if ("endAt" in body) patch.endAt = body.endAt || null;
      if ("notes" in body) patch.notes = body.notes;
      if ("price" in body) patch.price = body.price != null ? Number(body.price) : null;
      if ("estimatedMinutes" in body) patch.estimatedMinutes = body.estimatedMinutes != null ? Math.round(Number(body.estimatedMinutes)) : null;
      if ("isTentative" in body) patch.isTentative = !!body.isTentative;
      if ("isEstimate" in body) patch.isEstimate = !!body.isEstimate;
      if ("isAdminOnly" in body) patch.isAdminOnly = !!body.isAdminOnly;
      if ("jobType" in body) patch.jobType = body.jobType || null;
      if ("startedAt" in body) patch.startedAt = body.startedAt || null;
      if ("completedAt" in body) patch.completedAt = body.completedAt || null;
      if ("startLat" in body) patch.startLat = body.startLat != null ? Number(body.startLat) : null;
      if ("startLng" in body) patch.startLng = body.startLng != null ? Number(body.startLng) : null;
      if ("completeLat" in body) patch.completeLat = body.completeLat != null ? Number(body.completeLat) : null;
      if ("completeLng" in body) patch.completeLng = body.completeLng != null ? Number(body.completeLng) : null;

      // You’ll want to implement services.jobs.updateOccurrence(...) OR do prisma here.
      return services.jobs.updateOccurrence(
        await currentUserId(req),
        occurrenceId,
        patch
      );
    }
  );

  // List archived jobs (paginated)
  app.get("/admin/jobs/archived", adminGuard, async (req: any) => {
    const { page, pageSize } = (req.query || {}) as {
      page?: string;
      pageSize?: string;
    };
    return services.jobs.listArchivedJobs({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  });

  // Archive an accepted job
  app.post("/admin/jobs/:id/archive", adminGuard, async (req: any) => {
    return services.jobs.archiveJob(
      await currentUserId(req),
      String(req.params.id)
    );
  });

  // Delete a proposed job permanently
  app.delete("/admin/jobs/:id", adminGuard, async (req: any) => {
    return services.jobs.deleteJob(String(req.params.id));
  });

  // Archive a completed occurrence
  app.post(
    "/admin/occurrences/:occurrenceId/archive",
    adminGuard,
    async (req: any) => {
      return services.jobs.archiveOccurrence(
        await currentUserId(req),
        String(req.params.occurrenceId)
      );
    }
  );

  // Delete a canceled occurrence permanently
  app.delete(
    "/admin/occurrences/:occurrenceId",
    adminGuard,
    async (req: any) => {
      const occurrenceId = String(req.params.occurrenceId);
      return services.jobs.deleteOccurrence(occurrenceId);
    }
  );

  // Accept payment for an occurrence (admin)
  app.post(
    "/admin/occurrences/:occurrenceId/accept-payment",
    adminGuard,
    async (req: any) => {
      const uid = await currentUserId(req);
      const body = req.body || {};
      return services.payments.createPayment(uid, {
        occurrenceId: String(req.params.occurrenceId),
        amountPaid: Number(body.amountPaid),
        method: String(body.method || "CASH"),
        note: body.note ? String(body.note) : null,
        splits: Array.isArray(body.splits) ? body.splits : [],
      });
    }
  );

  // Recalculate payment splits based on current assignees
  app.post("/admin/occurrences/:occurrenceId/recalculate-splits", adminGuard, async (req: any) => {
    return services.payments.recalculateSplits(String(req.params.occurrenceId));
  });

  // Update a payment (admin)
  app.patch("/admin/payments/:paymentId", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const input: any = {};
    if (body.amountPaid !== undefined) input.amountPaid = Number(body.amountPaid);
    if (body.method !== undefined) input.method = String(body.method);
    if ("note" in body) input.note = body.note ? String(body.note) : null;
    if (body.splits !== undefined) {
      if (!Array.isArray(body.splits)) throw app.httpErrors.badRequest("splits must be an array");
      input.splits = body.splits.map((sp: any) => ({
        userId: String(sp.userId),
        amount: Number(sp.amount),
      }));
    }
    return services.payments.updatePayment(uid, String(req.params.paymentId), input);
  });

  // Delete a payment (admin)
  app.delete("/admin/payments/:paymentId", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    await services.payments.deletePayment(uid, String(req.params.paymentId));
    return { ok: true };
  });

  // List all payments (admin)
  app.get("/admin/payments", adminGuard, async (req: any) => {
    const { from, to, userId, method } = (req.query || {}) as {
      from?: string;
      to?: string;
      userId?: string;
      method?: string;
    };
    return services.payments.listAllPayments({ from, to, userId, method });
  });

  app.get("/admin/payments/equipment-charges", adminGuard, async (req: any) => {
    const { from, to, userId } = (req.query || {}) as { from?: string; to?: string; userId?: string };
    return services.equipment.listEquipmentCharges({ from, to, userId });
  });

  // ── Admin Expenses ──

  app.get("/admin/occurrences/:occurrenceId/expenses", adminGuard, async (req: any) => {
    return services.expenses.listExpensesByOccurrence(String(req.params.occurrenceId));
  });

  app.post("/admin/occurrences/:occurrenceId/expenses", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    return services.expenses.adminAddExpense(uid, String(req.params.occurrenceId), {
      cost: Number(body.cost),
      description: String(body.description ?? ""),
    });
  });

  app.delete("/admin/expenses/:id", adminGuard, async (req: any) => {
    return services.expenses.adminDeleteExpense(String(req.params.id));
  });

  // ── Estimate Proposal Actions ──

  app.post("/admin/occurrences/:occurrenceId/accept-proposal", adminGuard, async (req: any) => {
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
    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "ACCEPTED",
        notes: body.comment ? `${occ.notes ? occ.notes + "\n" : ""}Accepted: ${String(body.comment)}` : occ.notes,
      },
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
        assignees: occ.assignees.map((a) => ({ userId: a.userId })),
      },
    };
  });

  app.post("/admin/occurrences/:occurrenceId/reject-proposal", adminGuard, async (req: any) => {
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

    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "REJECTED",
        rejectionReason: body.reason ? String(body.reason) : null,
      },
    });

    return { rejected: true };
  });

  // ── Generate AI Estimate ──

  app.post("/admin/occurrences/:occurrenceId/generate-estimate", adminGuard, async (req: any) => {
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
        expenses: true,
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
      occ.expenses?.length ? `Expenses: ${occ.expenses.map((e: any) => `$${e.amount.toFixed(2)} (${e.description})`).join(", ")}` : null,
      prop?.accessNotes ? `Access notes: ${prop.accessNotes}` : null,
    ].filter(Boolean).join("\n");

    const prompt = `You are estimating a lawn care job for Seedlings Lawn Care. Produce two outputs as JSON.

Job info:
${details}

STEP 1 — INTERNAL BREAKDOWN (for business eyes only):
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
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });

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
      await prisma.jobOccurrence.update({
        where: { id: occurrenceId },
        data: {
          generatedEstimate: message,
          generatedEstimateBreakdown: breakdown,
        },
      });

      return { estimate: message, breakdown };
    } catch (err: any) {
      throw app.httpErrors.internalServerError(`Estimate generation failed: ${err.message}`);
    }
  });

  // ── Worker Type & Compliance ──

  app.get("/admin/users/:id", adminGuard, async (req: any) => {
    const userId = String(req.params.id);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, displayName: true, workerType: true, homeBaseAddress: true,
        isApproved: true, insuranceExpiresAt: true, contractorAgreedAt: true, w9Collected: true,
      },
    });
    return user;
  });

  app.patch("/admin/users/:id/worker-type", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    if (body.workerType === null || body.workerType === "") {
      await services.users.setWorkerType(uid, userId, null);
      return { ok: true };
    }
    const wt = String(body.workerType).toUpperCase();
    if (wt !== "EMPLOYEE" && wt !== "CONTRACTOR" && wt !== "TRAINEE") {
      throw app.httpErrors.badRequest("workerType must be EMPLOYEE, CONTRACTOR, or TRAINEE");
    }
    await services.users.setWorkerType(uid, userId, wt);
    return { ok: true };
  });

  app.patch("/admin/users/:id/w9", adminGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    await services.users.setW9Collected(uid, userId, !!body.collected);
    return { ok: true };
  });

  app.patch("/admin/users/:id/home-base", adminGuard, async (req: any) => {
    const userId = String(req.params.id);
    const body = req.body || {};
    await prisma.user.update({
      where: { id: userId },
      data: { homeBaseAddress: body.address != null ? String(body.address).trim() || null : null },
    });
    return { ok: true };
  });

  // ── Worker Statistics ──

  app.get("/admin/statistics", adminGuard, async (req: any) => {
    const from = req.query?.from as string | undefined;
    const to = req.query?.to as string | undefined;

    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from + "T00:00:00Z");
    if (to) dateFilter.lte = new Date(to + "T23:59:59.999Z");
    const hasDate = from || to;

    // Get all closed occurrences with assignees, payment splits, timing
    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        ...(hasDate ? { completedAt: dateFilter } : {}),
      },
      select: {
        id: true,
        status: true,
        kind: true,
        startedAt: true,
        completedAt: true,
        estimatedMinutes: true,
        price: true,
        workflow: true,
        isEstimate: true,
        startAt: true,
        assignees: {
          select: {
            userId: true,
            user: { select: { id: true, displayName: true, email: true, workerType: true } },
          },
        },
        payment: {
          select: {
            amountPaid: true,
            method: true,
            platformFeeAmount: true,
            businessMarginAmount: true,
            splits: {
              select: { userId: true, amount: true },
            },
          },
        },
        expenses: {
          select: { cost: true },
        },
        job: {
          select: {
            property: { select: { id: true, displayName: true, city: true } },
          },
        },
      },
      orderBy: { completedAt: "desc" },
    });

    // Get all workers
    const workers = await prisma.user.findMany({
      where: {
        isApproved: true,
        roles: { some: { role: "WORKER" } },
      },
      select: { id: true, displayName: true, email: true, workerType: true },
    });

    // Build per-worker stats
    type WorkerStat = {
      userId: string;
      displayName: string;
      workerType: string | null;
      jobsCompleted: number;
      totalEarnings: number;
      totalExpenses: number;
      netEarnings: number;
      totalActualMinutes: number;
      totalEstimatedMinutes: number;
      jobsWithTiming: number;
      avgActualMinutes: number;
      avgEstimatedMinutes: number;
      efficiencyPercent: number | null; // estimated/actual * 100
      propertiesServiced: number;
      paymentMethods: Record<string, number>;
      jobsByDay: Record<string, number>; // YYYY-MM-DD -> count
    };

    const statsMap = new Map<string, WorkerStat>();

    for (const w of workers) {
      statsMap.set(w.id, {
        userId: w.id,
        displayName: w.displayName ?? w.email ?? w.id,
        workerType: w.workerType,
        jobsCompleted: 0,
        totalEarnings: 0,
        totalExpenses: 0,
        netEarnings: 0,
        totalActualMinutes: 0,
        totalEstimatedMinutes: 0,
        jobsWithTiming: 0,
        avgActualMinutes: 0,
        avgEstimatedMinutes: 0,
        efficiencyPercent: null,
        propertiesServiced: 0,
        paymentMethods: {},
        jobsByDay: {},
      });
    }

    const propertySetMap = new Map<string, Set<string>>();

    for (const occ of occurrences) {
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) continue;

      const actualMinutes = occ.startedAt && occ.completedAt
        ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000)
        : null;

      const expenseTotal = occ.expenses.reduce((s, e) => s + e.cost, 0);
      const dayKey = occ.completedAt ? occ.completedAt.toISOString().slice(0, 10) : null;
      const propId = occ.job?.property?.id;

      for (const a of occ.assignees) {
        let stat = statsMap.get(a.userId);
        if (!stat) continue;

        stat.jobsCompleted++;

        // Earnings from splits
        const split = occ.payment?.splits.find((s) => s.userId === a.userId);
        if (split) {
          const splitRatio = occ.payment && occ.payment.splits.length > 0
            ? split.amount / occ.payment.splits.reduce((s, sp) => s + sp.amount, 0)
            : 1;
          const expenseShare = expenseTotal * splitRatio;
          stat.totalEarnings += split.amount;
          stat.totalExpenses += expenseShare;
          stat.netEarnings += split.amount - expenseShare;
        }

        // Timing
        if (actualMinutes != null && actualMinutes > 0) {
          stat.totalActualMinutes += actualMinutes;
          stat.jobsWithTiming++;
        }
        if (occ.estimatedMinutes) {
          stat.totalEstimatedMinutes += occ.estimatedMinutes;
        }

        // Payment method
        if (occ.payment?.method) {
          stat.paymentMethods[occ.payment.method] = (stat.paymentMethods[occ.payment.method] || 0) + 1;
        }

        // Jobs by day
        if (dayKey) {
          stat.jobsByDay[dayKey] = (stat.jobsByDay[dayKey] || 0) + 1;
        }

        // Properties
        if (propId) {
          if (!propertySetMap.has(a.userId)) propertySetMap.set(a.userId, new Set());
          propertySetMap.get(a.userId)!.add(propId);
        }
      }
    }

    // Finalize averages
    const results: WorkerStat[] = [];
    for (const stat of statsMap.values()) {
      stat.propertiesServiced = propertySetMap.get(stat.userId)?.size ?? 0;
      if (stat.jobsWithTiming > 0) {
        stat.avgActualMinutes = Math.round(stat.totalActualMinutes / stat.jobsWithTiming);
      }
      if (stat.jobsCompleted > 0 && stat.totalEstimatedMinutes > 0) {
        stat.avgEstimatedMinutes = Math.round(stat.totalEstimatedMinutes / stat.jobsCompleted);
      }
      if (stat.totalActualMinutes > 0 && stat.totalEstimatedMinutes > 0) {
        stat.efficiencyPercent = Math.round((stat.totalEstimatedMinutes / stat.totalActualMinutes) * 100);
      }
      stat.totalEarnings = Math.round(stat.totalEarnings * 100) / 100;
      stat.totalExpenses = Math.round(stat.totalExpenses * 100) / 100;
      stat.netEarnings = Math.round(stat.netEarnings * 100) / 100;
      results.push(stat);
    }

    // Sort by jobs completed desc
    results.sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    // Days with jobs for "jobs per day" calc
    const allDays = new Set<string>();
    for (const stat of results) {
      for (const d of Object.keys(stat.jobsByDay)) allDays.add(d);
    }

    return {
      workers: results,
      totalOccurrences: occurrences.filter((o) => o.workflow !== "ESTIMATE" && !o.isEstimate).length,
      daysInRange: allDays.size,
    };
  });

  // ── Admin Photos ──

  app.get("/admin/occurrences/:occurrenceId/photos", adminGuard, async (req: any) => {
    const occurrenceId = String(req.params.occurrenceId);

    const photos = await prisma.jobOccurrencePhoto.findMany({
      where: { occurrenceId },
      orderBy: { createdAt: "asc" },
      include: { uploadedBy: { select: { id: true, displayName: true } } },
    });

    return Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        contentType: p.contentType,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        url: await getDownloadUrl(p.r2Key),
      }))
    );
  });

  app.delete("/admin/photos/:id", adminGuard, async (req: any) => {
    const photoId = String(req.params.id);

    const photo = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");

    await deleteObject(photo.r2Key);
    await prisma.jobOccurrencePhoto.delete({ where: { id: photoId } });

    return { ok: true };
  });

  // ── Settings ──

  app.get("/admin/settings", adminGuard, async () => {
    return services.settings.getAll();
  });

  app.patch("/admin/settings/:key", superGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    const body = req.body || {};
    if (body.value === undefined) throw app.httpErrors.badRequest("value is required");
    return services.settings.set(uid, key, String(body.value));
  });

  // ── Full Data Export ──

  app.get("/admin/export", adminGuard, async (_req: any, reply: any) => {

    const [
      users,
      userRoles,
      equipment,
      checkouts,
      clients,
      clientContacts,
      properties,
      jobs,
      jobContacts,
      jobClients,
      jobSchedules,
      jobOccurrences,
      jobAssigneeDefaults,
      jobOccurrenceAssignees,
      payments,
      paymentSplits,
      expenses,
      auditEvents,
    ] = await Promise.all([
      prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.userRole.findMany(),
      prisma.equipment.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.checkout.findMany(),
      prisma.client.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.clientContact.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.property.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.job.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobContact.findMany(),
      prisma.jobClient.findMany(),
      prisma.jobSchedule.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobOccurrence.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobAssigneeDefault.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.jobOccurrenceAssignee.findMany(),
      prisma.payment.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.paymentSplit.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.expense.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.auditEvent.findMany({ orderBy: { createdAt: "asc" } }),
    ]);

    const data = {
      exportedAt: new Date().toISOString(),
      users,
      userRoles,
      equipment,
      checkouts,
      clients,
      clientContacts,
      properties,
      jobs,
      jobContacts,
      jobClients,
      jobSchedules,
      jobOccurrences,
      jobAssigneeDefaults,
      jobOccurrenceAssignees,
      payments,
      paymentSplits,
      expenses,
      auditEvents,
    };

    const filename = `seedlings-export-${new Date().toISOString().slice(0, 10)}.json`;
    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(JSON.stringify(data, null, 2));
  });

  // ── Human-Readable Summary Export ──

  app.get("/admin/export-summary", adminGuard, async (_req: any) => {

    const clients = await prisma.client.findMany({
      orderBy: { displayName: "asc" },
      include: {
        contacts: { orderBy: { isPrimary: "desc" } },
        properties: {
          orderBy: { displayName: "asc" },
          include: {
            pointOfContact: true,
            jobs: {
              orderBy: { createdAt: "asc" },
              include: {
                schedule: true,
                defaultAssignees: { include: { user: true } },
                occurrences: {
                  orderBy: { startAt: "asc" },
                  include: {
                    assignees: { include: { user: true } },
                    payment: true,
                    expenses: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    const users = await prisma.user.findMany({
      orderBy: { displayName: "asc" },
      include: { roles: true },
    });

    const equipment = await prisma.equipment.findMany({
      orderBy: { brand: "asc" },
      include: {
        checkouts: {
          orderBy: { checkedOutAt: "desc" },
          take: 5,
          include: { user: true },
        },
      },
    });

    const lines: string[] = [];
    const hr = "=".repeat(80);
    const sr = "-".repeat(60);
    const date = (d: Date | string | null | undefined) =>
      d ? new Date(d).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
    const money = (n: number | null | undefined) =>
      n != null ? `$${n.toFixed(2)}` : "—";

    lines.push(`SEEDLINGS LAWN CARE — DATA SUMMARY`);
    lines.push(`Exported: ${new Date().toLocaleString("en-US")}`);
    lines.push(hr);
    lines.push("");

    // ── Users ──
    lines.push("TEAM MEMBERS");
    lines.push(sr);
    for (const u of users) {
      const roles = u.roles.map((r: any) => r.role).join(", ") || "No role";
      lines.push(`  ${u.displayName || u.email || u.id}  (${roles})${u.email ? "  " + u.email : ""}`);
    }
    lines.push("");

    // ── Equipment ──
    lines.push("EQUIPMENT");
    lines.push(sr);
    for (const eq of equipment) {
      const eqName = [eq.brand, eq.model].filter(Boolean).join(" ") || eq.shortDesc || eq.id;
      lines.push(`  ${eqName}  [${eq.status}]${eq.type ? "  Type: " + eq.type : ""}`);
      if (eq.shortDesc) lines.push(`    Desc: ${eq.shortDesc}`);
      if (eq.issues) lines.push(`    Issues: ${eq.issues}`);
    }
    lines.push("");

    // ── Clients → Properties → Jobs → Occurrences ──
    lines.push("CLIENTS, PROPERTIES & JOBS");
    lines.push(hr);
    for (const client of clients) {
      lines.push("");
      lines.push(`CLIENT: ${client.displayName}  [${client.status}]  (${client.type})`);
      if (client.notesInternal) lines.push(`  Notes: ${client.notesInternal}`);

      // Contacts
      if (client.contacts.length > 0) {
        lines.push(`  Contacts:`);
        for (const c of client.contacts) {
          const primary = c.isPrimary ? " (PRIMARY)" : "";
          lines.push(`    - ${c.firstName} ${c.lastName}${primary}${c.role ? " [" + c.role + "]" : ""}${c.phone ? "  " + c.phone : ""}${c.email ? "  " + c.email : ""}`);
        }
      }

      // Properties
      for (const prop of client.properties) {
        lines.push("");
        lines.push(`  PROPERTY: ${prop.displayName}  [${prop.status}]`);
        lines.push(`    Address: ${prop.street1}${prop.street2 ? ", " + prop.street2 : ""}, ${prop.city}, ${prop.state} ${prop.postalCode}`);
        if (prop.accessNotes) lines.push(`    Access: ${prop.accessNotes}`);
        if (prop.pointOfContact) lines.push(`    POC: ${prop.pointOfContact.firstName} ${prop.pointOfContact.lastName}`);

        // Jobs
        for (const job of prop.jobs) {
          lines.push("");
          lines.push(`    JOB: ${job.kind}  [${job.status}]${job.frequencyDays ? "  Every " + job.frequencyDays + " days" : ""}${job.defaultPrice != null ? "  Default price: " + money(job.defaultPrice) : ""}`);
          if (job.notes) lines.push(`      Notes: ${job.notes}`);

          // Schedule
          if (job.schedule) {
            const s = job.schedule;
            lines.push(`      Schedule: ${s.cadence || "custom"}${s.autoRenew ? " (auto-renew)" : ""}${s.active ? "" : " [INACTIVE]"}  Horizon: ${s.horizonDays} days`);
          }

          // Default assignees
          if (job.defaultAssignees.length > 0) {
            lines.push(`      Default crew: ${job.defaultAssignees.map((a: any) => a.user.displayName || a.user.email).join(", ")}`);
          }

          // Occurrences
          if (job.occurrences.length > 0) {
            lines.push(`      Occurrences (${job.occurrences.length}):`);
            for (const occ of job.occurrences) {
              const flags = [
                occ.isOneOff && "one-off",
                occ.isEstimate && "estimate",
                occ.isTentative && "tentative",
              ].filter(Boolean).join(", ");
              const crew = occ.assignees.map((a: any) => a.user.displayName || a.user.email).join(", ");
              lines.push(`        ${date(occ.startAt)}  [${occ.status}]${flags ? "  (" + flags + ")" : ""}  ${money(occ.price)}${crew ? "  Crew: " + crew : ""}`);
              if (occ.notes) lines.push(`          Notes: ${occ.notes}`);
              if (occ.payment) {
                const p = occ.payment;
                lines.push(`          Payment: ${money(p.amountPaid)} via ${p.method} on ${date(p.createdAt)}`);
              }
              if (occ.expenses.length > 0) {
                for (const ex of occ.expenses) {
                  lines.push(`          Expense: ${money(ex.cost)} — ${ex.description || "no description"}`);
                }
              }
            }
          }
        }
      }
      lines.push(sr);
    }

    const text = lines.join("\n");
    return { text };
  });
}
