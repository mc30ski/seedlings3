/* eslint-disable no-console */
// print-tomorrow.ts
//
// Prints a printable "day sheet" of everything you're assigned to
// tomorrow — jobs, estimates, followups, events, reminders.
//
// Usage:
//   DATABASE_URL="<paste-prod-url-from-neon-or-vercel>" \
//     tsx apps/api/scripts/print-tomorrow.ts
//
// Options:
//   USER_EMAIL=<email>   Which user (defaults to the isOwner=true user)
//   DAY=YYYY-MM-DD       Override the target day (defaults to tomorrow in ET)
//   TZ=America/New_York  (default) — used for day-window calc + display
//
// Pipe to a file for printing:
//   ... > tomorrow.txt

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { etToday, etAddDays, etMidnight, type EtDateKey } from "../src/lib/dates";

neonConfig.webSocketConstructor = ws;
neonConfig.pipelineConnect = false;

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const TZ = "America/New_York";

const dayArg = process.env.DAY;
const targetDay: EtDateKey = (dayArg ? (dayArg as EtDateKey) : etAddDays(etToday(), 1));
const dayStart = etMidnight(targetDay);
const dayEnd = etMidnight(etAddDays(targetDay, 1));

const dayLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
}).format(dayStart);

function fmtTime(d: Date | null | undefined): string {
  if (!d) return "(no time)";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  const emailArg = process.env.USER_EMAIL;
  const user = emailArg
    ? await prisma.user.findFirst({ where: { email: emailArg } })
    : await prisma.user.findFirst({ where: { isOwner: true } });
  if (!user) {
    throw new Error(
      emailArg
        ? `No user found with email ${emailArg}`
        : "No isOwner=true user found. Set USER_EMAIL=<your-email>."
    );
  }

  const occurrences = await prisma.jobOccurrence.findMany({
    where: {
      assignees: {
        // Include if the user is any non-observer assignee. `role` is
        // nullable and SQL `!= 'observer'` is UNKNOWN for NULL, so we
        // have to OR-null explicitly instead of using `{ not: "observer" }`.
        some: {
          userId: user.id,
          OR: [{ role: null }, { role: { not: "observer" } }],
        },
      },
      startAt: { gte: dayStart, lt: dayEnd },
      status: { notIn: ["COMPLETED", "CLOSED", "CANCELED", "ARCHIVED"] },
    },
    include: {
      job: {
        include: {
          property: {
            include: {
              client: {
                include: {
                  contacts: {
                    where: { isPrimary: true },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      },
      assignees: { include: { user: true } },
    },
    orderBy: [{ startAt: "asc" }],
  });

  const reminders = await prisma.reminder.findMany({
    where: {
      userId: user.id,
      remindAt: { gte: dayStart, lt: dayEnd },
      dismissedAt: null,
    },
    orderBy: { remindAt: "asc" },
  });

  const bar = "=".repeat(72);
  const dash = "-".repeat(72);
  console.log(bar);
  console.log(`  ${(user.displayName ?? user.email ?? "USER").toUpperCase()} — ${dayLabel}`);
  console.log(bar);
  console.log(`  ${occurrences.length} item${occurrences.length === 1 ? "" : "s"} scheduled, ${reminders.length} reminder${reminders.length === 1 ? "" : "s"}`);
  console.log("");

  if (occurrences.length === 0 && reminders.length === 0) {
    console.log("  (nothing on the schedule)");
    console.log("");
    return;
  }

  for (const occ of occurrences) {
    const time = fmtTime(occ.startAt);
    const wf = occ.workflow ?? "STANDARD";
    const tag =
      wf === "ESTIMATE" ? "ESTIMATE"
      : wf === "FOLLOWUP" ? "FOLLOWUP"
      : wf === "EVENT" ? "EVENT"
      : wf === "ANNOUNCEMENT" ? "ANNOUNCEMENT"
      : (occ.kind ?? "JOB");
    const title = occ.title || occ.job?.kind || "(untitled)";

    console.log(dash);
    console.log(`  ${time.padEnd(10)}  [${String(tag).padEnd(12)}]  ${title}`);

    // Address
    const propertyAddress = occ.job?.property?.displayName;
    const estimateAddress = occ.estimateAddress;
    const addr = estimateAddress || propertyAddress;
    if (addr) console.log(`              addr: ${addr}`);

    // Client / contact
    const clientName = occ.job?.property?.client?.displayName;
    if (clientName) console.log(`              client: ${clientName}`);
    const primaryContact = occ.job?.property?.client?.contacts?.[0];
    const contactName = occ.contactName || primaryContact?.displayName;
    const contactPhone = occ.contactPhone || primaryContact?.phone;
    const contactEmail = occ.contactEmail || primaryContact?.email;
    if (contactName || contactPhone || contactEmail) {
      const parts: string[] = [];
      if (contactName) parts.push(contactName);
      if (contactPhone) parts.push(contactPhone);
      if (contactEmail) parts.push(contactEmail);
      console.log(`              contact: ${parts.join(" · ")}`);
    }

    // Money
    if (occ.proposalAmount != null) console.log(`              proposal: $${occ.proposalAmount.toFixed(2)}`);
    else if (occ.price != null) console.log(`              price: $${occ.price.toFixed(2)}`);

    // Team
    const activeAssignees = occ.assignees.filter((a) => a.role == null || a.role !== "observer");
    if (activeAssignees.length > 1) {
      const others = activeAssignees
        .filter((a) => a.userId !== user.id)
        .map((a) => a.user?.displayName ?? a.user?.email ?? a.userId)
        .join(", ");
      if (others) console.log(`              team: you + ${others}`);
    }

    // Notes (truncate long)
    if (occ.notes) {
      const notes = occ.notes.length > 220 ? occ.notes.slice(0, 220) + "…" : occ.notes;
      console.log(`              notes: ${notes.split("\n").join("\n                     ")}`);
    }
    if (occ.pinnedNote) {
      console.log(`              PINNED: ${occ.pinnedNote}`);
    }
  }

  if (reminders.length > 0) {
    console.log("");
    console.log(bar);
    console.log("  REMINDERS");
    console.log(bar);
    for (const r of reminders) {
      const time = fmtTime(r.remindAt);
      console.log(`  ${time.padEnd(10)}  ${r.title || "(no title)"}`);
      if (r.notes) console.log(`              ${r.notes.split("\n").join("\n              ")}`);
    }
  }

  console.log("");
  console.log(bar);
  console.log("");
}

main()
  .catch((err) => {
    console.error("FAILED:", err?.message ?? err);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
