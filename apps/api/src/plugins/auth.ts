import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";

// Fastify auth plugin for Clerk JWTs that also auto-provisions a matching user row in your database.
// This plugin does not reject unauthenticated requests; routes must check req.auth?.clerkUserId and enforce as needed.
// DB “provisioning” happens lazily on first authenticated request.

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY!;
const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });

type Claims = { sub?: string; iat?: number; [k: string]: unknown };

// Best-effort sign-in recorder. Writes a USER.SIGN_IN audit row and
// refreshes the User.lastSignInAt + lastSessionIat columns whenever a
// JWT arrives with a previously-unseen `iat` for this user. Distinct
// sessions mint distinct iat values (Clerk re-signs on sign-in), so
// per-session deduplication falls out naturally — a single session's
// many requests all share one iat and write the audit row once.
//
// Errors are swallowed; recording a sign-in is observability, not
// functionality, and a hiccup here must NOT block the request path.
async function recordSignInIfNew(
  app: FastifyInstance,
  userId: string,
  iat: number | undefined,
  knownIat: number | null,
) {
  if (!iat || iat === knownIat) return;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { lastSignInAt: new Date(iat * 1000), lastSessionIat: iat },
      });
      await writeAudit(tx, AUDIT.USER.SIGN_IN, userId, { iat });
    });
  } catch (e) {
    app.log.warn({
      where: "auth",
      reason: "recordSignInIfNew failed",
      err: (e as Error).message,
    });
  }
}

export default fp(async function auth(app: FastifyInstance) {
  // Registers an onRequest hook (via fastify-plugin) that runs on every request.
  app.addHook("onRequest", async (req, _reply) => {
    // Skips auth for OPTIONS (CORS preflight).
    if (req.method === "OPTIONS") return;

    // Looks for an Authorization: Bearer <token> header. If missing/invalid format, continues (request is not blocked).
    const authz = req.headers.authorization;
    if (!authz?.startsWith("Bearer ")) {
      (req as any).auth = {};
      return;
    }

    const token = authz.slice(7);

    try {
      // Verifies the JWT with Clerk using your CLERK_SECRET_KEY (verifyToken), and reads claims directly (not .payload).
      const claims = (await verifyToken(token, {
        secretKey: CLERK_SECRET_KEY,
      })) as Claims;

      // Extracts sub (the Clerk user id). If missing, logs a warning and continues.
      const rawClerkUserId =
        claims && typeof claims.sub === "string" ? claims.sub : undefined;
      if (!rawClerkUserId) {
        app.log.warn({ where: "auth", reason: "no-sub-in-claims" });
        (req as any).auth = {};
        return;
      }
      // Narrowed const for use inside the nested fetchClerkUser closure
      // — TS doesn't propagate the early-return narrowing across a
      // function boundary.
      const clerkUserId: string = rawClerkUserId;

      // On success, attaches for downstream handlers.
      (req as any).auth = { clerkUserId };

      // Ensures a corresponding user exists in your DB
      // If not found, fetches the Clerk user (server-side SDK), derives information, and creates a new row with isApproved: false.
      const existing = await prisma.user.findUnique({ where: { clerkUserId } });

      // Helper to fetch Clerk user data
      let clerkUser: any = null;
      async function fetchClerkUser() {
        if (clerkUser) return clerkUser;
        try {
          clerkUser = await clerk.users.getUser(clerkUserId);
        } catch (e) {
          app.log.warn({ where: "auth", reason: "clerk-users.getUser failed", err: (e as Error).message });
        }
        return clerkUser;
      }

      function extractClerkData(u: any) {
        const email = u?.primaryEmailAddress?.emailAddress ?? u?.emailAddresses?.[0]?.emailAddress ?? null;
        // Only use verified phone numbers — primaryPhoneNumber is always verified in Clerk;
        // fall back to first verified number if no primary is set
        const phone = u?.primaryPhoneNumber?.phoneNumber
          ?? u?.phoneNumbers?.find((p: any) => p.verification?.status === "verified")?.phoneNumber
          ?? null;
        const firstName = u?.firstName ?? null;
        const lastName = u?.lastName ?? null;
        const name = [firstName, lastName].filter(Boolean).join(" ").trim();
        const displayName = name || u?.username || null;
        return { email, phone, firstName, lastName, displayName };
      }

      const iat = typeof claims?.iat === "number" ? claims.iat : undefined;

      if (!existing) {
        const u = await fetchClerkUser();
        const { email, phone, firstName, lastName, displayName } = extractClerkData(u);

        const created = await prisma.user.create({
          data: {
            clerkUserId,
            email: email ?? undefined,
            phone: phone ?? undefined,
            firstName: firstName ?? undefined,
            lastName: lastName ?? undefined,
            displayName: displayName ?? undefined,
            isApproved: false,
          },
        });
        // Brand-new user → record their first sign-in. lastSessionIat is
        // null by definition, so any iat counts as new.
        void recordSignInIfNew(app, created.id, iat, null);
      } else {
        // Existing user — sync fields from Clerk periodically (every ~1 hour) or when fields are missing
        const syncAge = Date.now() - (existing.updatedAt?.getTime() ?? 0);
        const needsSync = !existing.phone || !existing.email || !existing.firstName || !existing.lastName || syncAge > 10800000;
        if (needsSync) {
          const u = await fetchClerkUser();
          if (u) {
            const { email, phone, firstName, lastName, displayName } = extractClerkData(u);
            const updates: any = {};
            if (email && existing.email !== email) updates.email = email;
            if (phone !== undefined && existing.phone !== phone) updates.phone = phone;
            if (firstName && existing.firstName !== firstName) updates.firstName = firstName;
            if (lastName && existing.lastName !== lastName) updates.lastName = lastName;
            if (displayName && existing.displayName !== displayName) updates.displayName = displayName;
            // Touch updatedAt even if no field changes, to reset the sync timer
            await prisma.user.update({
              where: { id: existing.id },
              data: { ...updates, updatedAt: new Date() },
            });
          }
        }
        // Fire-and-forget so the per-session sign-in record never blocks
        // the request. Internally a no-op when iat hasn't changed.
        void recordSignInIfNew(app, existing.id, iat, existing.lastSessionIat ?? null);
      }
    } catch (e) {
      app.log.warn({
        where: "auth",
        reason: "verifyToken failed",
        err: (e as Error).message,
      });
      (req as any).auth = {};
      return;
    }
  });
});

declare module "fastify" {
  interface FastifyRequest {
    auth?: { clerkUserId?: string };
  }
}
