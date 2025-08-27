import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { services } from "../services";
import "@fastify/sensible"; // brings in app.httpErrors typing

export default fp(async (app: FastifyInstance) => {
  app.decorate("requireApproved", async (req: any, _reply: any) => {
    // IMPORTANT: throw, don't return
    if (!req.auth?.clerkUserId)
      throw app.httpErrors.unauthorized("Missing auth");
    const me = await services.users.me(req.auth.clerkUserId);
    if (!me.isApproved) throw app.httpErrors.forbidden("NOT_APPROVED");
    req.user = me;
  });

  app.decorate(
    "requireRole",
    async (req: any, reply: any, role: "ADMIN" | "WORKER") => {
      await app.requireApproved(req, reply);
      if (!req.user?.roles?.includes(role))
        throw app.httpErrors.forbidden("NOT_AUTHORIZED");
    }
  );
});

declare module "fastify" {
  interface FastifyInstance {
    requireApproved(req: any, reply: any): Promise<void>;
    requireRole(req: any, reply: any, role: "ADMIN" | "WORKER"): Promise<void>;
  }
}
