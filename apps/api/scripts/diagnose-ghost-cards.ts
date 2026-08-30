/**
 * Why isn't the "Next visit not scheduled" ghost card showing for a job?
 *
 * Checks every gate in services/jobs.ts → listNextOccurrenceGhosts and
 * reports which one fails. Read-only; safe against production.
 *
 *   npx tsx scripts/diagnose-ghost-cards.ts "Harrington"
 *   npx tsx scripts/diagnose-ghost-cards.ts            # every candidate job
 */
import "dotenv/config";
import { prisma } from "../src/db/prisma";
import { JobStatus, JobOccurrenceStatus } from "@prisma/client";
import { computeNextOccurrenceStart } from "../src/services/payments";

const TERM = process.argv[2] ?? "";

const ok = (b: boolean) => (b ? "PASS" : "FAIL");

(async () => {
  const jobs = await prisma.job.findMany({
    where: TERM
      ? {
          OR: [
            { property: { displayName: { contains: TERM, mode: "insensitive" } } },
            { property: { street1: { contains: TERM, mode: "insensitive" } } },
            { property: { client: { displayName: { contains: TERM, mode: "insensitive" } } } },
          ],
        }
      : {},
    include: {
      schedule: true,
      property: { select: { displayName: true, street1: true, client: { select: { displayName: true } } } },
      occurrences: { orderBy: { startAt: "desc" }, take: 1, include: { assignees: true } },
    },
  });

  const now = new Date();
  console.log(`${jobs.length} job(s) matched${TERM ? ` for "${TERM}"` : ""}\n`);

  for (const job of jobs) {
    const label = `${job.property?.client?.displayName ?? "?"} — ${job.property?.displayName ?? job.property?.street1 ?? job.id}`;
    const [latest] = job.occurrences;

    const g1 = job.status === JobStatus.ACCEPTED;
    // Either an auto-renewing schedule, or no schedule at all (the job's
    // own frequencyDays governs — gate 6).
    const g2 = job.schedule
      ? !!job.schedule.autoRenew && !!job.schedule.active
      : true;
    const g3 = !!latest;
    const g4 = !!latest?.startAt && new Date(latest.startAt).getTime() <= now.getTime();
    const g5 =
      !!latest &&
      latest.status !== JobOccurrenceStatus.CANCELED &&
      latest.status !== JobOccurrenceStatus.ARCHIVED &&
      latest.status !== JobOccurrenceStatus.STREAM_PAUSED;
    // A one-off (or any non-STANDARD workflow) has no next visit.
    const g5b = !!latest && latest.workflow === "STANDARD" && !(latest as any).isOneOff;
    const freq = latest?.frequencyDays ?? job.frequencyDays;
    const g6 = !!freq && freq > 0;

    const allPass = g1 && g2 && g3 && g4 && g5 && g5b && g6;
    let ghostDate = "—";
    if (allPass && latest) {
      const { startAt } = computeNextOccurrenceStart(
        latest.startAt, latest.endAt, freq!, (latest as any).nextStartOverride ?? null,
      );
      ghostDate = startAt.toISOString().slice(0, 10);
    }

    console.log(`${allPass ? "✅ GHOSTS" : "❌ NO GHOST"}  ${label}`);
    console.log(`    1. Job.status = ACCEPTED .................. ${ok(g1)}  (${job.status})`);
    console.log(`    2. Repeating (schedule or frequency) ..... ${ok(g2)}  (${job.schedule ? `autoRenew=${job.schedule.autoRenew} active=${job.schedule.active}` : "no schedule — Job.frequencyDays governs"})`);
    console.log(`    3. Has at least one occurrence ........... ${ok(g3)}`);
    console.log(`    4. No FUTURE occurrence already .......... ${ok(g4)}  (latest ${latest?.startAt?.toISOString().slice(0, 10) ?? "—"} ${latest?.status ?? ""})`);
    console.log(`    5. Latest not CANCELED/ARCHIVED/PAUSED ... ${ok(g5)}  (${latest?.status ?? "—"})`);
    console.log(`    5b. Repeating visit, not a one-off ....... ${ok(g5b)}  (workflow=${latest?.workflow ?? "—"}${(latest as any)?.isOneOff ? ", isOneOff" : ""})`);
    console.log(`    6. Frequency resolvable .................. ${ok(g6)}  (occ=${latest?.frequencyDays ?? "null"} job=${job.frequencyDays ?? "null"})`);
    if (allPass) {
      console.log(`    → ghost would be dated ${ghostDate}. It shows only if your`);
      console.log(`      selected date range covers that day, and — in Worker view or`);
      console.log(`      with a single worker picked in "View as" — only if that`);
      console.log(`      worker is a non-observer assignee on the blocking occurrence.`);
      const names = latest!.assignees.map((a) => `${a.userId.slice(-6)}${a.role ? `:${a.role}` : ""}`).join(", ");
      console.log(`      blocking occurrence assignees: ${names || "(none)"}`);
    }
    console.log("");
  }
  process.exit(0);
})();
