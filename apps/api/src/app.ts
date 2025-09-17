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

  async function registerApi(app: FastifyInstance) {
    await app.register(auth);
    await app.register(rbac);
    await app.register(meRoutes);
    await app.register(workerRoutes);
    await app.register(adminRoutes);
    await app.register(userRoutes);
    await app.register(auditRoutes);
  }

  await app.register(registerApi, { prefix: "/api/v1" }); // for local
  await app.register(registerApi, { prefix: "/v1" }); // for Vercel

  // Opt-in route table dump
  if (process.env.ROUTE_DUMP === "1") {
    app.get("/__routes", (_req, reply) =>
      reply.type("text/plain").send(app.printRoutes())
    );
  }

  return app;
}
