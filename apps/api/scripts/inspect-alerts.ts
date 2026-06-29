// One-off inspection — counts each alert-dropdown category from the
// current DB so we know which ones the seed already covers and which
// need a row added.

import { prisma } from "../src/db/prisma";

async function main() {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 24 * 3600 * 1000);
  const sevenDaysOut = new Date(today.getTime() + 7 * 24 * 3600 * 1000);

  const checks: Array<{ name: string; count: number }> = [];

  // 1. Overdue jobs
  checks.push({
    name: "Overdue jobs",
    count: await prisma.jobOccurrence.count({
      where: {
        startAt: { gte: sixtyDaysAgo, lt: yesterday },
        status: { notIn: ["COMPLETED", "CLOSED", "ARCHIVED", "ACCEPTED", "REJECTED", "CANCELED"] as any },
        workflow: { not: "ANNOUNCEMENT" as any },
      },
    }),
  });

  // 2. Pending Users
  checks.push({
    name: "Pending Users (sign-ups awaiting approval)",
    count: await prisma.user.count({ where: { isApproved: false } }),
  });

  // 3. Guaranteed payout expiring (≤7 days)
  checks.push({
    name: "Guaranteed payout expiring (≤7 days)",
    count: await prisma.user.count({
      where: {
        guaranteedPayoutUntil: { gte: today, lte: sevenDaysOut },
      },
    }),
  });

  // 4a. Pending payment approvals (unconfirmed Payments)
  checks.push({
    name: "Pending payment approvals",
    count: await prisma.payment.count({ where: { confirmed: false, writtenOff: false } }),
  });

  // 4b. Outstanding client invoices (paymentRequestSentAt set, no payment)
  checks.push({
    name: "Outstanding client invoices",
    count: await prisma.jobOccurrence.count({
      where: {
        status: "PENDING_PAYMENT" as any,
        paymentRequestSentAt: { not: null },
        payment: { is: null },
      },
    }),
  });

  // 5. Workdays to approve (past date, ended, not approved)
  checks.push({
    name: "Workdays to approve",
    count: await prisma.workerWorkday.count({
      where: { approvedAt: null, endedAt: { not: null } },
    }),
  });

  // 6. Ledger followups (unresolved)
  checks.push({
    name: "Ledger followups (unresolved)",
    count: await prisma.ledgerFollowup.count({ where: { resolvedAt: null } }),
  });

  // 7. Change requests (pending)
  checks.push({
    name: "Change requests (pending)",
    count: await prisma.occurrenceChangeRequest.count({ where: { resolvedAt: null } }),
  });

  // 8. Estimate followups (PROPOSAL_SUBMITTED + old)
  checks.push({
    name: "Estimate followups (PROPOSAL_SUBMITTED, ≥3 days old)",
    count: await prisma.jobOccurrence.count({
      where: {
        workflow: "ESTIMATE" as any,
        status: "PROPOSAL_SUBMITTED" as any,
        startAt: { lt: new Date(today.getTime() - 3 * 24 * 3600 * 1000) },
      },
    }),
  });

  // 9. Unapproved hours (job completed, hoursApprovedAt null)
  checks.push({
    name: "Unapproved hours awaiting payroll review",
    count: await prisma.jobOccurrence.count({
      where: {
        completedAt: { not: null },
        hoursApprovedAt: null,
      },
    }),
  });

  // 10. Unclaimed jobs (no assignees)
  checks.push({
    name: "Unclaimed jobs",
    count: await prisma.jobOccurrence.count({
      where: {
        startAt: { gte: yesterday, lte: sevenDaysOut },
        status: "SCHEDULED" as any,
        assignees: { none: {} },
      },
    }),
  });

  // 11. Announcements (active)
  checks.push({
    name: "Announcements (active)",
    count: await prisma.jobOccurrence.count({
      where: {
        workflow: "ANNOUNCEMENT" as any,
        startAt: { gte: today },
      },
    }),
  });

  // 12. Timeline urgent — past-due rows (matches services/timelineEvents.ts upcomingCounts)
  checks.push({
    name: "Timeline (past due / urgent)",
    count: await prisma.timelineEvent.count({
      where: {
        archivedAt: null,
        OR: [
          { nextDueDate: { lt: today } },
          { AND: [{ nextDueDate: null }, { anchorDate: { lt: today } }] },
        ],
      },
    }),
  });

  // 13. Unlinked client accounts (User with no roles, isApproved=true, no ClientContact link)
  const clientUsers = await prisma.user.findMany({
    where: { roles: { none: {} }, isApproved: true },
    select: { clerkUserId: true },
  });
  const linked = await prisma.clientContact.findMany({
    where: { clerkUserId: { not: null } },
    select: { clerkUserId: true },
  });
  const linkedSet = new Set(linked.map((c) => c.clerkUserId));
  const unlinkedCount = clientUsers.filter((u) => !linkedSet.has(u.clerkUserId)).length;
  checks.push({ name: "Unlinked client accounts", count: unlinkedCount });

  console.log("\n=== Alert dropdown category coverage ===\n");
  const max = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    const status = c.count > 0 ? "✓" : "✗ MISSING";
    console.log(`  ${c.name.padEnd(max + 2)} ${String(c.count).padStart(4)}  ${status}`);
  }
  console.log("");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
