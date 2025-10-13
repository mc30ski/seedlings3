import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { Role as RoleVal } from "@prisma/client";

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
    return services.equipment.reserve(req.auth?.clerkUserId, id, req.user.id);
  });

  app.post("/equipment/:id/reserve/cancel", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.cancelReservation(
      req.auth?.clerkUserId,
      id,
      req.user.id
    );
  });

  //app.post("/equipment/:id/checkout", workerGuard, async (req: any) => {
  //  const id = req.params.id as string;
  //  return services.equipment.checkout(id, req.user.id);
  //});

  // Enforce QR slug verification before finishing checkout
  app.post("/equipment/:id/checkout/verify", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    const slug = String(req.body?.slug ?? "").trim();
    return services.equipment.checkoutWithQr(
      req.auth?.clerkUserId,
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
      req.auth?.clerkUserId,
      id,
      req.user.id,
      slug
    );
  });
}
