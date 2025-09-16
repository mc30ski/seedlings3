// apps/api/src/routes/system.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";

// (add these small helpers near the top)
function maskHost(host?: string) {
  if (!host) return undefined;
  const parts = host.split(".");
  if (parts[0]) parts[0] = parts[0].replace(/.(?=.{4})/g, "*");
  return parts.join(".");
}
function parseDbInfo(url?: string) {
  try {
    if (!url) return {};
    const u = new URL(url);
    return {
      host: u.hostname,
      dbName: u.pathname.replace(/^\//, "") || undefined,
      provider: /\.neon\.tech$/i.test(u.hostname) ? "neon" : "postgres",
    };
  } catch {
    return {};
  }
}

export default async function systemRoutes(app: FastifyInstance) {
  app.get("/hello", async (_req, _reply) => ({ message: "Hello from API" }));

  app.get("/healthz", async (req, reply) => {
    try {
      // Cast 'name' -> text to keep Prisma happy
      const [{ db, now_utc, user }] = await prisma.$queryRaw<
        { db: string; now_utc: Date; user: string }[]
      >`
        select
          current_database()::text as db,
          now() at time zone 'utc'      as now_utc,
          current_user::text            as user
      `;

      // Neon metadata (returns text already; 'true' makes it missing_ok)
      const [neon] = await prisma.$queryRaw<
        {
          branch: string | null;
          branch_id: string | null; // ⬅️ added
          project_id: string | null;
          timeline_id: string | null;
        }[]
      >`
        select
          current_setting('neon.branch', true)      as branch,
          current_setting('neon.branch_id', true)   as branch_id,   -- ⬅️ added
          current_setting('neon.project_id', true)  as project_id,
          current_setting('neon.timeline_id', true) as timeline_id
      `;

      const parsedHost = (() => {
        try {
          return new URL(process.env.DATABASE_URL ?? "").hostname;
        } catch {
          return undefined;
        }
      })();
      const hostMasked = parsedHost
        ? parsedHost
            .split(".")
            .map((part, i) =>
              i === 0 ? part.replace(/.(?=.{4})/g, "*") : part
            )
            .join(".")
        : undefined;

      const vercelEnv =
        process.env.VERCEL_ENV ||
        (process.env.VERCEL ? "production" : "development");

      return reply.send({
        ok: true,
        env: vercelEnv, // "production" | "preview" | "development"
        now: now_utc,
        db: {
          up: true,
          parsedHost: parsedHost,
          provider: /\.neon\.tech$/i.test(parsedHost ?? "")
            ? "neon"
            : "postgres",
          name: db,
          host: hostMasked,
          user,
          neon:
            neon && (neon.branch || neon.project_id || neon.timeline_id)
              ? {
                  branchId: neon?.branch_id ?? null,
                  branch: neon?.branch ?? null,
                  projectId: neon?.project_id ?? null,
                  timelineId: neon?.timeline_id ?? null,
                }
              : undefined,
        },
      });
    } catch (err) {
      req.log.error({ err }, "healthz failed");
      return reply.code(500).send({ ok: false, error: "healthz_failed" });
    }
  });
}
