import { FastifyInstance } from "fastify";
import cors, { type FastifyCorsOptions } from "@fastify/cors";
import sensible from "@fastify/sensible";
import { getVersionInfo } from "./lib/version";
import auth from "./plugins/auth";
import rbac from "./plugins/rbac";
import errorMapper from "./plugins/errorMapper";
import adminRoutes from "./routes/admin";
import auditRoutes from "./routes/audit";
import meRoutes from "./routes/me";
import systemRoutes from "./routes/system";
import usersRoutes from "./routes/users";
import workerRoutes from "./routes/worker";

// ---------- CORS Helpers

function parseAllowedOrigins(): string[] {
  return (process.env.WEB_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ORIGIN_REGEX = process.env.WEB_ORIGIN_REGEX
  ? new RegExp(process.env.WEB_ORIGIN_REGEX)
  : null;

function isOriginAllowed(origin?: string): boolean {
  // dev: allow localhost & no-Origin (curl)
  if (process.env.NODE_ENV !== "production") {
    if (!origin) return true;
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return true;
  }
  if (!origin) return false;

  // wildcard escape hatch
  if ((process.env.WEB_ORIGIN ?? "").trim() === "*") return true;

  // optional regex for preview branches
  if (ORIGIN_REGEX && ORIGIN_REGEX.test(origin)) return true;

  // exact list (default)
  return parseAllowedOrigins().includes(origin);
}

// ---------- Register all routes

export async function registerRoutes(app: FastifyInstance) {
  await app.register((app: FastifyInstance) =>
    app.get("/", async () => {
      return { message: "Use /api", version: getVersionInfo() };
    })
  );
  await app.register((app: FastifyInstance) =>
    app.get("/api", async () => {
      return { message: "API endpoint.", version: getVersionInfo() };
    })
  );

  // ---------- Register all routes

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

  // ---------- Pre-flight short-circuit
  // Answer OPTIONS immediately with CORS headers before auth/RBAC.
  app.addHook("onRequest", (req, reply, done) => {
    if (req.method !== "OPTIONS") return done();

    const origin = (req.headers.origin as string | undefined) ?? undefined;
    const allowed = isOriginAllowed(origin);

    if (process.env.DEBUG_CORS) {
      app.log.info({ origin, allowed, path: req.url }, "CORS preflight");
    }

    if (!allowed) {
      // No ACAO if not allowed (browser will block)
      return reply.code(204).send();
    }

    // Reflect origin + requested headers/methods
    reply.header("Access-Control-Allow-Origin", origin!);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PATCH,DELETE,OPTIONS"
    );
    const reqHeaders =
      (req.headers["access-control-request-headers"] as string | undefined) ??
      "authorization,content-type";
    reply.header("Access-Control-Allow-Headers", reqHeaders);

    return reply.code(204).send();
  });

  // ---------- CORS plugin
  const corsOptions: FastifyCorsOptions = {
    origin: (origin, cb) => cb(null, isOriginAllowed(origin ?? undefined)),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    // omit allowedHeaders so the plugin reflects what the browser asks for
  };
  await app.register(cors, corsOptions);

  await app.register(sensible);
  await app.register(auth);
  await app.register(errorMapper);

  // ---------- Always attach ACAO on responses (including 401/403) for allowed origins.
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

  // ---------- Register all API endpoints
  await app.register(
    async (api) => {
      await api.register(rbac);
      await api.register(systemRoutes);
      await api.register(meRoutes);
      await api.register(adminRoutes);
      await api.register(auditRoutes);
      await app.register(usersRoutes);
      await app.register(workerRoutes);
    },
    { prefix: "/api" }
  );
}
