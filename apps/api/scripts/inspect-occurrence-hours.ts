// Read-only diagnostic — dumps everything you need to explain why a
// completed JobOccurrence's hours got (or didn't get) auto-approved.
//
// Usage:
//   npx tsx scripts/inspect-occurrence-hours.ts <occurrenceId>
//   npx tsx scripts/inspect-occurrence-hours.ts --client "Nicole Wray"
//   npx tsx scripts/inspect-occurrence-hours.ts --property "Main House"
//
// With --client or --property, it picks the most-recent COMPLETED
// occurrence matching. Combine both to narrow further. Prints:
//   • Core payroll-input fields (est, start/end, paused, worker count)
//   • Computed variance vs current threshold setting
//   • hoursApprovedAt / hoursApprovedById (+ approver name if any)
//   • The last 20 audit events touching this occurrence
//
// No writes. Safe to run against prod.

import { prisma } from "../src/db/prisma";

async function main() {
  const args = process.argv.slice(2);
  let occurrenceId: string | null = null;
  let clientFilter: string | null = null;
  let propertyFilter: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--client") clientFilter = args[++i] ?? null;
    else if (a === "--property") propertyFilter = args[++i] ?? null;
    else if (!a.startsWith("--")) occurrenceId = a;
  }

  if (!occurrenceId && !clientFilter && !propertyFilter) {
    console.error("Usage: <occurrenceId> | --client <name> | --property <name>");
    process.exit(1);
  }

  if (!occurrenceId) {
    const occ = await prisma.jobOccurrence.findFirst({
      where: {
        completedAt: { not: null },
        AND: [
          clientFilter
            ? {
                job: {
                  property: {
                    client: { displayName: { contains: clientFilter, mode: "insensitive" } },
                  },
                },
              }
            : {},
          propertyFilter
            ? { job: { property: { displayName: { contains: propertyFilter, mode: "insensitive" } } } }
            : {},
        ],
      },
      orderBy: { completedAt: "desc" },
      select: { id: true },
    });
    if (!occ) {
      console.error("No matching completed occurrence found.");
      process.exit(1);
    }
    occurrenceId = occ.id;
    console.log(`Resolved to occurrence: ${occurrenceId}\n`);
  }

  const occ = await prisma.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      job: {
        select: {
          id: true,
          estimatedMinutes: true,
          frequencyDays: true,
          property: {
            select: {
              displayName: true,
              client: { select: { displayName: true } },
            },
          },
        },
      },
      assignees: {
        include: {
          user: { select: { id: true, displayName: true, email: true } },
        },
      },
    },
  });
  if (!occ) {
    console.error(`Occurrence ${occurrenceId} not found.`);
    process.exit(1);
  }

  const approver = occ.hoursApprovedById
    ? await prisma.user.findUnique({
        where: { id: occ.hoursApprovedById },
        select: { id: true, displayName: true, email: true },
      })
    : null;

  const thresholdRow = await prisma.setting.findUnique({
    where: { key: "HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT" },
  });
  const thresholdPct = thresholdRow?.value ? Number(thresholdRow.value) : 30;

  // Match the server logic exactly (see services/jobs.ts evaluateHoursApproval).
  const activeAssignees = occ.assignees.filter((a) => a.role !== "observer");
  const workerCount = Math.max(1, activeAssignees.length);
  const adjEst =
    occ.estimatedMinutes != null && workerCount > 0
      ? occ.estimatedMinutes / workerCount
      : null;
  const actualMin =
    occ.startedAt && occ.completedAt
      ? Math.max(
          0,
          (occ.completedAt.getTime() - occ.startedAt.getTime() - (occ.totalPausedMs ?? 0)) /
            60000,
        )
      : null;
  const variancePct =
    adjEst && actualMin != null ? (Math.abs(actualMin - adjEst) / adjEst) * 100 : null;
  const shouldAutoApprove =
    variancePct != null && variancePct <= thresholdPct;

  console.log("═══ Occurrence ═══");
  console.log(`  id                    ${occ.id}`);
  console.log(`  client                ${occ.job?.property?.client?.displayName ?? "(none)"}`);
  console.log(`  property              ${occ.job?.property?.displayName ?? "(none)"}`);
  console.log(`  workflow              ${occ.workflow}`);
  console.log(`  status                ${occ.status}`);
  console.log(`  frequencyDays (job)   ${occ.job?.frequencyDays ?? "(one-off)"}`);
  console.log();
  console.log("═══ Payroll inputs ═══");
  console.log(`  estimatedMinutes      ${occ.estimatedMinutes ?? "(null — needs review)"}`);
  console.log(`  job.estimatedMinutes  ${occ.job?.estimatedMinutes ?? "(null)"}`);
  console.log(`  startedAt             ${occ.startedAt?.toISOString() ?? "(null)"}`);
  console.log(`  completedAt           ${occ.completedAt?.toISOString() ?? "(null)"}`);
  console.log(`  totalPausedMs         ${occ.totalPausedMs ?? 0} (${Math.round((occ.totalPausedMs ?? 0) / 60000)}m)`);
  console.log(`  activeAssignees       ${activeAssignees
    .map((a) => a.user?.displayName ?? a.user?.email ?? a.userId)
    .join(", ")}`);
  console.log(`  workerCount           ${workerCount}`);
  console.log();
  console.log("═══ Variance ═══");
  console.log(`  adjustedEstimate      ${adjEst?.toFixed(2) ?? "n/a"} min`);
  console.log(`  actualMinutes         ${actualMin?.toFixed(2) ?? "n/a"} min`);
  console.log(`  variance              ${variancePct?.toFixed(1) ?? "n/a"}%`);
  console.log(`  threshold (setting)   ${thresholdPct}%`);
  console.log(
    `  eval says             ${
      variancePct == null
        ? "NO EVAL POSSIBLE (missing est or times)"
        : shouldAutoApprove
          ? "AUTO-APPROVE"
          : "NEEDS REVIEW"
    }`,
  );
  console.log();
  console.log("═══ Approval state ═══");
  console.log(`  hoursApprovedAt       ${occ.hoursApprovedAt?.toISOString() ?? "(null)"}`);
  console.log(`  hoursApprovedById     ${occ.hoursApprovedById ?? "(null)"}`);
  console.log(
    `  approver              ${approver ? `${approver.displayName ?? approver.email ?? approver.id}` : "(none)"}`,
  );
  if (
    occ.hoursApprovedAt &&
    variancePct != null &&
    !shouldAutoApprove
  ) {
    console.log("  ⚠ INCONSISTENT — approved but variance is outside threshold.");
  }
  console.log();

  const audit = await prisma.auditEvent.findMany({
    where: { metadata: { path: ["occurrenceId"], equals: occ.id } as any },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { actorUser: { select: { displayName: true, email: true } } },
  });
  console.log(`═══ Audit events (${audit.length}) ═══`);
  for (const a of audit) {
    const actor = a.actorUser?.displayName ?? a.actorUser?.email ?? a.actorUserId ?? "(system)";
    const meta = a.metadata as any;
    const flags: string[] = [];
    if (meta?.hoursApproved === true) flags.push("hoursApproved:true");
    if (meta?.hoursApproved === false) flags.push("hoursApproved:false");
    if (meta?.note) flags.push(`note:${meta.note}`);
    if (meta?.status) flags.push(`status:${meta.status}`);
    console.log(
      `  ${a.createdAt.toISOString()}  ${a.action.padEnd(24)}  ${actor.padEnd(24)}  ${flags.join(" ")}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
