import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import devAuth from "./plugins/devAuth";
import rbac from "./plugins/rbac";
import meRoutes from "./routes/me";
import workerRoutes from "./routes/worker";
import adminRoutes from "./routes/admin";
import userRoutes from "./routes/users";
import auditRoutes from "./routes/audit";
import systemRoutes from "./routes/system";
import versionRoutes from "./routes/version";
import errorMapper from "./plugins/errorMapper";

export function buildApp() {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true, credentials: true });

  // Public system endpoints
  app.register(systemRoutes); // No prefix so /hello and /healthz are at the root

  app.register(sensible); // Register BEFORE rbac
  app.register(errorMapper);
  app.register(devAuth);
  app.register(rbac);

  app.register(async (r) => {
    await r.register(versionRoutes, { prefix: "/api/v1" });
    await r.register(meRoutes, { prefix: "/api/v1" });
    await r.register(workerRoutes, { prefix: "/api/v1" });
    await r.register(adminRoutes, { prefix: "/api/v1" });
    await r.register(userRoutes, { prefix: "/api/v1" });
    await r.register(auditRoutes, { prefix: "/api/v1" });
  });

  return app;
}
