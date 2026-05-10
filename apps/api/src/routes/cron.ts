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

    // Find tomorrow's occurrences across all workflows, mirroring the Planning tab.
    // Status SCHEDULED or ACCEPTED. Workflows: jobs/estimates/events get their own
    // labeled section in the email; TASK/REMINDER/FOLLOWUP/ANNOUNCEMENT get bundled
    // into an "Other" section. ANNOUNCEMENTs are team-wide (no assignee filter).
    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["SCHEDULED", "ACCEPTED"] as any },
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

    // Pull all approved workers — used to fan ANNOUNCEMENTs out to the whole team
    // (announcements aren't tied to assignees).
    const allWorkers = await prisma.user.findMany({
      where: { isApproved: true, roles: { some: { role: "WORKER" } } },
      select: { id: true, displayName: true, email: true, phone: true },
    });

    // Group by worker → by section (jobs / estimates / events / others).
    type WorkerBuckets = { user: any; jobs: string[]; estimates: string[]; events: string[]; others: string[] };
    const workerBuckets = new Map<string, WorkerBuckets>();
    const ensureBucket = (userId: string, user: any) => {
      if (!workerBuckets.has(userId)) {
        workerBuckets.set(userId, { user, jobs: [], estimates: [], events: [], others: [] });
      }
      return workerBuckets.get(userId)!;
    };
    function describeOcc(occ: any): string {
      const prop = occ.job?.property;
      if (prop) return `${prop.displayName}${prop.city ? ` (${prop.city})` : ""}`;
      if (occ.title) return occ.title;
      return "(untitled)";
    }
    function otherTypeLabel(wf: string | null | undefined): string {
      if (wf === "TASK") return "Task";
      if (wf === "REMINDER") return "Reminder";
      if (wf === "FOLLOWUP") return "Follow-up";
      if (wf === "ANNOUNCEMENT") return "Announcement";
      return "Item";
    }
    for (const occ of occurrences) {
      const wf = occ.workflow as string | null;
      const desc = describeOcc(occ);

      if (wf === "ANNOUNCEMENT") {
        // Fan out to every approved worker, regardless of assignees.
        const labeled = `[Announcement] ${desc}`;
        for (const w of allWorkers) ensureBucket(w.id, w).others.push(labeled);
        continue;
      }

      for (const a of occ.assignees) {
        const bucket = ensureBucket(a.userId, a.user);
        if (wf === "STANDARD" || wf === "ONE_OFF" || !wf) bucket.jobs.push(desc);
        else if (wf === "ESTIMATE") bucket.estimates.push(desc);
        else if (wf === "EVENT") bucket.events.push(desc);
        else bucket.others.push(`[${otherTypeLabel(wf)}] ${desc}`);
      }
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.seedlings.team";
    const homeLink = `${appUrl}?tab=worker-work-home`;
    const results: { userId: string; method: string; ok: boolean; error?: string }[] = [];

    for (const [userId, bucket] of workerBuckets) {
      const total = bucket.jobs.length + bucket.estimates.length + bucket.events.length + bucket.others.length;
      if (total === 0) continue;

      const firstName = bucket.user.displayName?.split(" ")[0] ?? "";
      const greeting = firstName ? `Hi ${firstName}!` : "Hi!";
      const itemNoun = total === 1 ? "1 item" : `${total} items`;

      // Email — labeled sections, skipping empties.
      const renderSection = (label: string, items: string[]) =>
        `${label} (${items.length}):\n${items.map((it, i) => `${i + 1}. ${it}`).join("\n")}`;
      const sections: string[] = [];
      if (bucket.jobs.length > 0) sections.push(renderSection("Jobs", bucket.jobs));
      if (bucket.estimates.length > 0) sections.push(renderSection("Estimates", bucket.estimates));
      if (bucket.events.length > 0) sections.push(renderSection("Events", bucket.events));
      if (bucket.others.length > 0) sections.push(renderSection("Other", bucket.others));
      const emailBody = `${greeting} You have ${itemNoun} scheduled for tomorrow:\n\n${sections.join("\n\n")}`;

      // SMS — short. Just the headline; the link is appended by notifyWorker.
      const smsBody = `${greeting} You have ${itemNoun} scheduled for tomorrow.`;

      // Push — short, native-style. URL targets the Home tab so a tap
      // deep-links straight to the worker's daily landing screen.
      const pushPayload = {
        title: `Tomorrow's plan — ${itemNoun}`,
        body: smsBody,
        url: homeLink,
        tag: "daily-plan",
      };

      const result = await notifyWorker(userId, { sms: smsBody, email: emailBody, push: pushPayload }, {
        subject: `Seedlings — ${itemNoun} tomorrow`,
        link: homeLink,
      });

      results.push({ userId, method: result.method, ok: result.ok, error: result.error });
    }

    app.log.info({ cron: "daily-notifications", date: tomorrowStr, workers: workerBuckets.size, results });

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
