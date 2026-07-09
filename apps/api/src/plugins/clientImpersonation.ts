import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { prisma } from "../db/prisma";
import {
  CLIENT_IMPERSONATE_HEADER,
  parseClientImpersonationHeader,
} from "../lib/impersonation";

/**
 * Super-only client "View as" plugin.
 *
 * Runs an onRequest hook that:
 *  1. Parses the `x-impersonate-client-contact` header (a ClientContact.id).
 *  2. Verifies the CALLER is really a SUPER (DB check on their roles).
 *  3. Looks up the target ClientContact and its clerkUserId.
 *  4. Sets `req.effectiveClerkUserId` to the target's clerkUserId so
 *     downstream client-facing routes fetch the client's real data.
 *  5. Refuses any mutation method (non-GET) while impersonation is active
 *     — read-only enforcement. Response: 403 with code IMPERSONATION_READONLY.
 *
 * Silently ignores the header when the caller is not SUPER — never leaks
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

    // The caller must actually be a SUPER for the header to do anything.
    // Silent no-op otherwise so we never leak the feature via a 4xx.
    const caller = await prisma.user.findUnique({
      where: { clerkUserId },
      select: { id: true, roles: { select: { role: true } } },
    });
    if (!caller) return;
    const isSuper = caller.roles.some((r) => r.role === "SUPER");
    if (!isSuper) return;

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
 * request — impersonated if a Super view-as session is active, otherwise
 * the caller's own. Use this in place of `req.auth.clerkUserId` in every
 * client-facing route so the impersonation is transparent to route logic.
 */
export function effectiveClerkUserId(req: FastifyRequest): string | undefined {
  const eff = (req as any).effectiveClerkUserId as string | undefined;
  return eff ?? req.auth?.clerkUserId;
}

/** True when the request is a Super-driven client impersonation. */
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
