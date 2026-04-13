import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../db/prisma";

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
      return services.users.me(token);
    }
  });

  app.post("/me/sync", async (req: any, reply: FastifyReply) => {
    const clerkUserId = req.auth?.clerkUserId;
    if (!clerkUserId) return reply.code(401).send({ error: "Unauthorized" });

    const user = await prisma.user.findUnique({ where: { clerkUserId } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    const u = await clerk.users.getUser(clerkUserId);

    const email = u?.primaryEmailAddress?.emailAddress ?? u?.emailAddresses?.[0]?.emailAddress ?? null;
    const phone = u?.primaryPhoneNumber?.phoneNumber
      ?? u?.phoneNumbers?.find((p: any) => p.verification?.status === "verified")?.phoneNumber
      ?? null;
    const firstName = u?.firstName ?? null;
    const lastName = u?.lastName ?? null;
    const name = [firstName, lastName].filter(Boolean).join(" ").trim();
    const displayName = name || u?.username || null;

    const updates: any = { updatedAt: new Date() };
    if (email && user.email !== email) updates.email = email;
    if (user.phone !== phone) updates.phone = phone;
    if (firstName && user.firstName !== firstName) updates.firstName = firstName;
    if (lastName && user.lastName !== lastName) updates.lastName = lastName;
    if (displayName && user.displayName !== displayName) updates.displayName = displayName;

    await prisma.user.update({ where: { id: user.id }, data: updates });

    return { ok: true, synced: Object.keys(updates).filter(k => k !== "updatedAt") };
  });
}
