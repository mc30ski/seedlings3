import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { prisma } from "../db/prisma";

// Fastify auth plugin for Clerk JWTs that also auto-provisions a matching user row in your database.
// This plugin does not reject unauthenticated requests; routes must check req.auth?.clerkUserId and enforce as needed.
// DB “provisioning” happens lazily on first authenticated request.

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY!;
const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });

type Claims = { sub?: string; [k: string]: unknown };

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
      const clerkUserId =
        claims && typeof claims.sub === "string" ? claims.sub : undefined;
      if (!clerkUserId) {
        app.log.warn({ where: "auth", reason: "no-sub-in-claims" });
        (req as any).auth = {};
        return;
      }

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
        const phone = u?.primaryPhoneNumber?.phoneNumber ?? u?.phoneNumbers?.[0]?.phoneNumber ?? null;
        const firstName = u?.firstName ?? null;
        const lastName = u?.lastName ?? null;
        const name = [firstName, lastName].filter(Boolean).join(" ").trim();
        const displayName = name || u?.username || null;
        return { email, phone, firstName, lastName, displayName };
      }

      if (!existing) {
        const u = await fetchClerkUser();
        const { email, phone, firstName, lastName, displayName } = extractClerkData(u);

        await prisma.user.create({
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
      } else {
        // Existing user — sync fields from Clerk (missing fields, or phone/email changes)
        if (!existing.phone || !existing.email || !existing.firstName || !existing.lastName) {
          const u = await fetchClerkUser();
          if (u) {
            const { email, phone, firstName, lastName, displayName } = extractClerkData(u);
            const updates: any = {};
            if (email && existing.email !== email) updates.email = email;
            if (phone && existing.phone !== phone) updates.phone = phone;
            if (!existing.firstName && firstName) updates.firstName = firstName;
            if (!existing.lastName && lastName) updates.lastName = lastName;
            if (!existing.displayName && displayName) updates.displayName = displayName;
            if (Object.keys(updates).length > 0) {
              await prisma.user.update({
                where: { id: existing.id },
                data: updates,
              });
            }
          }
        }
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
