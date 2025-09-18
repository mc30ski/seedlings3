import { FastifyInstance } from "fastify";
import { services } from "../services";

export default async function adminRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: [
      (app as any).requireRole.bind(app, undefined, undefined, "ADMIN"),
    ],
  };

  // Equipment (basic + with holders)
  app.get("/admin/equipment", adminGuard, async () =>
    services.equipment.listAllAdmin()
  );
  app.get("/admin/equipment/with-holders", adminGuard, async () =>
    services.equipment.listAllAdmin()
  );

  app.post("/admin/equipment", adminGuard, async (req: any) =>
    services.equipment.create(req.body)
  );
  app.patch("/admin/equipment/:id", adminGuard, async (req: any) =>
    services.equipment.update(req.params.id, req.body)
  );
  app.post("/admin/equipment/:id/retire", adminGuard, async (req: any) =>
    services.equipment.retire(req.params.id)
  );
  app.post("/admin/equipment/:id/unretire", adminGuard, async (req: any) =>
    services.equipment.unretire(req.params.id)
  );
  app.delete("/admin/equipment/:id", adminGuard, async (req: any) =>
    services.equipment.hardDelete(req.params.id)
  );
  app.post("/admin/equipment/:id/assign", adminGuard, async (req: any) =>
    services.equipment.assign(req.params.id, req.body.userId)
  );
  app.post("/admin/equipment/:id/release", adminGuard, async (req: any) =>
    services.equipment.release(req.params.id)
  );
  app.post(
    "/admin/equipment/:id/maintenance/start",
    adminGuard,
    async (req: any) => services.maintenance.start(req.params.id)
  );
  app.post(
    "/admin/equipment/:id/maintenance/end",
    adminGuard,
    async (req: any) => services.maintenance.end(req.params.id)
  );

  // Holdings (reserved + checked out) — via services layer
  app.get("/admin/holdings", adminGuard, async () => {
    return services.users.listHoldings();
  });

  // Audit
  app.get("/admin/audit", adminGuard, async (req: any) => {
    const q = (req.query || {}) as {
      page?: string;
      pageSize?: string;
      actorUserId?: string;
      equipmentId?: string;
      action?: string;
      from?: string;
      to?: string;
    };
    const page = q.page ? Number(q.page) : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 50;

    return services.audit.list({
      actorUserId: q.actorUserId || undefined,
      equipmentId: q.equipmentId || undefined,
      action: q.action || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      page,
      pageSize,
    });
  });

  // -------- Users management (ADMIN only) --------
  app.get("/admin/users", adminGuard, async (req: any) => {
    const q = (req.query || {}) as {
      approved?: string; // "true" | "false"
      role?: "ADMIN" | "WORKER";
    };
    const approved =
      q.approved === "true" ? true : q.approved === "false" ? false : undefined;

    return services.users.list({
      approved,
      role: q.role,
    });
  });

  app.post("/admin/users/:id/approve", adminGuard, async (req: any) =>
    services.users.approve(req.params.id)
  );

  app.post("/admin/users/:id/roles", adminGuard, async (req: any) => {
    const id = req.params.id as string;
    const role = String(req.body?.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "WORKER") {
      throw app.httpErrors.badRequest("Invalid role");
    }
    return services.users.addRole(id, role as "ADMIN" | "WORKER");
  });

  app.delete("/admin/users/:id/roles/:role", adminGuard, async (req: any) => {
    const id = req.params.id as string;
    const role = String(req.params.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "WORKER") {
      throw app.httpErrors.badRequest("Invalid role");
    }
    return services.users.removeRole(id, role as "ADMIN" | "WORKER");
  });

  // Hard delete a user (DB + Clerk)
  app.delete("/admin/users/:id", adminGuard, async (req: any) => {
    const targetId = String(req.params.id);
    const actorId = String(req.user?.id || "");
    return services.users.remove(targetId, actorId);
  });
}
