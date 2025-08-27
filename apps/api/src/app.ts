// apps/api/src/app.ts
import fastify from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import sensible from "@fastify/sensible";

import devAuth from "./plugins/devAuth.js";
import rbac from "./plugins/rbac.js";
import errorMapper from "./plugins/errorMapper.js";

import systemRoutes from "./routes/system.js"; // /hello, /healthz at root
import versionRoutes from "./routes/version.js"; // defines absolute /api/v1/version and /version
import meRoutes from "./routes/me.js";
import workerRoutes from "./routes/worker.js";
import adminRoutes from "./routes/admin.js";
import userRoutes from "./routes/users.js";
import auditRoutes from "./routes/audit.js";

export async function buildApp() {
  const app = fastify({ logger: true });

  // CORS (allow no-origin requests and explicit WEB_ORIGIN list)
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
  await app.register(cors, corsOptions);

  // Plugins (order matters)
  await app.register(sensible); // provides app.httpErrors, etc.
  await app.register(errorMapper); // maps Prisma/validation errors
  await app.register(devAuth); // mock/dev auth (before RBAC)
  await app.register(rbac); // requireRole, etc.

  // Public system/version endpoints (no prefix)
  await app.register(systemRoutes); // e.g., GET /hello, /healthz
  await app.register(versionRoutes); // GET /api/v1/version and /version

  // API routes under /api/v1
  await app.register(async (r) => {
    await r.register(meRoutes, { prefix: "/api/v1" });
    await r.register(workerRoutes, { prefix: "/api/v1" });
    await r.register(adminRoutes, { prefix: "/api/v1" });
    await r.register(userRoutes, { prefix: "/api/v1" });
    await r.register(auditRoutes, { prefix: "/api/v1" });
  });

  return app;
}
