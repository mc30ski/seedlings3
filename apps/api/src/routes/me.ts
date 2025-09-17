// apps/api/src/routes/me.ts
import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { Role } from "@prisma/client";

// ---- helpers ---------------------------------------------------------------

function readBearer(req: any): string | null {
  const h = req.headers?.authorization ?? "";
  if (typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m?.[1] ?? null;
}

function readCookie(name: string, cookieHeader?: string): string | null {
  const h = cookieHeader || "";
  if (!h) return null;
  const parts = h.split(";").map((s) => s.trim());
  for (const p of parts) {
    const i = p.indexOf("=");
    if (i === -1) continue;
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function parseBootstrapList() {
  return (process.env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY!;
const clerk = CLERK_SECRET_KEY
  ? createClerkClient({ secretKey: CLERK_SECRET_KEY })
  : null;

export default async function meRoutes(app: FastifyInstance) {
  app.get("/me", async (req, reply) => {
    // 0) Env sanity
    if (!CLERK_SECRET_KEY) {
      app.log.error("[/me] CLERK_SECRET_KEY is not set");
      return reply.code(500).send({
        code: "SERVER_MISCONFIGURED",
        message: "Missing Clerk secret",
      });
    }

    // 1) Acquire a token from header or cookie
    const authHeader = readBearer(req);
    const cookieToken = readCookie("__session", req.headers?.cookie as string);
    const token = authHeader || cookieToken;

    app.log.info(
      {
        hasAuthHeader: !!authHeader,
        hasSessionCookie: !!cookieToken,
        using: authHeader ? "authorization" : cookieToken ? "cookie" : "none",
      },
      "[/me] token sourcing"
    );

    if (!token) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Missing token (header/cookie)",
      });
    }

    // 2) Verify token with Clerk
    let clerkUserId: string;
    try {
      const payload = await verifyToken(token, { secretKey: CLERK_SECRET_KEY });
      clerkUserId = String((payload as any).sub);
      if (!clerkUserId) throw new Error("Missing sub in token");
      app.log.info({ clerkUserId }, "[/me] token verified");
    } catch (err) {
      app.log.warn({ err }, "[/me] token verification failed");
      return reply
        .code(401)
        .send({ code: "UNAUTHORIZED", message: "Invalid token" });
    }

    // 3) Fetch Clerk profile (for email/displayName + bootstrap check)
    let fetchedEmail: string | undefined;
    let fetchedDisplayName: string | undefined;
    try {
      if (clerk) {
        const u = await clerk.users.getUser(clerkUserId);
        fetchedEmail =
          u.primaryEmailAddress?.emailAddress ??
          u.emailAddresses?.[0]?.emailAddress ??
          undefined;
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        fetchedDisplayName = (name || u.username || undefined) ?? undefined;

        app.log.info(
          {
            clerkUserId,
            fetchedEmail: !!fetchedEmail,
            fetchedDisplayName: !!fetchedDisplayName,
          },
          "[/me] fetched Clerk profile"
        );
      }
    } catch (e) {
      app.log.warn(
        { clerkUserId, error: (e as Error).message },
        "[/me] Clerk profile fetch failed (continuing)"
      );
    }

    // 4) Ensure local DB user exists (create if missing)
    let user = await prisma.user.findUnique({
      where: { clerkUserId },
      include: { roles: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          clerkUserId,
          email: fetchedEmail,
          displayName: fetchedDisplayName,
          isApproved: false,
        },
        include: { roles: true },
      });
      app.log.info({ clerkUserId, dbUserId: user.id }, "[/me] created DB user");
    } else if (
      (!user.email || !user.displayName) &&
      (fetchedEmail || fetchedDisplayName)
    ) {
      user = await prisma.user.update({
        where: { clerkUserId },
        data: {
          email: user.email ?? fetchedEmail,
          displayName: user.displayName ?? fetchedDisplayName,
        },
        include: { roles: true },
      });
      app.log.info(
        {
          clerkUserId,
          filledEmail: !user.email ? !!fetchedEmail : false,
          filledName: !user.displayName ? !!fetchedDisplayName : false,
        },
        "[/me] backfilled DB user fields"
      );
    }

    // 5) Bootstrap admins via ADMIN_BOOTSTRAP_EMAILS (idempotent)
    const bootstrapEmails = parseBootstrapList();
    const normalizedEmail = (user.email ?? fetchedEmail ?? "").toLowerCase();
    const shouldBootstrap =
      normalizedEmail && bootstrapEmails.includes(normalizedEmail);

    if (shouldBootstrap) {
      await prisma.$transaction(async (tx) => {
        if (!user!.isApproved) {
          await tx.user.update({
            where: { id: user!.id },
            data: { isApproved: true },
          });
        }
        await tx.userRole.upsert({
          where: { userId_role: { userId: user!.id, role: Role.WORKER } },
          update: {},
          create: { userId: user!.id, role: Role.WORKER },
        });
        await tx.userRole.upsert({
          where: { userId_role: { userId: user!.id, role: Role.ADMIN } },
          update: {},
          create: { userId: user!.id, role: Role.ADMIN },
        });
      });
      user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });
      app.log.info(
        {
          clerkUserId,
          email: normalizedEmail,
          roles: user?.roles.map((r) => r.role),
        },
        "[/me] bootstrapped as ADMIN"
      );
    }

    // 6) Respond
    const me = {
      id: user!.id,
      isApproved: !!user!.isApproved,
      roles: (user!.roles ?? []).map((r) => r.role) as ("ADMIN" | "WORKER")[],
      email: user!.email ?? null,
      displayName: user!.displayName ?? null,
    };

    app.log.info(
      {
        clerkUserId,
        dbUserId: me.id,
        approved: me.isApproved,
        roles: me.roles,
      },
      "[/me] done"
    );

    return me;
  });
}
