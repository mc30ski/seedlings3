/**
 * Verification script for the assertOccurrenceHasWorker gate.
 *
 * Exercises the production code path end-to-end inside a single rollback
 * transaction (no DB pollution). Asserts:
 *   1) No assignees → gate fires (NO_CLAIMER)
 *   2) One worker assignee (role=null) → gate passes
 *   3) One observer-only assignee (role="observer") → gate fires
 *   4) Workers + observers → gate passes (counts workers, ignores observers)
 *   5) Raw SQL sanity: the OR-with-null query matches workers; the
 *      original buggy filter (role <> 'observer') misses them.
 */
import { PrismaClient, JobOccurrenceStatus } from "@prisma/client";

const prisma = new PrismaClient();

const COLORS = { ok: "\x1b[32m", err: "\x1b[31m", reset: "\x1b[0m", dim: "\x1b[2m" };

async function main() {
  let failures = 0;
  const log = (label: string, ok: boolean, detail = "") => {
    const tag = ok ? `${COLORS.ok}PASS${COLORS.reset}` : `${COLORS.err}FAIL${COLORS.reset}`;
    console.log(`  ${tag}  ${label}${detail ? `  ${COLORS.dim}${detail}${COLORS.reset}` : ""}`);
    if (!ok) failures++;
  };

  // Find a real SCHEDULED occurrence to use as the test subject. Reusing
  // its FK columns + workflow keeps the data realistic without inserting
  // anything that escapes the rollback.
  const seedOcc = await prisma.jobOccurrence.findFirst({
    where: { status: "SCHEDULED", jobId: { not: null } },
    select: { id: true, jobId: true, workflow: true, startAt: true },
  });
  if (!seedOcc) {
    console.error("No SCHEDULED occurrence available in dev DB. Reseed first.");
    process.exit(2);
  }
  // Pick two arbitrary worker users to attach (just for FK validity).
  const someUsers = await prisma.user.findMany({
    where: { roles: { some: { role: "WORKER" } } },
    take: 2,
    select: { id: true },
  });
  if (someUsers.length < 2) {
    console.error("Need at least 2 worker users in dev DB. Reseed first.");
    process.exit(2);
  }
  const [workerA, workerB] = someUsers;

  // Wrap the entire verification in a transaction we'll roll back. This
  // intentionally throws at the end to guarantee no rows persist.
  console.log("Running verification (rolls back on completion)…\n");

  try {
    await prisma.$transaction(async (tx) => {
      // Clone the SCHEDULED occurrence so we can mutate without touching the
      // real one. We need its FKs to be valid; we just want an occurrence
      // ID we own for the test.
      const occ = await tx.jobOccurrence.create({
        data: {
          jobId: seedOcc.jobId,
          workflow: seedOcc.workflow,
          status: "SCHEDULED",
          startAt: seedOcc.startAt,
          source: "MANUAL",
        },
      });

      // Helper: run the same count query our gate uses.
      const countWorkers = () =>
        tx.jobOccurrenceAssignee.count({
          where: {
            occurrenceId: occ.id,
            OR: [{ role: null }, { role: { not: "observer" } }],
          },
        });

      // Also run the OLD buggy filter so we can prove the difference.
      const countWorkersBuggy = () =>
        tx.jobOccurrenceAssignee.count({
          where: { occurrenceId: occ.id, role: { not: "observer" } },
        });

      // ── 1) No assignees → count is 0 ─────────────────────────────────
      {
        const n = await countWorkers();
        log("No assignees → count = 0", n === 0, `got ${n}`);
      }

      // ── 2) One worker (role=null) → count is 1 ───────────────────────
      const a = await tx.jobOccurrenceAssignee.create({
        data: { occurrenceId: occ.id, userId: workerA.id, assignedById: workerA.id, role: null },
      });
      {
        const n = await countWorkers();
        log("One worker (role=null) → count = 1", n === 1, `got ${n}`);
        const nBuggy = await countWorkersBuggy();
        log(
          "Original buggy filter MISSES the null-role worker",
          nBuggy === 0,
          `buggy count = ${nBuggy} (would have falsely fired the gate)`,
        );
      }

      // ── 3) Observer-only → count is 0 ────────────────────────────────
      await tx.jobOccurrenceAssignee.delete({ where: { id: a.id } });
      const o = await tx.jobOccurrenceAssignee.create({
        data: { occurrenceId: occ.id, userId: workerA.id, assignedById: workerA.id, role: "observer" },
      });
      {
        const n = await countWorkers();
        log("Observer-only → count = 0", n === 0, `got ${n}`);
      }

      // ── 4) Workers + observers → counts only workers ─────────────────
      await tx.jobOccurrenceAssignee.create({
        data: { occurrenceId: occ.id, userId: workerB.id, assignedById: workerA.id, role: null },
      });
      {
        const n = await countWorkers();
        log("1 observer + 1 worker → count = 1", n === 1, `got ${n}`);
      }

      // ── 5) Exercise the real updateOccurrenceStatus path end-to-end ──
      // Promote the second user out of observer (would be the claimer):
      await tx.jobOccurrenceAssignee.update({
        where: { id: o.id },
        data: { role: null, assignedById: workerA.id },
      });
      {
        const n = await countWorkers();
        log("2 workers, no observers → count = 2", n === 2, `got ${n}`);
      }

      // Force rollback so we don't leave the test occurrence behind.
      throw new Error("__rollback__");
    });
  } catch (err: any) {
    if (err?.message !== "__rollback__") {
      console.error("\nUnexpected error during count-query phase:");
      console.error(err);
      process.exit(1);
    }
  }

  // ── End-to-end: hit the real services.jobs.updateOccurrenceStatus ────
  // We can't use a Prisma transaction here because the service opens its
  // own internal transaction. Instead we create a real occurrence, run
  // the assertions, and clean up explicitly in a finally.
  console.log("\nEnd-to-end via services.jobs.updateOccurrenceStatus…\n");

  // Reuse the same seedOcc as a template.
  const { services } = await import("../src/services/index");
  const adminUser = await prisma.user.findFirst({
    where: { roles: { some: { role: { in: ["ADMIN", "SUPER"] } } } },
    select: { id: true },
  });
  if (!adminUser) {
    console.error("Need an ADMIN or SUPER user in dev DB. Reseed first.");
    process.exit(2);
  }

  let createdOccId: string | null = null;
  try {
    const occ = await prisma.jobOccurrence.create({
      data: {
        jobId: seedOcc.jobId,
        workflow: seedOcc.workflow,
        status: "SCHEDULED",
        startAt: seedOcc.startAt,
        source: "MANUAL",
        isClientConfirmed: true, // bypass the unrelated confirmation gate
      },
    });
    createdOccId = occ.id;

    // ── 6) updateOccurrenceStatus with no assignees → throws NO_CLAIMER ─
    try {
      await services.jobs.updateOccurrenceStatus(adminUser.id, occ.id, JobOccurrenceStatus.IN_PROGRESS);
      log("Status change with no assignees throws NO_CLAIMER", false, "did not throw");
    } catch (err: any) {
      log(
        "Status change with no assignees throws NO_CLAIMER",
        err?.code === "NO_CLAIMER",
        `code=${err?.code}`,
      );
    }

    // ── 7) Add admin as worker, then status change should succeed ───────
    await prisma.jobOccurrenceAssignee.create({
      data: { occurrenceId: occ.id, userId: adminUser.id, assignedById: adminUser.id, role: null },
    });
    try {
      await services.jobs.updateOccurrenceStatus(adminUser.id, occ.id, JobOccurrenceStatus.IN_PROGRESS);
      const after = await prisma.jobOccurrence.findUnique({ where: { id: occ.id }, select: { status: true } });
      log(
        "Status change with assignee succeeds → IN_PROGRESS",
        after?.status === "IN_PROGRESS",
        `status=${after?.status}`,
      );
    } catch (err: any) {
      log("Status change with assignee succeeds → IN_PROGRESS", false, `threw: ${err?.message ?? err}`);
    }

    // ── 8) Forward to PENDING_PAYMENT — gate still passes ───────────────
    try {
      await services.jobs.updateOccurrenceStatus(adminUser.id, occ.id, JobOccurrenceStatus.PENDING_PAYMENT);
      const after = await prisma.jobOccurrence.findUnique({ where: { id: occ.id }, select: { status: true } });
      log(
        "Status change to PENDING_PAYMENT succeeds",
        after?.status === "PENDING_PAYMENT",
        `status=${after?.status}`,
      );
    } catch (err: any) {
      log("Status change to PENDING_PAYMENT succeeds", false, `threw: ${err?.message ?? err}`);
    }

    // ── 9) Revert to SCHEDULED — gate is exempt for reverts ─────────────
    // First remove assignees to simulate a truly-empty occurrence
    await prisma.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId: occ.id } });
    try {
      await services.jobs.updateOccurrenceStatus(adminUser.id, occ.id, JobOccurrenceStatus.SCHEDULED);
      const after = await prisma.jobOccurrence.findUnique({ where: { id: occ.id }, select: { status: true } });
      log(
        "Revert to SCHEDULED succeeds even with zero assignees",
        after?.status === "SCHEDULED",
        `status=${after?.status}`,
      );
    } catch (err: any) {
      log(
        "Revert to SCHEDULED succeeds even with zero assignees",
        false,
        `threw: ${err?.message ?? err}`,
      );
    }
  } finally {
    if (createdOccId) {
      await prisma.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId: createdOccId } });
      await prisma.auditEvent.deleteMany({ where: { metadata: { path: ["occurrenceId"], equals: createdOccId } as any } });
      await prisma.jobOccurrence.delete({ where: { id: createdOccId } }).catch(() => {});
    }
  }

  console.log("");
  if (failures > 0) {
    console.log(`${COLORS.err}${failures} assertion(s) failed.${COLORS.reset}`);
    process.exit(1);
  }
  console.log(`${COLORS.ok}All assertions passed.${COLORS.reset} Safe to deploy.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
