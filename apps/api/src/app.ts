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

export async function buildApp() {
  const app = Fastify({ logger: true });

  // ---- simple global route capture + endpoint (for /__routes) ----
  type RouteRow = { method: string; path: string };
  const __routes: RouteRow[] = [];

  app.addHook("onRoute", (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    const rawPath = (opts as any).url ?? (opts as any).path ?? "/";
    const path = String(rawPath).replace(/\/{2,}/g, "/");
    for (const m of methods) {
      __routes.push({ method: String(m), path });
    }
  });

  app.get("/__routes", async (req, reply) => {
    const wantsJSON =
      String(req.headers.accept ?? "").includes("application/json") ||
      (req.query as any)?.format === "json";

    const hasGET = new Set(
      __routes.filter((r) => r.method === "GET").map((r) => r.path)
    );
    const rows = __routes
      .filter((r) => !(r.method === "HEAD" && hasGET.has(r.path)))
      .sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
      );

    if (wantsJSON) return reply.send(rows);

    const lines = rows.map((r) => `${r.method.padEnd(6)} ${r.path}`);
    return reply.type("text/plain; charset=utf-8").send(lines.join("\n"));
  });
  // -----------------------------------------------------------------

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
  await app.register(sensible);
  await app.register(errorMapper);

  // Public (unguarded) routes at root
  await app.register(systemRoutes); // /hello, /healthz  (root only)
  await app.register(versionRoutes); // /version and /api/v1/version (public)

  // Guarded API under /api/v1
  await app.register(
    async (api) => {
      await api.register(devAuth); // must attach request.user
      await api.register(rbac, {
        defaultPolicy: {
          public: false,
          requireAuth: true,
          approved: true,
          // roles undefined by default; plugin applies safe path fallbacks
        },
      });

      // Register feature routes WITHOUT per-route prefixes here
      await api.register(meRoutes);
      await api.register(workerRoutes);
      await api.register(adminRoutes);
      await api.register(userRoutes);
      await api.register(auditRoutes);
    },
    { prefix: "/api/v1" }
  );

  return app;
}
