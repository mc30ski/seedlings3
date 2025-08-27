import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";

export default async function systemRoutes(app: FastifyInstance) {
  // Simple hello
  app.get("/hello", async () => ({ message: "Hello from API" }));

  // K8s/Cloud Run-friendly healthz (200 if app is up; 503 if DB is down)
  app.get("/healthz", async (req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: "up" };
    } catch (err) {
      req.log.error({ err }, "db health check failed");
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });

  // (Optional) also expose them under /api/v1 if you want:
  app.get("/api/v1/hello", async () => ({ message: "Hello from API" }));
  app.get("/api/v1/healthz", async (req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: "up" };
    } catch {
      return reply.code(503).send({ ok: false, db: "down" });
    }
  });
}
