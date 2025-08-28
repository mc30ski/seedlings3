import type { FastifyInstance } from "fastify";

export default async function routeList(app: FastifyInstance) {
  // Always-on route map (text). Safe because it's registered before app.ready().
  app.get("/__routes", async (_req, reply) => {
    const text = app.printRoutes();
    reply.type("text/plain").send(text);
  });
}
