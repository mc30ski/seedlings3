import type { Prisma, PrismaClient } from "@prisma/client";
import { isPaid, type WorkerType } from "@repo/money";
import { AUDIT } from "./auditActions";
import { writeAudit } from "./auditLogger";

/**
 * THE ASSIGNEE INVARIANTS
 * =======================
 *
 * Two rules about the rows on one occurrence, both re-established at the end
 * of every write path by `enforceAssigneeInvariants`. They live together
 * because they interact: demoting someone to observer can remove the claimer,
 * so the demotion has to run FIRST and the claimer repair on what is left.
 *
 *   1. THE CLAIMER INVARIANT (below) — unclaimed, or exactly one claimer.
 *   2. ONLY A PAID PERSON TAKES A PAID SEAT — a non-observer assignee must be
 *      on payroll. See `planObserverOnlyDemotions`.
 *
 * ── 1. THE CLAIMER INVARIANT ──────────────────────────────────────────────
 *
 * An occurrence is either UNCLAIMED (no non-observer assignees at all) or it
 * has EXACTLY ONE claimer — a non-observer assignee whose `assignedById`
 * equals their own `userId`. There is no third state.
 *
 * Everything downstream reads the claimer the same way, so a visit with
 * workers and no claimer is not a cosmetic problem — it is unworkable:
 *
 *   • `jobs.updateOccurrenceStatus` throws NOT_CLAIMER, so nobody without
 *     `schedule.manage` can start, pause, complete or manage the visit.
 *   • The Jobs card hides Start / Complete entirely — both the card and the
 *     server gate on `isClaimer || canManageSchedule`, so the worker standing
 *     at the property has no control and no explanation. Anyone holding
 *     `schedule.manage` still sees the button, which is why this hid for
 *     months behind "just get someone with `schedule.manage` to do it".
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
 *      `assignedById = actorUserId`. Someone with `schedule.manage` adding the FIRST worker made
 *      that worker a non-claimer on a visit with no claimer.
 *   3. `groups.attachGroupToOccurrence` in admin mode stamped
 *      `assignedById = actorUserId` for every member, claimer included.
 *   4. `removeOccurrenceAssignee` let someone with `schedule.manage` delete the claimer out from
 *      under a team (the single-remove path guards this; this one did not).
 *
 * The rule for new code is simple: any function that writes
 * `jobOccurrenceAssignee` ends by awaiting `enforceAssigneeInvariants`. That
 * is mechanically enforced by `claimer-invariant-build-gate.test.ts` — the
 * gate fails the build if a write site skips it, so the invariant cannot rot
 * back in through a path nobody thought about.
 *
 * ── 2. ONLY A PAID PERSON TAKES A PAID SEAT ───────────────────────────────
 *
 * A non-observer assignee is a person the money system will try to pay. So
 * they must be on payroll — EMPLOYEE or CONTRACTOR — and anyone else is an
 * observer.
 *
 * This exists because UNPAID does not mean "paid zero", it means NOT IN
 * PAYROLL AT ALL. An unpaid helper in a paid seat broke things in both
 * directions:
 *
 *   • `computeBreakdown` THREW. `rateFor` refuses to price a worker with no
 *     pay class rather than guess, so setting the price on a visit with an
 *     unpaid helper on the crew failed the whole transaction. Proven: a crew
 *     of {EMPLOYEE 34%, CONTRACTOR 33%, UNPAID 33%} raised
 *     "rateFor() was handed an UNPAID worker".
 *   • Before that refusal existed, every `!isEmployeeClass(x)` in the money
 *     code read them as a CONTRACTOR — a share of equipment fees, a line in
 *     QuickBooks Contract Labor, and a row in the employer payroll-tax base.
 *
 * An untyped person (`workerType === null`) is held to the same rule, for the
 * same reason: nobody can be paid before it is decided how they are paid, and
 * "decide later" is how a person ends up priced as whatever the fallback was.
 *
 * Demotion rather than refusal, HERE. This runs after the fact, on rows that
 * already exist, and the common way to reach it is someone's worker type
 * changing while they sit on open visits — there is no request left to
 * refuse. The add/assign boundary refuses up front so the UI can explain
 * itself; this is the net underneath, and it audits every demotion so a
 * silently-moved person is visible rather than looking like they were always
 * an observer.
 */

/** The subset of JobOccurrenceAssignee the invariants reason about. */
export type ClaimerAssigneeRow = {
  id: string;
  userId: string;
  assignedById: string | null;
  role: string | null;
  assignedAt: Date;
  /** How this person is paid. Undefined when the caller did not load it —
   *  treated as "do not demote", because a missing join must never be read
   *  as "not on payroll" and silently demote a whole team. */
  workerType?: WorkerType | null;
};

export type ClaimerPlan = {
  /** Who ends up claimer, or null when the occurrence is legitimately unclaimed. */
  claimerUserId: string | null;
  /** Rows whose `assignedById` is wrong today, with the value to write. */
  updates: Array<{ id: string; userId: string; assignedById: string }>;
};

const isObserver = (r: ClaimerAssigneeRow) => r.role === "observer";

/**
 * Which rows are sitting in a paid seat they are not eligible for.
 *
 * Pure, and deliberately conservative: a row whose `workerType` was not
 * loaded (`undefined`) is LEFT ALONE. Reading an absent join as "not on
 * payroll" would demote an entire team the moment someone forgot a `select`,
 * and a silent mass-demotion is far worse than a missed one — the claimer
 * repair below would then hand the visit to nobody.
 */
export function planObserverOnlyDemotions(
  rows: ClaimerAssigneeRow[],
): Array<{ id: string; userId: string; workerType: WorkerType | null }> {
  return rows
    .filter((r) => !isObserver(r))
    .filter((r) => r.workerType !== undefined)
    .filter((r) => !isPaid(r.workerType))
    .map((r) => ({ id: r.id, userId: r.userId, workerType: r.workerType ?? null }));
}

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
export async function enforceAssigneeInvariants(
  tx: PrismaClient | Prisma.TransactionClient,
  occurrenceId: string,
  actorUserId: string | null,
): Promise<{
  repaired: boolean;
  claimerUserId: string | null;
  demotedUserIds: string[];
}> {
  const loaded = await tx.jobOccurrenceAssignee.findMany({
    where: { occurrenceId },
    select: {
      id: true,
      userId: true,
      assignedById: true,
      role: true,
      assignedAt: true,
      user: { select: { workerType: true } },
    },
  });
  let rows: ClaimerAssigneeRow[] = loaded.map((r) => ({
    id: r.id,
    userId: r.userId,
    assignedById: r.assignedById,
    role: r.role,
    assignedAt: r.assignedAt,
    workerType: r.user?.workerType ?? null,
  }));

  // INVARIANT 2 FIRST. A demotion can remove the claimer, so the claimer
  // repair below has to run on the rows as they end up, not as they arrived.
  const demotions = planObserverOnlyDemotions(rows);
  for (const d of demotions) {
    await tx.jobOccurrenceAssignee.update({
      where: { id: d.id },
      // `assignedById` is nulled because an observer's is meaningless, and a
      // self-assigned row left behind would read as a claimer.
      data: { role: "observer", assignedById: null },
    });
    await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, actorUserId, {
      occurrenceId,
      action: "demoted_to_observer_not_on_payroll",
      userId: d.userId,
      workerType: d.workerType,
      why:
        "A non-observer assignee is someone the money system will try to pay. " +
        "This person has no pay class, so they cannot hold a paid seat.",
    });
  }
  if (demotions.length > 0) {
    const demoted = new Set(demotions.map((d) => d.id));
    rows = rows.map((r) =>
      demoted.has(r.id) ? { ...r, role: "observer", assignedById: null } : r,
    );
  }

  const plan = planClaimerRepair(rows);
  const demotedUserIds = demotions.map((d) => d.userId);
  if (plan.updates.length === 0) {
    return {
      repaired: demotions.length > 0,
      claimerUserId: plan.claimerUserId,
      demotedUserIds,
    };
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

  return { repaired: true, claimerUserId: plan.claimerUserId, demotedUserIds };
}

/**
 * May this person hold a PAID seat on a visit?
 *
 * The boundary counterpart to `planObserverOnlyDemotions`. The demotion is a
 * net under rows that already exist; this refuses the request up front, so
 * the UI can say why instead of the person appearing to be added and then
 * quietly turning into an observer.
 */
export function canHoldPaidSeat(workerType: WorkerType | null | undefined): boolean {
  return isPaid(workerType);
}

/** Why a non-paid person cannot take a paid seat, in the operator's words. */
export const PAID_SEAT_REFUSAL =
  "Only someone on payroll can be added to a visit as a worker. An unpaid " +
  "helper, or anyone whose worker type has not been set, can be added as an " +
  "observer.";
