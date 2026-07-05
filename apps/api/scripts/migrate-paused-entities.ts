// Step 4 of the pause-simplification migration.
//
// Converts every remaining PAUSED row to the target state:
//
//   Client.status = PAUSED
//     → Cascade-pause all ACCEPTED Jobs on the Client (tagged with
//       clientBulkPausedAt so bulk-resume can find them later), delete
//       their future SCHEDULED occurrences, then flip the Client back
//       to ACTIVE. Independently-paused Jobs stay paused, untagged.
//
//   ClientContact.status = PAUSED
//     → Flip to ARCHIVED. The PAUSED state was silently blocking
//       payment-request delivery; ARCHIVED does the same visibly.
//
// SAFETY INVARIANTS (asserted at multiple points, non-negotiable):
//
//   1. NEVER flips Job.status = PAUSED → ACCEPTED. Existing paused
//      services stay paused.
//   2. NEVER flips Job.status = ARCHIVED → anything. Archived stays
//      archived.
//   3. NEVER triggers next-occurrence generation. This is a stop-only
//      operation; nothing gets restarted.
//   4. NEVER modifies Occurrence rows except deleting future
//      SCHEDULED STANDARD ones on Jobs it's bulk-pausing (same effect
//      as manual pause; this is the intended stopping behavior).
//
// After a successful run:
//   • Zero rows have Client.status = PAUSED
//   • Zero rows have ClientContact.status = PAUSED
//   • Step 5 (schema tighten to drop the PAUSED enum value) can proceed
//
// Idempotent: re-running finds nothing to do.
//
// Usage:
//   npx tsx scripts/migrate-paused-entities.ts                       # dry-run (no actor needed)
//   npx tsx scripts/migrate-paused-entities.ts --apply --actor <uid> # write; --actor REQUIRED
//
// --actor must be a real User.id — AuditEvent.actorUserId has a FK
// constraint. Find yours via a Prisma query or a quick look at the
// Users tab.

import { prisma } from "../src/db/prisma";
import { applyJobPauseSideEffectsInTx } from "../src/services/jobs";
import { randomBytes } from "crypto";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const actorIdx = args.indexOf("--actor");
  const actorUserId = actorIdx >= 0 ? args[actorIdx + 1] : null;

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`Step 4 migration — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Actor: ${actorUserId ?? "(none — dry-run only)"}`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // --actor is required for --apply because AuditEvent has a FK on
  // actorUserId. Dry-runs can skip it (no writes).
  if (apply && !actorUserId) {
    console.error(
      "ERROR: --apply requires --actor <userId>.\n" +
      "Find your user id via a Prisma query or the Users tab, then re-run:\n" +
      "  npx tsx scripts/migrate-paused-entities.ts --apply --actor <uid>",
    );
    process.exit(1);
  }
  if (actorUserId) {
    const found = await prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, displayName: true, email: true },
    });
    if (!found) {
      console.error(`Actor user ${actorUserId} not found. Aborting.`);
      process.exit(1);
    }
    console.log(`Actor resolved: ${found.displayName ?? found.email ?? found.id}\n`);
  }

  // ── Snapshot before ──────────────────────────────────────────────────
  const [pausedClients, pausedContacts] = await Promise.all([
    prisma.client.findMany({
      where: { status: "PAUSED" },
      select: {
        id: true,
        displayName: true,
        properties: {
          select: {
            id: true,
            jobs: {
              select: { id: true, status: true },
            },
          },
        },
      },
    }),
    prisma.clientContact.findMany({
      where: { status: "PAUSED" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        isPrimary: true,
        clientId: true,
        client: { select: { displayName: true } },
      },
    }),
  ]);

  if (pausedClients.length === 0 && pausedContacts.length === 0) {
    console.log("Nothing to migrate. Already at target state.");
    return;
  }

  console.log(`Paused Clients to migrate: ${pausedClients.length}`);
  console.log(`Paused Contacts to migrate: ${pausedContacts.length}\n`);

  // ── Client migration ─────────────────────────────────────────────────
  let clientsMigrated = 0;
  let jobsBulkPaused = 0;
  const clientDetails: { name: string; jobsPaused: number }[] = [];

  for (const c of pausedClients) {
    const acceptedJobs = c.properties.flatMap((p) =>
      p.jobs.filter((j) => j.status === "ACCEPTED").map((j) => j.id),
    );
    clientDetails.push({ name: c.displayName, jobsPaused: acceptedJobs.length });

    if (!apply) {
      clientsMigrated++;
      jobsBulkPaused += acceptedJobs.length;
      continue;
    }

    // Per-Client transaction. Rolling back one Client doesn't lose the
    // others — a partial run can be safely resumed by re-executing.
    const cascadeGroupId = `cg_${randomBytes(9).toString("hex")}`;
    await prisma.$transaction(async (tx) => {
      // ── SAFETY ASSERTIONS at write time ──
      // Never touch PAUSED or ARCHIVED Jobs. Only pause fresh ACCEPTED
      // Jobs. This is the load-bearing invariant that guarantees
      // "nothing that was stopped magically restarts."
      const jobsBefore = await tx.job.findMany({
        where: {
          property: { clientId: c.id },
          status: { in: ["PAUSED", "ARCHIVED"] as any },
        },
        select: { id: true, status: true },
      });
      const beforeSnap = new Map(jobsBefore.map((j) => [j.id, j.status]));

      const now = new Date();
      for (const jobId of acceptedJobs) {
        await tx.job.update({
          where: { id: jobId },
          data: {
            status: "PAUSED",
            clientBulkPausedAt: now,
            clientBulkPausedById: actorUserId,
          },
        });
        await applyJobPauseSideEffectsInTx(tx, actorUserId!, jobId, {
          cascadeGroupId,
          triggeredBy: "step_4_migration",
          clientId: c.id,
          migrationBatch: "paused_client_conversion",
        });
      }

      // Assert invariant #1 + #2 held: no PAUSED or ARCHIVED Job
      // changed status during the operation.
      const jobsAfter = await tx.job.findMany({
        where: {
          id: { in: Array.from(beforeSnap.keys()) },
        },
        select: { id: true, status: true },
      });
      for (const j of jobsAfter) {
        const before = beforeSnap.get(j.id);
        if (j.status !== before) {
          throw new Error(
            `SAFETY VIOLATION: Job ${j.id} status changed ${before} → ${j.status} during migration. Rolling back.`,
          );
        }
      }

      // Flip Client to ACTIVE. archivedAt was already null on any
      // PAUSED Client (they can't have been archived through the
      // cosmetic pause path); leave it alone.
      await tx.client.update({
        where: { id: c.id },
        data: { status: "ACTIVE" },
      });
    });

    clientsMigrated++;
    jobsBulkPaused += acceptedJobs.length;
    console.log(`  ✓ ${c.displayName} — ${acceptedJobs.length} job(s) bulk-paused; Client → ACTIVE`);
  }

  // ── Contact migration ────────────────────────────────────────────────
  let contactsMigrated = 0;
  const primarylessClients: string[] = [];

  for (const ct of pausedContacts) {
    // If archiving this contact leaves its client without any ACTIVE
    // primary contact, flag it for post-migration cleanup. We still
    // ARCHIVE — Step 3 removed the writer so we can't restore PAUSED,
    // and delivery was already broken. But the operator should be
    // aware.
    let leavesClientPrimaryless = false;
    if (ct.isPrimary) {
      const otherActivePrimaries = await prisma.clientContact.count({
        where: {
          clientId: ct.clientId,
          isPrimary: true,
          status: "ACTIVE",
          id: { not: ct.id },
        },
      });
      leavesClientPrimaryless = otherActivePrimaries === 0;
    }

    if (leavesClientPrimaryless && ct.client?.displayName) {
      primarylessClients.push(ct.client.displayName);
    }

    if (!apply) {
      contactsMigrated++;
      continue;
    }

    // Direct update — no cascade needed, no side effects.
    await prisma.clientContact.update({
      where: { id: ct.id },
      data: { status: "ARCHIVED" },
    });
    contactsMigrated++;
    const name = `${ct.firstName} ${ct.lastName ?? ""}`.trim();
    const clientLabel = ct.client?.displayName ?? "(no client)";
    const primaryFlag = leavesClientPrimaryless ? " ⚠ leaves client primary-less" : "";
    console.log(`  ✓ ${name} on ${clientLabel} → ARCHIVED${primaryFlag}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log();
  console.log("─── Summary ────────────────────────────────────────────────────────");
  if (apply) {
    console.log(`  Clients migrated to ACTIVE: ${clientsMigrated}`);
    console.log(`  Jobs bulk-paused: ${jobsBulkPaused}`);
    console.log(`  Contacts moved to ARCHIVED: ${contactsMigrated}`);
    if (primarylessClients.length > 0) {
      console.log();
      console.log(`  ⚠ ${primarylessClients.length} client(s) now have no ACTIVE primary contact:`);
      for (const name of primarylessClients) console.log(`    - ${name}`);
      console.log(`  Payment requests for these clients will fail until an ACTIVE`);
      console.log(`  primary is set. Promote an existing contact or add a new one.`);
    }
  } else {
    console.log(`  Would migrate ${clientsMigrated} client(s) to ACTIVE`);
    console.log(`  Would bulk-pause ${jobsBulkPaused} job(s)`);
    console.log(`  Would archive ${contactsMigrated} contact(s)`);
    if (primarylessClients.length > 0) {
      console.log();
      console.log(`  ⚠ WARNING: ${primarylessClients.length} client(s) would end up with no ACTIVE primary contact.`);
      for (const name of primarylessClients) console.log(`    - ${name}`);
      console.log(`  Consider promoting alternate primaries BEFORE running with --apply.`);
    }
    console.log();
    console.log("Re-run with --apply to write.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
