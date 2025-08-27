import { FastifyInstance } from "fastify";
import { services } from "../services";

export default async function meRoutes(app: FastifyInstance) {
  app.get("/me", async (req, reply) => {
    if (!(req as any).auth?.clerkUserId) return reply.unauthorized();
    const me = await services.users.me((req as any).auth.clerkUserId);
    return me;
  });
}
