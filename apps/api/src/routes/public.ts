import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { getDownloadUrl } from "../lib/r2";
import { services } from "../services";

export default async function publicRoutes(app: FastifyInstance) {
  // Public activity feed — no auth required
  app.get("/public/feed", async (req: any) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 50);
    const days = Math.min(Math.max(Number(req.query?.days) || 7, 1), 30);

    const now = new Date();
    const lookback = new Date(now);
    lookback.setDate(lookback.getDate() - days);

    // Fetch completed jobs (with photos, assignees, property) — exclude estimates
    const completed = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        completedAt: { not: null, gte: lookback },
        workflow: { notIn: ["ESTIMATE", "TASK"] },
        isEstimate: false,
      },
      orderBy: { completedAt: "desc" },
      take: limit,
      select: {
        id: true,
        kind: true,
        completedAt: true,
        startedAt: true,
        estimatedMinutes: true,
        job: {
          select: {
            kind: true,
            property: {
              select: { city: true, state: true },
            },
          },
        },
        assignees: {
          select: {
            user: { select: { displayName: true } },
          },
        },
        photos: {
          select: {
            id: true,
            r2Key: true,
            contentType: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    // Fetch in-progress jobs — exclude estimates
    const inProgress = await prisma.jobOccurrence.findMany({
      where: { status: "IN_PROGRESS", workflow: { notIn: ["ESTIMATE", "TASK"] }, isEstimate: false },
      orderBy: { startedAt: "desc" },
      take: 5,
      select: {
        id: true,
        kind: true,
        startedAt: true,
        estimatedMinutes: true,
        job: {
          select: {
            kind: true,
            property: {
              select: { city: true, state: true },
            },
          },
        },
        assignees: {
          select: {
            user: { select: { displayName: true } },
          },
        },
      },
    });

    // Helper: first names only
    function firstNames(assignees: { user: { displayName: string | null } | null }[]): string[] {
      return assignees
        .map((a) => (a.user?.displayName ?? "").split(" ")[0])
        .filter(Boolean) as string[];
    }

    function area(prop: { city: string | null; state: string | null } | null): string {
      return [prop?.city, prop?.state].filter(Boolean).join(", ");
    }

    // Build feed items
    type FeedItemOut = {
      id: string;
      type: "completed" | "in_progress";
      timestamp: string;
      jobKind: string;
      kind: string;
      area: string;
      workers: string[];
      durationMinutes: number | null;
      estimatedMinutes: number | null;
      photos: { id: string; url: string; contentType: string | null }[];
    };

    const items: FeedItemOut[] = [];

    // In-progress items
    for (const occ of inProgress) {
      let durationMinutes: number | null = null;
      if (occ.startedAt) {
        durationMinutes = Math.round((now.getTime() - new Date(occ.startedAt).getTime()) / 60000);
      }
      items.push({
        id: occ.id,
        type: "in_progress",
        timestamp: occ.startedAt?.toISOString() ?? now.toISOString(),
        jobKind: occ.job?.kind ?? "",
        kind: occ.kind ?? "",
        area: area(occ.job?.property ?? null),
        workers: firstNames(occ.assignees),
        durationMinutes,
        estimatedMinutes: occ.estimatedMinutes,
        photos: [],
      });
    }

    // Completed items (with photos)
    for (const occ of completed) {
      const photoUrls = await Promise.all(
        occ.photos.map(async (p) => {
          try {
            return { id: p.id, url: await getDownloadUrl(p.r2Key, 3600), contentType: p.contentType };
          } catch {
            return null;
          }
        })
      );

      let durationMinutes: number | null = null;
      if (occ.startedAt && occ.completedAt) {
        durationMinutes = Math.round(
          (new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000
        );
      }

      items.push({
        id: occ.id,
        type: "completed",
        timestamp: occ.completedAt!.toISOString(),
        jobKind: occ.job?.kind ?? "",
        kind: occ.kind ?? "",
        area: area(occ.job?.property ?? null),
        workers: firstNames(occ.assignees),
        durationMinutes,
        estimatedMinutes: occ.estimatedMinutes,
        photos: photoUrls.filter(Boolean) as FeedItemOut["photos"],
      });
    }



    return { items };
  });

  // Public stats
  app.get("/public/stats", async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [completedAllTime, completedThisMonth, activePropertyCount, workerCount, inProgressCount] = await Promise.all([
      prisma.jobOccurrence.count({
        where: { status: "CLOSED" },
      }),
      prisma.jobOccurrence.count({
        where: { status: "CLOSED", completedAt: { gte: thirtyDaysAgo } },
      }),
      prisma.property.count({
        where: { status: "ACTIVE" },
      }),
      prisma.user.count({
        where: {
          roles: { some: { role: "WORKER" } },
          isApproved: true,
        },
      }),
      prisma.jobOccurrence.count({
        where: { status: "IN_PROGRESS" },
      }),
    ]);

    return {
      jobsCompleted: completedAllTime,
      jobsThisMonth: completedThisMonth,
      activeProperties: activePropertyCount,
      teamSize: workerCount,
      inProgress: inProgressCount,
    };
  });

  // ── Calendar Feed (.ics) ──
  // Token-based auth — no Clerk needed. Calendar apps poll this URL.
  app.get("/public/calendar/:token.ics", async (req: any, reply: any) => {
    const token = String(req.params.token);
    const feedToken = await prisma.calendarFeedToken.findUnique({
      where: { token },
      include: { user: { select: { id: true, displayName: true } } },
    });
    if (!feedToken) return reply.code(404).send("Not found");

    // Update lastAccessedAt
    await prisma.calendarFeedToken.update({
      where: { id: feedToken.id },
      data: { lastAccessedAt: new Date() },
    });

    const filters = (feedToken.filters ?? {}) as Record<string, any>;
    const uid = feedToken.userId;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.seedlings.team";

    // Rolling window: 2 weeks back, 2 months forward
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 14);
    const to = new Date(now);
    to.setMonth(to.getMonth() + 2);

    // Fetch occurrences in range (include tasks)
    const where: any = {
      startAt: { gte: from, lte: to },
    };

    // Apply status filter
    const sf = filters.statusFilter;
    if (sf && sf !== "ALL") {
      if (sf === "UNCLAIMED") {
        where.assignees = { none: {} };
        where.status = "SCHEDULED";
      } else {
        where.status = sf;
      }
    }

    // Apply kind filter
    const kf = filters.kind;
    if (kf && kf !== "ALL") {
      where.kind = kf;
    }

    // Apply type filter
    const tf = filters.typeFilter;
    if (tf === "ONE_OFF") where.workflow = "ONE_OFF";
    else if (tf === "ESTIMATE") where.workflow = "ESTIMATE";
    else if (tf === "TENTATIVE") where.isTentative = true;
    else if (tf === "TASK") where.workflow = "TASK";

    const occurrences = await prisma.jobOccurrence.findMany({
      where,
      include: {
        job: {
          include: {
            property: {
              select: { displayName: true, street1: true, city: true, state: true, postalCode: true, client: { select: { displayName: true, isVip: true } } },
            },
          },
        },
        assignees: {
          select: { userId: true, role: true, user: { select: { displayName: true } } },
        },
        linkedOccurrence: {
          select: { id: true, job: { select: { property: { select: { displayName: true } } } } },
        },
      },
      orderBy: { startAt: "asc" },
    });

    // Also fetch reminders for this user (for ghost cards)
    const reminders = await prisma.reminder.findMany({
      where: { userId: uid, dismissedAt: null },
      select: { occurrenceId: true, remindAt: true, note: true },
    });
    const reminderMap = new Map(reminders.map((r) => [r.occurrenceId, r]));

    // Filter to only this worker's jobs + unassigned (same logic as worker view)
    let filtered = occurrences.filter((occ) => {
      const assignees = occ.assignees ?? [];
      const isAssigned = assignees.some((a) => a.userId === uid);
      const isUnassigned = assignees.filter((a) => a.role !== "observer").length === 0;
      return isAssigned || isUnassigned;
    });

    // Apply VIP filter if set
    if (filters.vipOnly) {
      filtered = filtered.filter((o) => !!(o.job?.property?.client as any)?.isVip);
    }

    // Helper functions
    const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
    const fmtDateOnly = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };
    const fmtDt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const prettyEnum = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
    const prettyStatus = (s: string) => s === "CLOSED" ? "Completed" : prettyEnum(s);

    // Determine workflow type label
    const workflowLabel = (occ: any) => {
      if (occ.workflow === "TASK") return "Task";
      if (occ.workflow === "REMINDER") return "Reminder";
      if (occ.workflow === "EVENT") return "Event";
      if (occ.workflow === "FOLLOWUP") return "Followup";
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) return "Estimate";
      if (occ.workflow === "ONE_OFF" || occ.isOneOff) return "One-Off";
      if (occ.workflow === "STANDARD") return "Repeating";
      return "Job";
    };

    // Build events
    const events: string[] = [];

    for (const occ of filtered) {
      const prop = occ.job?.property;
      const client = prop?.client?.displayName ?? "";
      const propName = prop?.displayName ?? "";
      const address = [prop?.street1, prop?.city, prop?.state, prop?.postalCode].filter(Boolean).join(", ");
      const jobType = occ.jobType ? prettyEnum(occ.jobType) : "";
      const isTask = occ.workflow === "TASK";
      const isEventOrFollowup = occ.workflow === "EVENT" || occ.workflow === "FOLLOWUP";
      const isReminder = occ.workflow === "REMINDER";
      const type = workflowLabel(occ);

      // Summary: [Type] Property (Client) — Job Type
      const summaryParts = [`[${type}]`];
      if (isTask || isReminder || isEventOrFollowup) {
        summaryParts.push(occ.title || type);
      } else {
        summaryParts.push(propName);
        if (client) summaryParts.push(`(${client})`);
      }
      if (jobType && !isTask) summaryParts.push(`— ${jobType}`);
      const summary = summaryParts.join(" ");

      const start = occ.startAt ?? new Date();

      // Description with full details
      const desc: string[] = [];
      desc.push(`Type: ${type}`);
      desc.push(`Status: ${prettyStatus(occ.status)}`);
      if (!isTask && client) desc.push(`Client: ${client}`);
      if (!isTask && propName) desc.push(`Property: ${propName}`);
      if (jobType && !isTask) desc.push(`Job Type: ${jobType}`);
      if (occ.price != null) desc.push(`Price: $${occ.price.toFixed(2)}`);
      if (occ.estimatedMinutes) desc.push(`Estimated Duration: ${occ.estimatedMinutes} min`);
      if (address && !isTask) desc.push(`Address: ${address}`);

      // Assignees
      const activeAssignees = (occ.assignees ?? []).filter((a: any) => a.role !== "observer");
      if (activeAssignees.length > 0) {
        desc.push(`Team: ${activeAssignees.map((a: any) => a.user?.displayName ?? "Unknown").join(", ")}`);
      }
      const observers = (occ.assignees ?? []).filter((a: any) => a.role === "observer");
      if (observers.length > 0) {
        desc.push(`Observers: ${observers.map((a: any) => a.user?.displayName ?? "Unknown").join(", ")}`);
      }

      if (occ.notes) desc.push(`Notes: ${occ.notes}`);
      if (occ.proposalAmount != null) desc.push(`Proposal: $${occ.proposalAmount.toFixed(2)}`);
      if (occ.proposalNotes) desc.push(`Proposal Notes: ${occ.proposalNotes}`);
      if (occ.isTentative) desc.push("⚠ Tentative — awaiting confirmation");
      if (occ.isAdminOnly) desc.push("⚠ Administered — assigned by admin");

      // Linked occurrence (for tasks)
      if (isTask && occ.linkedOccurrence) {
        const lp = (occ.linkedOccurrence as any).job?.property?.displayName;
        if (lp) desc.push(`Linked to: ${lp}`);
      }

      // Reminder
      const reminder = reminderMap.get(occ.id);
      if (reminder) {
        desc.push(`Reminder: ${reminder.note || "Set"} (${reminder.remindAt.toISOString().slice(0, 10)})`);
      }

      // Check if this is an EVENT with a specific time (not default 09:00)
      const isTimedEvent = occ.workflow === "EVENT" && start instanceof Date && (start.getHours() !== 9 || start.getMinutes() !== 0);

      if (isTimedEvent) {
        // Timed event — 1 hour duration
        const endTime = new Date(start.getTime() + 60 * 60 * 1000);
        events.push([
          "BEGIN:VEVENT",
          `UID:${occ.id}@seedlings`,
          `DTSTART:${fmtDt(start)}`,
          `DTEND:${fmtDt(endTime)}`,
          `SUMMARY:${esc(summary)}`,
          `DESCRIPTION:${esc(desc.join("\\n"))}`,
          `URL:${appUrl}?occ=${occ.id}`,
          `LAST-MODIFIED:${fmtDt(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
          "END:VEVENT",
        ].filter(Boolean).join("\r\n"));
      } else {
        // All-day event using VALUE=DATE format
        events.push([
          "BEGIN:VEVENT",
          `UID:${occ.id}@seedlings`,
          `DTSTART;VALUE=DATE:${fmtDateOnly(start)}`,
          `DTEND;VALUE=DATE:${fmtDateOnly(new Date(start.getTime() + 86400000))}`,
          `SUMMARY:${esc(summary)}`,
          address && !isTask ? `LOCATION:${esc(address)}` : null,
          `DESCRIPTION:${esc(desc.join("\\n"))}`,
          `URL:${appUrl}?occ=${occ.id}`,
          `LAST-MODIFIED:${fmtDt(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
          "END:VEVENT",
        ].filter(Boolean).join("\r\n"));
      }

      // Ghost reminder event (if reminder date differs from occurrence date)
      if (reminder) {
        const remDateStr = fmtDateOnly(reminder.remindAt);
        const occDateStr = fmtDateOnly(start);
        if (remDateStr !== occDateStr) {
          const ghostSummary = `[Reminder] ${isTask ? (occ.title || "Task") : propName}${reminder.note ? ` — ${reminder.note}` : ""}`;
          events.push([
            "BEGIN:VEVENT",
            `UID:reminder-${occ.id}@seedlings`,
            `DTSTART;VALUE=DATE:${remDateStr}`,
            `DTEND;VALUE=DATE:${fmtDateOnly(new Date(reminder.remindAt.getTime() + 86400000))}`,
            `SUMMARY:${esc(ghostSummary)}`,
            `DESCRIPTION:${esc(`Reminder for: ${summary}\\nScheduled: ${start.toISOString().slice(0, 10)}\\n${reminder.note ? `Note: ${reminder.note}` : ""}`)}`,
            `URL:${appUrl}?occ=${occ.id}`,
            `LAST-MODIFIED:${fmtDt(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
            "END:VEVENT",
          ].filter(Boolean).join("\r\n"));
        }
      }
    }

    const cal = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Seedlings Lawn Care//Calendar Feed//EN",
      `X-WR-CALNAME:${esc(feedToken.label || `Seedlings - ${feedToken.user.displayName ?? "Jobs"}`)}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      ...events,
      "END:VCALENDAR",
    ].join("\r\n");

    reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Content-Disposition", "inline; filename=seedlings.ics")
      .header("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
      .send(cal);
  });

  // ── Public payment page endpoints (no auth) ──────────────────────────────
  // `/pay/[token]` Next.js page calls these. The token is the only auth.

  // Resolve a payment-request token → job summary + payment options. Returns
  // null shape (404) when the token doesn't match or has expired.
  app.get("/public/pay/:token", async (req: any, reply: any) => {
    const token = String(req.params.token || "");
    const resolved = await services.paymentRequests.resolveToken(token);
    if (!resolved) return reply.code(404).send({ error: "not_found" });

    // Sign URLs for the photos so the public page can render them. R2 GETs
    // are presigned and expire after ~6h — fine for a single-load page view.
    const photos: { url: string; contentType: string | null }[] = [];
    for (const p of resolved.photos) {
      try {
        const url = await getDownloadUrl(p.r2Key, 6 * 3600);
        photos.push({ url, contentType: p.contentType });
      } catch {
        /* skip photos we can't sign */
      }
    }

    // Fetch every setting referenced by the PAYMENT_METHODS taxonomy plus
    // the legacy keys still exposed in paymentOptions (for older clients).
    // We pull all settings — the resolver scans the template for placeholders
    // so it only consumes what's actually referenced.
    const settings = await prisma.setting.findMany({
      select: { key: true, value: true },
    });
    const venmoHandle = settings.find((s) => s.key === "VENMO_BUSINESS_HANDLE")?.value ?? null;
    const zelleAddress = settings.find((s) => s.key === "ZELLE_ADDRESS")?.value ?? null;

    // Resolve the taxonomy into ready-to-render methods for the public page.
    // Server-side resolution prevents leaking the full Settings table to an
    // unauthenticated client — only the resolved `instructions` and
    // `deepLink` strings (and basic fee config for display) come down.
    const { loadPaymentMethods, listActivePaymentMethods, resolvePlaceholders } =
      await import("../services/paymentMethods");
    const methodsList = await loadPaymentMethods(prisma);
    const clientMethods = listActivePaymentMethods(methodsList, "CLIENT_REQUEST");
    // Memo line used for {{note}} in deep links + suggested-memo display.
    const dateLabel = resolved.serviceDate
      ? new Date(resolved.serviceDate).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "";
    const noteText = `${resolved.propertyLabel}${dateLabel ? " " + dateLabel : ""}`;
    const runtime = {
      amount: resolved.amountDue.toFixed(2),
      note: noteText,
    };
    const resolvedMethods = clientMethods.map((m) => ({
      key: m.key,
      label: m.label,
      feePercent: m.feePercent,
      feeFixed: m.feeFixed,
      instructions: m.instructions ? resolvePlaceholders(m.instructions, settings, runtime) : null,
      deepLink: m.deepLinkTemplate
        ? resolvePlaceholders(m.deepLinkTemplate, settings, runtime)
        : null,
    }));

    // Best-effort audit row (don't fail the response if it errors).
    services.paymentRequests
      .recordTokenAccess(resolved.occurrenceId, req.headers["x-forwarded-for"] ?? req.ip ?? null)
      .catch(() => {});

    // Pull the property's preferred-method from any active contact (they
    // share — we set it on all of them on approval). The page highlights it.
    const preferredFromContact = await prisma.clientContact.findFirst({
      where: {
        status: "ACTIVE",
        client: {
          properties: { some: { jobs: { some: { occurrences: { some: { id: resolved.occurrenceId } } } } } },
        },
        preferredPaymentMethod: { not: null },
      },
      select: { preferredPaymentMethod: true },
    });

    return {
      occurrenceId: resolved.occurrenceId,
      amountDue: resolved.amountDue,
      propertyLabel: resolved.propertyLabel,
      propertyAddress: resolved.propertyAddress,
      serviceDate: resolved.serviceDate,
      jobTags: resolved.jobTags,
      photos,
      payment: resolved.payment,
      preferredMethod: preferredFromContact?.preferredPaymentMethod ?? null,
      paymentOptions: {
        venmoHandle,
        zelleAddress,
      },
      // Taxonomy-driven list — single source of truth going forward. Older
      // clients can still consume paymentOptions; new clients should prefer
      // `paymentMethods` (resolved instructions + deep links).
      paymentMethods: resolvedMethods,
      expiresAt: resolved.expiresAt,
    };
  });

  // Public self-report — client tapping "I sent my Zelle payment" etc.
  // Creates an unconfirmed Payment that admin must approve before the
  // occurrence closes. Token is the only auth.
  app.post("/public/pay/:token/self-report", async (req: any, reply: any) => {
    const token = String(req.params.token || "");
    const body = req.body || {};
    const method = String(body.method || "").toUpperCase();
    const resolved = await services.paymentRequests.resolveToken(token);
    if (!resolved) return reply.code(404).send({ error: "not_found" });
    if (!method) return reply.code(400).send({ error: "method_required" });

    const payment = await services.payments.selfReportPayment(null, {
      occurrenceId: resolved.occurrenceId,
      method,
      amountPaid: resolved.amountDue,
      note: body.note ? String(body.note) : null,
    });

    // Notify admins + super. We dispatch to every approved user with an
    // admin/super role; the Pending Approval surface in the app handles
    // the actual queue. Failures are non-fatal — the payment is recorded
    // regardless.
    //
    // Web-push (free) always fires. SMS/email (Twilio/Resend, paid) only
    // fire when NOTIFY_PAYMENT_APPROVAL_VIA_SMS_EMAIL is "true". Default
    // is push-only to keep dev/test cost at zero.
    const adminUsers = await prisma.user.findMany({
      where: {
        isApproved: true,
        roles: { some: { role: { in: ["ADMIN", "SUPER"] as any } } },
      },
      select: { id: true },
    });
    const smsEmailSetting = await prisma.setting.findUnique({
      where: { key: "NOTIFY_PAYMENT_APPROVAL_VIA_SMS_EMAIL" },
    });
    const allowSmsEmail = smsEmailSetting?.value === "true";
    const { notifyWorker } = await import("../lib/notifications");
    for (const u of adminUsers) {
      notifyWorker(
        u.id,
        `New payment to approve: $${resolved.amountDue.toFixed(2)} (${method}) at ${resolved.propertyLabel}.`,
        { subject: "Payment to approve", pushOnly: !allowSmsEmail },
      ).catch(() => {});
    }

    return { ok: true, paymentId: payment.id };
  });

  // Optional: client tapped "Create account" on the post-payment confirmation
  // screen. The Clerk signup happens in the browser; this endpoint just
  // records the source so future discount/credit logic can apply.
  app.post("/public/pay/:token/signup-from-page", async (req: any, reply: any) => {
    const token = String(req.params.token || "");
    const resolved = await services.paymentRequests.resolveToken(token);
    if (!resolved) return reply.code(404).send({ error: "not_found" });
    // Tag every active contact on the client — the actual Clerk → contact
    // linking happens later via /client/link. This is just a hint that the
    // signup originated from the payment page.
    await prisma.clientContact.updateMany({
      where: {
        status: "ACTIVE",
        client: {
          properties: { some: { jobs: { some: { occurrences: { some: { id: resolved.occurrenceId } } } } } },
        },
        clientAccountCreatedFromPaymentPageAt: null,
      },
      data: { clientAccountCreatedFromPaymentPageAt: new Date() },
    });
    return { ok: true };
  });
}
