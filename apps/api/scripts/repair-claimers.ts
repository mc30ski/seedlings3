/**
 * Repair occurrences that have workers but no claimer.
 *
 * Such a visit cannot be started, completed or paid by anyone below admin —
 * `updateOccurrenceStatus` throws NOT_CLAIMER and the Jobs card hides the
 * buttons entirely. See src/lib/claimerInvariant.ts for how they were created.
 *
 * The write paths are fixed, so this is a one-shot cleanup of rows already on
 * disk. It uses the same `planClaimerRepair` the runtime uses, so the repair
 * and the invariant can never drift apart.
 *
 *   npm run repair:claimers            # dry run — reports, writes nothing
 *   npm run repair:claimers -- --apply # writes, one transaction per occurrence
 */
import { PrismaClient } from "@prisma/client";
import { AUDIT } from "../src/lib/auditActions";
import { writeAudit } from "../src/lib/auditLogger";
import { planClaimerRepair, type ClaimerAssigneeRow } from "../src/lib/claimerInvariant";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const occs = await prisma.jobOccurrence.findMany({
    where: { assignees: { some: {} } },
    select: {
      id: true,
      status: true,
      startAt: true,
      title: true,
      job: { select: { property: { select: { displayName: true } } } },
      assignees: {
        select: {
          id: true, userId: true, assignedById: true, role: true, assignedAt: true,
          user: { select: { displayName: true } },
        },
      },
    },
    orderBy: { startAt: "asc" },
  });

  const broken = occs
    .map((o) => ({ occ: o, plan: planClaimerRepair(o.assignees as unknown as ClaimerAssigneeRow[]) }))
    .filter((x) => x.plan.updates.length > 0);

  console.log(`Scanned ${occs.length} occurrences with assignees.`);
  console.log(`${broken.length} violate the claimer invariant.\n`);

  for (const { occ, plan } of broken) {
    const who = new Map(occ.assignees.map((a) => [a.userId, a.user?.displayName ?? a.userId]));
    const where = occ.job?.property?.displayName ?? occ.title ?? "(no property)";
    const when = occ.startAt ? occ.startAt.toISOString().slice(0, 10) : "(no date)";
    console.log(`  ${occ.id}  ${when}  ${occ.status}  ${where}`);
    for (const a of occ.assignees) {
      const tag = a.role === "observer" ? "observer" : a.assignedById === a.userId ? "CLAIMER" : "worker";
      console.log(`      ${tag.padEnd(9)} ${who.get(a.userId)}  assignedById=${a.assignedById ?? "NULL"}`);
    }
    console.log(`      -> claimer becomes ${who.get(plan.claimerUserId!) ?? plan.claimerUserId}` +
      ` (${plan.updates.length} row${plan.updates.length === 1 ? "" : "s"} repointed)`);
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — nothing written. Re-run with --apply to repair.`);
    return;
  }

  for (const { occ, plan } of broken) {
    await prisma.$transaction(async (tx) => {
      for (const u of plan.updates) {
        await tx.jobOccurrenceAssignee.update({
          where: { id: u.id },
          data: { assignedById: u.assignedById },
        });
      }
      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, null, {
        occurrenceId: occ.id,
        action: "claimer_invariant_repaired",
        source: "repair-claimers script",
        claimerUserId: plan.claimerUserId,
        repointed: plan.updates.map((u) => ({ userId: u.userId, assignedById: u.assignedById })),
      });
    });
  }
  console.log(`\nRepaired ${broken.length} occurrence(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
