// apps/api/src/app.ts
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

  // --- CORS helpers (more debuggable, with regex/wildcard options) ---
  function parseAllowedOrigins(): string[] {
    return (process.env.WEB_ORIGIN ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const WEB_ORIGIN_REGEX = process.env.WEB_ORIGIN_REGEX
    ? new RegExp(process.env.WEB_ORIGIN_REGEX)
    : null;

  function isOriginAllowed(origin?: string): boolean {
    // Dev: allow localhost (and no Origin like curl)
    if (process.env.NODE_ENV !== "production") {
      if (!origin) return true;
      if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return true;
    }
    if (!origin) return false;

    // Wildcard: allow any
    if ((process.env.WEB_ORIGIN ?? "").trim() === "*") return true;

    // Regex for preview domains (optional)
    if (WEB_ORIGIN_REGEX && WEB_ORIGIN_REGEX.test(origin)) return true;

    // Exact-match list (default prod behavior)
    return parseAllowedOrigins().includes(origin);
  }

  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => cb(null, isOriginAllowed(origin ?? undefined)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    // omit allowedHeaders => plugin reflects Access-Control-Request-Headers
  };

  await app.register(cors, corsOptions); // keep CORS early (as in your repo) :contentReference[oaicite:1]{index=1}
  await app.register(sensible); // BEFORE auth/RBAC (unchanged)      :contentReference[oaicite:2]{index=2}
  await app.register(auth);
  await app.register(errorMapper);

  // Ensure ACAO is present even on 401/403/etc for allowed origins
  app.addHook("onSend", (req, reply, payload, done) => {
    const origin = req.headers.origin as string | undefined;
    if (origin && isOriginAllowed(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      if (corsOptions.credentials) {
        reply.header("Access-Control-Allow-Credentials", "true");
      }
    }
    done();
  });

  // Quick introspection endpoint (remove later if you want)
  app.get("/debug/cors", async (req) => {
    const origin = (req.headers.origin as string | undefined) ?? null;
    return {
      nodeEnv: process.env.NODE_ENV,
      origin,
      allowed: isOriginAllowed(origin ?? undefined),
      WEB_ORIGIN: process.env.WEB_ORIGIN ?? null,
      WEB_ORIGIN_REGEX: process.env.WEB_ORIGIN_REGEX ?? null,
    };
  });

  // Public routes (unchanged)
  await app.register(systemRoutes);
  await app.register(versionRoutes);

  // Guarded API under /api/v1 (unchanged shape/order) :contentReference[oaicite:3]{index=3}
  await app.register(
    async (api) => {
      await api.register(rbac);
      await api.register(meRoutes);
      await api.register(workerRoutes);
      await api.register(adminRoutes);
      await api.register(userRoutes);
      await api.register(auditRoutes);
      await api.register(debugRoutes);
    },
    { prefix: "/api/v1" }
  );

  return app;
}
