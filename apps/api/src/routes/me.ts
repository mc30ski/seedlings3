import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../db/prisma";
import { IMPERSONATE_HEADER } from "../lib/impersonation";
import { resolveCutoff } from "../lib/businessStartCutoff";

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

export default async function meRoutes(app: FastifyInstance) {
  app.get("/me", async (req: FastifyRequest, reply: FastifyReply) => {
    // Acquire a token from header or cookie
    const authHeader = readBearer(req);
    const cookieToken = readCookie("__session", req.headers?.cookie as string);
    const token = authHeader || cookieToken;

    if (!token) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "Missing token (header/cookie)",
      });
    } else {
      // Super-only impersonation header — services.users.me ignores it unless
      // the underlying user is actually SUPER (silent fallback), so no extra
      // gating needed here.
      return services.users.me(token, req.headers[IMPERSONATE_HEADER]);
    }
  });

  // Business Start Date — exposes the EFFECTIVE cutoff for the current
  // request so the client can render UI consistently with the API filter.
  // Honors the X-Reveal-Pre-Cutoff header the same way every money endpoint
  // does — i.e. when a Super sends reveal=true, this returns null and the
  // UI shows the unfiltered state. See lib/businessStartCutoff.ts.
  app.get("/me/business-start", { preHandler: app.requireApproved.bind(app) }, async (req: any) => {
    const cutoff = await resolveCutoff(req);
    return {
      // `cutoff` is null when the filter is off (globally OR via reveal
      // header). When non-null, ISO 8601 — UI compares against job dates
      // to decide whether to show "—" for hidden money fields.
      cutoff: cutoff ? cutoff.toISOString() : null,
    };
  });

  app.post("/me/sync", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });

    const user = await prisma.user.findUnique({ where: { clerkUserId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    const u = await clerk.users.getUser(clerkUserId);

    const email = u?.primaryEmailAddress?.emailAddress ?? u?.emailAddresses?.[0]?.emailAddress ?? null;
    const firstName = u?.firstName ?? null;
    const lastName = u?.lastName ?? null;
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const displayName = name || u?.username || null;

    const updates: any = { updatedAt: new Date() };
    if (email && user.email !== email) updates.email = email;
    if (firstName && user.firstName !== firstName) updates.firstName = firstName;
    if (lastName && user.lastName !== lastName) updates.lastName = lastName;
    if (displayName && user.displayName !== displayName) updates.displayName = displayName;

    await prisma.user.update({ where: { id: user.id }, data: updates });

    return { ok: true, synced: Object.keys(updates).filter(k => k !== "updatedAt") };
  });

  // ── Push subscriptions ──────────────────────────────────────────────
  // Per-device web-push subscriptions for the current user. Self-healing:
  // the web app re-subscribes on every PWA launch and POSTs the result;
  // the unique constraint on `endpoint` makes that a no-op when valid and
  // a fresh insert when iOS/Android quietly invalidated the old one.

  app.get("/me/push-subscriptions", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: "User not found" });
    const subs = await prisma.pushSubscription.findMany({
      where: { userId: user.id },
      select: { id: true, endpoint: true, userAgent: true, label: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    });
    return subs;
  });

  app.post("/me/push-subscriptions", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const body = req.body || {};
    const endpoint = String(body.endpoint || "").trim();
    const p256dh = String(body.p256dh || "").trim();
    const auth = String(body.auth || "").trim();
    const userAgent = body.userAgent ? String(body.userAgent).slice(0, 200) : null;
    const label = body.label ? String(body.label).slice(0, 60) : null;

    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).send({ error: "endpoint, p256dh, and auth are required" });
    }

    // Upsert on endpoint — same browser hitting subscribe() returns the same
    // endpoint, so re-subscribe-on-launch is a no-op when nothing changed.
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: user.id, endpoint, p256dh, auth, userAgent, label },
      update: { userId: user.id, p256dh, auth, userAgent, label, lastUsedAt: new Date() },
      select: { id: true, endpoint: true, userAgent: true, label: true, createdAt: true, lastUsedAt: true },
    });
    return sub;
  });

  app.delete("/me/push-subscriptions/:id", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });
    const user = await prisma.user.findUnique({ where: { clerkUserId }, select: { id: true } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const id = String((req.params as any)?.id || "");
    const sub = await prisma.pushSubscription.findUnique({ where: { id }, select: { userId: true } });
    if (!sub) return reply.code(404).send({ error: "Not found" });
    if (sub.userId !== user.id) return reply.code(403).send({ error: "Forbidden" });

    await prisma.pushSubscription.delete({ where: { id } });
    return { ok: true };
  });
}
