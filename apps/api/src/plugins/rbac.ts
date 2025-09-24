import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { services } from "../services";
import { Role } from "../types/services";
import "@fastify/sensible";

// RBAC helper plugin for Fastify.
// It gives you two guards—requireApproved and requireRole—that you can use as pre-handlers to enforce authenticated + approved users and role checks (ADMIN/WORKER), based on a Clerk-authenticated clerkUserId.

export default fp(async (app: FastifyInstance) => {
  /**
   * Require an authenticated & approved user.
   * - Relies on plugins/auth.ts to set req.auth.clerkUserId (verified Clerk token)
   * - Calls services.users.me(clerkUserId) which SHOULD upsert DB user if missing
   * - Throws 401/403 as needed
   * - Attaches req.user for downstream handlers
   */
  app.decorate("requireApproved", async (req: FastifyRequest, _reply: any) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) {
      throw app.httpErrors.unauthorized("Missing auth");
    }

    // This should upsert on first visit (keep the upsert in services.users.me)
    const me = await services.currentUser.me(clerkUserId);

    // Attach for downstream usage
    (req as any).user = me;
    if (!me.isApproved) {
      throw app.httpErrors.forbidden("NOT_APPROVED");
    }
  });

  /**
   * Require a specific role (after approval).
   */
  app.decorate(
    "requireRole",
    async (req: FastifyRequest, reply: any, role: Role) => {
      await app.requireApproved(req, reply);

      const roles = (req as any).user?.roles as Role[] | undefined;

      if (!roles?.includes(role)) {
        throw app.httpErrors.forbidden("NOT_AUTHORIZED");
      }
    }
  );
});

// ----- Fastify module augmentation -----

declare module "fastify" {
  interface FastifyInstance {
    requireApproved(req: FastifyRequest, reply: any): Promise<void>;
    requireRole(req: FastifyRequest, reply: any, role: Role): Promise<void>;
  }

  interface FastifyRequest {
    // set by plugins/auth.ts after Clerk verification
    auth?: {
      clerkUserId?: string;
    };

    // set by requireApproved()
    user?: {
      id: string;
      isApproved: boolean;
      roles: Role[];
      email?: string | null;
      displayName?: string | null;
    };
  }
}
