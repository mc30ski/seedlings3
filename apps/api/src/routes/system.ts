import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";

export default async function systemRoutes(app: FastifyInstance) {
  app.get("/hello", async (req, reply) => ({ message: "Hello from API" }));

  app.get("/healthz", async (req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: "up" };
    } catch (err) {
      req.log.error({ err }, "db health check failed");
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });
}
