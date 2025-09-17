import { FastifyInstance } from "fastify";
import { getVersionInfo } from "../lib/version";

export default async function versionRoutes(app: FastifyInstance) {
  app.get("/version", async (_req, reply) => reply.send(getVersionInfo()));
}
