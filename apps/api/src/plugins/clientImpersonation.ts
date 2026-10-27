import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/prisma";
import {
  CLIENT_IMPERSONATE_HEADER,
  PERSPECTIVE_HEADER,
  parseClientImpersonationHeader,
  resolvePerspective,
} from "../lib/impersonation";
import { capabilitiesForUsers } from "../lib/userCapabilities";
import { availablePerspectives } from "../lib/perspectives";
import { isEntitlement, type Entitlement } from "@repo/permissions";

/**
 * docs/features/client-view-as.md: the actor is "a real Super user with a
 * valid Clerk session. Never anyone" else. NOT `identity.link`, which is
 * data entry the baseline Admin role holds — linking a login to a customer
 * record is not the
 * same authority as reading that customer's entire portal as them.
 */
const CLIENT_VIEW_AS: Entitlement = "clients.view-as";

/**
 * The client "View as" plugin — `clients.view-as`.
 *
 * Runs an onRequest hook that:
 *  1. Parses the `x-impersonate-client-contact` header (a ClientContact.id).
 *  2. Verifies the CALLER is really someone with `clients.view-as` (DB check on their roles).
 *  3. Looks up the target ClientContact and its clerkUserId.
 *  4. Sets `req.effectiveClerkUserId` to the target's clerkUserId so
 *     downstream client-facing routes fetch the client's real data.
 *  5. Refuses any mutation method (non-GET) while impersonation is active
 *     — read-only enforcement. Response: 403 with code IMPERSONATION_READONLY.
 *
 * Silently ignores the header without `clients.view-as` — never leaks
 * whether the feature exists via a 4xx.
 *
 * Route-level integration: client-facing route handlers must prefer
 * `effectiveClerkUserId(req)` over `req.auth.clerkUserId` so they read
 * the impersonated data. See routes/client.ts.
 */
export default fp(async (app: FastifyInstance) => {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = req.headers[CLIENT_IMPERSONATE_HEADER];
    const targetId = parseClientImpersonationHeader(raw);
    if (!targetId) return; // Header absent or malformed — no-op.

    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return; // Not authenticated — auth layer handles this.

    // THE GATE, AND WHY IT IS HERE RATHER THAN DOWNSTREAM.
    //
    // I moved this check out once, reasoning that the hook only RECORDS the
    // request and `services.users.me()` makes the real decision. That was
    // wrong, and an e2e security spec caught it: an Employee forging the
    // header got a client's data back from `/client/me`.
    //
    // The mistake was verifying the wrong symbol. I grepped for
    // `impersonatedContact` — one consumer — and missed that this hook also
    // sets `effectiveClerkUserId`, which `clientGuard` reads and then uses
    // to PATCH `req.auth.clerkUserId`. Every `/client/*` route then serves
    // the target's data transparently, never touching `users.me()` at all.
    // Three fields leave here; only one of them was audited.
    //
    // So the decision belongs in the hook, which means resolving the
    // caller's capabilities before any principal exists. The cost is
    // acceptable: everything above returns early unless the impersonation
    // header is actually present, so this runs on impersonation requests
    // only, not on every request.
    //
    // PERSPECTIVE IS APPLIED, which is what the old `userCan` call got
    // wrong. A fresh read by id returns someone's real grants and ignores
    // the perspective they are looking through, so someone with `clients.view-as` viewing as a Trainee
    // kept the power to open a client session. `availablePerspectives`
    // guarantees a perspective is a SUBSET of what the person holds, so
    // "allowed" is: they hold it, and the active perspective still includes it.
    const caller = await prisma.user.findUnique({
      where: { clerkUserId },
      select: { id: true, workerType: true },
    });
    if (!caller) return;
    // Pay class is the first gate — being in the system is not being
    // cleared to act in it (G31).
    if (caller.workerType === null) return;

    // caller-read-allow: an onRequest hook runs before every route
    // preHandler, so `req.principal` does not exist yet and there is no
    // narrowed set to read. The perspective is therefore applied by hand
    // immediately below, which is the property the ban on fresh caller
    // reads exists to protect.
    const held = (await capabilitiesForUsers(prisma, [caller.id])).get(caller.id) ?? new Set();
    if (!held.has(CLIENT_VIEW_AS)) return;

    const roles = await prisma.customRole.findMany({
      select: {
        id: true, name: true, key: true, inheritsFromId: true,
        isPerspective: true, perspectiveOrder: true, perspectiveIcon: true,
        entitlements: { select: { entitlement: true } },
      },
    });
    const byId = new Map(
      roles.map((r) => [r.id, {
        id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
        isPerspective: r.isPerspective, perspectiveOrder: r.perspectiveOrder,
        perspectiveIcon: r.perspectiveIcon,
        entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement),
      }]),
    );
    const heldRoleIds = (
      await prisma.userCustomRole.findMany({
        where: { userId: caller.id, suspendedAt: null, customRole: { suspendedAt: null } },
        select: { customRoleId: true },
      })
    ).map((g) => g.customRoleId);
    const perspective = resolvePerspective(
      availablePerspectives(heldRoleIds, byId as never),
      req.headers[PERSPECTIVE_HEADER],
    );
    // Looking through a narrower perspective means not holding it right now.
    if (perspective && !perspective.entitlements.includes(CLIENT_VIEW_AS)) return;

    // Look up the target contact. Must exist AND have a Clerk account —
    // otherwise there's nothing to impersonate.
    const contact = await prisma.clientContact.findUnique({
      where: { id: targetId },
      select: {
        id: true,
        clerkUserId: true,
        firstName: true,
        lastName: true,
        clientId: true,
        client: { select: { id: true, displayName: true } },
      },
    });
    if (!contact || !contact.clerkUserId) {
      // Bad ID or contact has no Clerk account — refuse with a specific
      // code so the frontend can surface the reason ("this contact has
      // never logged in"). Safe to 4xx here because reaching this point
      // required a valid Super token AND a well-formed header.
      reply.code(400).send({
        code: "IMPERSONATION_TARGET_INVALID",
        message: contact
          ? "This contact has no Clerk account and cannot be impersonated."
          : "Impersonation target not found.",
      });
      return reply;
    }

    // Read-only enforcement. Any non-GET method while impersonating is
    // refused — no mutations under a client's identity, ever, regardless
    // of the endpoint's specific business logic.
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      reply.code(403).send({
        code: "IMPERSONATION_READONLY",
        message:
          "Client impersonation is read-only. Exit the view-as session before performing this action.",
      });
      return reply;
    }

    // Attach effective identity + impersonation flag to the request so
    // downstream route handlers can distinguish real client access from
    // Super-impersonated access. Audit logs (if triggered by GETs — rare)
    // can attribute to the real caller via `req.auth.clerkUserId`.
    (req as any).effectiveClerkUserId = contact.clerkUserId;
    (req as any).isClientImpersonating = true;
    (req as any).impersonatedContact = {
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      clientId: contact.clientId,
      clientDisplayName: contact.client?.displayName ?? null,
    };
  });
});

/**
 * Route-side helper: returns the effective Clerk user ID for the current
 * request — impersonated if someone with `clients.view-as` view-as session is active, otherwise
 * the caller's own. Use this in place of `req.auth.clerkUserId` in every
 * client-facing route so the impersonation is transparent to route logic.
 */
export function effectiveClerkUserId(req: FastifyRequest): string | undefined {
  const eff = (req as any).effectiveClerkUserId as string | undefined;
  return eff ?? req.auth?.clerkUserId;
}

/** True when the request is someone with `clients.view-as`-driven client impersonation. */
export function isClientImpersonating(req: FastifyRequest): boolean {
  return (req as any).isClientImpersonating === true;
}

// ─────────────────────────────────────────────────────────────────────────
// Type augmentation
// ─────────────────────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    effectiveClerkUserId?: string;
    isClientImpersonating?: boolean;
    impersonatedContact?: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      clientId: string;
      clientDisplayName: string | null;
    };
  }
}
