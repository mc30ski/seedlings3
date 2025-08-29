// apps/api/src/plugins/rbac.ts
// Flexible RBAC for Fastify v4 with per-route config via `config.auth`.
// Register this plugin INSIDE the /api/v1 scope.

import type { FastifyPluginAsync } from "fastify";

export type Role = "ADMIN" | "WORKER";

export type UserContext = {
  id: string;
  isApproved: boolean;
  roles: Role[];
  email?: string | null;
  displayName?: string | null;
};

// ---- Augment Fastify types ----
declare module "fastify" {
  interface FastifyRequest {
    user?: UserContext;
  }
  // This is how you type `routeOptions.config` in Fastify v4
  interface FastifyContextConfig {
    auth?: {
      public?: boolean; // if true: public, skip all checks
      requireAuth?: boolean; // if false: no auth required (default true)
      approved?: boolean; // if false: no approval required (default true)
      roles?: Role[]; // if set: require one of these roles
    };
  }
}

// Local type used for merging policies
type AuthConfig = {
  public?: boolean;
  requireAuth?: boolean;
  approved?: boolean;
  roles?: Role[];
};

type RbacOptions = {
  defaultPolicy?: Required<
    Pick<AuthConfig, "public" | "requireAuth" | "approved">
  > & {
    roles?: Role[];
  };
};

const rbac: FastifyPluginAsync<RbacOptions> = async (app, opts) => {
  const defaults: Required<
    Pick<AuthConfig, "public" | "requireAuth" | "approved">
  > & {
    roles?: Role[];
  } = {
    public: false,
    requireAuth: true,
    approved: true,
    roles: undefined,
    ...(opts?.defaultPolicy ?? {}),
  };

  // Public endpoints you want open under /api/v1
  const PUBLIC_API = new Set<string>(["/api/v1/version"]);

  app.addHook("onRequest", async (request, reply) => {
    const path = (request.raw.url || "/").split("?", 1)[0] || "/";

    // Only guard /api/v1/**. Everything else (/, /healthz, /hello, /version) is public.
    if (!path.startsWith("/api/v1/")) return;

    // Explicit allowlist within /api/v1
    if (PUBLIC_API.has(path)) return;

    // Read per-route config (typed via FastifyContextConfig above)
    const routeOpts = (request as any).routeOptions ?? {};
    const routeAuth: AuthConfig | undefined = routeOpts?.config?.auth;

    // Merge defaults with per-route
    let policy: Required<
      Pick<AuthConfig, "public" | "requireAuth" | "approved">
    > & {
      roles?: Role[];
    } = { ...defaults, ...(routeAuth ?? {}) };

    // If no per-route override, apply safe path-based fallbacks
    if (!routeAuth) {
      if (
        path.startsWith("/api/v1/admin") ||
        path.startsWith("/api/v1/users") ||
        path.startsWith("/api/v1/audit")
      ) {
        policy = { ...policy, roles: ["ADMIN"] };
      } else {
        policy = { ...policy, roles: ["WORKER", "ADMIN"] };
      }
    }

    if (policy.public) return;

    const user = request.user;

    if (policy.requireAuth && !user) {
      return reply
        .code(401)
        .send({ error: "UNAUTHORIZED", message: "Sign in required" });
    }

    if (policy.approved && user && user.isApproved === false) {
      return reply
        .code(403)
        .send({ error: "FORBIDDEN", message: "Account not approved" });
    }

    if (policy.roles?.length) {
      const ok = user?.roles?.some((r) => policy.roles!.includes(r)) ?? false;
      if (!ok) {
        return reply
          .code(403)
          .send({
            error: "FORBIDDEN",
            message: `Requires role: ${policy.roles.join(" or ")}`,
          });
      }
    }
  });
};

export default rbac;
