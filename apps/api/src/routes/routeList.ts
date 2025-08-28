import type { FastifyInstance } from "fastify";

export default async function routeList(app: FastifyInstance) {
  app.get("/__routes", async (_req, reply) => {
    // Fastify’s built-in tree, normalized to plain ASCII so it’s readable everywhere
    const txt = app
      .printRoutes()
      .replace(/├/g, "|")
      .replace(/└/g, "`")
      .replace(/│/g, "|")
      .replace(/─/g, "-")
      .replace(/[^\x00-\x7F]/g, ""); // strip any remaining non-ASCII

    reply.type("text/plain; charset=utf-8").send(txt);
  });
}
