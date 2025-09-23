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

  // ---------- route capture (unchanged) ----------
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
  // ----------------------------------------------

  // ---------- CORS helpers ----------
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

  // ---------- PRE-FLIGHT SHORT-CIRCUIT ----------
  // Answer OPTIONS immediately with CORS headers *before* auth/RBAC.
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

  // ---------- CORS plugin (kept, but simplified) ----------
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

  // Always attach ACAO on responses (including 401/403) for allowed origins.
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

  // Public routes
  //await app.register(systemRoutes);
  //await app.register(versionRoutes);

  // TESTING DIFFERENT OPTIONS, ONLY /me WORKS ON VERCEL FOR SOME REASON
  //await app.register(meRoutes);
  //await app.register(meRoutes, { prefix: "/v1" });
  /*
  await app.register(
    async (api) => {
      await api.register(meRoutes);
    },
    { prefix: "/v1" }
  );
  */

  /*
  // Guarded API
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
  */

  if (process.env.NODE_ENV === "development") {
    await app.register(
      async (api) => {
        await api.register(systemRoutes);
        await api.register(versionRoutes);

        await api.register(rbac);
        await api.register(meRoutes);
        await api.register(workerRoutes);
        await api.register(adminRoutes);
        await api.register(userRoutes);
        await api.register(auditRoutes);
        await api.register(debugRoutes);
      },
      { prefix: "/api" }
    );
  } else {
    console.log("MIKEW app.ts", "SHOULD ONLY RUN ONCE");

    await app.register(async (api) => {
      await api.register(systemRoutes);
      await api.register(versionRoutes);

      await api.register(rbac);
      await api.register(meRoutes);
      await api.register(workerRoutes);
      await api.register(adminRoutes);
      await api.register(userRoutes);
      await api.register(auditRoutes);
      await api.register(debugRoutes);
    });

    /*
    await app.register(systemRoutes);
    await app.register(versionRoutes);

    await app.register(rbac);
    await app.register(meRoutes);
    await app.register(workerRoutes);
    await app.register(adminRoutes);
    await app.register(userRoutes);
    await app.register(auditRoutes);
    await app.register(debugRoutes);
    */
  }

  return app;
}
