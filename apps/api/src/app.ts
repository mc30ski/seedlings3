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

  // ---- simple global route capture + endpoint ----
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

    // de-dupe HEAD when GET exists (Fastify auto-adds HEAD)
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
  await app.register(sensible); // Register BEFORE rbac
  await app.register(errorMapper);

  await app.register(systemRoutes);
  await app.register(versionRoutes);

  await app.register(devAuth);
  await app.register(rbac);

  app.register(async (r) => {
    await r.register(meRoutes, { prefix: "/api/v1" });
    await r.register(workerRoutes, { prefix: "/api/v1" });
    await r.register(adminRoutes, { prefix: "/api/v1" });
    await r.register(userRoutes, { prefix: "/api/v1" });
    await r.register(auditRoutes, { prefix: "/api/v1" });
  });

  return app;
}
