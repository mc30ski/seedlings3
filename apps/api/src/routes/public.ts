import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { getDownloadUrl } from "../lib/r2";

export default async function publicRoutes(app: FastifyInstance) {
  // Public activity feed — no auth required
  app.get("/public/feed", async (req: any) => {
    const limit = Math.min(Math.max(Number(req.query?.limit) || 30, 1), 50);

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sevenDaysAhead = new Date(now);
    sevenDaysAhead.setDate(sevenDaysAhead.getDate() + 7);

    // Fetch completed jobs (with photos, assignees, property)
    const completed = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        completedAt: { not: null, gte: thirtyDaysAgo },
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

    // Fetch upcoming scheduled jobs (next 7 days)
    const upcoming = await prisma.jobOccurrence.findMany({
      where: {
        status: "SCHEDULED",
        startAt: { gte: now, lte: sevenDaysAhead },
      },
      orderBy: { startAt: "asc" },
      take: 10,
      select: {
        id: true,
        kind: true,
        startAt: true,
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

    // Fetch in-progress jobs
    const inProgress = await prisma.jobOccurrence.findMany({
      where: { status: "IN_PROGRESS" },
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
      type: "completed" | "in_progress" | "upcoming";
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
        jobKind: occ.job.kind,
        kind: occ.kind,
        area: area(occ.job.property),
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
        jobKind: occ.job.kind,
        kind: occ.kind,
        area: area(occ.job.property),
        workers: firstNames(occ.assignees),
        durationMinutes,
        estimatedMinutes: occ.estimatedMinutes,
        photos: photoUrls.filter(Boolean) as FeedItemOut["photos"],
      });
    }

    // Upcoming items
    for (const occ of upcoming) {
      items.push({
        id: occ.id,
        type: "upcoming",
        timestamp: occ.startAt?.toISOString() ?? now.toISOString(),
        jobKind: occ.job.kind,
        kind: occ.kind,
        area: area(occ.job.property),
        workers: firstNames(occ.assignees),
        durationMinutes: null,
        estimatedMinutes: occ.estimatedMinutes,
        photos: [],
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
}
