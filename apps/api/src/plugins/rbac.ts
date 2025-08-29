import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { services } from "../services";
import { prisma } from "../db/prisma"; // <-- add this
import "@fastify/sensible"; // brings in app.httpErrors typing

type Role = "ADMIN" | "WORKER";

/** Read a dev role override from header or env (dev only). */
function devRoleFromReq(req: FastifyRequest): Role | null {
  const hdr = (req.headers["x-dev-role"] as string | undefined)?.toUpperCase();
  if (hdr === "ADMIN" || hdr === "WORKER") return hdr;
  const env = (process.env.DEV_ROLE ?? "").toUpperCase();
  if (env === "ADMIN" || env === "WORKER") return env as Role;
  return null;
}

/** Enable bypass by default in dev; toggle with DEV_ROLE_OVERRIDE=0/1 */
const devBypassEnabled =
  (process.env.DEV_ROLE_OVERRIDE ??
    (process.env.NODE_ENV !== "production" ? "1" : "0")) === "1";

export default fp(async (app: FastifyInstance) => {
  app.decorate("requireApproved", async (req: any, _reply: any) => {
    // ---- DEV BYPASS (with DB upsert so FKs work) ----
    if (devBypassEnabled) {
      const devRole = devRoleFromReq(req as FastifyRequest);
      if (devRole) {
        const clerkUserId = devRole === "ADMIN" ? "dev-admin" : "dev-worker";
        const email =
          devRole === "ADMIN" ? "admin@example.com" : "worker@example.com";
        const displayName =
          devRole === "ADMIN" ? "Admin (DEV)" : "Worker (DEV)";

        // Ensure the dev user exists (your schema requires clerkUserId)
        const user = await prisma.user.upsert({
          where: { clerkUserId },
          update: { isApproved: true, email, displayName },
          create: { clerkUserId, isApproved: true, email, displayName },
        });

        // Ensure roles (idempotent composite key userId+role)
        if (devRole === "ADMIN") {
          await prisma.userRole.upsert({
            where: { userId_role: { userId: user.id, role: "ADMIN" } },
            update: {},
            create: { userId: user.id, role: "ADMIN" },
          });
          await prisma.userRole.upsert({
            where: { userId_role: { userId: user.id, role: "WORKER" } },
            update: {},
            create: { userId: user.id, role: "WORKER" },
          });
        } else {
          await prisma.userRole.upsert({
            where: { userId_role: { userId: user.id, role: "WORKER" } },
            update: {},
            create: { userId: user.id, role: "WORKER" },
          });
        }

        // Attach a real, approved user with roles — services can now use req.user.id safely
        req.user = {
          id: user.id,
          clerkUserId,
          isApproved: true,
          roles: devRole === "ADMIN" ? ["ADMIN", "WORKER"] : ["WORKER"],
          email: user.email,
          displayName: user.displayName,
        };
        return; // bypass DB approval/role checks for dev
      }
    }
    // ---- /DEV BYPASS ----

    // Production / no dev override: real auth + approval
    if (!req.auth?.clerkUserId)
      throw app.httpErrors.unauthorized("Missing auth");
    const me = await services.users.me(req.auth.clerkUserId);
    if (!me.isApproved) throw app.httpErrors.forbidden("NOT_APPROVED");
    req.user = me;
  });

  app.decorate("requireRole", async (req: any, reply: any, role: Role) => {
    await app.requireApproved(req, reply);
    if (!req.user?.roles?.includes(role)) {
      throw app.httpErrors.forbidden("NOT_AUTHORIZED");
    }
  });
});

declare module "fastify" {
  interface FastifyInstance {
    requireApproved(req: any, reply: any): Promise<void>;
    requireRole(req: any, reply: any, role: "ADMIN" | "WORKER"): Promise<void>;
  }
}
