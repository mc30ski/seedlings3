// apps/api/src/plugins/auth.ts
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { prisma } from "../db/prisma";

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY!;
const clerk = createClerkClient({ secretKey: CLERK_SECRET_KEY });

type Claims = { sub?: string; [k: string]: unknown };

export default fp(async function auth(app: FastifyInstance) {
  app.addHook("onRequest", async (req, _reply) => {
    // Don’t auth OPTIONS (CORS preflight)
    if (req.method === "OPTIONS") return;

    const authz = req.headers.authorization;
    if (!authz?.startsWith("Bearer ")) {
      (req as any).auth = {};
      return;
    }

    const token = authz.slice(7);

    try {
      // IMPORTANT: verifyToken returns claims directly (no `.payload`)
      const claims = (await verifyToken(token, {
        secretKey: CLERK_SECRET_KEY,
      })) as Claims;

      const clerkUserId =
        claims && typeof claims.sub === "string" ? claims.sub : undefined;

      if (!clerkUserId) {
        app.log.warn({ where: "auth", reason: "no-sub-in-claims" });
        (req as any).auth = {};
        return;
      }

      (req as any).auth = { clerkUserId };

      // Ensure a DB user row exists
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
