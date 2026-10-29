import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { services } from "../services";
import { PERSPECTIVE_HEADER, resolvePerspective } from "../lib/impersonation";
import { AREA_LENS_HEADER, parseAreaLensHeader, resolveAreaLensPath } from "../lib/portfolioLens";
import type { Principal } from "@repo/permissions";
import { isEntitlement, type Entitlement, type RoleGrant } from "@repo/permissions";
import "@fastify/sensible";
import { runWithRequestAuditContext, setRequestAuditContext } from "../lib/requestContext";

/**
 * RBAC plugin — resolves WHO is calling, ONCE per request.
 *
 * It decorates one guard, `requireApproved`, which attaches `req.user` (the
 * identity) and `req.principal` (what they may do). Route authorization is
 * `requires(entitlement)` in lib/routeGuards, which calls this first.
 *
 * `requireRole` IS GONE. It took a `Role` enum value and compared it against
 * a roles array; neither exists. Every route that used it now declares the
 * capability it needs instead, which is the question it was always really
 * asking — and means an operator can grant that capability without handing
 * over a whole role.
 */
export default fp(async (app: FastifyInstance) => {
  /**
   * Require an authenticated & approved user.
   * - Relies on plugins/auth.ts to set req.auth.clerkUserId (verified Clerk token)
   * - Calls services.currentUser.me(clerkUserId), which upserts on first visit
   * - Throws 401/403 as needed
   * - Attaches req.user and req.principal for downstream handlers
   */
  // Opened for EVERY request, before anything can need it. The store is
  // empty here; `requireApproved` fills in the perspective once it has
  // resolved one. See lib/requestContext.ts for why this is a `run` at
  // onRequest rather than an `enterWith` later.
  app.addHook("onRequest", (_req, _reply, done) => {
    runWithRequestAuditContext(done);
  });

  app.decorate("requireApproved", async (req: FastifyRequest, _reply: any) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) {
      throw app.httpErrors.unauthorized("Missing auth");
    }

    // Upserts on first visit (the upsert lives in services.currentUser.me).
    const me = await services.currentUser.me(clerkUserId);

    // ── The principal ─────────────────────────────────────────────────────
    //
    // Resolved HERE, once, and assigned on its own line rather than carried
    // on `me`. A `capabilities` or `principal` field living on `me` is the
    // trap: any `{ ...me }` downstream would spread it through a narrowed
    // perspective intact and hand someone their real powers back — silently,
    // with every page rendering normally. G4 fails the build on one.
    //
    // `workerType === null` is the gate: being in the system is not being
    // cleared to act in it. Grants arrive already flattened through
    // inheritance and already filtered for suspension — can() is a pure set
    // operation and assumes both.
    //
    // ── The perspective ───────────────────────────────────────────────────
    //
    // A SUBSET of what this person holds, so they can see the app as someone
    // with less access does. `me.perspectives` was already filtered to roles
    // they hold or inherit, and `resolvePerspective` only ever returns one
    // from that list — which is what makes the header incapable of granting
    // anything. A value they cannot reach is ignored silently rather than
    // refused, so the feature's existence does not leak through a 4xx.
    //
    // This REPLACES the old role swap. That dropped custom-role grants
    // wholesale to avoid leaking them, so it could only ever show the
    // generic worker experience — someone with `settings.manage` could not actually check what one
    // of their own people sees. Narrowing the real set shows exactly that.
    const perspective = resolvePerspective(
      me.perspectives ?? [],
      req.headers[PERSPECTIVE_HEADER],
    );

    // ── The portfolio lens ─────────────────────────────────────────────────────
    //
    // "Show me only Durham", for somebody entitled to see more. Resolved
    // here, onto the principal, so that all 100+ existing
    // `portfolioWhere(principal, …)` query sites honour it without an edit — and
    // so a view written next year honours it too.
    //
    // UNVALIDATED ON PURPOSE. Whether the caller may look there is settled
    // by intersection in portfolioScope, where a lens outside their grants
    // yields nothing rather than that territory's rows. Checking it here as
    // well would add a second place to get it wrong and a 4xx that leaks
    // which portfolios exist.
    const lensPath = await resolveAreaLensPath(
      parseAreaLensHeader(req.headers[AREA_LENS_HEADER]),
    );

    const principal: Principal = {
      kind: "user",
      workerType: me.workerType,
      roles: (me.roleGrants ?? []).map((g) => ({
        roleId: g.roleId,
        name: g.name,
        entitlements: g.entitlements.filter(isEntitlement) as Entitlement[],
        ...(g.portfolioPath ? { portfolioPath: g.portfolioPath } : {}),
      })) satisfies RoleGrant[],
      perspective,
      lensPath,
    };

    // Attach for downstream usage.
    (req as any).user = me;
    (req as any).principal = principal;
    // AND FOR THE AUDIT TRAIL, ambiently. `writeAudit` has 369 call sites
    // and none of them can reasonably be asked to carry this; the fact
    // belongs to the request. See lib/requestContext.ts — it is a label
    // for an audit row and is never consulted by any permission check.
    // The NAME comes from `me.perspectives`, not from `perspective` —
    // `resolvePerspective` returns only `{ roleId, entitlements }`. A cast
    // here read `.name` off a type that has no such field and would have
    // written `name: null` into every row forever, which looks like data
    // rather than like a bug.
    setRequestAuditContext({
      perspective: perspective
        ? {
            roleId: perspective.roleId,
            name: (me.perspectives ?? []).find((p) => p.roleId === perspective.roleId)?.name,
          }
        : null,
    });
    if (!me.isApproved) {
      throw app.httpErrors.forbidden("NOT_APPROVED");
    }
  });
});

// ----- Fastify module augmentation -----

declare module "fastify" {
  interface FastifyInstance {
    requireApproved(req: FastifyRequest, reply: any): Promise<void>;
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
      email?: string | null;
      displayName?: string | null;
    };
  }
}
