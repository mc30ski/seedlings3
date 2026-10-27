import { FastifyInstance } from "fastify";
import { capabilitiesForUsers } from "../lib/userCapabilities";
import { prisma } from "../db/prisma";
import { notifyWorker } from "../lib/notifications";
import { etMidnight, etToday, etTomorrow, etAddDays } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { pruneCache } from "../lib/cache";
import { timingSafeEqual } from "crypto";

/**
 * Cron job routes — called by Vercel Cron.
 *
 * These endpoints carry NO route guard: there is no principal to check,
 * because the caller is Vercel's scheduler, not a person. Authorization is a
 * shared secret in the Authorization header, which Vercel sends on every
 * scheduled invocation of a path listed in `apps/api/vercel.json#crons`.
 */

/**
 * THIS CHECK USED TO FAIL OPEN, AND THAT WAS THE WHOLE PROBLEM.
 *
 * Each of the four routes below carried its own copy of:
 *
 *     if (secret && authHeader !== `Bearer ${secret}`) return 401
 *
 * Read the condition: when `CRON_SECRET` is UNSET, `secret` is undefined, the
 * `&&` short-circuits, and the request is ALLOWED. A missing secret therefore
 * disabled the only protection these routes had. In production it logged
 * "request allowed but this is insecure" and ran the job anyway.
 *
 * Nothing else stood behind it. `plugins/auth.ts` does not reject
 * unauthenticated requests — it sets `req.auth = {}` and continues — so an
 * unset secret left `/cron/daily-notifications` (push notifications to every
 * worker), `/cron/document-sync` and `/cron/client-backup` publicly
 * triggerable by anyone who could reach the host.
 *
 * Now: a configured secret is REQUIRED in production, and the handler refuses
 * rather than running unprotected. Outside production a missing secret still
 * allows the call, because that is how the jobs are exercised locally and
 * there is no secret in `apps/api/.env` — but it is a deliberate, narrow
 * exception rather than the default everywhere.
 *
 * The comparison is timing-safe. It is a secret compare, and the lengths are
 * attacker-visible anyway, so the length check leaking is not a weakness.
 */
function cronAuthorized(
  app: FastifyInstance,
  req: { headers: Record<string, unknown> },
  reply: { status: (c: number) => { send: (b: unknown) => unknown } },
  job: string,
): boolean {
  const secret = process.env.CRON_SECRET;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      // FAIL CLOSED. Refusing a scheduled run is visible and recoverable;
      // running it for anyone who asks is neither.
      app.log.error({ cron: job, reason: "CRON_SECRET not set — refusing to run unprotected" });
      reply.status(503).send({ error: "Cron not configured" });
      return false;
    }
    app.log.warn({ cron: job, reason: "CRON_SECRET not set (non-production) — allowing" });
    return true;
  }

  const header = req.headers["authorization"];
  const expected = `Bearer ${secret}`;
  const got = typeof header === "string" ? header : "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    app.log.warn({ cron: job, reason: "Unauthorized request blocked" });
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export default async function cronRoutes(app: FastifyInstance) {
  /**
   * Daily notification: remind workers with jobs tomorrow to plan their day.
   * Scheduled to run at 6pm ET (22:00 UTC) via Vercel Cron.
   */
  app.get("/cron/daily-notifications", async (req, reply) => {
    // Verify cron secret (Vercel sets this automatically in production)
    if (!cronAuthorized(app, req as any, reply as any, "daily-notifications")) return;

    const tomorrowStr = etTomorrow();
    const tomorrowStart = etMidnight(tomorrowStr);
    // Day after tomorrow in ET — go through etAddDays on the string key
    // to dodge DST edges (the millisecond `Date.now() + 2 * 86400000`
    // pattern is off by an hour on DST spring/fall days).
    const dayAfterStr = etAddDays(tomorrowStr, 1);
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
    // WHO IS "THE TEAM"? Whoever can see the schedule.
    //
    // This asked for a role. Converting it, I first
    // wrote `workerType IN (EMPLOYEE, CONTRACTOR)` and called payroll "the
    // durable version of that question". It is not: pay class is a tax and
    // employment fact, not a permission, and substituting one for the other
    // is exactly what G30 and G31 exist to prevent. The concrete bug was
    // that someone carrying a pay class but NO role grants holds no
    // capability at all, and would still have been sent team announcements.
    //
    // `schedule.view` is the real question — every rung of the starter
    // ladder from Trainee upward holds it, and an operator can grant it to a
    // custom role without having to classify that person for payroll first.
    // `capabilitiesForUsers` already drops anyone whose `workerType` is null
    // (G31), so the mid-onboarding unclassified still fall out, and it
    // flattens inheritance so a custom role built on Worker counts too.
    const teamCandidates = await prisma.user.findMany({
      where: { isApproved: true },
      select: { id: true, displayName: true, email: true, phone: true },
    });
    const teamCaps = await capabilitiesForUsers(
      prisma,
      teamCandidates.map((u) => u.id),
    );
    const allWorkers = teamCandidates.filter((u) =>
      teamCaps.get(u.id)?.has("schedule.view"),
    );

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
        title: `Tomorrow's plan - ${itemNoun}`,
        body: smsBody,
        url: homeLink,
        tag: "daily-plan",
      };

      const result = await notifyWorker(userId, { sms: smsBody, email: emailBody, push: pushPayload }, {
        subject: `Seedlings - ${itemNoun} tomorrow`,
        link: homeLink,
      });

      results.push({ userId, method: result.method, ok: result.ok, error: result.error });
    }

    // Sweep long-dead cache entries while we're already running daily.
    // Deliberately only removes rows expired well past their grace period —
    // recently-expired entries are what stale-on-error serves, so pruning on
    // expiry would delete exactly the safety net. Never fails the cron.
    let cachePruned = 0;
    try {
      cachePruned = await pruneCache();
    } catch (err: any) {
      app.log.warn({ cron: "daily-notifications", step: "pruneCache", err: err?.message });
    }

    app.log.info({ cron: "daily-notifications", date: tomorrowStr, workers: workerBuckets.size, cachePruned, results });

    return {
      ok: true,
      date: tomorrowStr,
      notified: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      cachePruned,
      results,
    };
  });

  /**
   * Test endpoint — send a test notification to a given user.
   *
   * SHIPPED UNAUTHENTICATED. The comment here used to claim "Protected by
   * admin guard when called via the API"; there was no guard of any kind, so
   * anyone who could reach the API could push a notification and send an
   * email to any userId they could guess. Nothing calls it and it is not in
   * vercel.json's cron schedule — it is a manual debugging tool that was
   * never locked down.
   *
   * Now behind the same CRON_SECRET bearer as every other route in this file
   * (see the file header). Call it with:
   *   curl -X POST .../api/cron/test-notification \
   *        -H "Authorization: Bearer $CRON_SECRET" ...
   */
  app.post("/cron/test-notification", async (req: any, reply: any) => {
    if (!cronAuthorized(app, req as any, reply as any, "test-notification")) return;

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

  /**
   * Google Drive backup — daily sync worker.
   * Drains up to 100 pending tasks from DocumentSyncQueue, in order,
   * with retry + exponential backoff on failures. Short-circuits
   * cleanly when DOCUMENT_SYNC_ENABLED setting is off.
   *
   * See docs/features/documents-gdrive-backup.md.
   */
  app.get("/cron/document-sync", async (req, reply) => {
    if (!cronAuthorized(app, req as any, reply as any, "document-sync")) return;
    const { runSync } = await import("../services/documentSyncWorker");
    const result = await runSync({ maxTasks: 100 });
    app.log.info({ cron: "document-sync", ...result });
    return result;
  });

  /**
   * Full-database snapshot uploaded to Google Drive at
   *   [GOOGLE_DRIVE_ROOT_FOLDER_ID]/CompanyClients/YYYY-MM-DD.json
   *
   * Rolling backup — every night gets its own file, nothing is ever
   * deleted or overwritten. Same authentication + Drive parent as
   * /cron/document-sync. Kill switch is the CLIENT_BACKUP_ENABLED
   * setting (distinct from DOCUMENT_SYNC_ENABLED).
   *
   * See services/clientBackup.ts for the payload + folder logic.
   */
  app.get("/cron/client-backup", async (req, reply) => {
    if (!cronAuthorized(app, req as any, reply as any, "client-backup")) return;
    try {
      const { runClientBackup } = await import("../services/clientBackup");
      const result = await runClientBackup();
      app.log.info({ cron: "client-backup", ...result });
      return result;
    } catch (err: any) {
      app.log.error({ cron: "client-backup", err: err?.message ?? String(err) });
      return reply.status(500).send({ error: err?.message ?? "Backup failed." });
    }
  });
}
