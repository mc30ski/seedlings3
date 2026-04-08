import { FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { notifyWorker } from "../lib/notifications";
import { etMidnight, etToday, etTomorrow } from "../lib/dates";

/**
 * Cron job routes — called by Vercel Cron.
 * These endpoints are NOT behind auth guards but are protected by
 * a CRON_SECRET header that Vercel sets automatically.
 */
export default async function cronRoutes(app: FastifyInstance) {
  /**
   * Daily notification: remind workers with jobs tomorrow to plan their day.
   * Scheduled to run at 6pm ET (22:00 UTC) via Vercel Cron.
   */
  app.get("/cron/daily-notifications", async (req, reply) => {
    // Verify cron secret (Vercel sets this automatically in production)
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers["authorization"];
    if (secret && authHeader !== `Bearer ${secret}`) {
      app.log.warn({ cron: "daily-notifications", reason: "Unauthorized request blocked" });
      return reply.status(401).send({ error: "Unauthorized" });
    }
    if (!secret && process.env.NODE_ENV === "production") {
      app.log.warn({ cron: "daily-notifications", reason: "CRON_SECRET not set in production — request allowed but this is insecure" });
    }

    const tomorrowStr = etTomorrow();
    const tomorrowStart = etMidnight(tomorrowStr);
    // Day after tomorrow in ET
    const dayAfterDate = new Date(Date.now() + 2 * 86400000);
    const dayAfterStr = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(dayAfterDate);
    const dayAfterMidnight = etMidnight(dayAfterStr);

    // Find all occurrences for tomorrow that have assignees
    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        startAt: { gte: tomorrowStart, lt: dayAfterMidnight },
      },
      include: {
        assignees: {
          include: { user: { select: { id: true, displayName: true, email: true, phone: true } } },
        },
        job: {
          include: {
            property: { select: { displayName: true, city: true } },
          },
        },
      },
    });

    // Group by worker — each worker gets one notification listing all their jobs
    const workerJobs = new Map<string, { user: any; jobs: string[] }>();
    for (const occ of occurrences) {
      for (const a of occ.assignees) {
        if (!workerJobs.has(a.userId)) {
          workerJobs.set(a.userId, { user: a.user, jobs: [] });
        }
        const prop = occ.job?.property;
        const desc = prop ? `${prop.displayName}${prop.city ? ` (${prop.city})` : ""}` : "a job";
        workerJobs.get(a.userId)!.jobs.push(desc);
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.seedlings.team";
    const results: { userId: string; method: string; ok: boolean; error?: string }[] = [];

    for (const [userId, { user, jobs }] of workerJobs) {
      const firstName = user.displayName?.split(" ")[0] ?? "";
      const greeting = firstName ? `Hi ${firstName}!` : "Hi!";
      const jobList = jobs.length === 1
        ? `1 job`
        : `${jobs.length} jobs`;

      const workflowLink = `${appUrl}?workflow=plan-workday`;
      const message = `${greeting} You have ${jobList} scheduled for tomorrow:\n\n${jobs.map((j, i) => `${i + 1}. ${j}`).join("\n")}\n\nPlan your day: ${workflowLink}`;

      const result = await notifyWorker(userId, message, {
        subject: `Seedlings — ${jobList} tomorrow`,
        link: workflowLink,
      });

      results.push({ userId, method: result.method, ok: result.ok, error: result.error });
    }

    app.log.info({ cron: "daily-notifications", date: tomorrowStr, workers: workerJobs.size, results });

    return {
      ok: true,
      date: tomorrowStr,
      notified: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

  /**
   * Test endpoint — send a test notification to yourself.
   * Protected by admin guard when called via the API.
   */
  app.post("/cron/test-notification", async (req: any) => {
    const body = req.body || {};
    const userId = body.userId as string;
    const message = body.message as string || "This is a test notification from Seedlings Lawn Care.";

    if (!userId) {
      return { ok: false, error: "userId is required" };
    }

    const result = await notifyWorker(userId, message, {
      subject: "Seedlings — Test Notification",
      link: process.env.NEXT_PUBLIC_APP_URL || "https://www.seedlings.team",
    });

    return result;
  });
}
