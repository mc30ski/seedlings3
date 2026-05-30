import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal, AuditScope, AuditVerb } from "@prisma/client";
import { prisma } from "../db/prisma";
import { notifyWorker } from "../lib/notifications";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

/**
 * Admin-driven notifications: ad-hoc messages an admin can send to one or more
 * approved users (workers + admins). All sends fan out via `notifyWorker`,
 * which fires SMS + email + push in parallel. Results are written to the
 * AuditEvent log for compliance and a "history" view.
 *
 * Templates are CRUDed under /admin/notification-templates.
 *
 * Rate limit: max 20 admin broadcasts per actor per UTC day.
 */
const RATE_LIMIT_PER_DAY = 20;

async function currentUser(req: any) {
  const clerkUserId = req.auth?.clerkUserId;
  if (!clerkUserId) return null;
  return prisma.user.findUnique({
    where: { clerkUserId },
    select: { id: true, displayName: true, firstName: true, lastName: true },
  });
}

export default async function notifyRoutes(app: FastifyInstance) {
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };

  // ── Templates CRUD ───────────────────────────────────────────────

  app.get("/admin/notification-templates", adminGuard, async () => {
    return prisma.notificationTemplate.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  });

  app.post("/admin/notification-templates", adminGuard, async (req: any, reply) => {
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const body = String(b.body || "").trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (!body) return reply.code(400).send({ error: "body is required" });
    return prisma.notificationTemplate.create({
      data: {
        name: name.slice(0, 80),
        title: b.title ? String(b.title).slice(0, 120) : null,
        body: body.slice(0, 1000),
        sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : 100,
      },
    });
  });

  app.patch("/admin/notification-templates/:id", adminGuard, async (req: any, reply) => {
    const id = String((req.params as any)?.id || "");
    const b = req.body || {};
    const data: any = {};
    if (typeof b.name === "string") data.name = b.name.trim().slice(0, 80);
    if ("title" in b) data.title = b.title ? String(b.title).slice(0, 120) : null;
    if (typeof b.body === "string") data.body = b.body.trim().slice(0, 1000);
    if (typeof b.sortOrder === "number") data.sortOrder = b.sortOrder;
    if (Object.keys(data).length === 0) return reply.code(400).send({ error: "Nothing to update" });
    try {
      return await prisma.notificationTemplate.update({ where: { id }, data });
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  app.delete("/admin/notification-templates/:id", adminGuard, async (req: any, reply) => {
    const id = String((req.params as any)?.id || "");
    try {
      await prisma.notificationTemplate.delete({ where: { id } });
      return { ok: true };
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
  });

  // ── Send ──────────────────────────────────────────────────────────

  app.post("/admin/notify", adminGuard, async (req: any, reply) => {
    const me = await currentUser(req);
    if (!me) return reply.code(401).send({ error: "Unauthorized" });

    // Rate limit — count today's NOTIFICATION.SENT entries for this actor.
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const sentToday = await prisma.auditEvent.count({
      where: {
        scope: AuditScope.NOTIFICATION,
        verb: AuditVerb.SENT,
        actorUserId: me.id,
        createdAt: { gte: dayStart },
      },
    });
    if (sentToday >= RATE_LIMIT_PER_DAY) {
      return reply.code(429).send({ error: `Daily limit of ${RATE_LIMIT_PER_DAY} broadcasts reached` });
    }

    const body = req.body || {};
    const requestedRecipients = body.userIds;        // string[] | "all"
    const title = body.title ? String(body.title).trim().slice(0, 120) : undefined;
    const messageBody = String(body.body || "").trim();
    const channels: string[] | undefined = Array.isArray(body.channels) ? body.channels : undefined;
    if (!messageBody) return reply.code(400).send({ error: "body is required" });

    // Resolve recipient user IDs to a concrete list of approved users
    // (workers + admins). "all" = every approved user.
    const everyone = await prisma.user.findMany({
      where: { isApproved: true },
      select: { id: true, displayName: true, email: true, phone: true },
    });

    let recipients: typeof everyone;
    if (requestedRecipients === "all") {
      recipients = everyone;
    } else if (Array.isArray(requestedRecipients)) {
      const wanted = new Set(requestedRecipients.map(String));
      recipients = everyone.filter((u) => wanted.has(u.id));
    } else {
      return reply.code(400).send({ error: "userIds must be string[] or \"all\"" });
    }

    if (recipients.length === 0) {
      return reply.code(400).send({ error: "No valid recipients" });
    }

    // Sender footer — appended to all message bodies so workers know who sent it.
    const senderName = me.displayName
      || [me.firstName, me.lastName].filter(Boolean).join(" ").trim()
      || "Admin";
    const footer = `\n\n- ${senderName}`;
    const finalBody = messageBody + footer;
    const finalTitle = title || "Seedlings - message from admin";

    const pushOnly = Array.isArray(channels) && channels.length === 1 && channels[0] === "push";

    type PerUserResult = {
      userId: string;
      displayName: string | null;
      method: string;
      ok: boolean;
      error?: string;
      pushDelivered: number;
    };
    const results: PerUserResult[] = [];

    // Fire in parallel — each notifyWorker call independently handles SMS/
    // email/push. For push-only mode, skip notifyWorker (which would also
    // fire SMS/email) and call sendPushToUser directly via a custom path.
    if (pushOnly) {
      // Lazy-import to avoid pulling push deps when not needed.
      const { sendPushToUser } = await import("../lib/push");
      await Promise.all(
        recipients.map(async (u) => {
          const r = await sendPushToUser(u.id, {
            title: finalTitle,
            body: finalBody,
          });
          results.push({
            userId: u.id,
            displayName: u.displayName,
            method: "push",
            ok: r.delivered > 0,
            pushDelivered: r.delivered,
            error: r.delivered === 0 ? "no active subscriptions" : undefined,
          });
        }),
      );
    } else {
      await Promise.all(
        recipients.map(async (u) => {
          try {
            const r = await notifyWorker(
              u.id,
              {
                sms: messageBody + footer,
                email: messageBody + footer,
                push: { title: finalTitle, body: finalBody },
              },
              { subject: finalTitle },
            );
            results.push({
              userId: u.id,
              displayName: u.displayName,
              method: r.method,
              ok: r.ok,
              error: r.error,
              pushDelivered: r.push?.delivered ?? 0,
            });
          } catch (err: any) {
            results.push({
              userId: u.id,
              displayName: u.displayName,
              method: "none",
              ok: false,
              error: err?.message || "Failed",
              pushDelivered: 0,
            });
          }
        }),
      );
    }

    // Aggregate counts for the audit metadata.
    const summary = {
      totalRecipients: recipients.length,
      smsSent: results.filter((r) => r.method === "sms" && r.ok).length,
      emailSent: results.filter((r) => r.method === "email" && r.ok).length,
      pushDelivered: results.reduce((acc, r) => acc + (r.pushDelivered || 0), 0),
      failed: results.filter((r) => !r.ok).length,
    };

    await writeAudit(
      prisma,
      AUDIT.NOTIFICATION.SENT,
      me.id,
      {
        title: finalTitle,
        body: messageBody, // log the body the admin typed, not the appended one
        senderName,
        pushOnly,
        recipientUserIds: recipients.map((r) => r.id),
        summary,
        results,
      },
    );

    return { ok: true, summary, results };
  });

  // ── History (read past sends from AuditEvent) ────────────────────

  app.get("/admin/notify/history", adminGuard, async (req: any) => {
    const q = (req.query || {}) as { page?: string; pageSize?: string };
    const page = q.page ? Math.max(1, Number(q.page)) : 1;
    const pageSize = q.pageSize ? Math.min(100, Math.max(1, Number(q.pageSize))) : 25;

    const [items, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where: { scope: AuditScope.NOTIFICATION, verb: AuditVerb.SENT },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          actor: { select: { id: true, displayName: true, firstName: true, lastName: true } },
        },
      }),
      prisma.auditEvent.count({
        where: { scope: AuditScope.NOTIFICATION, verb: AuditVerb.SENT },
      }),
    ]);

    return { items, total, page, pageSize };
  });
}
