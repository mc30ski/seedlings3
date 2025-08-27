import { FastifyInstance } from "fastify";
import { getVersionInfo } from "../lib/version";

export default async function versionRoutes(app: FastifyInstance) {
  // Absolute path so it's always exactly /api/v1/version
  app.get("/api/v1/version", async (_req, reply) => {
    reply.send(getVersionInfo());
  });

  // Optional helper at root for quick checks
  app.get("/version", async (_req, reply) => {
    reply.send(getVersionInfo());
  });
}
