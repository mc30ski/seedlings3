import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { getDownloadUrl } from "../lib/r2";

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

    // Rolling window: 2 weeks back, 2 months forward
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 14);
    const to = new Date(now);
    to.setMonth(to.getMonth() + 2);

    // Fetch occurrences in range
    const where: any = {
      startAt: { gte: from, lte: to },
      workflow: { not: "TASK" },
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
        assignees: { select: { userId: true, role: true } },
      },
      orderBy: { startAt: "asc" },
    });

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

    // Build iCalendar
    const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
    const fmtDt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

    const events = filtered.map((occ) => {
      const prop = occ.job?.property;
      const client = prop?.client?.displayName ?? "";
      const propName = prop?.displayName ?? "";
      const address = [prop?.street1, prop?.city, prop?.state, prop?.postalCode].filter(Boolean).join(", ");
      const jobType = occ.jobType ? occ.jobType.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase()) : "";
      const summary = [propName, client ? `(${client})` : "", jobType].filter(Boolean).join(" ");

      const start = occ.startAt ?? new Date();
      const end = occ.endAt ?? new Date(start.getTime() + (occ.estimatedMinutes ?? 60) * 60000);

      const descParts = [];
      if (jobType) descParts.push(`Type: ${jobType}`);
      if (client) descParts.push(`Client: ${client}`);
      if (occ.price != null) descParts.push(`Price: $${occ.price.toFixed(2)}`);
      if (occ.notes) descParts.push(`Notes: ${occ.notes}`);
      const status = occ.status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());
      descParts.push(`Status: ${status}`);

      return [
        "BEGIN:VEVENT",
        `UID:${occ.id}@seedlings`,
        `DTSTART:${fmtDt(start)}`,
        `DTEND:${fmtDt(end)}`,
        `SUMMARY:${esc(summary)}`,
        address ? `LOCATION:${esc(address)}` : null,
        `DESCRIPTION:${esc(descParts.join("\\n"))}`,
        `LAST-MODIFIED:${fmtDt(occ.updatedAt ?? occ.createdAt ?? new Date())}`,
        "END:VEVENT",
      ].filter(Boolean).join("\r\n");
    });

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
}
