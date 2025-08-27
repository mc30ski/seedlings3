import { FastifyInstance } from "fastify";
import { services } from "../services";

export default async function auditRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: [
      (app as any).requireRole.bind(app, undefined, undefined, "ADMIN"),
    ],
  };
  app.get("/audit", adminGuard, async (req: any) =>
    services.audit.list(req.query)
  );
}
