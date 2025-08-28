import { FastifyInstance } from "fastify";
import { getVersionInfo } from "../lib/version";

export default async function versionRoutes(app: FastifyInstance) {
  // Absolute path so it’s always exactly this path
  app.get("/api/v1/version", async (_req, reply) =>
    reply.send(getVersionInfo())
  );
  // Handy helper
  app.get("/version", async (_req, reply) => reply.send(getVersionInfo()));
}
