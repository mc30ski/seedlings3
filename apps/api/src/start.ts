import { buildApp } from "./app";

const app = await buildApp();
await app.ready();

// One-off debug route to see the routing table in prod if needed
if (process.env.ROUTE_DUMP === "1") {
  app.get("/__routes", (_req, reply) =>
    reply.type("text/plain").send(app.printRoutes())
  );
}

const port = Number(process.env.PORT) || 8080;
await app.listen({ port, host: "0.0.0.0" });
