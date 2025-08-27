// apps/api/src/start.ts
import { buildApp } from "./app.js";

const app = await buildApp();
await app.ready();

// Optional: ad-hoc route dump for debugging
if (process.env.ROUTE_DUMP === "1") {
  app.get("/__routes", (_req, reply) =>
    reply.type("text/plain").send(app.printRoutes())
  );
}

const port = Number(process.env.PORT ?? 8080);
await app.listen({ port, host: "0.0.0.0" });
app.log.info(`listening on http://localhost:${port}`);
