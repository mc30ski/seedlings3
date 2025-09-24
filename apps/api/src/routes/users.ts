import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { Role as RoleVal } from "@prisma/client";

export default async function userRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };

  app.get("/users", adminGuard, async (req: any) =>
    services.users.list(req.query)
  );
  app.post("/users/:id/approve", adminGuard, async (req: any) =>
    services.users.approve(req.params.id)
  );
  app.post("/users/:id/roles", adminGuard, async (req: any) =>
    services.users.addRole(req.params.id, req.body.role)
  );
  app.delete("/users/:id/roles/:role", adminGuard, async (req: any) =>
    services.users.removeRole(req.params.id, req.params.role)
  );
}
