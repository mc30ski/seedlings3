import { FastifyInstance } from "fastify";
import { services } from "../services";

export default async function adminRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: any, reply: any) => app.requireRole(req, reply, "ADMIN"),
  };

  app.get("/admin/equipment", adminGuard, async () =>
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

  // Admin force release (works for RESERVED or CHECKED_OUT)
  app.post("/admin/equipment/:id/release", adminGuard, async (req: any) => {
    // If you want to capture the admin actor in audit metadata later,
    // you can update services.equipment.release to accept an optional actorUserId.
    return services.equipment.release(req.params.id);
  });

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

  // GET /api/v1/admin/audit?page=1&pageSize=50&actorUserId=&equipmentId=&action=&from=&to=
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
}
