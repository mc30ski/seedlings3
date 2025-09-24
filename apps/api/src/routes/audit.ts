import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { Role as RoleVal } from "@prisma/client";

//TODO: Isn't there already an audit endpoint under admin routes? Do we need both?

export default async function auditRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };

  app.get("/audit", adminGuard, async (req: any) =>
    services.audit.list(req.query)
  );
}
