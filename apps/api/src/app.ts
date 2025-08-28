import Fastify from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
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
import routeList from "./routes/routeList";

export async function buildApp() {
  const app = Fastify({ logger: true });

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      const allowed = (process.env.WEB_ORIGIN ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!origin || allowed.includes(origin)) cb(null, true);
      else cb(null, false);
    },
    credentials: true,
  };

  app.register(cors, corsOptions);

  app.register(sensible); // Register BEFORE rbac
  app.register(errorMapper);
  app.register(devAuth);
  app.register(rbac);

  await app.register(routeList);
  await app.register(systemRoutes);
  await app.register(versionRoutes);

  app.register(async (r) => {
    await r.register(meRoutes, { prefix: "/api/v1" });
    await r.register(workerRoutes, { prefix: "/api/v1" });
    await r.register(adminRoutes, { prefix: "/api/v1" });
    await r.register(userRoutes, { prefix: "/api/v1" });
    await r.register(auditRoutes, { prefix: "/api/v1" });
  });

  return app;
}
