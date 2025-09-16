import Fastify from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import sensible from "@fastify/sensible";
import rbac from "./plugins/rbac";
import meRoutes from "./routes/me";
import workerRoutes from "./routes/worker";
import adminRoutes from "./routes/admin";
import userRoutes from "./routes/users";
import auditRoutes from "./routes/audit";
import systemRoutes from "./routes/system";
import versionRoutes from "./routes/version";
import errorMapper from "./plugins/errorMapper";
import auth from "./plugins/auth";
import debugRoutes from "./routes/debug";

export async function buildApp() {
  const app = Fastify({ logger: true });

  // ---- simple global route capture + endpoint ----
  type RouteRow = { method: string; path: string };
  const __routes: RouteRow[] = [];
  app.addHook("onRoute", (opts) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    const rawPath = (opts as any).url ?? (opts as any).path ?? "/";
    const path = String(rawPath).replace(/\/{2,}/g, "/");
    for (const m of methods) __routes.push({ method: String(m), path });
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
  // -----------------------------------------------

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => {
      // Allow localhost in dev (and requests with no Origin like curl)
      if (process.env.NODE_ENV !== "production") {
        if (!origin) return cb(null, true);
        if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
          return cb(null, true);
        }
      }

      // Production: allow only configured origins
      const allowed = (process.env.WEB_ORIGIN ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (!origin) return cb(null, false);
      return cb(null, allowed.includes(origin));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  };

  await app.register(cors, corsOptions);
  await app.register(sensible); // Register BEFORE rbac
  await app.register(auth);
  await app.register(errorMapper);

  await app.register(systemRoutes);
  await app.register(versionRoutes);

  await app.register(
    async (api) => {
      // auth + rbac only apply inside this /api/v1 scope
      await api.register(rbac);

      // Register your feature routes here WITHOUT per-route prefixes
      await api.register(meRoutes);

      await api.register(workerRoutes);
      await api.register(adminRoutes);
      await api.register(userRoutes);
      await api.register(auditRoutes);

      // dev-only
      await api.register(debugRoutes);
    },
    { prefix: "/api/v1" }
  );

  return app;
}
