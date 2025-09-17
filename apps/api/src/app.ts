// apps/api/src/app.ts
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";

import errorMapper from "./plugins/errorMapper.js";
import rbac from "./plugins/rbac.js";
import auth from "./plugins/auth.js"; // ← Clerk-based auth (replaces devAuth)

import systemRoutes from "./routes/system.js";
import versionRoutes from "./routes/version.js";
import meRoutes from "./routes/me.js";
import workerRoutes from "./routes/worker.js";
import adminRoutes from "./routes/admin.js";
import userRoutes from "./routes/users.js";
import auditRoutes from "./routes/audit.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // CORS — allow your web app + localhost
  const webOrigin =
    process.env.WEB_ORIGIN ||
    (process.env.NODE_ENV !== "production"
      ? "http://localhost:3000"
      : undefined);

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow same-origin / curl / SSR
      if (!origin) return cb(null, true);

      const allowList = [
        webOrigin,
        "http://localhost:3000",
        // helpful when testing Vercel preview/prod without constantly editing WEB_ORIGIN
        process.env.NEXT_PUBLIC_WEB_ORIGIN, // if you keep one of these around
        process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : undefined,
      ].filter(Boolean) as string[];

      cb(null, allowList.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["X-Request-Id"],
  });

  // Global plugins and public routes
  await app.register(sensible);
  await app.register(errorMapper);
  await app.register(systemRoutes);
  await app.register(versionRoutes);

  const f = async (api) => {
    await api.register(auth); // Clerk auth (verifies bearer/cookie) :contentReference[oaicite:1]{index=1}
    await api.register(rbac);

    await api.register(meRoutes); // /api/v1/me  (Clerk-backed) :contentReference[oaicite:2]{index=2}
    await api.register(workerRoutes);
    await api.register(adminRoutes);
    await api.register(userRoutes);
    await api.register(auditRoutes);
  };

  // Versioned API — auth + rbac + feature routes
  await app.register(f, { prefix: "/v1" });
  await app.register(f, { prefix: "/api/v1" });

  // Opt-in route table dump
  if (process.env.ROUTE_DUMP === "1") {
    app.get("/__routes", (_req, reply) =>
      reply.type("text/plain").send(app.printRoutes())
    );
  }

  return app;
}
