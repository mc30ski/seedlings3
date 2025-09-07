import { FastifyInstance } from "fastify";
import { services } from "../services";

export default async function workerRoutes(app: FastifyInstance) {
  const workerGuard = {
    preHandler: (req: any, reply: any) => {
      return app.requireRole(req, reply, "WORKER");
    },
  };

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
    return services.equipment.reserve(id, req.user.id);
  });

  app.post("/equipment/:id/reserve/cancel", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.cancelReservation(id, req.user.id);
  });

  app.post("/equipment/:id/checkout", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.checkout(id, req.user.id);
  });

  app.post("/equipment/:id/return", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.returnByUser(id, req.user.id);
  });

  // Claim (only if AVAILABLE and not in maintenance/retired)
  app.post("/equipment/:id/claim", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.reserve(id, req.user.id);
  });

  // Release (only works if THIS user has the active checkout)
  app.post("/equipment/:id/release", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.releaseByUser(id, req.user.id);
  });

  // Legacy “available” list (still fine to keep)
  app.get("/equipment/available", workerGuard, async () => {
    return services.equipment.listAvailable();
  });

  // Unavailable equipment (maintenance / reserved / checked out)
  app.get("/equipment/unavailable", workerGuard, async () =>
    services.equipment.listUnavailableWithHolder()
  );
}
