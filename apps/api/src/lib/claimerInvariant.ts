import type { Prisma, PrismaClient } from "@prisma/client";
import { AUDIT } from "./auditActions";
import { writeAudit } from "./auditLogger";

/**
 * THE CLAIMER INVARIANT
 * =====================
 *
 * An occurrence is either UNCLAIMED (no non-observer assignees at all) or it
 * has EXACTLY ONE claimer — a non-observer assignee whose `assignedById`
 * equals their own `userId`. There is no third state.
 *
 * Everything downstream reads the claimer the same way, so a visit with
 * workers and no claimer is not a cosmetic problem — it is unworkable:
 *
 *   • `jobs.updateOccurrenceStatus` throws NOT_CLAIMER, so nobody below
 *     admin can start, pause, complete or manage the visit.
 *   • The Jobs card hides Start / Complete entirely (`isClaimer || forAdmin`),
 *     so the worker standing at the property has no control at all and no
 *     explanation. An admin sees the button because `forAdmin` is the VIEW,
 *     not the role — which is why this hid for months behind "just switch to
 *     Admin".
 *   • `paymentRequests` picks the payee with `find(a => a.assignedById === a.userId)`
 *     and gets `null`.
 *
 * How visits used to lose their claimer (all fixed, all now netted here):
 *
 *   1. `setOccurrenceAssignees` promoted a new claimer with
 *      `createMany({ skipDuplicates: true })`. `createMany` cannot UPDATE, and
 *      `@@unique([occurrenceId, userId])` means anyone who already had a row
 *      was silently skipped — so the promotion was dropped on exactly the
 *      people who needed it. Remove the claimer from a two-person team and the
 *      survivor kept `assignedById` pointing at the person who just left.
 *   2. `updateLightEstimate` / `addOccurrenceAssignee` stamped
 *      `assignedById = actorUserId`. An admin adding the FIRST worker made
 *      that worker a non-claimer on a visit with no claimer.
 *   3. `groups.attachGroupToOccurrence` in admin mode stamped
 *      `assignedById = actorUserId` for every member, claimer included.
 *   4. `removeOccurrenceAssignee` let an admin delete the claimer out from
 *      under a team (the single-remove admin path guards this; this one did not).
 *
 * The rule for new code is simple: any function that writes
 * `jobOccurrenceAssignee` ends by awaiting `enforceClaimerInvariant`. That is
 * mechanically enforced by `claimer-invariant-build-gate.test.ts` — the gate
 * fails the build if a write site skips it, so the invariant cannot rot back
 * in through a path nobody thought about.
 */

/** The subset of JobOccurrenceAssignee the invariant reasons about. */
export type ClaimerAssigneeRow = {
  id: string;
  userId: string;
  assignedById: string | null;
  role: string | null;
  assignedAt: Date;
};

export type ClaimerPlan = {
  /** Who ends up claimer, or null when the occurrence is legitimately unclaimed. */
  claimerUserId: string | null;
  /** Rows whose `assignedById` is wrong today, with the value to write. */
  updates: Array<{ id: string; userId: string; assignedById: string }>;
};

const isObserver = (r: ClaimerAssigneeRow) => r.role === "observer";

/**
 * Decide the repair. Pure — no DB, no clock — so the edge cases below are
 * unit-testable without a database.
 *
 * Seniority (earliest `assignedAt`, ties broken by row id) picks the claimer
 * when there is no valid one, because on a mixed team the person who has been
 * on the visit longest is the one the others were assigned alongside. It is
 * also stable: re-running the repair never reshuffles a team.
 *
 * Observers are left completely alone. They are not eligible to be claimer and
 * their `assignedById` carries no meaning (`changeAssigneeRole` nulls it), so
 * touching them would only churn rows.
 */
export function planClaimerRepair(rows: ClaimerAssigneeRow[]): ClaimerPlan {
  const workers = rows.filter((r) => !isObserver(r));
  // Unclaimed is a legal, meaningful state — an open visit on the board.
  if (workers.length === 0) return { claimerUserId: null, updates: [] };

  const bySeniority = [...workers].sort((a, b) => {
    const t = a.assignedAt.getTime() - b.assignedAt.getTime();
    return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // More than one self-assigned row is just as broken as none: `find()`
  // callers would silently pick whichever row the query returned first.
  const claimers = bySeniority.filter((r) => r.assignedById === r.userId);
  const claimer = claimers[0] ?? bySeniority[0];

  const updates: ClaimerPlan["updates"] = [];
  for (const r of bySeniority) {
    const want = r.userId === claimer.userId ? r.userId : claimer.userId;
    if (r.assignedById !== want) {
      updates.push({ id: r.id, userId: r.userId, assignedById: want });
    }
  }
  return { claimerUserId: claimer.userId, updates };
}

/**
 * Re-establish the invariant on one occurrence, inside the caller's
 * transaction. Reads, repairs only if something is actually wrong, and audits
 * the repair so a silently-fixed team is visible afterwards rather than
 * looking like it was always fine.
 *
 * Call this at the END of any function that writes `jobOccurrenceAssignee`,
 * after the last write, so it sees the final state of the transaction.
 */
export async function enforceClaimerInvariant(
  tx: PrismaClient | Prisma.TransactionClient,
  occurrenceId: string,
  actorUserId: string | null,
): Promise<{ repaired: boolean; claimerUserId: string | null }> {
  const rows = await tx.jobOccurrenceAssignee.findMany({
    where: { occurrenceId },
    select: { id: true, userId: true, assignedById: true, role: true, assignedAt: true },
  });

  const plan = planClaimerRepair(rows as ClaimerAssigneeRow[]);
  if (plan.updates.length === 0) {
    return { repaired: false, claimerUserId: plan.claimerUserId };
  }

  for (const u of plan.updates) {
    await tx.jobOccurrenceAssignee.update({
      where: { id: u.id },
      data: { assignedById: u.assignedById },
    });
  }

  await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, actorUserId, {
    occurrenceId,
    action: "claimer_invariant_repaired",
    claimerUserId: plan.claimerUserId,
    repointed: plan.updates.map((u) => ({ userId: u.userId, assignedById: u.assignedById })),
  });

  return { repaired: true, claimerUserId: plan.claimerUserId };
}
