import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { Role as RoleVal } from "@prisma/client";

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

  app.delete("/admin/clients/:id", adminGuard, async (req: any) => {
    return services.clients.hardDelete(
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
}
