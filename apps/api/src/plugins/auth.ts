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
      if (!existing) {
        let email: string | null = null;
        let displayName: string | null = null;

        try {
          const u = await clerk.users.getUser(clerkUserId);
          email =
            u.primaryEmailAddress?.emailAddress ??
            u.emailAddresses?.[0]?.emailAddress ??
            null;
          const name = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(" ")
            .trim();
          displayName = name || u.username || null;
        } catch (e) {
          app.log.warn({
            where: "auth",
            reason: "clerk-users.getUser failed",
            err: (e as Error).message,
          });
        }

        await prisma.user.create({
          data: {
            clerkUserId,
            email: email ?? undefined,
            displayName: displayName ?? undefined,
            isApproved: false,
          },
        });
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
