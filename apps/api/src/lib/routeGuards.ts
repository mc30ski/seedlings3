import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { can, type Principal } from "@repo/permissions";
import type { Entitlement } from "@repo/permissions";
import { ServiceError } from "./errors";

/**
 * ROUTE GUARDS — one factory, one path.
 *
 * Before this, ten route files each declared their own role guards
 * locally — three of them, 204 / 202 / 171 uses. Identical bodies, ten
 * copies, and no way to change the rule once.
 *
 * THE CORD IS CUT. There is no `ENTITLEMENTS_ENABLED` flag any more and no
 * legacy branch: `requires(entitlement)` asks `can()` and nothing else. The
 * flag existed so one deploy could not change every permission in the app at
 * once with no way back — a real risk, and the right call while two models
 * ran side by side. It is gone because two models no longer exist: the `Role`
 * enum has been removed, so "fall back to the role check" has nothing to
 * fall back to. Keeping a dead branch would have been worse than deleting
 * it, because a dual path nobody exercises is a path nobody notices breaking.
 *
 * WHY THERE ARE NO ROLE-NAMED GUARDS
 * They named a ROLE, and roles are not what authorizes anything now. A
 * route that used to say "someone with `routes.plan` may do this" now says which capability it
 * needs, which is the thing that was actually meant — and it means an
 * operator can grant that capability to a bookkeeper without making them an
 * admin. Any route still wanting "someone with `routes.plan`" would be asking the one question
 * this model exists to stop asking.
 *
 * WHY `approvedUser` IS NOT AN ENTITLEMENT
 * About a hundred routes are OWNERSHIP: my own earnings, my own dashboard, my
 * own pinned jobs. They need the caller signed in and approved, and then they
 * check that the record belongs to them. There is no capability to hold —
 * `earnings.view-own` would be an entitlement every single person has, which
 * is a check that always passes and therefore not a check at all. The guard
 * is named for what it does so nobody mistakes it for one.
 */

export type RouteGuard = {
  preHandler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

export function makeGuards(app: FastifyInstance) {
  return {
    /**
     * Signed in and approved. For OWNERSHIP routes, which then scope their
     * own query to the caller. Not a role, and deliberately not an
     * entitlement — see the note above.
     */
    approvedUser: {
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        await app.requireApproved(req, reply);
      },
    } satisfies RouteGuard,

    /** Declare the capability a route needs. */
    requires(entitlement: Entitlement): RouteGuard {
      return {
        preHandler: async (req, reply) => {
          // Approval first, because it is what populates `req.principal`.
          await app.requireApproved(req, reply);
          const principal = (req as any).principal as Principal | undefined;
          if (!principal || !can(principal, entitlement)) {
            // SAY WHICH CAPABILITY WAS MISSING. The guard is the only place
            // that knows, and it used to throw the name away — leaving the
            // web app to render the bare word `NOT_AUTHORIZED` next to a
            // sentence that could not tell a missing capability from an
            // unapproved account.
            //
            // `app.httpErrors.forbidden` has no channel for detail, so this
            // uses the ServiceError shape the compliance gate already uses;
            // `errorMapper` passes `details` through untouched.
            //
            // The entitlement is not a secret: the person is signed in and
            // approved, every id is listed in the role builder, and naming
            // it is what lets the refusal say "You don't have permission to
            // approve a payment" in the entitlement's own words.
            throw new ServiceError(
              "NOT_AUTHORIZED",
              "You don't have permission to do that.",
              403,
              { entitlement },
            );
          }
        },
      };
    },
  };
}

export type Guards = ReturnType<typeof makeGuards>;
