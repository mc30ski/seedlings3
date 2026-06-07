import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { getDownloadUrl } from "../lib/r2";
import { services } from "../services";
import { etFormatDate, etFormatDateOpts, etIcalLocalDateTime, etHourMinute, etMidnight, etToday, etAddDays } from "../lib/dates";

export default async function publicRoutes(app: FastifyInstance) {
  // Public activity feed — no auth required
  app.get("/public/feed", async (req: any) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 50);
    const days = Math.min(Math.max(Number(req.query?.days) || 7, 1), 30);

    // ET-anchored lookback so the public site shows full ET-day windows
    // even when the request lands near midnight UTC. setDate() on a UTC
    // Date would drop in / out of the lookback by ~4 hours.
    const lookback = etMidnight(etAddDays(etToday(), -days));
    // `now` is needed downstream for in-progress feed items (duration
    // since startedAt) — kept separately because that math is on the
    // instant axis, not the calendar-day axis.
    const now = new Date();

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
    // ET-anchored 30-day window — see notes on the recent-completed route
    // above.
    const thirtyDaysAgo = etMidnight(etAddDays(etToday(), -30));

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

  // Branding info — non-sensitive identity fields used on client-facing
  // surfaces (receipts, /pay page, etc.). Public so anyone rendering a
  // receipt — signed-in worker, signed-in client, or anonymous on /pay —
  // gets a consistent business name without needing to be on a
  // privileged settings endpoint.
  app.get("/public/branding", async () => {
    const businessNameSetting = await prisma.setting.findUnique({
      where: { key: "BUSINESS_NAME" },
    });
    return {
      businessName: businessNameSetting?.value || "Seedlings Lawn Care",
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

    // Rolling window: 2 weeks back, ~2 months forward. ET-anchored so
    // the iCal feed's covered range matches the operator's calendar
    // expectation regardless of when the request lands relative to UTC.
    const todayKey = etToday();
    const from = etMidnight(etAddDays(todayKey, -14));
    const to = etMidnight(etAddDays(todayKey, 60));

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
    // iCalendar VALUE=DATE format: YYYYMMDD in the operator's calendar
    // timezone (ET). On Vercel the server is UTC, so `.getFullYear()` etc.
    // would emit the wrong day near midnight ET — calendar subscribers
    // would see events drift by one day in their app. Always go through
    // `etFormatDate` which formats in America/New_York.
    const fmtDateOnly = (d: Date) => etFormatDate(d).replace(/-/g, "");
    // ET-anchored local datetime, paired with the VTIMEZONE block + the
    // `TZID=America/New_York` parameter on DTSTART / DTEND. Per RFC 5545,
    // a TZID-qualified local datetime puts the event at the right ET
    // wall-clock time for every subscriber, regardless of their device
    // timezone. The previous `.toISOString()` UTC format ("Z" suffix)
    // emitted UTC instants — RFC-correct but caused subscribers in
    // non-ET zones to see the event at the wrong local time.
    const fmtDtLocalEt = etIcalLocalDateTime;
    // UTC instant — kept for LAST-MODIFIED (which iCal requires in UTC).
    const fmtDtUtc = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
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

      // Description with full details. Observers (assigned with
      // role="observer") see the job in their calendar — they need to
      // know where to show up — but must NOT see the price (financial
      // detail leak). Their token's `uid` is matched against the
      // assignee list to decide.
      const subscriberAssignee = (occ.assignees ?? []).find(
        (a: any) => a.userId === uid,
      );
      const subscriberIsObserver = subscriberAssignee?.role === "observer";
      const desc: string[] = [];
      desc.push(`Type: ${type}`);
      desc.push(`Status: ${prettyStatus(occ.status)}`);
      if (!isTask && client) desc.push(`Client: ${client}`);
      if (!isTask && propName) desc.push(`Property: ${propName}`);
      if (jobType && !isTask) desc.push(`Job Type: ${jobType}`);
      if (occ.price != null && !subscriberIsObserver) {
        desc.push(`Price: $${occ.price.toFixed(2)}`);
      }
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

      // Reminder description text — show the reminder date in ET so the
      // text matches what the subscriber sees on their calendar.
      const reminder = reminderMap.get(occ.id);
      if (reminder) {
        desc.push(`Reminder: ${reminder.note || "Set"} (${etFormatDate(reminder.remindAt)})`);
      }

      // Check if this is an EVENT with a specific time (not default 09:00).
      // Get the ET hours/minutes (not local server time, which is UTC on
      // Vercel) so the "is the event at default 9am or not" decision
      // matches what the operator scheduled.
      let isTimedEvent = false;
      if (occ.workflow === "EVENT" && start instanceof Date) {
        isTimedEvent = etHourMinute(start) !== "09:00";
      }

      if (isTimedEvent) {
        // Timed event — 1 hour duration. Use TZID-qualified local ET
        // datetime so the event lands at the right ET wall-clock time
        // for every subscriber, regardless of their device timezone.
        const endTime = new Date(start.getTime() + 60 * 60 * 1000);
        events.push([
          "BEGIN:VEVENT",
          `UID:${occ.id}@seedlings`,
          `DTSTART;TZID=America/New_York:${fmtDtLocalEt(start)}`,
          `DTEND;TZID=America/New_York:${fmtDtLocalEt(endTime)}`,
          `SUMMARY:${esc(summary)}`,
          `DESCRIPTION:${esc(desc.join("\\n"))}`,
          `URL:${appUrl}?occ=${occ.id}`,
          `LAST-MODIFIED:${fmtDtUtc(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
          "END:VEVENT",
        ].filter(Boolean).join("\r\n"));
      } else {
        // All-day event using VALUE=DATE format. DTEND must be the day
        // AFTER DTSTART per RFC 5545 (exclusive end). Computing it via
        // `start.getTime() + 86_400_000` is fragile across DST fall-back
        // (Nov 2026: noon-to-noon UTC + 24h lands at 11 PM EST the same
        // day → previous calendar day → wrong DTEND). Go through the
        // canonical etAddDays helper on the ET day key instead.
        const startDayKey = etFormatDate(start);
        const endDayKey = etAddDays(startDayKey, 1);
        const endIcalDay = endDayKey.replace(/-/g, "");
        events.push([
          "BEGIN:VEVENT",
          `UID:${occ.id}@seedlings`,
          `DTSTART;VALUE=DATE:${fmtDateOnly(start)}`,
          `DTEND;VALUE=DATE:${endIcalDay}`,
          `SUMMARY:${esc(summary)}`,
          address && !isTask ? `LOCATION:${esc(address)}` : null,
          `DESCRIPTION:${esc(desc.join("\\n"))}`,
          `URL:${appUrl}?occ=${occ.id}`,
          `LAST-MODIFIED:${fmtDtUtc(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
          "END:VEVENT",
        ].filter(Boolean).join("\r\n"));
      }

      // Ghost reminder event (if reminder date differs from occurrence date)
      if (reminder) {
        const remDateStr = fmtDateOnly(reminder.remindAt);
        const occDateStr = fmtDateOnly(start);
        if (remDateStr !== occDateStr) {
          const ghostSummary = `[Reminder] ${isTask ? (occ.title || "Task") : propName}${reminder.note ? ` — ${reminder.note}` : ""}`;
          // DTEND day-after computed via etAddDays (same rationale as above).
          const remEndDay = etAddDays(etFormatDate(reminder.remindAt), 1).replace(/-/g, "");
          events.push([
            "BEGIN:VEVENT",
            `UID:reminder-${occ.id}@seedlings`,
            `DTSTART;VALUE=DATE:${remDateStr}`,
            `DTEND;VALUE=DATE:${remEndDay}`,
            `SUMMARY:${esc(ghostSummary)}`,
            `DESCRIPTION:${esc(`Reminder for: ${summary}\\nScheduled: ${etFormatDate(start)}\\n${reminder.note ? `Note: ${reminder.note}` : ""}`)}`,
            `URL:${appUrl}?occ=${occ.id}`,
            `LAST-MODIFIED:${fmtDtUtc(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
            "END:VEVENT",
          ].filter(Boolean).join("\r\n"));
        }
      }
    }

    // Inline VTIMEZONE block for America/New_York. Subscribers' apps
    // need this to correctly interpret the TZID-qualified DTSTART/DTEND
    // values on timed events. The DST rules below are the official US
    // rules in effect since 2007: spring-forward on the 2nd Sunday of
    // March, fall-back on the 1st Sunday of November.
    const vtimezone = [
      "BEGIN:VTIMEZONE",
      "TZID:America/New_York",
      "BEGIN:DAYLIGHT",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "TZNAME:EDT",
      "DTSTART:19700308T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "TZNAME:EST",
      "DTSTART:19701101T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
    const cal = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Seedlings Lawn Care//Calendar Feed//EN",
      `X-WR-CALNAME:${esc(feedToken.label || `Seedlings - ${feedToken.user.displayName ?? "Jobs"}`)}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-TIMEZONE:America/New_York",
      ...vtimezone,
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
    // ET-anchored so the date the client sees matches the date the job
    // happened on the operator's calendar (not the UTC server's locale).
    const dateLabel = resolved.serviceDate
      ? etFormatDateOpts(new Date(resolved.serviceDate), {
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
      preferred: m.preferred,
      instructions: m.instructions ? resolvePlaceholders(m.instructions, settings, runtime) : null,
      deepLink: m.deepLinkTemplate
        ? resolvePlaceholders(m.deepLinkTemplate, settings, runtime)
        : null,
      // Manual-pay target shown in the modal when a method has no deep link
      // (e.g. Zelle). Resolved same as the other text fields so
      // `{ZELLE_ADDRESS}` etc. flow through.
      payToTarget: m.payToTarget ? resolvePlaceholders(m.payToTarget, settings, runtime) : null,
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

    // Defense-in-depth: reject self-reports when the request carries a
    // worker/admin/super Clerk session. The /pay/[token] page is a
    // client-facing self-report form — a worker submitting it would
    // queue an unverified payment without the actual money having
    // changed hands. Workers/admins should use the in-app
    // Accept Payment flow instead. The frontend also blocks this, but
    // any direct API call (curl, custom client) is caught here.
    const clerkUserId = (req as any).auth?.clerkUserId as string | undefined;
    if (clerkUserId) {
      const user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });
      // Super is the owner role and overrides every other role — they can
      // do anything, including testing the client self-report flow even
      // when they also hold WORKER/ADMIN rows. For anyone else, block
      // WORKER and ADMIN from self-reporting on a client's behalf (would
      // queue an unverified payment without money actually changing hands).
      const isSuper = !!user?.roles?.some((r: any) => r.role === "SUPER");
      const hasBlockedRole = !!user?.roles?.some((r: any) =>
        r.role === "WORKER" || r.role === "ADMIN",
      );
      // TEMP DEBUG — remove once Super-override is confirmed working.
      // eslint-disable-next-line no-console
      console.log("[pay/self-report DEBUG]", {
        clerkUserId,
        userFound: !!user,
        userId: user?.id,
        userEmail: user?.email,
        roles: user?.roles?.map((r: any) => r.role) ?? [],
        isSuper,
        hasBlockedRole,
        willBlock: !isSuper && hasBlockedRole,
      });
      if (!isSuper && hasBlockedRole) {
        return reply.code(403).send({
          error: "worker_self_report_forbidden",
          message:
            "Workers can't submit self-reports on the client's behalf. Use Accept Payment in the worker app instead.",
        });
      }
    }

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
    // Payment approval is a Super-only responsibility, so only supers are
    // notified of a payment awaiting approval.
    const adminUsers = await prisma.user.findMany({
      where: {
        isApproved: true,
        roles: { some: { role: "SUPER" as any } },
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
    // Suggested email + names — biases the Clerk sign-up form toward the
    // on-file values so the email-match auto-link succeeds without the
    // user even seeing the smart-hint, AND so the signup carries the
    // first/last name we already have (Clerk requires them, and asking
    // the client to re-type a name we already addressed them by is bad
    // UX). Picks the primary contact when available; falls back to any
    // active contact with an email.
    const primary = await prisma.clientContact.findFirst({
      where: {
        status: "ACTIVE",
        email: { not: null },
        client: {
          properties: { some: { jobs: { some: { occurrences: { some: { id: resolved.occurrenceId } } } } } },
        },
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { email: true, firstName: true, lastName: true },
    });
    return {
      ok: true,
      suggestedEmail: primary?.email ?? null,
      suggestedFirstName: primary?.firstName ?? null,
      suggestedLastName: primary?.lastName ?? null,
    };
  });
}
