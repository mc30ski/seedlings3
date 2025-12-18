import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
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

  app.post("/admin/properties/:id/approve", adminGuard, async (req: any) => {
    return services.properties.approve(
      await currentUserId(req),
      String(req.params.id)
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
    const { q, propertyId, status, kind, limit } = (req.query || {}) as {
      q?: string;
      propertyId?: string;
      status?: "PROPOSED" | "ACCEPTED" | "ALL";
      kind?: "ENTIRE_SITE" | "SINGLE_ADDRESS" | "ALL";
      limit?: string;
    };

    return services.jobs.list({
      q,
      propertyId,
      status: (status as any) ?? "ALL",
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
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
    if (status && status !== "PROPOSED" && status !== "ACCEPTED") {
      throw app.httpErrors.badRequest("Invalid status");
    }

    return services.jobs.create(await currentUserId(req), {
      propertyId,
      kind: kind as JobKind,
      status: (status as JobStatus) || undefined,
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
      if (status !== "PROPOSED" && status !== "ACCEPTED") {
        throw app.httpErrors.badRequest("Invalid status");
      }
      patch.status = status as JobStatus;
    }

    return services.jobs.update(await currentUserId(req), id, patch);
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

    // Dates: accept ISO strings; service should parse/validate
    if (body.windowStart != null) input.windowStart = body.windowStart;
    if (body.windowEnd != null) input.windowEnd = body.windowEnd;
    if (body.startAt != null) input.startAt = body.startAt;
    if (body.endAt != null) input.endAt = body.endAt;
    if (body.notes != null) input.notes = body.notes;

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
          st === "CANCELED";
        if (!ok) throw app.httpErrors.badRequest("Invalid occurrence status");
        patch.status = st as JobOccurrenceStatus;
      }

      if (body.windowStart != null) patch.windowStart = body.windowStart;
      if (body.windowEnd != null) patch.windowEnd = body.windowEnd;
      if (body.startAt != null) patch.startAt = body.startAt;
      if (body.endAt != null) patch.endAt = body.endAt;
      if (body.notes != null) patch.notes = body.notes;

      // You’ll want to implement services.jobs.updateOccurrence(...) OR do prisma here.
      return services.jobs.updateOccurrence(
        await currentUserId(req),
        occurrenceId,
        patch
      );
    }
  );
}
