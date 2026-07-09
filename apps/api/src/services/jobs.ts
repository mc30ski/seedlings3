/*
Summary: how it all works together
 - You create a Job for a Property (template) with required kind and status.
 - Optionally attach a JobSchedule with autoRenew=true and a simple cadence.
 - The system creates JobOccurrences (instances) either:
   - manually (createOccurrence → source=MANUAL), or
   - by your generator (generateOccurrences → source=GENERATED)
 - Each occurrence can be assigned to one or more workers using JobOccurrenceAssignee.
   -The service enforces “assignable only if Role.WORKER” by checking UserRole before writing assignment rows.
 - Default assignees on the Job template get copied to the occurrence when you create/generate it, but you can override on the occurrence at any time.
*/

import { prisma } from "../db/prisma";
import {
  Prisma,
  Role,
  JobStatus,
  JobOccurrenceStatus,
  JobOccurrenceSource,
  OccurrenceWorkflow,
} from "@prisma/client";
import type { ServicesJobs } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { etMidnight, etEndOfDay, etToday, etFormatDate, etDaysBetween } from "../lib/dates";
import { ServiceError } from "../lib/errors";
import {
  occurrenceWorkDateCutoff,
  paymentIncludeWithCutoff,
  expensesIncludeWithCutoff,
} from "../lib/businessStartCutoff";
import {
  consumeHoldsForOccurrence,
  releaseHoldsForOccurrence,
  reactivateHoldsForOccurrence,
} from "./supplies";

// ─────────────────────────────────────────────────────────────────────────
// Pause / resume side-effect helpers
//
// Shared between `jobs.update()` (the canonical single-Job status change
// entry point) and `clients.bulkPauseServices()` / `bulkResumeServices()`
// (the Client-level bulk actions built on top). Both entry points must
// produce identical side effects — future-occurrence deletion on pause,
// recurring-chain rebuild on resume — otherwise the bulk operation drifts
// from what an operator sees when they pause one Job manually.
//
// Both helpers accept an existing tx so the caller can compose them into
// a larger transaction (e.g. bulk-pausing 5 Jobs all-or-nothing).
// ─────────────────────────────────────────────────────────────────────────

/**
 * "Job stopped" side effects — used by both pause and archive:
 *   1. Delete every future SCHEDULED STANDARD JobOccurrence.
 *   2. Audit the count removed.
 *
 * Does NOT flip Job.status — that's the caller's responsibility. This
 * lets a bulk action write status + tag columns + audit itself in one
 * place, and just call this for the side effects.
 *
 * `sideEffectAction` distinguishes pause from archive in the audit
 * trail — defaults to the pause label so existing callers stay stable.
 */
export async function applyJobPauseSideEffectsInTx(
  tx: Prisma.TransactionClient,
  currentUserId: string,
  jobId: string,
  extraAuditMeta?: Record<string, unknown>,
  sideEffectAction: string = "PAUSED_REMOVED_FUTURE_OCCURRENCES",
): Promise<void> {
  const deleted = await tx.jobOccurrence.deleteMany({
    where: {
      jobId,
      status: JobOccurrenceStatus.SCHEDULED,
      workflow: OccurrenceWorkflow.STANDARD,
      startAt: { gt: new Date() },
    },
  });
  if (deleted.count > 0) {
    await writeAudit(tx, AUDIT.JOB.UPDATED, currentUserId, {
      id: jobId,
      action: sideEffectAction,
      removedCount: deleted.count,
      ...(extraAuditMeta ?? {}),
    });
  }
}

/**
 * "Job restarted" side effects — used by both unpause and unarchive:
 *   1. Skip if `frequencyDays` is missing or ≤ 0 (nothing to regenerate).
 *   2. Skip if a future SCHEDULED STANDARD occurrence already exists
 *      (dedupe against manual "Force Create Next" clicks).
 *   3. Anchor on the most-recent existing occurrence and step forward
 *      by `frequencyDays` until the next start lands today-or-later.
 *   4. Create one SCHEDULED occurrence and attach default assignees
 *      (group default wins; archived groups leave the occurrence
 *      unassigned, matching approvePayment's rule).
 *   5. Audit the regeneration.
 *
 * Does NOT flip Job.status — same contract as the stop helper.
 *
 * `sideEffectAction` distinguishes unpause from unarchive in the audit
 * trail — defaults to the unpause label so existing callers stay stable.
 */
export async function applyJobResumeSideEffectsInTx(
  tx: Prisma.TransactionClient,
  currentUserId: string,
  jobId: string,
  extraAuditMeta?: Record<string, unknown>,
  sideEffectAction: string = "UNPAUSED_REGENERATED_NEXT_OCCURRENCE",
): Promise<void> {
  const job = await tx.job.findUnique({
    where: { id: jobId },
    select: { frequencyDays: true },
  });
  const freq = job?.frequencyDays;
  if (!freq || freq <= 0) return;

  // Dedupe against any future occurrence already on the stream — SCHEDULED
  // (normal) OR STREAM_PAUSED (temporarily held). Skipping STREAM_PAUSED
  // in this check would create a duplicate occurrence on the stream after
  // a Job-level pause/resume cycle if a stream-pause was in flight when
  // the Job pause happened.
  const existingFuture = await tx.jobOccurrence.findFirst({
    where: {
      jobId,
      status: {
        in: [
          JobOccurrenceStatus.SCHEDULED,
          JobOccurrenceStatus.STREAM_PAUSED,
        ],
      },
      workflow: OccurrenceWorkflow.STANDARD,
      startAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (existingFuture) return;

  const lastOcc = await tx.jobOccurrence.findFirst({
    where: {
      jobId,
      workflow: OccurrenceWorkflow.STANDARD,
      isOneOff: false,
    },
    orderBy: { startAt: "desc" },
    include: {
      job: {
        select: {
          kind: true,
          defaultPrice: true,
          estimatedMinutes: true,
          notes: true,
          defaultGroupId: true,
          defaultAssignees: {
            where: { active: true },
            select: { userId: true, role: true },
          },
        },
      },
    },
  });
  if (!lastOcc?.startAt || !lastOcc.job) return;

  const nextStart = new Date(lastOcc.startAt);
  // date-handling-allow: recurrence — adds calendar days to the last
  // occurrence's startAt to compute the next cycle. Same pattern as
  // approvePayment / forceCreateNextOccurrence; the documented Vercel-UTC
  // exemption applies (see date-handling-build-gate.test.ts rule 8).
  nextStart.setDate(nextStart.getDate() + freq);
  const now = new Date();
  while (nextStart.getTime() < now.getTime()) {
    nextStart.setDate(nextStart.getDate() + freq);
  }
  const nextEnd = lastOcc.endAt
    ? new Date(nextStart.getTime() + (lastOcc.endAt.getTime() - lastOcc.startAt.getTime()))
    : null;
  const nextOcc = await tx.jobOccurrence.create({
    data: {
      jobId,
      kind: lastOcc.kind,
      startAt: nextStart,
      endAt: nextEnd,
      status: JobOccurrenceStatus.SCHEDULED,
      source: JobOccurrenceSource.GENERATED,
      workflow: OccurrenceWorkflow.STANDARD,
      isAdminOnly: !!(lastOcc as any).isAdminOnly,
      jobType: (lastOcc as any).jobType ?? null,
      jobTags: (lastOcc as any).jobTags ?? null,
      notes: lastOcc.notes ?? lastOcc.job.notes ?? null,
      price: lastOcc.price ?? lastOcc.job.defaultPrice ?? null,
      estimatedMinutes: lastOcc.estimatedMinutes ?? lastOcc.job.estimatedMinutes ?? null,
      frequencyDays: (lastOcc as any).frequencyDays ?? null,
    } as any,
  });
  const assigneeSource: { userId: string; role: string | null }[] = [];
  const defaultGroupId = lastOcc.job.defaultGroupId as string | null;
  if (defaultGroupId) {
    const group = await tx.group.findUnique({
      where: { id: defaultGroupId },
      include: { members: { select: { userId: true, role: true } } },
    });
    if (group && !group.archivedAt) {
      await tx.jobOccurrence.update({
        where: { id: nextOcc.id },
        data: { assignedGroupId: group.id } as any,
      });
      assigneeSource.push({ userId: group.claimerUserId, role: null });
      for (const m of group.members) {
        assigneeSource.push({
          userId: m.userId,
          role: m.role === "observer" ? "observer" : null,
        });
      }
    }
  } else {
    for (const d of lastOcc.job.defaultAssignees) {
      assigneeSource.push({ userId: d.userId, role: d.role ?? null });
    }
  }
  if (assigneeSource.length > 0) {
    const claimerId = assigneeSource[0].userId;
    await tx.jobOccurrenceAssignee.createMany({
      data: assigneeSource.map((d, i) => ({
        occurrenceId: nextOcc.id,
        userId: d.userId,
        role: d.role,
        assignedById: i === 0 ? d.userId : claimerId,
      })),
      skipDuplicates: true,
    });
  }
  await writeAudit(tx, AUDIT.JOB.UPDATED, currentUserId, {
    id: jobId,
    action: sideEffectAction,
    occurrenceId: nextOcc.id,
    startAt: nextStart.toISOString(),
    ...(extraAuditMeta ?? {}),
  });
}

// ---- helpers ----

async function assertWorkerAssignable(
  tx: Prisma.TransactionClient,
  userId: string
) {
  const hasWorker = await tx.userRole.findFirst({
    where: { userId, role: Role.WORKER },
    select: { id: true },
  });
  if (!hasWorker) {
    throw new Error("Only users with Role.WORKER can be assigned to jobs.");
  }
}

function toDate(x: any): Date | null {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(String(x));
  return isNaN(d.getTime()) ? null : d;
}

/** Valid status transitions per workflow */
const VALID_TRANSITIONS: Record<string, Record<string, string[]>> = {
  STANDARD: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["CLOSED", "CANCELED"],
    CLOSED: ["ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["CLOSED", "CANCELED"],
    CLOSED: ["ARCHIVED"],
  },
  ESTIMATE: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PROPOSAL_SUBMITTED", "CANCELED"],
    PROPOSAL_SUBMITTED: ["ACCEPTED", "REJECTED"],
    ACCEPTED: ["CLOSED"],
    REJECTED: ["CLOSED"],
    CLOSED: ["ARCHIVED"],
  },
  TASK: {
    SCHEDULED: ["CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "ARCHIVED"],
  },
  REMINDER: {
    SCHEDULED: ["CLOSED"],
    CLOSED: ["SCHEDULED"],
  },
};

/** Admin-allowed transitions — includes reversals for correcting mistakes */
const ADMIN_TRANSITIONS: Record<string, Record<string, string[]>> = {
  STANDARD: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "SCHEDULED", "CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "PENDING_PAYMENT", "ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PAUSED", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PAUSED: ["IN_PROGRESS", "SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "SCHEDULED", "CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "PENDING_PAYMENT", "ARCHIVED"],
  },
  ESTIMATE: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["SCHEDULED", "PROPOSAL_SUBMITTED", "CANCELED"],
    PROPOSAL_SUBMITTED: ["IN_PROGRESS", "ACCEPTED", "REJECTED"],
    ACCEPTED: ["PROPOSAL_SUBMITTED", "CLOSED"],
    REJECTED: ["PROPOSAL_SUBMITTED", "CLOSED"],
    CLOSED: ["ACCEPTED", "ARCHIVED"],
  },
  TASK: {
    SCHEDULED: ["CLOSED", "CANCELED"],
    CLOSED: ["SCHEDULED", "ARCHIVED"],
    CANCELED: ["SCHEDULED"],
  },
  REMINDER: {
    SCHEDULED: ["CLOSED"],
    CLOSED: ["SCHEDULED"],
  },
};

function isValidTransition(workflow: string, from: string, to: string): boolean {
  return VALID_TRANSITIONS[workflow]?.[from]?.includes(to) ?? false;
}

function isValidAdminTransition(workflow: string, from: string, to: string): boolean {
  return ADMIN_TRANSITIONS[workflow]?.[from]?.includes(to) ?? false;
}

// Default for the hours-variance threshold when no Setting row is present.
// The Setting key is HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT, stored as a
// whole number (e.g. "30" = 30%). Both the payroll-approval logic below and
// the visual "⚠ X% over estimate" warning on the JobsTab card read the
// same value so they can't drift.
const DEFAULT_HOURS_APPROVAL_VARIANCE_THRESHOLD = 0.3;

/** Load the variance threshold as a decimal (e.g. 0.3 for 30%). */
export async function loadHoursApprovalVarianceThreshold(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: "HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT" },
  });
  if (!row?.value) return DEFAULT_HOURS_APPROVAL_VARIANCE_THRESHOLD;
  const pct = Number(row.value);
  if (!Number.isFinite(pct) || pct < 0) return DEFAULT_HOURS_APPROVAL_VARIANCE_THRESHOLD;
  return pct / 100;
}

/**
 * Decide whether to auto-approve payroll hours when an occurrence transitions
 * into a completed state. The two outputs are the values to patch onto
 * JobOccurrence: a Date+userId (auto-approved) or null+null (needs review).
 *
 * Rules:
 *   - Only STANDARD / ONE_OFF workflows carry payroll-relevant hours. Other
 *     workflows (ESTIMATE, TASK, REMINDER, EVENT, FOLLOWUP, ANNOUNCEMENT)
 *     get auto-approved unconditionally — they don't appear in payroll.
 *   - Without an estimatedMinutes baseline we have no variance to compare
 *     against, so we require explicit approval.
 *   - Otherwise compare actual minutes vs adjusted estimate (divided by
 *     active worker count). Within threshold → auto-approve. Outside → review.
 *
 * Threshold is passed in from the caller (read once per request via
 * loadHoursApprovalVarianceThreshold) so the database isn't hit per-row.
 */
export function evaluateHoursApproval(args: {
  workflow: string;
  estimatedMinutes: number | null;
  startedAt: Date | null;
  completedAt: Date;
  totalPausedMs: number;
  workerCount: number;
  currentUserId: string;
  varianceThreshold: number;
}): { hoursApprovedAt: Date | null; hoursApprovedById: string | null } {
  const { workflow, estimatedMinutes, startedAt, completedAt, totalPausedMs, workerCount, currentUserId, varianceThreshold } = args;
  // Non-payroll workflows: stamp on completion so they never surface in the
  // unapproved-hours queue.
  if (workflow !== "STANDARD" && workflow !== "ONE_OFF") {
    return { hoursApprovedAt: completedAt, hoursApprovedById: currentUserId };
  }
  if (!estimatedMinutes || !startedAt) {
    return { hoursApprovedAt: null, hoursApprovedById: null };
  }
  const adjustedEstimate = workerCount > 1 ? estimatedMinutes / workerCount : estimatedMinutes;
  if (!adjustedEstimate) {
    return { hoursApprovedAt: null, hoursApprovedById: null };
  }
  const actualMinutes = Math.max(
    0,
    (completedAt.getTime() - new Date(startedAt).getTime() - (totalPausedMs ?? 0)) / 60000,
  );
  const variance = Math.abs(actualMinutes - adjustedEstimate) / adjustedEstimate;
  if (variance <= varianceThreshold) {
    return { hoursApprovedAt: completedAt, hoursApprovedById: currentUserId };
  }
  return { hoursApprovedAt: null, hoursApprovedById: null };
}

// Forward states that imply "someone is working on this occurrence." A
// transition into any of these must have a real worker (non-observer
// assignee) on the occurrence, otherwise downstream payment/payout logic
// has no claimer to split against. Reverts back to SCHEDULED/CANCELED/etc.
// are intentionally exempt — those are the cleanup paths admins use to
// undo a bad state.
const STATUSES_REQUIRING_WORKER: ReadonlySet<JobOccurrenceStatus> = new Set([
  JobOccurrenceStatus.IN_PROGRESS,
  JobOccurrenceStatus.PAUSED,
  JobOccurrenceStatus.PENDING_PAYMENT,
  JobOccurrenceStatus.CLOSED,
  JobOccurrenceStatus.PROPOSAL_SUBMITTED,
]);

/**
 * Refuse status transitions that would leave the occurrence in a "someone
 * is working on this" state when no actual worker is assigned. Prevents
 * the contradiction where an admin/super completes an unclaimed occurrence
 * (using the admin bypass in updateOccurrenceStatus) and lands it in
 * PENDING_PAYMENT with zero assignees — which breaks the payment flow
 * because split percentages need at least one worker to apply to.
 */
async function assertOccurrenceHasWorker(
  tx: Prisma.TransactionClient,
  occurrenceId: string,
  targetStatus: JobOccurrenceStatus,
): Promise<void> {
  if (!STATUSES_REQUIRING_WORKER.has(targetStatus)) return;
  // role is "observer" for observers and NULL for workers/claimers (see
  // schema.prisma:841). SQL three-valued logic excludes NULLs from a
  // `role <> 'observer'` comparison, so we explicitly OR in `role IS NULL`
  // to count workers + claimers correctly. Without this OR, the count is
  // always zero and the gate falsely fires even on properly assigned
  // occurrences.
  const workerCount = await tx.jobOccurrenceAssignee.count({
    where: {
      occurrenceId,
      OR: [
        { role: null },
        { role: { not: "observer" } },
      ],
    },
  });
  if (workerCount === 0) {
    throw new ServiceError(
      "NO_CLAIMER",
      `This occurrence has no assigned worker. Assign a worker (or claim it) before moving it to ${targetStatus}.`,
      409,
    );
  }
}

export const jobs: ServicesJobs = {
  async list(params) {
    const q = (params?.q ?? "").trim();
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);

    const where: Prisma.JobWhereInput = {};
    if (params?.propertyId) where.propertyId = params.propertyId;
    if (params?.status === "ALL") {
      // no status filter — return all including ARCHIVED
    } else if (params?.status) {
      where.status = params.status as JobStatus;
    } else {
      // default: exclude ARCHIVED
      where.status = { not: JobStatus.ARCHIVED };
    }
    if (params?.kind && params.kind !== "ALL") where.kind = params.kind;

    const andClauses: Prisma.JobWhereInput[] = [];

    if (params?.from || params?.to) {
      const dateRange: Prisma.DateTimeFilter = {};
      if (params.from) dateRange.gte = etMidnight(params.from);
      if (params.to) dateRange.lte = etEndOfDay(params.to);
      // Include jobs with an occurrence in range OR jobs with no occurrences yet
      andClauses.push({
        OR: [
          { occurrences: { some: { startAt: dateRange } } },
          { occurrences: { none: {} } },
        ],
      });
    }

    if (q) {
      andClauses.push({
        OR: [
          { property: { displayName: { contains: q, mode: "insensitive" } } },
          { property: { city: { contains: q, mode: "insensitive" } } },
        ],
      });
    }

    if (andClauses.length) where.AND = andClauses;

    const rows = await prisma.job.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        property: {
          select: {
            id: true,
            displayName: true,
            street1: true,
            city: true,
            state: true,
            status: true,
            client: { select: { id: true, displayName: true, isVip: true, vipReason: true, adminTags: true } },
          },
        },
        schedule: true,
        defaultAssignees: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
        occurrences: {
          select: {
            id: true,
            startAt: true,
            status: true,
            kind: true,
          },
          orderBy: [
            { startAt: "asc" },
            { createdAt: "asc" },
          ],
          take: 1, // “next”
          where: {
            status: {
              in: [
                JobOccurrenceStatus.SCHEDULED,
                JobOccurrenceStatus.IN_PROGRESS,
              ],
            },
          },
        },
        _count: {
          select: { defaultAssignees: true, occurrences: true },
        },
      },
    });

    return rows.map(({ _count, occurrences, ...j }) => ({
      ...j,
      notes: j.notes,
      defaultPrice: j.defaultPrice,
      nextOccurrence: occurrences[0] ?? null,
      assigneeCount: _count.defaultAssignees,
      occurrenceCount: _count.occurrences,
    }));
  },

  async get(id, cutoff: Date | null = null) {
    return prisma.job.findUniqueOrThrow({
      where: { id },
      include: {
        property: true,
        schedule: true,
        defaultAssignees: {
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
        defaultGroup: {
          select: {
            id: true,
            name: true,
            claimerUserId: true,
            archivedAt: true,
            claimer: { select: { id: true, displayName: true, email: true } },
            members: {
              include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } },
            },
          },
        },
        occurrences: {
          // Business Start Date filter — Pattern C on the occurrence work
          // date so pre-cutoff occurrences drop out of the Services job
          // detail view, matching JobsTab + Statistics + Operations. Pattern
          // B layered on payment / expenses below as defense-in-depth.
          // Super reveal resolves cutoff to null so this becomes a no-op.
          where: { ...occurrenceWorkDateCutoff(cutoff) },
          orderBy: [{ createdAt: "desc" }],
          take: 50,
          include: {
            assignees: {
              include: {
                user: { select: { id: true, displayName: true, email: true, workerType: true } },
              },
            },
            payment: paymentIncludeWithCutoff(cutoff, {
              include: {
                splits: { include: { user: { select: { id: true, displayName: true } } } },
                collectedBy: { select: { id: true, displayName: true } },
              },
            }),
            expenses: expensesIncludeWithCutoff(cutoff, {
              include: {
                createdBy: { select: { id: true, displayName: true } },
                businessExpense: { select: { category: true, vendor: true, date: true } },
                supplyHold: {
                  select: {
                    id: true,
                    quantity: true,
                    status: true,
                    supply: { select: { id: true, name: true, unit: true } },
                  },
                },
              },
              orderBy: { createdAt: "asc" as const },
            }),
            addons: {
              select: { id: true, tag: true, customLabel: true, price: true },
              orderBy: { createdAt: "asc" as const },
            },
            instructions: {
              select: { id: true, text: true, isPreset: true, repeats: true, sortOrder: true },
              orderBy: { sortOrder: "asc" as const },
            },
            propertyPhotos: {
              include: { propertyPhoto: { select: { id: true, r2Key: true, fileName: true, description: true, sortOrder: true } } },
            },
            _count: { select: { photos: true, comments: true } },
          },
        },
        clients: { include: { client: true } },
        contacts: { include: { clientContact: true } },
      },
    });
  },

  async create(currentUserId, payload) {
    return prisma.$transaction(async (tx) => {
      const record = await tx.job.create({
        data: {
          propertyId: payload.propertyId,
          kind: payload.kind,
          status: payload.status ?? JobStatus.PROPOSED,
          frequencyDays: (payload as any).frequencyDays ?? null,
          description: (payload as any).description ?? null,
          notes: payload.notes ?? null,
          guidanceNote: (payload as any).guidanceNote ?? null,
          defaultPrice: payload.defaultPrice ?? null,
          estimatedMinutes: (payload as any).estimatedMinutes ?? null,
        } as any,
      });

      await writeAudit(tx, AUDIT.JOB.CREATED, currentUserId, {
        id: record.id,
        record,
      });

      return record;
    });
  },

  async update(currentUserId, id, payload) {
    return prisma.$transaction(async (tx) => {
      // Capture prior status so we can detect the PAUSED → ACTIVE
      // transition and rebuild the recurring chain (see unpause block
      // below). The pause branch wipes future SCHEDULED occurrences;
      // without symmetric regeneration on resume the cycle stays
      // permanently broken and the operator has to manually click
      // Generate Next on a closed occurrence.
      const prior = await tx.job.findUnique({
        where: { id },
        select: { status: true },
      });

      const record = await tx.job.update({
        where: { id },
        data: {
          kind: payload.kind,
          status: payload.status,
          propertyId: payload.propertyId,
          frequencyDays: "frequencyDays" in (payload as any) ? ((payload as any).frequencyDays ?? null) : undefined,
          description: "description" in (payload as any) ? ((payload as any).description ?? null) : undefined,
          guidanceNote: "guidanceNote" in (payload as any) ? ((payload as any).guidanceNote ?? null) : undefined,
          notes: payload.notes ?? undefined,
          defaultPrice: payload.defaultPrice ?? undefined,
          estimatedMinutes: "estimatedMinutes" in (payload as any) ? ((payload as any).estimatedMinutes ?? null) : undefined,
          defaultJobType: "defaultJobType" in (payload as any) ? ((payload as any).defaultJobType ?? null) : undefined,
        } as any,
      });

      // When pausing, remove future scheduled repeating occurrences.
      // Shared with `applyJobPauseSideEffectsInTx` so the bulk-pause
      // client action produces identical side effects.
      if (payload.status === "PAUSED") {
        await applyJobPauseSideEffectsInTx(tx, currentUserId, id);
      }

      // When unpausing (PAUSED → ACCEPTED), rebuild the recurring chain
      // via the shared helper. See `applyJobResumeSideEffectsInTx` for
      // the algorithm; extracting it lets the bulk-resume client action
      // produce identical results.
      if (prior?.status === JobStatus.PAUSED && payload.status === JobStatus.ACCEPTED) {
        await applyJobResumeSideEffectsInTx(tx, currentUserId, id);
      }

      await writeAudit(tx, AUDIT.JOB.UPDATED, currentUserId, {
        id,
        record,
      });

      return record;
    });
  },

  async upsertSchedule(currentUserId, jobId, patch) {
    return prisma.$transaction(async (tx) => {
      const record = await tx.jobSchedule.upsert({
        where: { jobId },
        create: {
          jobId,
          autoRenew: !!patch.autoRenew,
          cadence: patch.cadence ?? null,
          interval: patch.interval ?? null,
          dayOfWeek: patch.dayOfWeek ?? null,
          dayOfMonth: patch.dayOfMonth ?? null,
          preferredStartHour: patch.preferredStartHour ?? null,
          preferredEndHour: patch.preferredEndHour ?? null,
          horizonDays: patch.horizonDays ?? 21,
          active: patch.active ?? true,
          nextGenerateAt: new Date(),
        },
        update: {
          autoRenew: patch.autoRenew ?? undefined,
          cadence: patch.cadence ?? undefined,
          interval: patch.interval ?? undefined,
          dayOfWeek: patch.dayOfWeek ?? undefined,
          dayOfMonth: patch.dayOfMonth ?? undefined,
          preferredStartHour: patch.preferredStartHour ?? undefined,
          preferredEndHour: patch.preferredEndHour ?? undefined,
          horizonDays: patch.horizonDays ?? undefined,
          active: patch.active ?? undefined,
          // bump generator so “turn it on” creates occurrences promptly
          nextGenerateAt: patch.autoRenew ? new Date() : undefined,
        },
      });

      await writeAudit(tx, AUDIT.JOB.SCHEDULE_UPDATED, currentUserId, {
        jobId,
        record,
      });

      return record;
    });
  },

  async createOccurrence(currentUserId, jobId, input) {
    return prisma.$transaction(async (tx) => {
      const job = await tx.job.findUniqueOrThrow({
        where: { id: jobId },
        include: {
          // Order by sortOrder so the chosen claimer (lowest sortOrder, set
          // via the make-claimer route) lands first and becomes the
          // occurrence's claimer.
          defaultAssignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      });

      const occ = await tx.jobOccurrence.create({
        data: {
          jobId,
          kind: input.kind ?? job.kind,
          startAt: toDate(input.startAt),
          endAt: toDate(input.endAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          jobType: input.jobType ?? null,
          jobTags: input.jobTags ?? null,
          pinnedNote: input.pinnedNote ?? null,
          pinnedNoteRepeats: input.pinnedNoteRepeats ?? true,
          notes: input.notes !== undefined ? input.notes : (job as any).notes ?? null,
          // Seeded from the job default unless the caller explicitly sets it
          // (the New Occurrence dialog passes null to opt this instance out).
          guidanceNote: (input as any).guidanceNote !== undefined
            ? (input as any).guidanceNote
            : ((job as any).guidanceNote ?? null),
          price: input.price !== undefined ? input.price : (job as any).defaultPrice ?? null,
          estimatedMinutes: input.estimatedMinutes !== undefined ? input.estimatedMinutes : (job as any).estimatedMinutes ?? null,
          workflow: input.workflow ?? OccurrenceWorkflow.STANDARD,
          isOneOff: input.workflow === "ONE_OFF" || input.isOneOff || false,
          isTentative: input.isTentative ?? false,
          isEstimate: input.workflow === "ESTIMATE" || input.isEstimate || false,
          isAdminOnly: input.isAdminOnly ?? (input.workflow === "ESTIMATE" || input.isEstimate ? true : false),
          frequencyDays: input.frequencyDays ?? null,
          title: input.title ?? null,
        } as any,
      });

      // Assignee resolution order:
      //   1. Caller-supplied list — explicit override, used as-is.
      //   2. Job.defaultGroupId (when set) — materialize the group's roster.
      //      Group must not be archived; if it is, fall back to unassigned.
      //   3. Job.defaultAssignees rows — the per-user "default team" mode.
      const useCallerIds = input.assigneeUserIds?.length;
      let assigneeSource: { userId: string; role: string | null }[] = [];
      let attachGroup: { id: string; claimerUserId: string; members: { userId: string; role: string }[] } | null = null;
      if (useCallerIds) {
        assigneeSource = input.assigneeUserIds!.map((uid) => ({ userId: uid, role: null as string | null }));
      } else if ((job as any).defaultGroupId) {
        const group = await tx.group.findUnique({
          where: { id: (job as any).defaultGroupId },
          include: { members: { select: { userId: true, role: true } } },
        });
        if (group && !group.archivedAt) {
          attachGroup = group;
          assigneeSource = [
            { userId: group.claimerUserId, role: null },
            ...group.members.map((m) => ({
              userId: m.userId,
              role: m.role === "observer" ? "observer" as const : null,
            })),
          ];
        }
      } else {
        assigneeSource = job.defaultAssignees.filter((d) => d.active).map((d) => ({ userId: d.userId, role: d.role ?? null }));
      }

      for (const a of assigneeSource) {
        await assertWorkerAssignable(tx, a.userId);
      }

      // Set assignedGroupId when materializing from a default group so the
      // card surfaces the group chip and group-only flows light up.
      if (attachGroup) {
        await tx.jobOccurrence.update({
          where: { id: occ.id },
          data: { assignedGroupId: attachGroup.id },
        });
      }

      if (assigneeSource.length) {
        const claimerId = assigneeSource[0].userId;
        await tx.jobOccurrenceAssignee.createMany({
          data: assigneeSource.map((a, i) => ({
            occurrenceId: occ.id,
            userId: a.userId,
            role: a.role,
            assignedById: i === 0 ? a.userId : claimerId,
          })),
          skipDuplicates: true,
        });
      }

      // Copy job's default property photo instructions to the new occurrence
      const jobPhotos = await tx.jobPropertyPhoto.findMany({ where: { jobId }, select: { propertyPhotoId: true } });
      if (jobPhotos.length > 0) {
        await tx.occurrencePropertyPhoto.createMany({
          data: jobPhotos.map((jp) => ({ occurrenceId: occ.id, propertyPhotoId: jp.propertyPhotoId })),
          skipDuplicates: true,
        });
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, currentUserId, {
        jobId,
        occurrenceId: occ.id,
        record: occ,
      });

      return occ;
    });
  },

  async createTask(currentUserId: string, input: { title: string; notes?: string; startAt: string; linkedOccurrenceId?: string }) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.create({
        data: {
          kind: null,
          title: input.title,
          notes: input.notes ?? null,
          startAt: toDate(input.startAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          workflow: OccurrenceWorkflow.TASK,
          linkedOccurrenceId: input.linkedOccurrenceId ?? null,
        } as any,
      });

      // Auto-assign creator
      await tx.jobOccurrenceAssignee.create({
        data: {
          occurrenceId: occ.id,
          userId: currentUserId,
          assignedById: currentUserId,
        },
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, currentUserId, {
        occurrenceId: occ.id,
        type: "TASK",
        title: input.title,
      });

      return occ;
    });
  },

  async createStandaloneReminder(currentUserId: string, input: { title: string; notes?: string; startAt: string; linkedOccurrenceId?: string; isHighPriority?: boolean }) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.create({
        data: {
          kind: null,
          title: input.title,
          notes: input.notes ?? null,
          startAt: toDate(input.startAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          workflow: OccurrenceWorkflow.REMINDER,
          linkedOccurrenceId: input.linkedOccurrenceId ?? null,
          isHighPriority: input.isHighPriority ?? false,
        } as any,
      });

      await tx.jobOccurrenceAssignee.create({
        data: {
          occurrenceId: occ.id,
          userId: currentUserId,
          assignedById: currentUserId,
        },
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, currentUserId, {
        occurrenceId: occ.id,
        type: "REMINDER",
        title: input.title,
      });

      return occ;
    });
  },

  async createEvent(adminUserId: string, input: { title: string; notes?: string; startAt: string; frequencyDays?: number | null }) {
    return prisma.$transaction(async (tx) => {
      const isRepeating = input.frequencyDays != null && input.frequencyDays > 0;
      const occ = await tx.jobOccurrence.create({
        data: {
          kind: null,
          title: input.title,
          notes: input.notes ?? null,
          startAt: toDate(input.startAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          workflow: "EVENT" as any,
          frequencyDays: isRepeating ? input.frequencyDays : null,
        } as any,
      });

      // Auto-assign the creator as claimer
      await tx.jobOccurrenceAssignee.create({
        data: {
          occurrenceId: occ.id,
          userId: adminUserId,
          assignedById: adminUserId,
        },
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, adminUserId, {
        occurrenceId: occ.id,
        type: "EVENT",
        title: input.title,
      });

      return occ;
    });
  },

  async completeEvent(adminUserId: string, occurrenceId: string) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({ where: { id: occurrenceId } });
      if (!occ) throw new Error("Event not found");
      if (occ.workflow !== "EVENT") throw new Error("Not an event");
      if (occ.status !== "SCHEDULED") throw new Error("Event is not in SCHEDULED status");

      const completedAt = new Date();
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED, completedAt },
      });
      // Sync any linked BusinessExpense.date to the completion timestamp —
      // matches the markComplete path so manual SQL inspection + future
      // reads stay accurate. See deriveJobExpenseDate.
      await tx.businessExpense.updateMany({
        where: { occurrenceId },
        data: { date: completedAt },
      });

      let nextOccurrence = null;
      const freq = (occ as any).frequencyDays;
      if (freq && freq > 0) {
        const baseDate = occ.startAt ? new Date(occ.startAt) : new Date();
        let nextStart: Date;
        if (freq === 30) {
          // Monthly: same day next month (clamp to last day if needed)
          const day = baseDate.getDate();
          const next = new Date(baseDate);
          next.setMonth(next.getMonth() + 1, 1); // go to 1st of next month
          const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(day, lastDay));
          nextStart = next;
        } else if (freq === 365) {
          // Yearly: same month+day next year (clamp for leap day)
          const month = baseDate.getMonth();
          const day = baseDate.getDate();
          const nextYear = baseDate.getFullYear() + 1;
          const lastDay = new Date(nextYear, month + 1, 0).getDate();
          nextStart = new Date(baseDate);
          nextStart.setFullYear(nextYear);
          nextStart.setMonth(month);
          nextStart.setDate(Math.min(day, lastDay));
        } else {
          nextStart = new Date(baseDate);
          nextStart.setDate(nextStart.getDate() + freq);
        }

        nextOccurrence = await tx.jobOccurrence.create({
          data: {
            kind: null,
            title: occ.title,
            notes: occ.notes,
            startAt: nextStart,
            status: JobOccurrenceStatus.SCHEDULED,
            source: "GENERATED" as any,
            workflow: "EVENT" as any,
            frequencyDays: freq,
          } as any,
        });
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, adminUserId, {
        occurrenceId,
        action: "COMPLETE_EVENT",
        nextOccurrenceId: nextOccurrence?.id ?? null,
      });

      return { completed: occ, next: nextOccurrence };
    });
  },

  async createFollowup(adminUserId: string, input: { title: string; notes?: string; startAt: string; frequencyDays?: number | null; clientIds?: string[]; jobIds?: string[] }) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.create({
        data: {
          kind: null,
          title: input.title,
          notes: input.notes ?? null,
          startAt: toDate(input.startAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          workflow: "FOLLOWUP" as any,
          frequencyDays: (input.frequencyDays != null && input.frequencyDays > 0) ? input.frequencyDays : null,
        } as any,
      });

      if (input.clientIds?.length) {
        await tx.followupClient.createMany({
          data: input.clientIds.map((clientId) => ({ occurrenceId: occ.id, clientId })),
        });
      }
      if (input.jobIds?.length) {
        await tx.followupJob.createMany({
          data: input.jobIds.map((jobId) => ({ occurrenceId: occ.id, jobId })),
        });
      }

      // Auto-assign the creator as claimer
      await tx.jobOccurrenceAssignee.create({
        data: {
          occurrenceId: occ.id,
          userId: adminUserId,
          assignedById: adminUserId,
        },
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, adminUserId, {
        occurrenceId: occ.id,
        type: "FOLLOWUP",
        title: input.title,
      });

      return occ;
    });
  },

  async completeFollowup(adminUserId: string, occurrenceId: string) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        include: { followupClients: true, followupJobs: true },
      });
      if (!occ) throw new Error("Followup not found");
      if (occ.workflow !== "FOLLOWUP") throw new Error("Not a followup");
      if (occ.status !== "SCHEDULED") throw new Error("Followup is not in SCHEDULED status");

      const completedAt = new Date();
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED, completedAt },
      });
      await tx.businessExpense.updateMany({
        where: { occurrenceId },
        data: { date: completedAt },
      });

      let nextOccurrence = null;
      const freq = (occ as any).frequencyDays;
      if (freq && freq > 0) {
        const baseDate = occ.startAt ? new Date(occ.startAt) : new Date();
        let nextStart: Date;
        if (freq === 30) {
          const day = baseDate.getDate();
          const next = new Date(baseDate);
          next.setMonth(next.getMonth() + 1, 1);
          const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(day, lastDay));
          nextStart = next;
        } else if (freq === 365) {
          const month = baseDate.getMonth();
          const day = baseDate.getDate();
          const nextYear = baseDate.getFullYear() + 1;
          const lastDay = new Date(nextYear, month + 1, 0).getDate();
          nextStart = new Date(baseDate);
          nextStart.setFullYear(nextYear);
          nextStart.setMonth(month);
          nextStart.setDate(Math.min(day, lastDay));
        } else {
          nextStart = new Date(baseDate);
          nextStart.setDate(nextStart.getDate() + freq);
        }

        nextOccurrence = await tx.jobOccurrence.create({
          data: {
            kind: null,
            title: occ.title,
            notes: occ.notes,
            startAt: nextStart,
            status: JobOccurrenceStatus.SCHEDULED,
            source: "GENERATED" as any,
            workflow: "FOLLOWUP" as any,
            frequencyDays: freq,
          } as any,
        });

        // Copy client and job attachments to the next occurrence
        if ((occ as any).followupClients?.length) {
          await tx.followupClient.createMany({
            data: (occ as any).followupClients.map((fc: any) => ({ occurrenceId: nextOccurrence!.id, clientId: fc.clientId })),
          });
        }
        if ((occ as any).followupJobs?.length) {
          await tx.followupJob.createMany({
            data: (occ as any).followupJobs.map((fj: any) => ({ occurrenceId: nextOccurrence!.id, jobId: fj.jobId })),
          });
        }
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, adminUserId, {
        occurrenceId,
        action: "COMPLETE_FOLLOWUP",
        nextOccurrenceId: nextOccurrence?.id ?? null,
      });

      return { completed: occ, next: nextOccurrence };
    });
  },

  async createAnnouncement(adminUserId: string, input: { title: string; notes?: string; startAt: string; frequencyDays?: number | null }) {
    return prisma.$transaction(async (tx) => {
      const isRepeating = input.frequencyDays != null && input.frequencyDays > 0;
      const occ = await tx.jobOccurrence.create({
        data: {
          kind: null,
          title: input.title,
          notes: input.notes ?? null,
          startAt: toDate(input.startAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          workflow: "ANNOUNCEMENT" as any,
          frequencyDays: isRepeating ? input.frequencyDays : null,
        } as any,
      });

      // Auto-assign the creator as claimer
      await tx.jobOccurrenceAssignee.create({
        data: {
          occurrenceId: occ.id,
          userId: adminUserId,
          assignedById: adminUserId,
        },
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, adminUserId, {
        occurrenceId: occ.id,
        type: "ANNOUNCEMENT",
        title: input.title,
      });

      return occ;
    });
  },

  async completeAnnouncement(adminUserId: string, occurrenceId: string) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({ where: { id: occurrenceId } });
      if (!occ) throw new Error("Announcement not found");
      if (occ.workflow !== "ANNOUNCEMENT") throw new Error("Not an announcement");
      if (occ.status !== "SCHEDULED") throw new Error("Announcement is not in SCHEDULED status");

      const completedAt = new Date();
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED, completedAt },
      });
      await tx.businessExpense.updateMany({
        where: { occurrenceId },
        data: { date: completedAt },
      });

      let nextOccurrence = null;
      const freq = (occ as any).frequencyDays;
      if (freq && freq > 0) {
        const baseDate = occ.startAt ? new Date(occ.startAt) : new Date();
        let nextStart: Date;
        if (freq === 30) {
          const day = baseDate.getDate();
          const next = new Date(baseDate);
          next.setMonth(next.getMonth() + 1, 1);
          const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
          next.setDate(Math.min(day, lastDay));
          nextStart = next;
        } else if (freq === 365) {
          const month = baseDate.getMonth();
          const day = baseDate.getDate();
          const nextYear = baseDate.getFullYear() + 1;
          const lastDay = new Date(nextYear, month + 1, 0).getDate();
          nextStart = new Date(baseDate);
          nextStart.setFullYear(nextYear);
          nextStart.setMonth(month);
          nextStart.setDate(Math.min(day, lastDay));
        } else {
          nextStart = new Date(baseDate);
          nextStart.setDate(nextStart.getDate() + freq);
        }

        nextOccurrence = await tx.jobOccurrence.create({
          data: {
            kind: null,
            title: occ.title,
            notes: occ.notes,
            startAt: nextStart,
            status: JobOccurrenceStatus.SCHEDULED,
            source: "GENERATED" as any,
            workflow: "ANNOUNCEMENT" as any,
            frequencyDays: freq,
          } as any,
        });
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, adminUserId, {
        occurrenceId,
        action: "COMPLETE_ANNOUNCEMENT",
        nextOccurrenceId: nextOccurrence?.id ?? null,
      });

      return { completed: occ, next: nextOccurrence };
    });
  },

  async createLightEstimate(adminUserId: string, input: {
    title: string;
    notes?: string;
    startAt: string;
    contactName?: string;
    contactPhone?: string;
    contactEmail?: string;
    estimateAddress?: string;
    proposalAmount?: number;
    proposalNotes?: string;
    jobTags?: string;
    jobType?: string;
    assigneeUserIds?: string[];
    jobId?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.create({
        data: {
          jobId: input.jobId ?? null,
          kind: null,
          title: input.title,
          notes: input.notes ?? null,
          startAt: toDate(input.startAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          workflow: OccurrenceWorkflow.ESTIMATE,
          isEstimate: true,
          isAdminOnly: true,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          contactEmail: input.contactEmail ?? null,
          estimateAddress: input.estimateAddress ?? null,
          proposalAmount: input.proposalAmount ?? null,
          jobTags: input.jobTags ?? null,
          jobType: input.jobType ?? null,
          proposalNotes: input.proposalNotes ?? null,
        } as any,
      });

      // Assign team if provided
      const assigneeIds = input.assigneeUserIds ?? [];
      if (assigneeIds.length > 0) {
        const claimerId = assigneeIds[0];
        await tx.jobOccurrenceAssignee.createMany({
          data: assigneeIds.map((uid, i) => ({
            occurrenceId: occ.id,
            userId: uid,
            assignedById: i === 0 ? uid : claimerId,
          })),
        });
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_CREATED, adminUserId, {
        occurrenceId: occ.id,
        type: "LIGHT_ESTIMATE",
        title: input.title,
      });

      return occ;
    });
  },

  async updateOccurrence(
    currentUserId: string,
    occurrenceId: string,
    patch: any,
    options?: { isAdmin?: boolean }
  ) {
    return prisma.$transaction(async (tx) => {
      // Fetch original before update (for link cascade delta + status validation)
      const original = await tx.jobOccurrence.findUnique({ where: { id: occurrenceId } });
      if (!original) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

      const data: any = {};

      if ("jobId" in patch) data.jobId = patch.jobId ?? null;
      if (patch.kind != null) data.kind = patch.kind;
      if (patch.status != null) {
        // Enforce valid status transitions — admins get expanded transitions (can revert)
        if (patch.status !== original.status) {
          const workflow = (original as any).workflow ?? "STANDARD";
          const validate = options?.isAdmin ? isValidAdminTransition : isValidTransition;
          if (!validate(workflow, original.status, patch.status)) {
            throw new ServiceError(
              "INVALID_TRANSITION",
              `Cannot transition from ${original.status} to ${patch.status} in ${workflow} workflow.`,
              409
            );
          }
        }
        // Block starting unconfirmed job occurrences
        if (patch.status === "IN_PROGRESS" && original.status === "SCHEDULED") {
          const needsConfirmation = !(original as any).isClientConfirmed && original.jobId &&
            ((original as any).workflow === "STANDARD" || (original as any).workflow === "ONE_OFF" || (original as any).workflow === "ESTIMATE" || !(original as any).workflow);
          if (needsConfirmation) {
            throw new ServiceError("NOT_CONFIRMED", "Client confirmation required before starting this job.", 409);
          }
        }
        // Same claimer-required gate as updateOccurrenceStatus — applied
        // here too because admins can flip status through this path.
        await assertOccurrenceHasWorker(tx, occurrenceId, patch.status as JobOccurrenceStatus);
        data.status = patch.status;
      }

      if ("startAt" in patch)
        data.startAt = patch.startAt ? new Date(patch.startAt) : null;
      if ("endAt" in patch)
        data.endAt = patch.endAt ? new Date(patch.endAt) : null;
      if ("notes" in patch) data.notes = patch.notes ?? null;
      if ("price" in patch) data.price = patch.price ?? null;
      if ("estimatedMinutes" in patch) data.estimatedMinutes = patch.estimatedMinutes ?? null;
      if ("isTentative" in patch) data.isTentative = !!patch.isTentative;
      if ("isEstimate" in patch) data.isEstimate = !!patch.isEstimate;
      if ("isAdminOnly" in patch) data.isAdminOnly = !!patch.isAdminOnly;
      if ("isClientConfirmed" in patch) data.isClientConfirmed = !!patch.isClientConfirmed;
      if ("pinnedNote" in patch) data.pinnedNote = patch.pinnedNote ?? null;
      if ("pinnedNoteRepeats" in patch) data.pinnedNoteRepeats = !!patch.pinnedNoteRepeats;
      if ("jobType" in patch) data.jobType = patch.jobType ?? null;
      if ("jobTags" in patch) data.jobTags = patch.jobTags ?? null;
      if ("startedAt" in patch) data.startedAt = patch.startedAt ? new Date(patch.startedAt) : null;
      if ("completedAt" in patch) data.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;
      if ("totalPausedMs" in patch) data.totalPausedMs = patch.totalPausedMs != null ? Math.max(0, Math.round(Number(patch.totalPausedMs))) : 0;

      // Auto-revert status when admin clears a timestamp that
      // semantically defines a status. Without this, an admin clearing
      // startedAt on an IN_PROGRESS occurrence leaves status=IN_PROGRESS
      // with startedAt=null — internally inconsistent, and the JobsTab
      // "Complete Job" button (which gates on status, not startedAt)
      // still shows. Same for completedAt on PENDING_PAYMENT / CLOSED.
      //
      // Only fires when the patch explicitly sets the field to null AND
      // the caller didn't already pass an explicit status. Editing the
      // timestamp to a different value (not null) is a normal correction
      // and doesn't change status. Note: the existing "reverting status
      // to non-CLOSED" branch below will then clean up the Payment row
      // for us, no extra work needed.
      const startedCleared = "startedAt" in patch && patch.startedAt == null;
      const completedCleared = "completedAt" in patch && patch.completedAt == null;
      const callerSetStatus = patch.status != null;
      if (!callerSetStatus && startedCleared) {
        const downstream = new Set<string>([
          JobOccurrenceStatus.IN_PROGRESS,
          JobOccurrenceStatus.PAUSED,
          JobOccurrenceStatus.PENDING_PAYMENT,
          JobOccurrenceStatus.CLOSED,
          JobOccurrenceStatus.PROPOSAL_SUBMITTED,
        ]);
        // Also treat SCHEDULED-with-stale-time as "needs cleanup": some
        // historical rows have status=SCHEDULED but lingering startedAt/
        // completedAt because the admin reset via a status-only flip
        // before the symmetric auto-clear branch existed. Clicking Reset
        // Job on such a row should null out the whole run-time block.
        const staleScheduled =
          original.status === JobOccurrenceStatus.SCHEDULED &&
          (original.startedAt != null || original.completedAt != null);
        if (downstream.has(original.status) || staleScheduled) {
          data.status = JobOccurrenceStatus.SCHEDULED;
          // A job that "was never started" can't have any of these.
          data.completedAt = null;
          data.pausedAt = null;
          data.totalPausedMs = 0;
          data.startLat = null;
          data.startLng = null;
          data.completeLat = null;
          data.completeLng = null;
          data.hoursApprovedAt = null;
          data.hoursApprovedById = null;
          data.lastPaymentRejectionReason = null;
          data.lastPaymentRejectedAt = null;
          data.lastPaymentRevertReason = null;
          data.lastPaymentRevertedAt = null;
        }
      } else if (!callerSetStatus && completedCleared) {
        const completedStatuses = new Set<string>([
          JobOccurrenceStatus.PENDING_PAYMENT,
          JobOccurrenceStatus.CLOSED,
        ]);
        if (completedStatuses.has(original.status)) {
          // Revert to IN_PROGRESS — completedAt was the marker that took
          // us out of IN_PROGRESS in the first place. The Payment row
          // (if any) will be cleaned up by the existing branch below
          // because the new status isn't CLOSED.
          data.status = JobOccurrenceStatus.IN_PROGRESS;
          data.completeLat = null;
          data.completeLng = null;
          data.lastPaymentRejectionReason = null;
          data.lastPaymentRejectedAt = null;
          data.lastPaymentRevertReason = null;
          data.lastPaymentRevertedAt = null;
        }
      }

      // Symmetric to the auto-clear above: if the caller explicitly sets
      // status back to SCHEDULED from any "started"/"completed" state, the
      // occurrence semantically "never happened" — so clear all run-time
      // artifacts (timestamps, GPS, hours-approval, payment rejection
      // metadata). Without this, admins who reset via a status edit are
      // left with an internally inconsistent row (SCHEDULED + startedAt
      // populated). Patch wins over auto-clear: any explicit values the
      // caller sent in `data` for the same fields stay as-is.
      if (callerSetStatus && patch.status === JobOccurrenceStatus.SCHEDULED) {
        const startedStatuses = new Set<string>([
          JobOccurrenceStatus.IN_PROGRESS,
          JobOccurrenceStatus.PAUSED,
          JobOccurrenceStatus.PENDING_PAYMENT,
          JobOccurrenceStatus.CLOSED,
          JobOccurrenceStatus.PROPOSAL_SUBMITTED,
        ]);
        if (startedStatuses.has(original.status)) {
          if (!("startedAt" in patch)) data.startedAt = null;
          if (!("completedAt" in patch)) data.completedAt = null;
          if (!("totalPausedMs" in patch)) data.totalPausedMs = 0;
          data.pausedAt = null;
          data.startLat = null;
          data.startLng = null;
          data.completeLat = null;
          data.completeLng = null;
          data.hoursApprovedAt = null;
          data.hoursApprovedById = null;
          data.lastPaymentRejectionReason = null;
          data.lastPaymentRejectedAt = null;
          data.lastPaymentRevertReason = null;
          data.lastPaymentRevertedAt = null;
        }
      }

      if ("title" in patch) data.title = patch.title ?? null;
      if ("contactName" in patch) data.contactName = patch.contactName ?? null;
      if ("contactPhone" in patch) data.contactPhone = patch.contactPhone ?? null;
      if ("contactEmail" in patch) data.contactEmail = patch.contactEmail ?? null;
      if ("estimateAddress" in patch) data.estimateAddress = patch.estimateAddress ?? null;
      if ("proposalAmount" in patch) data.proposalAmount = patch.proposalAmount != null ? Number(patch.proposalAmount) : null;
      if ("frequencyDays" in patch) data.frequencyDays = patch.frequencyDays != null ? Math.round(Number(patch.frequencyDays)) : null;

      const updated = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data,
      });

      // Sync linked BusinessExpense.date whenever the occurrence's
      // anchor date moved — completedAt change in either direction OR a
      // startAt reschedule on a not-yet-completed occurrence. See the
      // longer comment in the markComplete path for the design rationale.
      const completedAtBefore = original.completedAt ?? null;
      const completedAtAfter = updated.completedAt ?? null;
      const startAtBefore = original.startAt ?? null;
      const startAtAfter = updated.startAt ?? null;
      const completedAtChanged =
        (completedAtBefore?.getTime() ?? null) !== (completedAtAfter?.getTime() ?? null);
      const startAtChanged =
        (startAtBefore?.getTime() ?? null) !== (startAtAfter?.getTime() ?? null);
      if (completedAtChanged || (startAtChanged && !completedAtAfter)) {
        const targetDate = completedAtAfter ?? updated.startAt;
        if (targetDate) {
          await tx.businessExpense.updateMany({
            where: { occurrenceId },
            data: { date: targetDate },
          });
        }
      }

      if (data.status === JobOccurrenceStatus.CANCELED) {
        await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
      }

      // Re-evaluate payroll hours approval if a payroll-input field changed
      // on a completed occurrence with unapproved hours. Without this, an
      // admin or worker editing estimate/start/end/pause time AFTER the
      // initial completion leaves hoursApprovedAt = null forever even when
      // the new variance is well within threshold — exactly the scenario
      // the Review-hours dialog promises ("the row auto-approves when the
      // corrected time falls within the variance threshold"). Only fires
      // when the row is currently in a completed payroll state and the
      // change actually involved one of the variance inputs.
      const isCompletedState =
        updated.status === JobOccurrenceStatus.PENDING_PAYMENT ||
        updated.status === JobOccurrenceStatus.CLOSED;
      const touchedPayrollInput =
        "estimatedMinutes" in patch ||
        "startedAt" in patch ||
        "completedAt" in patch ||
        "totalPausedMs" in patch;
      if (
        isCompletedState &&
        !updated.hoursApprovedAt &&
        touchedPayrollInput &&
        updated.completedAt
      ) {
        const workflow = (updated as any).workflow ?? "STANDARD";
        const activeAssignees = await tx.jobOccurrenceAssignee.count({
          // SQL NULL-safety on role (see services/equipment.ts comment).
          where: { occurrenceId, OR: [{ role: null }, { role: { not: "observer" } }] },
        });
        const varianceThreshold = await loadHoursApprovalVarianceThreshold();
        const approval = evaluateHoursApproval({
          workflow,
          estimatedMinutes: updated.estimatedMinutes,
          startedAt: updated.startedAt,
          completedAt: updated.completedAt,
          totalPausedMs: updated.totalPausedMs ?? 0,
          workerCount: Math.max(1, activeAssignees),
          currentUserId,
          varianceThreshold,
        });
        if (approval.hoursApprovedAt) {
          await tx.jobOccurrence.update({
            where: { id: occurrenceId },
            data: {
              hoursApprovedAt: approval.hoursApprovedAt,
              hoursApprovedById: approval.hoursApprovedById,
            },
          });
          updated.hoursApprovedAt = approval.hoursApprovedAt;
          updated.hoursApprovedById = approval.hoursApprovedById;
        }
      }

      // Inventory hooks: hold lifecycle follows the occurrence's status.
      if (data.status) {
        if (data.status === JobOccurrenceStatus.CANCELED) {
          await releaseHoldsForOccurrence(occurrenceId, tx);
        } else if (
          data.status === JobOccurrenceStatus.CLOSED ||
          data.status === JobOccurrenceStatus.PENDING_PAYMENT ||
          data.status === JobOccurrenceStatus.PROPOSAL_SUBMITTED
        ) {
          await consumeHoldsForOccurrence(occurrenceId, tx);
        } else if (
          (original?.status === JobOccurrenceStatus.CLOSED ||
            original?.status === JobOccurrenceStatus.PENDING_PAYMENT ||
            original?.status === JobOccurrenceStatus.PROPOSAL_SUBMITTED) &&
          (data.status === JobOccurrenceStatus.SCHEDULED ||
            data.status === JobOccurrenceStatus.IN_PROGRESS)
        ) {
          await reactivateHoldsForOccurrence(occurrenceId, tx);
        }
      }

      // If reverting from CLOSED to a pre-payment state, clean up the payment
      // AND the auto-created next occurrence (if still untouched). This used
      // to be split across the deletePayment service and updateOccurrence —
      // unified here so Revert Payment is the single canonical undo path.
      //
      // CRITICAL — must check BOTH original AND new status. Earlier versions
      // checked only `data.status !== CLOSED/ARCHIVED`, which silently nuked
      // payments any time an admin saved a non-CLOSED occurrence that
      // happened to have a payment row (e.g. an OccurrenceDialog save on a
      // PENDING_PAYMENT occurrence with a pending-approval payment, or any
      // PATCH that re-sent `status: "PENDING_PAYMENT"` for an already-paid
      // job whose dialog state was stale). That caused paid jobs to reappear
      // in the "Awaiting payment" list with the old `paymentRequestSentAt`
      // marked as "pay link expired." The revert path is the ONLY caller
      // that legitimately wants this cleanup, and it always sends
      // `status: PENDING_PAYMENT` against an `original.status === CLOSED`.
      const isExplicitRevertFromClosed =
        original.status === JobOccurrenceStatus.CLOSED &&
        data.status &&
        data.status !== JobOccurrenceStatus.CLOSED &&
        data.status !== JobOccurrenceStatus.ARCHIVED;
      if (isExplicitRevertFromClosed) {
        const existingPayment = await tx.payment.findUnique({ where: { occurrenceId } });
        if (existingPayment) {
          // Find the auto-created next occurrence (if any). The cron-driven
          // generator + the in-line createPayment auto-create both emit a
          // GENERATED + SCHEDULED occurrence dated after this one's startAt
          // and created at or after the payment's own createdAt.
          if (original?.jobId) {
            const nextOcc = await tx.jobOccurrence.findFirst({
              where: {
                jobId: original.jobId,
                source: "GENERATED",
                status: "SCHEDULED",
                startAt: { gt: original.startAt ?? new Date() },
                createdAt: { gte: existingPayment.createdAt },
              },
              orderBy: { createdAt: "asc" },
            });
            // Only delete the ghost if no one has touched it (still
            // SCHEDULED, never started). If a worker already claimed or
            // started it, we leave it alone so their work isn't blown away.
            if (nextOcc && !nextOcc.startedAt) {
              await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId: nextOcc.id } });
              await tx.pinnedOccurrence.deleteMany({ where: { occurrenceId: nextOcc.id } });
              await tx.likedOccurrence.deleteMany({ where: { occurrenceId: nextOcc.id } });
              await tx.occurrenceComment.deleteMany({ where: { occurrenceId: nextOcc.id } });
              await tx.jobOccurrence.delete({ where: { id: nextOcc.id } });
            }
          }
          await tx.paymentSplit.deleteMany({ where: { paymentId: existingPayment.id } });
          await tx.payment.delete({ where: { id: existingPayment.id } });
          // DESIGN NOTE — we intentionally DO NOT delete any
          // GuaranteedPayoutAdvance rows tied to this occurrence here,
          // even though they reference a payment we just deleted. The
          // advance was created at a prior export run; in the normal
          // flow the operator has already uploaded that export to Gusto
          // and the contractor has been actually paid the advanced
          // amount. Keeping the advance row preserves that paid-state:
          // when the operator re-records the payment after revert and
          // the new splits are created, fetchAdvanceFlagsByUser stamps
          // `guaranteedPayoutPaidAt` on the matching split — preventing
          // a double-pay on the next payroll cycle.
          //
          // EDGE CASE — if the operator reverted before uploading the
          // earlier export's CSV to Gusto, the contractor was never
          // actually paid the advance amount. In that case the orphan
          // advance silently suppresses the new split from the next
          // payroll, under-paying the contractor.
          //
          // Recovery (rare): manually DELETE the GuaranteedPayoutAdvance
          // row for (occurrenceId, userId) before approving the new
          // payment, so the new split lands unflagged in the next
          // Gusto Contractors CSV.
          //
          // Auto-deleting here was considered and rejected because the
          // common case (operator already paid Gusto) would cause a
          // double-pay that's worse than the rare under-pay above.
        }
      }

      // Stamp the latest-revert metadata onto the occurrence when admin
      // reverts an already-approved payment (CLOSED → PENDING_PAYMENT).
      // Same semantics as lastPaymentRejection*: the job card surfaces a
      // banner with the reason; cleared on the next approval.
      const isRevertingPayment =
        original.status === JobOccurrenceStatus.CLOSED &&
        data.status === JobOccurrenceStatus.PENDING_PAYMENT;
      if (isRevertingPayment) {
        const rawReason = typeof patch.paymentRevertReason === "string" ? patch.paymentRevertReason.trim() : "";
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: {
            lastPaymentRevertReason: rawReason || "Reverted",
            lastPaymentRevertedAt: new Date(),
          },
        });
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
        occurrenceId,
        record: updated,
      });

      // Cascade startAt change to linked occurrences — sync to same date
      let linkedUpdated: string[] = [];
      if (data.startAt && original?.linkGroupId) {
        const newStart = data.startAt as Date;
        const linked = await tx.jobOccurrence.findMany({
          where: { linkGroupId: original.linkGroupId, id: { not: occurrenceId } },
        });
        for (const l of linked) {
          if (l.startAt && l.startAt.getTime() === newStart.getTime()) continue; // already synced
          const updates: any = { startAt: newStart };
          // Preserve each occurrence's duration
          if (l.startAt && l.endAt) {
            const duration = l.endAt.getTime() - l.startAt.getTime();
            updates.endAt = new Date(newStart.getTime() + duration);
          }
          await tx.jobOccurrence.update({ where: { id: l.id }, data: updates });
          linkedUpdated.push(l.id);
        }
      }

      return { ...updated, _linkedUpdated: linkedUpdated };
    });
  },

  async setOccurrenceAssignees(currentUserId, occurrenceId, input) {
    return prisma.$transaction(async (tx) => {
      // Load the occurrence with its Payment row so we can guard the
      // PENDING_PAYMENT case before mutating anything. Status + payment
      // existence drive the policy below.
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { status: true, payment: { select: { id: true, confirmed: true } } },
      });
      if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

      // PENDING_PAYMENT policy: team changes are allowed by admins (the
      // common case is correcting an as-built team after work is done —
      // e.g. a worker was sick and didn't actually show up). But if a
      // Payment row already exists, blocking is the safer move:
      //
      //   • Splits + promised-payout snapshot were computed against the
      //     OLD team. Silently rewriting them would surprise the operator.
      //   • The existing Reject / Revert flows already do exactly the
      //     right cleanup (delete Payment + PaymentSplit), and surface
      //     in the audit log as their own distinct event.
      //
      // We block on ANY Payment row (confirmed or not) for the same
      // reason — there's no path where rewriting splits in place is
      // less surprising than asking the operator to reject + re-record.
      // Edge case: revert from CLOSED → PENDING_PAYMENT already deletes
      // the Payment row, so this guard never fires on a freshly-reverted
      // occurrence.
      if (occ.status === JobOccurrenceStatus.PENDING_PAYMENT && occ.payment) {
        const action = occ.payment.confirmed ? "revert" : "reject";
        throw new ServiceError(
          "PAYMENT_EXISTS",
          `Cannot change the team while a payment record exists for this occurrence. Please ${action} the payment first, then change the team.`,
          409,
        );
      }

      // validate role constraint
      for (const uid of input.assigneeUserIds) {
        await assertWorkerAssignable(tx, uid);
      }

      // replace semantics: delete any not in desired set; add missing
      await tx.jobOccurrenceAssignee.deleteMany({
        where: {
          occurrenceId,
          userId: { notIn: input.assigneeUserIds },
        },
      });

      // Preserve existing claimer if possible, otherwise first person is claimer
      const existing = await tx.jobOccurrenceAssignee.findMany({
        where: { occurrenceId },
        orderBy: { assignedAt: "asc" },
      });
      const existingClaimer = existing.find((a) => a.assignedById === a.userId);
      const claimerId = existingClaimer && input.assigneeUserIds.includes(existingClaimer.userId)
        ? existingClaimer.userId
        : input.assigneeUserIds[0];

      await tx.jobOccurrenceAssignee.createMany({
        data: input.assigneeUserIds.map((uid) => ({
          occurrenceId,
          userId: uid,
          assignedById: uid === claimerId ? uid : claimerId,
        })),
        skipDuplicates: true,
      });

      // PENDING_PAYMENT snapshot reset. completionSplits + promisedPayouts
      // are written when the operator hits "Initiate Payment" OR when a
      // payment request is sent (paymentRequests.recordClaimerHandoff /
      // sendForOccurrence). In either case the snapshot is tied to the
      // OLD team's userIds / workerTypes / shares. Clearing both makes
      // the next "Initiate Payment" run regenerate them from the new
      // team, and makes the W-2 export fall through to its even-split
      // fallback (live assignees) instead of a stale snapshot. Hours
      // and hoursApprovedAt are intentionally left untouched — hours
      // are duration-based, not headcount-based.
      //
      // The pay-link token (paymentRequestToken) is also left intact:
      // it just collects a dollar amount from the client; the team-
      // dependent math runs on submit, against whatever team the
      // occurrence has at that moment.
      if (occ.status === JobOccurrenceStatus.PENDING_PAYMENT) {
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: { completionSplits: Prisma.JsonNull, promisedPayouts: Prisma.JsonNull },
        });
      }

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        assignees: input.assigneeUserIds,
      });

      return { updated: true as const };
    });
  },

  async archiveOccurrence(currentUserId: string, occurrenceId: string) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({ where: { id: occurrenceId } });
      if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
      if (occ.status !== JobOccurrenceStatus.CLOSED) {
        throw new ServiceError("INVALID_STATUS", "Only closed occurrences can be archived.", 409);
      }

      const updated = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.ARCHIVED },
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_ARCHIVED, currentUserId, {
        occurrenceId,
        record: updated,
      });

      return updated;
    });
  },

  async listAllOccurrences(params) {
    const dateRange: Prisma.DateTimeFilter = {};
    if (params?.from) dateRange.gte = etMidnight(params.from);
    if (params?.to) dateRange.lte = etEndOfDay(params.to);
    const hasDates = params?.from || params?.to;

    const occs = await prisma.jobOccurrence.findMany({
      where: {
        status: { not: JobOccurrenceStatus.ARCHIVED },
        ...(hasDates ? { startAt: dateRange } : {}),
        // Business Start Date filter — pre-cutoff occurrences (anchored on
        // work date: completedAt > startedAt > startAt) hidden entirely from
        // the operator JobsTab. When cutoff is null this is a no-op so the
        // off-state matches pre-feature behavior exactly. Client-facing
        // routes deliberately do NOT pass a cutoff — see routes/client.ts.
        ...occurrenceWorkDateCutoff(params?.cutoff ?? null),
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: {
                  select: {
                    id: true, displayName: true, isVip: true, vipReason: true, adminTags: true,
                    // Active client contacts as a fallback target for the
                    // "Request Confirmation" message when the property has
                    // no pointOfContactId set. Primary first so the worker
                    // always reaches out to the right person.
                    contacts: {
                      where: { status: "ACTIVE" },
                      select: { firstName: true, lastName: true, nickname: true, phone: true, email: true, isPrimary: true },
                      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                    },
                  },
                },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
            },
            recommendedCollections: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: { collectionId: true },
            },
          },
        },
        assignees: {
          include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } },
        },
        payment: {
          include: {
            splits: { include: { user: { select: { id: true, displayName: true, email: true } } } },
            collectedBy: { select: { id: true, displayName: true, email: true } },
          },
        },
        expenses: {
          include: {
            createdBy: { select: { id: true, displayName: true } },
            businessExpense: { select: { category: true, vendor: true, date: true } },
            supplyHold: {
              select: {
                id: true,
                quantity: true,
                status: true,
                supply: { select: { id: true, name: true, unit: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" as const },
        },
        propertyPhotos: {
          include: { propertyPhoto: { select: { id: true, r2Key: true, fileName: true, description: true, sortOrder: true } } },
        },
        addons: {
          select: { id: true, tag: true, customLabel: true, price: true },
          orderBy: { createdAt: "asc" as const },
        },
        instructions: {
          select: { id: true, text: true, isPreset: true, repeats: true, sortOrder: true },
          orderBy: { sortOrder: "asc" as const },
        },
        linkedOccurrence: {
          select: {
            id: true, startAt: true, status: true, workflow: true, jobType: true, price: true,
            job: { include: { property: { select: { id: true, displayName: true, client: { select: { displayName: true } }, pointOfContact: { select: { firstName: true, lastName: true, phone: true, email: true } } } } } },
          },
        },
        _count: { select: { photos: true, comments: true } },
        assignedGroup: {
          select: {
            id: true,
            name: true,
            claimerUserId: true,
            preferredEquipment: {
              orderBy: { sortOrder: "asc" as const },
              select: {
                id: true,
                equipmentId: true,
                equipmentCollectionId: true,
                equipment: { select: { id: true, shortDesc: true, brand: true, model: true, type: true, status: true, retiredAt: true } },
                equipmentCollection: { select: { id: true, name: true } },
              },
            },
          },
        },
        photos: {
          select: { id: true, r2Key: true, contentType: true, createdAt: true },
          orderBy: { createdAt: "desc" as const },
          take: 3,
        },
        followupClients: {
          include: { client: { select: { id: true, displayName: true } } },
        },
        followupJobs: {
          include: { job: { include: { property: { select: { id: true, displayName: true, client: { select: { id: true, displayName: true } } } } } } },
        },
        // Most-recent change request that resolved with a note. Used to
        // surface the admin's dismiss/approve note on the job card on
        // both the worker/admin JobsTab and the client's My Properties.
        // Filtered down to resolutionNote != null so we never grab a
        // resolved-without-note row that has nothing to display.
        // Naturally disappears for the next recurring occurrence: that
        // occurrence is a new row with no requests on it.
        changeRequests: {
          where: {
            status: { in: ["DENIED", "APPROVED"] },
            resolutionNote: { not: null },
          },
          orderBy: { resolvedAt: "desc" },
          take: 1,
          select: {
            id: true,
            kind: true,
            status: true,
            resolutionNote: true,
            resolvedAt: true,
          },
        },
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    });

    // Compute historical median duration per job (last 10 completed occurrences)
    const jobIds = [...new Set(occs.map((o: any) => o.jobId).filter(Boolean))] as string[];
    const medianMap: Record<string, number> = {};
    if (jobIds.length > 0) {
      const completedOccs = await prisma.jobOccurrence.findMany({
        where: {
          jobId: { in: jobIds },
          status: { in: ["CLOSED", "COMPLETED", "PENDING_PAYMENT"] },
          startedAt: { not: null },
          completedAt: { not: null },
        },
        select: {
          jobId: true,
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          assignees: { select: { role: true } },
        },
        orderBy: { completedAt: "desc" },
      });
      // Group by jobId, take last 8 per job. Median is in person-minutes
      // (wall-clock × team size at completion) so it's comparable across runs
      // with different team sizes; consumers divide by current team size for display.
      const byJob: Record<string, number[]> = {};
      for (const o of completedOccs) {
        const jobId = o.jobId;
        if (!jobId) continue;
        if (!o.startedAt || !o.completedAt) continue;
        if (!byJob[jobId]) byJob[jobId] = [];
        if (byJob[jobId].length >= 8) continue;
        const wallclockMin = (new Date(o.completedAt).getTime() - new Date(o.startedAt).getTime() - (o.totalPausedMs ?? 0)) / 60000;
        if (wallclockMin <= 0) continue;
        const teamSize = Math.max(1, ((o as any).assignees ?? []).filter((a: any) => a.role !== "observer").length);
        byJob[jobId].push(wallclockMin * teamSize);
      }
      for (const [jobId, durations] of Object.entries(byJob)) {
        if (durations.length < 3) continue; // need at least 3 samples for a meaningful average
        const sorted = durations.sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        medianMap[jobId] = sorted.length % 2 === 0
          ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
          : Math.round(sorted[mid]);
      }
    }
    // Attach median to each occurrence (spread to plain objects since Prisma results may be sealed)
    return occs.map((occ: any) => ({
      ...occ,
      ...(occ.jobId && medianMap[occ.jobId] != null ? { medianDurationMinutes: medianMap[occ.jobId] } : {}),
    }));
  },

  async getOccurrencesByIds(ids: string[], cutoff?: Date | null) {
    if (ids.length === 0) return [];
    return prisma.jobOccurrence.findMany({
      where: {
        id: { in: ids },
        // Pre-cutoff occurrences filtered out even on explicit-ID fetches
        // (pins, likes, deep-link includes, ghost reminders). Keeps the
        // JobsTab consistent with the bulk-list path — without this, a
        // pinned pre-cutoff occurrence would silently reappear with its
        // money fields populated, undoing the cutoff. No-op when null.
        ...occurrenceWorkDateCutoff(cutoff ?? null),
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: {
                  select: {
                    id: true, displayName: true, isVip: true, vipReason: true, adminTags: true,
                    // Active client contacts as a fallback target for the
                    // "Request Confirmation" message when the property has
                    // no pointOfContactId set. Primary first so the worker
                    // always reaches out to the right person.
                    contacts: {
                      where: { status: "ACTIVE" },
                      select: { firstName: true, lastName: true, nickname: true, phone: true, email: true, isPrimary: true },
                      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                    },
                  },
                },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
            },
            recommendedCollections: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: { collectionId: true },
            },
          },
        },
        assignees: {
          include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } },
        },
        payment: {
          include: {
            splits: { include: { user: { select: { id: true, displayName: true, email: true } } } },
            collectedBy: { select: { id: true, displayName: true, email: true } },
          },
        },
        expenses: {
          include: {
            createdBy: { select: { id: true, displayName: true } },
            businessExpense: { select: { category: true, vendor: true, date: true } },
            supplyHold: {
              select: {
                id: true,
                quantity: true,
                status: true,
                supply: { select: { id: true, name: true, unit: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" as const },
        },
        propertyPhotos: {
          include: { propertyPhoto: { select: { id: true, r2Key: true, fileName: true, description: true, sortOrder: true } } },
        },
        addons: {
          select: { id: true, tag: true, customLabel: true, price: true },
          orderBy: { createdAt: "asc" as const },
        },
        instructions: {
          select: { id: true, text: true, isPreset: true, repeats: true, sortOrder: true },
          orderBy: { sortOrder: "asc" as const },
        },
        linkedOccurrence: {
          select: {
            id: true, startAt: true, status: true, workflow: true, jobType: true, price: true,
            job: { include: { property: { select: { id: true, displayName: true, client: { select: { displayName: true } }, pointOfContact: { select: { firstName: true, lastName: true, phone: true, email: true } } } } } },
          },
        },
        _count: { select: { photos: true, comments: true } },
        assignedGroup: {
          select: {
            id: true,
            name: true,
            claimerUserId: true,
            preferredEquipment: {
              orderBy: { sortOrder: "asc" as const },
              select: {
                id: true,
                equipmentId: true,
                equipmentCollectionId: true,
                equipment: { select: { id: true, shortDesc: true, brand: true, model: true, type: true, status: true, retiredAt: true } },
                equipmentCollection: { select: { id: true, name: true } },
              },
            },
          },
        },
        photos: {
          select: { id: true, r2Key: true, contentType: true, createdAt: true },
          orderBy: { createdAt: "desc" as const },
          take: 3,
        },
      },
    });
  },

  async listMyOccurrences(userId, options?: { isAdmin?: boolean }) {
    return prisma.jobOccurrence.findMany({
      where: {
        status: { in: [JobOccurrenceStatus.SCHEDULED, JobOccurrenceStatus.IN_PROGRESS] },
        assignees: { some: { userId } },
        // Timeline events (workflow=EVENT) are admin-only. Non-admin
        // workers must never see them even if they were somehow assigned
        // — same gate as the other /worker/* endpoints. The caller
        // (routes/worker.ts) passes isAdmin based on the requesting
        // user's effective roles.
        ...(options?.isAdmin ? {} : { workflow: { not: OccurrenceWorkflow.EVENT } }),
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: {
                  select: {
                    id: true, displayName: true, isVip: true, vipReason: true, adminTags: true,
                    // Active client contacts as a fallback target for the
                    // "Request Confirmation" message when the property has
                    // no pointOfContactId set. Primary first so the worker
                    // always reaches out to the right person.
                    contacts: {
                      where: { status: "ACTIVE" },
                      select: { firstName: true, lastName: true, nickname: true, phone: true, email: true, isPrimary: true },
                      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                    },
                  },
                },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
            },
            recommendedCollections: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: { collectionId: true },
            },
          },
        },
        assignees: {
          include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } },
        },
        payment: {
          include: {
            splits: { include: { user: { select: { id: true, displayName: true, email: true } } } },
            collectedBy: { select: { id: true, displayName: true, email: true } },
          },
        },
        expenses: {
          include: {
            createdBy: { select: { id: true, displayName: true } },
            businessExpense: { select: { category: true, vendor: true, date: true } },
            supplyHold: {
              select: {
                id: true,
                quantity: true,
                status: true,
                supply: { select: { id: true, name: true, unit: true } },
              },
            },
          },
          orderBy: { createdAt: "asc" as const },
        },
        _count: { select: { photos: true, comments: true } },
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    });
  },

  async listAvailableOccurrences() {
    return prisma.jobOccurrence.findMany({
      where: {
        status: JobOccurrenceStatus.SCHEDULED,
        assignees: { none: {} },
        // Timeline events (workflow=EVENT) and tasks are NOT claimable
        // by workers. Events are admin-only; tasks are non-job items.
        // Only STANDARD and ONE_OFF (and possibly PROPOSAL_SUBMITTED in
        // some flows) are claimable. Keep this narrow rather than open
        // so future workflow additions default to "not claimable".
        workflow: { in: [OccurrenceWorkflow.STANDARD, OccurrenceWorkflow.ONE_OFF] },
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: {
                  select: {
                    id: true, displayName: true, isVip: true, vipReason: true, adminTags: true,
                    // Active client contacts as a fallback target for the
                    // "Request Confirmation" message when the property has
                    // no pointOfContactId set. Primary first so the worker
                    // always reaches out to the right person.
                    contacts: {
                      where: { status: "ACTIVE" },
                      select: { firstName: true, lastName: true, nickname: true, phone: true, email: true, isPrimary: true },
                      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
                    },
                  },
                },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
            },
            recommendedCollections: {
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: { collectionId: true },
            },
          },
        },
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    });
  },

  async addOccurrenceAssignee(currentUserId, occurrenceId, targetUserId, role?: string | null) {
    return prisma.$transaction(async (tx) => {
      // Only someone already assigned can add team members
      const isClaimer = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!isClaimer) {
        throw new ServiceError("FORBIDDEN", "Only an assigned worker can add team members.", 403);
      }

      await assertWorkerAssignable(tx, targetUserId);

      // Idempotent — skip if already assigned
      const existing = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: targetUserId },
      });
      if (existing) return { added: false as const, reason: "already_assigned" };

      await tx.jobOccurrenceAssignee.create({
        data: { occurrenceId, userId: targetUserId, assignedById: currentUserId, role: role ?? null },
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        targetUserId,
        action: "added",
        role: role ?? undefined,
      });

      return { added: true as const };
    });
  },

  async removeOccurrenceAssignee(currentUserId, occurrenceId, targetUserId) {
    return prisma.$transaction(async (tx) => {
      // Only the claimer (self-assigned) or admin can remove team members
      const callerUser = await tx.user.findUniqueOrThrow({ where: { id: currentUserId }, include: { roles: true } });
      const callerIsAdmin = callerUser.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      const callerAssignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!callerIsAdmin && (!callerAssignee || callerAssignee.assignedById !== currentUserId)) {
        throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can remove team members.", 403);
      }
      // Cannot remove yourself via this endpoint — use unclaim instead
      if (targetUserId === currentUserId) {
        throw new ServiceError("INVALID_INPUT", "Use unclaim to remove yourself.", 400);
      }

      await tx.jobOccurrenceAssignee.deleteMany({
        where: { occurrenceId, userId: targetUserId },
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        targetUserId,
        action: "removed",
      });

      return { removed: true as const };
    });
  },

  async adminAddOccurrenceAssignee(adminUserId, occurrenceId, targetUserId, role?: string | null) {
    return prisma.$transaction(async (tx) => {
      // Reject individual adds when the occurrence is group-attached.
      // Admins must detach the group first if they want to switch to
      // individual assignment.
      const occMeta = await tx.jobOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
        select: { assignedGroupId: true } as any,
      });
      if ((occMeta as any).assignedGroupId) {
        throw new ServiceError(
          "GROUP_ATTACHED",
          "Occurrence is group-attached. Detach the group before adding individual assignees.",
          409,
        );
      }
      const existing = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: targetUserId },
      });
      if (existing) return { added: false as const, reason: "already_assigned" };

      // First assignee becomes the claimer (assignedById = themselves).
      // Subsequent assignees are assigned by the claimer.
      const existingAssignees = await tx.jobOccurrenceAssignee.findMany({
        where: { occurrenceId },
        orderBy: { assignedAt: "asc" },
      });
      const assignedById =
        existingAssignees.length === 0
          ? targetUserId
          : existingAssignees[0].assignedById ?? existingAssignees[0].userId;

      await tx.jobOccurrenceAssignee.create({
        data: { occurrenceId, userId: targetUserId, assignedById, role: role ?? null },
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, adminUserId, {
        occurrenceId,
        targetUserId,
        action: "added",
      });

      return { added: true as const };
    });
  },

  async adminRemoveOccurrenceAssignee(adminUserId, occurrenceId, targetUserId) {
    return prisma.$transaction(async (tx) => {
      const assignees = await tx.jobOccurrenceAssignee.findMany({ where: { occurrenceId } });
      const target = assignees.find((a) => a.userId === targetUserId);
      if (!target) throw new ServiceError("NOT_FOUND", "Assignee not found.", 404);

      const isClaimer = target.assignedById === targetUserId && target.role !== "observer";
      const otherWorkers = assignees.filter((a) => a.userId !== targetUserId && a.role !== "observer");

      // Prevent removing the claimer if other workers exist — must reassign first
      if (isClaimer && otherWorkers.length > 0) {
        throw new ServiceError("CLAIMER_CANNOT_BE_REMOVED", "Reassign the claimer role to someone else before removing this person.", 400);
      }

      await tx.jobOccurrenceAssignee.deleteMany({
        where: { occurrenceId, userId: targetUserId },
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, adminUserId, {
        occurrenceId,
        targetUserId,
        action: "removed",
      });

      return { removed: true as const };
    });
  },

  async reassignClaimer(adminUserId: string, occurrenceId: string, newClaimerUserId: string) {
    return prisma.$transaction(async (tx) => {
      const assignees = await tx.jobOccurrenceAssignee.findMany({ where: { occurrenceId } });
      const target = assignees.find((a) => a.userId === newClaimerUserId);
      if (!target) throw new ServiceError("NOT_FOUND", "User is not on this job.", 404);

      // If target is an observer, promote them to worker
      if (target.role === "observer") {
        await tx.jobOccurrenceAssignee.update({
          where: { id: target.id },
          data: { role: null },
        });
      }

      // Set new claimer: assignedById = themselves
      await tx.jobOccurrenceAssignee.update({
        where: { id: target.id },
        data: { assignedById: newClaimerUserId },
      });

      // Update all other non-observer assignees to point to the new claimer
      for (const a of assignees) {
        if (a.userId === newClaimerUserId) continue;
        if (a.role === "observer") continue;
        await tx.jobOccurrenceAssignee.update({
          where: { id: a.id },
          data: { assignedById: newClaimerUserId },
        });
      }

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, adminUserId, {
        occurrenceId,
        newClaimerUserId,
        action: "reassign_claimer",
      });

      return { reassigned: true as const };
    });
  },

  async changeAssigneeRole(adminUserId: string, occurrenceId: string, targetUserId: string, newRole: string | null) {
    return prisma.$transaction(async (tx) => {
      const assignees = await tx.jobOccurrenceAssignee.findMany({ where: { occurrenceId } });
      const target = assignees.find((a) => a.userId === targetUserId);
      if (!target) throw new ServiceError("NOT_FOUND", "Assignee not found.", 404);

      // Prevent demoting the claimer to observer
      const isClaimer = target.assignedById === targetUserId && target.role !== "observer";
      if (isClaimer && newRole === "observer") {
        throw new ServiceError("CLAIMER_CANNOT_BE_OBSERVER", "Reassign the claimer role before changing this person to observer.", 400);
      }

      const updates: any = { role: newRole };

      // If promoting from observer to worker, set assignedById to current claimer
      if (target.role === "observer" && newRole !== "observer") {
        const claimer = assignees.find((a) => a.assignedById === a.userId && a.role !== "observer");
        updates.assignedById = claimer?.userId ?? targetUserId;
      }

      // If demoting to observer, clear assignedById
      if (newRole === "observer") {
        updates.assignedById = null;
      }

      await tx.jobOccurrenceAssignee.update({
        where: { id: target.id },
        data: updates,
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, adminUserId, {
        occurrenceId,
        targetUserId,
        newRole,
        action: "role_changed",
      });

      return { updated: true as const };
    });
  },

  async unclaimOccurrence(currentUserId, occurrenceId) {
    return prisma.$transaction(async (tx) => {
      // Only the claimer or admin can unclaim
      const callerUser = await tx.user.findUniqueOrThrow({ where: { id: currentUserId }, include: { roles: true } });
      const callerIsAdmin = callerUser.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      const callerAssignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!callerIsAdmin && (!callerAssignee || callerAssignee.assignedById !== currentUserId)) {
        throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can unclaim this job.", 403);
      }
      // Can only unclaim if not yet started
      const occ = await tx.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
      if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
        throw new ServiceError("INVALID_STATUS", "Cannot unclaim a job that has already been started.", 409);
      }

      await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
      // If this was a group-claimed occurrence, clear the link too — removes
      // the Group chip on the card and re-opens the claim chooser for next time.
      if ((occ as any).assignedGroupId) {
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: { assignedGroupId: null },
        });
      }

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        action: "unclaimed",
      });

      return { unclaimed: true as const };
    });
  },

  async claimOccurrence(currentUserId, occurrenceId, opts?: { groupId?: string | null }) {
    return prisma.$transaction(async (tx) => {
      await assertWorkerAssignable(tx, currentUserId);

      // Trainees cannot claim jobs — they must be added to a team by someone else
      const claimUser = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
      if (claimUser.workerType === "TRAINEE") {
        throw new ServiceError("TRAINEE_CANNOT_CLAIM", "Trainees cannot claim jobs. A team lead must add you to the occurrence.", 403);
      }

      const occ = await tx.jobOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
        include: { job: { select: { defaultPrice: true } } },
      });
      if (occ.workflow === OccurrenceWorkflow.TASK) {
        throw new ServiceError("CANNOT_CLAIM_TASK", "Tasks cannot be claimed. The creator is auto-assigned.", 409);
      }
      if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
        throw new ServiceError("INVALID_STATUS", "Only SCHEDULED occurrences can be claimed.", 409);
      }
      if (occ.isTentative) {
        throw new ServiceError("TENTATIVE", "Tentative occurrences cannot be claimed until confirmed by an admin.", 409);
      }
      if ((occ as any).isAdminOnly) {
        throw new ServiceError("ADMIN_ONLY", "This job is administered and can only be assigned by an admin.", 409);
      }

      // Group attachment rules.
      // - If occurrence is already group-attached (admin pre-attached), solo
      //   claims aren't allowed. The group claimer must "Claim for [Group]"
      //   or detach the group first.
      // - If client requested a group claim, the caller must be the group's
      //   claimer. Other group members can still claim solo.
      const occAssignedGroupId = (occ as any).assignedGroupId as string | null;
      if (opts?.groupId) {
        const group = await tx.group.findUnique({
          where: { id: opts.groupId },
          include: { members: { select: { userId: true, role: true } } },
        });
        if (!group) throw new ServiceError("NOT_FOUND", "Group not found.", 404);
        if (group.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);
        if (group.claimerUserId !== currentUserId) {
          throw new ServiceError("FORBIDDEN", "Only the group's claimer can claim on behalf of the group.", 403);
        }
        if (occAssignedGroupId && occAssignedGroupId !== group.id) {
          throw new ServiceError("CONFLICT", "Occurrence is already assigned to a different group.", 409);
        }
        // Existing individuals (not from this group) block group claim.
        const existingNonGroup = await tx.jobOccurrenceAssignee.findFirst({
          where: { occurrenceId },
        });
        if (existingNonGroup && !occAssignedGroupId) {
          throw new ServiceError("CONFLICT", "Occurrence already has individual assignees. Detach them before assigning a group.", 409);
        }
      } else if (occAssignedGroupId) {
        throw new ServiceError(
          "GROUP_ATTACHED",
          "This occurrence is group-attached. Use 'Claim for Group' or detach the group first.",
          409,
        );
      }

      // Contractors can only claim jobs within 2 days
      {
        const user = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
        if (user.workerType === "CONTRACTOR" && occ.startAt) {
          // ET calendar-day diff (DST-safe) — contractor lockout rule.
          const daysAhead = etDaysBetween(etToday(), etFormatDate(occ.startAt));
          if (daysAhead > 2) {
            throw new ServiceError("CONTRACTOR_TOO_FAR", "Contractors can only claim jobs within 2 days. This job is " + daysAhead + " days out.", 403);
          }
        }
      }

      // Compliance gate. Every active BLOCK policy that lists JOB_CLAIM in
      // its gatesServices must have a current signature. Policies with a
      // `gatesJobsAbovePrice` threshold only fire when this job's
      // effective price meets or exceeds that value — the seeded
      // Insurance policy uses this to only gate high-value jobs.
      const thresholdSetting = await prisma.setting.findUnique({ where: { key: "HIGH_VALUE_JOB_THRESHOLD" } });
      const threshold = Number(thresholdSetting?.value ?? 200);
      const effectivePrice = occ.price ?? (occ.job as any).defaultPrice ?? 0;
      const { policies } = await import("./policies");
      await policies.assertPoliciesSigned(currentUserId, "JOB_CLAIM", { effectivePrice });
      // Worker-type presence is still required independently for high-value
      // jobs — a policy gate assumes the worker actually has a type.
      if (effectivePrice >= threshold) {
        const user = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
        if (!user.workerType) {
          throw new ServiceError("WORKER_TYPE_REQUIRED", "Your worker type must be assigned before claiming high-value jobs. Contact your admin.", 403);
        }
      }

      if (opts?.groupId) {
        // Materialize group members. Re-fetch the group to read members
        // with role info (we only had a count check above).
        const group = await tx.group.findUniqueOrThrow({
          where: { id: opts.groupId },
          include: { members: { select: { userId: true, role: true } } },
        });
        await tx.jobOccurrence.update({
          where: { id: occurrenceId },
          data: { assignedGroupId: group.id },
        });
        // Claimer first, then everyone else. Claimer's assignedById === self
        // (matches solo-claim semantics). Other members are assigned-by-claimer.
        await tx.jobOccurrenceAssignee.upsert({
          where: { occurrenceId_userId: { occurrenceId, userId: currentUserId } },
          create: { occurrenceId, userId: currentUserId, assignedById: currentUserId },
          update: { assignedById: currentUserId, role: null },
        });
        for (const m of group.members) {
          if (m.userId === currentUserId) continue;
          await tx.jobOccurrenceAssignee.upsert({
            where: { occurrenceId_userId: { occurrenceId, userId: m.userId } },
            create: {
              occurrenceId,
              userId: m.userId,
              role: m.role === "observer" ? "observer" : null,
              assignedById: currentUserId,
            },
            update: { role: m.role === "observer" ? "observer" : null },
          });
        }
        await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
          occurrenceId,
          action: "claimed-for-group",
          groupId: group.id,
        });
        return { claimed: true as const, groupId: group.id };
      }

      await tx.jobOccurrenceAssignee.create({
        data: { occurrenceId, userId: currentUserId, assignedById: currentUserId },
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        action: "claimed",
      });

      return { claimed: true as const };
    });
  },

  async updateOccurrenceStatus(currentUserId, occurrenceId, status, notes?: string, location?: { lat: number; lng: number }, timestamps?: { startedAt?: string; completedAt?: string; totalPausedMs?: number }, extras?: { completionSplits?: Array<{ userId: string; percent: number }> }) {
    return prisma.$transaction(async (tx) => {
      const actionUser = await tx.user.findUniqueOrThrow({ where: { id: currentUserId }, include: { roles: true } });
      const isAdmin = actionUser.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");

      const assignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!assignee && !isAdmin) {
        throw new ServiceError("FORBIDDEN", "You are not assigned to this occurrence.", 403);
      }

      // Only the claimer (or admin) can start, complete, or manage jobs
      const isClaimer = assignee?.assignedById === currentUserId && assignee?.role !== "observer";
      if (!isClaimer && !isAdmin) {
        throw new ServiceError("NOT_CLAIMER", "Only the claimer can perform this action.", 403);
      }

      // Trainees cannot take actions
      if (actionUser.workerType === "TRAINEE") {
        throw new ServiceError("TRAINEE_CANNOT_ACT", "Trainees cannot start, complete, or manage jobs. The team lead must take this action.", 403);
      }

      const occ = await tx.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
      // Tentative jobs cannot be started
      if (occ.isTentative && status === JobOccurrenceStatus.IN_PROGRESS) {
        throw new ServiceError("TENTATIVE", "Tentative jobs cannot be started until confirmed by an admin.", 409);
      }

      const workflow = occ.workflow ?? "STANDARD";

      // For backward compat: estimates trying PENDING_PAYMENT → use PROPOSAL_SUBMITTED
      let finalStatus = status;
      if (workflow === "ESTIMATE" && status === JobOccurrenceStatus.PENDING_PAYMENT) {
        finalStatus = JobOccurrenceStatus.PROPOSAL_SUBMITTED;
      }

      // Validate transition — admins get expanded reversal options
      const validTransition = isAdmin
        ? isValidAdminTransition(workflow, occ.status, finalStatus)
        : isValidTransition(workflow, occ.status, finalStatus);
      if (!validTransition) {
        throw new ServiceError(
          "INVALID_TRANSITION",
          `Cannot transition from ${occ.status} to ${finalStatus} in ${workflow} workflow.`,
          409
        );
      }

      // Block forward transitions when no worker is assigned. Without this,
      // the admin-bypass above would let a super complete an unclaimed
      // occurrence, stranding it in PENDING_PAYMENT with no claimer.
      await assertOccurrenceHasWorker(tx, occurrenceId, finalStatus);

      // Workday gate — defense in depth alongside the client-side guard
      // dialog. A worker can't transition a job into IN_PROGRESS without
      // an active workday. Admins are exempt (they may be cleaning up).
      // The PAUSED → IN_PROGRESS path (resume) is also gated since it
      // resumes work and should require an open workday.
      //
      // The gate fires on BOTH the actor (claimer) AND every other
      // non-observer assignee. If the claimer presses Start while a
      // teammate hasn't clocked in yet, the start is blocked with a
      // 409 listing the teammates who need to start their workday.
      // Observers are exempt (they're not doing the work).
      if (
        !isAdmin &&
        finalStatus === JobOccurrenceStatus.IN_PROGRESS &&
        (occ.status === JobOccurrenceStatus.SCHEDULED || occ.status === JobOccurrenceStatus.PAUSED)
      ) {
        const { assertWorkdayActiveOrPrompt } = await import("./workdays");
        const check = await assertWorkdayActiveOrPrompt(currentUserId);
        if (!check.ok) {
          throw new ServiceError(
            "WORKDAY_NOT_ACTIVE",
            "Start your workday before starting a job.",
            409,
          );
        }

        // Team workday gate: every non-observer assignee must also be
        // actively on the clock. Single batched query.
        const teamAssignees = await tx.jobOccurrenceAssignee.findMany({
          where: {
            occurrenceId,
            // Claimer is in this list and was already checked above;
            // including them here is harmless because their workday
            // is active. Excluding the actor's own row would also
            // work but it's simpler to include and let the active
            // check pass through.
            OR: [{ role: null }, { role: { not: "observer" } }],
          },
          select: {
            userId: true,
            user: { select: { displayName: true, email: true } },
          },
        });
        // No teammates beyond the claimer → nothing to check.
        const otherTeam = teamAssignees.filter((a) => a.userId !== currentUserId);
        if (otherTeam.length > 0) {
          const todayKey = etFormatDate(new Date());
          const teamWorkdays = await tx.workerWorkday.findMany({
            where: {
              userId: { in: otherTeam.map((a) => a.userId) },
              workdayDate: todayKey,
            },
            select: {
              userId: true,
              endedAt: true,
              pausedAt: true,
            },
          });
          // "Active" = today's row exists AND is not ended AND is not
          // paused. Same definition the claimer gate uses (via
          // assertWorkdayActiveOrPrompt). PAUSED is explicitly NOT
          // active — those workers need to resume first.
          const wdByUser = new Map(teamWorkdays.map((w) => [w.userId, w]));
          const notReady: { userId: string; name: string }[] = [];
          for (const a of otherTeam) {
            const wd = wdByUser.get(a.userId);
            const isActive = !!wd && wd.endedAt == null && wd.pausedAt == null;
            if (!isActive) {
              notReady.push({
                userId: a.userId,
                name: a.user?.displayName ?? a.user?.email ?? "(unnamed)",
              });
            }
          }
          if (notReady.length > 0) {
            const names = notReady.map((n) => n.name).join(", ");
            const noun = notReady.length === 1 ? "teammate" : "teammates";
            const verb = notReady.length === 1 ? "hasn't" : "haven't";
            throw new ServiceError(
              "TEAM_WORKDAY_NOT_ACTIVE",
              `Can't start yet — ${noun} ${verb} started their workday: ${names}`,
              409,
              { notReady },
            );
          }
        }
      }

      const data: any = { status: finalStatus };
      if (finalStatus === JobOccurrenceStatus.IN_PROGRESS && !occ.startedAt) {
        data.startedAt = timestamps?.startedAt ? new Date(timestamps.startedAt) : new Date();
      }

      // Pausing: record when paused
      if (finalStatus === JobOccurrenceStatus.PAUSED) {
        data.pausedAt = new Date();
      }

      // Resuming from paused: accumulate pause duration, clear pausedAt
      if (occ.status === JobOccurrenceStatus.PAUSED && finalStatus === JobOccurrenceStatus.IN_PROGRESS) {
        if (occ.pausedAt) {
          data.totalPausedMs = (occ.totalPausedMs ?? 0) + (Date.now() - new Date(occ.pausedAt).getTime());
        }
        data.pausedAt = null;
      }

      // Reverting from completed/pending back to IN_PROGRESS: treat gap as pause time, clear completedAt
      if ((occ.status === JobOccurrenceStatus.PENDING_PAYMENT || occ.status === JobOccurrenceStatus.CLOSED) &&
        finalStatus === JobOccurrenceStatus.IN_PROGRESS) {
        if (occ.completedAt) {
          data.totalPausedMs = (occ.totalPausedMs ?? 0) + (Date.now() - new Date(occ.completedAt).getTime());
          data.completedAt = null;
        }
        // Clear hours approval — re-completion will re-evaluate from
        // the new completedAt against the variance threshold.
        data.hoursApprovedAt = null;
        data.hoursApprovedById = null;
      }

      // Completing from paused: finalize last pause segment
      if (occ.status === JobOccurrenceStatus.PAUSED &&
        (finalStatus === JobOccurrenceStatus.PENDING_PAYMENT ||
         finalStatus === JobOccurrenceStatus.CLOSED ||
         finalStatus === JobOccurrenceStatus.PROPOSAL_SUBMITTED)) {
        if (occ.pausedAt) {
          data.totalPausedMs = (occ.totalPausedMs ?? 0) + (Date.now() - new Date(occ.pausedAt).getTime());
        }
        data.pausedAt = null;
      }

      if (
        (finalStatus === JobOccurrenceStatus.PENDING_PAYMENT ||
         finalStatus === JobOccurrenceStatus.CLOSED ||
         finalStatus === JobOccurrenceStatus.PROPOSAL_SUBMITTED) &&
        !occ.completedAt
      ) {
        data.completedAt = timestamps?.completedAt ? new Date(timestamps.completedAt) : new Date();
      }

      // Payroll-hours approval on completion. Auto-approves jobs whose actual
      // time falls within the variance threshold; jobs outside the threshold
      // get hoursApprovedAt = null and surface in the title-bar alert + a
      // Jobs filter until an admin/super reviews. Reverts (clearing
      // completedAt) drop the approval below in the SCHEDULED/IN_PROGRESS
      // branches so a re-completion gets re-evaluated.
      if (
        (finalStatus === JobOccurrenceStatus.PENDING_PAYMENT ||
         finalStatus === JobOccurrenceStatus.CLOSED) &&
        !occ.hoursApprovedAt
      ) {
        // Read every effective value as the LATEST of: this request's
        // `timestamps` payload override, an in-flight `data.*` set earlier
        // in this same transaction, or the pre-update DB value. Without the
        // `timestamps` branch here, the variance check ran against the
        // pre-edit DB values while the post-edit values were applied
        // later (lines below) — a worker submitting off-the-clock time on
        // completion could land within variance after save but still be
        // flagged "Hours awaiting review" because the calc used the old
        // (smaller) totalPausedMs.
        const effectiveCompletedAt: Date | null =
          timestamps?.completedAt
            ? new Date(timestamps.completedAt)
            : data.completedAt instanceof Date
              ? data.completedAt
              : (occ.completedAt ?? null);
        const effectiveStartedAt: Date | null =
          timestamps?.startedAt
            ? new Date(timestamps.startedAt)
            : data.startedAt instanceof Date
              ? data.startedAt
              : (occ.startedAt ?? null);
        const effectivePausedMs: number =
          timestamps?.totalPausedMs != null
            ? Math.max(0, Math.round(timestamps.totalPausedMs))
            : typeof data.totalPausedMs === "number"
              ? data.totalPausedMs
              : (occ.totalPausedMs ?? 0);
        if (effectiveCompletedAt) {
          const activeAssignees = await tx.jobOccurrenceAssignee.count({
            // NULL-role rows are the canonical "regular worker" — must
            // be included. A direct exclusion of observers via Prisma's
            // not-equal forms translates to SQL `role != 'observer'`
            // which excludes NULL via Postgres three-valued logic,
            // silently undercounting the team and breaking the
            // variance-threshold auto-approve math. Use the OR pattern
            // that the rest of the codebase uses.
            where: {
              occurrenceId,
              OR: [{ role: null }, { role: { not: "observer" } }],
            },
          });
          const varianceThreshold = await loadHoursApprovalVarianceThreshold();
          const approval = evaluateHoursApproval({
            workflow,
            estimatedMinutes: occ.estimatedMinutes,
            startedAt: effectiveStartedAt,
            completedAt: effectiveCompletedAt,
            totalPausedMs: effectivePausedMs,
            workerCount: Math.max(1, activeAssignees),
            currentUserId,
            varianceThreshold,
          });
          if (approval.hoursApprovedAt) {
            data.hoursApprovedAt = approval.hoursApprovedAt;
            data.hoursApprovedById = approval.hoursApprovedById;
          }
        }
      }
      // Splits + promised-payout snapshot are NOT set here anymore. They're
      // deferred to the Take Payment stage (services/payments.ts +
      // services/paymentRequests.ts), which writes JobOccurrence.completionSplits
      // and JobOccurrence.promisedPayouts atomically when the user actually
      // commits to recording or requesting a payment. Completing the job
      // leaves both fields untouched.
      // Allow caller to explicitly override startedAt (e.g., worker adjusting start time on complete).
      if (timestamps?.startedAt) {
        data.startedAt = new Date(timestamps.startedAt);
      }
      // Allow caller to set totalPausedMs (e.g., off-the-clock time at completion).
      if (timestamps?.totalPausedMs != null) {
        data.totalPausedMs = Math.max(0, Math.round(timestamps.totalPausedMs));
      }
      if (notes !== undefined) data.notes = notes;
      if (location) {
        if (status === JobOccurrenceStatus.IN_PROGRESS) {
          data.startLat = location.lat;
          data.startLng = location.lng;
        } else {
          data.completeLat = location.lat;
          data.completeLng = location.lng;
        }
      }

      // Reverting to SCHEDULED: reset all time tracking and delete payment
      if (finalStatus === JobOccurrenceStatus.SCHEDULED) {
        data.startedAt = null;
        data.completedAt = null;
        data.pausedAt = null;
        data.totalPausedMs = 0;
        data.startLat = null;
        data.startLng = null;
        data.completeLat = null;
        data.completeLng = null;
        // Reverting wipes payment lifecycle metadata too.
        data.lastPaymentRejectionReason = null;
        data.lastPaymentRejectedAt = null;
        data.lastPaymentRevertReason = null;
        data.lastPaymentRevertedAt = null;
        // Payroll hours approval also clears — the next completion will
        // re-evaluate from a fresh timestamp.
        data.hoursApprovedAt = null;
        data.hoursApprovedById = null;
        // Delete payment and splits if they exist
        const existingPayment = await tx.payment.findFirst({ where: { occurrenceId } });
        if (existingPayment) {
          await tx.paymentSplit.deleteMany({ where: { paymentId: existingPayment.id } });
          await tx.payment.delete({ where: { id: existingPayment.id } });
        }
      }

      const updated = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data,
      });

      // Sync linked BusinessExpense.date to the occurrence's effective
      // anchor whenever completedAt transitions in either direction.
      //   • Completing (completedAt becomes non-null): BE.date = completedAt
      //     so the job's expenses anchor on the actual completion date in
      //     reports + exports.
      //   • Reverting (completedAt cleared): BE.date = startAt so future
      //     re-completions reset cleanly. Matches deriveJobExpenseDate.
      // Read-side queries also clip to occurrence.completedAt regardless
      // of BE.date (expenseAnchorDateWhere), so this sync is for keeping
      // the column itself semantically correct — manual SQL, future code,
      // and the operator-facing list all read the right date.
      const completedAtBefore = occ.completedAt ?? null;
      const completedAtAfter =
        data.completedAt === null
          ? null
          : data.completedAt instanceof Date
            ? data.completedAt
            : completedAtBefore;
      if (
        (completedAtBefore?.getTime() ?? null) !== (completedAtAfter?.getTime() ?? null)
      ) {
        const targetDate = completedAtAfter ?? updated.startAt;
        if (targetDate) {
          await tx.businessExpense.updateMany({
            where: { occurrenceId },
            data: { date: targetDate },
          });
        }
      }

      // Inventory hooks: same lifecycle policy as the `update` path above.
      // ACTIVE holds → CONSUMED on entering CLOSED/PENDING_PAYMENT/PROPOSAL_SUBMITTED;
      // CONSUMED holds → ACTIVE when reverting to SCHEDULED/IN_PROGRESS.
      // CANCELED isn't reachable from this code path (the `update` flow handles it).
      if (
        finalStatus === JobOccurrenceStatus.CLOSED ||
        finalStatus === JobOccurrenceStatus.PENDING_PAYMENT ||
        finalStatus === JobOccurrenceStatus.PROPOSAL_SUBMITTED
      ) {
        await consumeHoldsForOccurrence(occurrenceId, tx);
      } else if (
        (occ.status === JobOccurrenceStatus.CLOSED ||
          occ.status === JobOccurrenceStatus.PENDING_PAYMENT ||
          occ.status === JobOccurrenceStatus.PROPOSAL_SUBMITTED) &&
        (finalStatus === JobOccurrenceStatus.SCHEDULED ||
          finalStatus === JobOccurrenceStatus.IN_PROGRESS)
      ) {
        await reactivateHoldsForOccurrence(occurrenceId, tx);
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
        occurrenceId,
        record: updated,
      });

      return updated;
    });
  },

  async generateOccurrences(currentUserId, jobId) {
    // Keep it simple for MVP: generate N occurrences into the future
    // based on cadence fields. You can make this smarter later.
    return prisma.$transaction(async (tx) => {
      const job = await tx.job.findUniqueOrThrow({
        where: { id: jobId },
        include: {
          schedule: true,
          // Order by sortOrder so the chosen claimer is honored when
          // generating new occurrences from the schedule.
          defaultAssignees: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        },
      });

      const sch = job.schedule;
      if (!sch || !sch.active || !sch.autoRenew || !sch.cadence) {
        return { generated: 0 };
      }

      // naive generator: create one occurrence “now + cadence”
      // (You can replace with a real horizon loop later.)
      const now = new Date();
      const occ = await tx.jobOccurrence.create({
        data: {
          jobId,
          kind: job.kind,
          startAt: now,
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.GENERATED,
          notes: (job as any).notes ?? null,
          price: (job as any).defaultPrice ?? null,
          estimatedMinutes: (job as any).estimatedMinutes ?? null,
        } as any,
      });

      // Default-crew resolution mirrors createOccurrence: group default
      // takes precedence over individual defaults; archived groups leave
      // the occurrence unassigned (admin can fix manually).
      const assigneeSource: { userId: string; role: string | null }[] = [];
      let attachedGroupId: string | null = null;
      if ((job as any).defaultGroupId) {
        const group = await tx.group.findUnique({
          where: { id: (job as any).defaultGroupId },
          include: { members: { select: { userId: true, role: true } } },
        });
        if (group && !group.archivedAt) {
          attachedGroupId = group.id;
          assigneeSource.push({ userId: group.claimerUserId, role: null });
          for (const m of group.members) {
            assigneeSource.push({
              userId: m.userId,
              role: m.role === "observer" ? "observer" : null,
            });
          }
        }
      } else {
        for (const d of job.defaultAssignees.filter((d) => d.active)) {
          assigneeSource.push({ userId: d.userId, role: d.role ?? null });
        }
      }

      for (const a of assigneeSource) {
        await assertWorkerAssignable(tx, a.userId);
      }

      if (attachedGroupId) {
        await tx.jobOccurrence.update({
          where: { id: occ.id },
          data: { assignedGroupId: attachedGroupId },
        });
      }

      if (assigneeSource.length) {
        const claimerId = assigneeSource[0].userId;
        await tx.jobOccurrenceAssignee.createMany({
          data: assigneeSource.map((a, i) => ({
            occurrenceId: occ.id,
            userId: a.userId,
            role: a.role ?? null,
            assignedById: i === 0 ? a.userId : claimerId,
          })),
          skipDuplicates: true,
        });
      }

      await tx.jobSchedule.update({
        where: { id: sch.id },
        data: { nextGenerateAt: now }, // placeholder: compute real next time later
      });

      await writeAudit(tx, AUDIT.JOB.OCCURRENCES_GENERATED, currentUserId, {
        jobId,
        generated: 1,
        occurrenceId: occ.id,
      });

      return { generated: 1 };
    });
  },

  async archiveJob(
    currentUserId: string,
    jobId: string,
    // Optional correlation id — set by the Client/Property archive
    // cascade so every row it touches carries the same tag in its
    // audit metadata. Query "all rows archived as part of this
    // cascade" later by scanning AuditEvent.metadata.cascadeGroupId.
    opts?: { cascadeGroupId?: string; tx?: Prisma.TransactionClient },
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) throw new ServiceError("NOT_FOUND", "Job not found.", 404);
      if (job.status === JobStatus.ARCHIVED) {
        // Idempotent — cascades pass over already-archived rows without
        // erroring. Return the current record so callers can still count.
        return job;
      }
      // Relaxed precondition: any non-archived Job may be archived so
      // Client/Property cascade doesn't blow up on PROPOSED or PAUSED
      // Jobs. Historical constraint of "only ACCEPTED" wasn't load-
      // bearing anywhere downstream (verified via archive semantics audit).

      const record = await tx.job.update({
        where: { id: jobId },
        data: { status: JobStatus.ARCHIVED },
      });

      // Archive parity with pause: delete future SCHEDULED STANDARD
      // occurrences from worker calendars. An archived Job represents
      // a closed relationship (or a manually closed service) — no
      // worker should be dispatched to it. Same helper as pause with
      // a distinct audit label so the two side effects are
      // distinguishable in the trail.
      await applyJobPauseSideEffectsInTx(
        tx,
        currentUserId,
        jobId,
        opts?.cascadeGroupId ? { cascadeGroupId: opts.cascadeGroupId } : undefined,
        "ARCHIVED_REMOVED_FUTURE_OCCURRENCES",
      );

      await writeAudit(tx, AUDIT.JOB.ARCHIVED, currentUserId, {
        jobId,
        record,
        ...(opts?.cascadeGroupId ? { cascadeGroupId: opts.cascadeGroupId } : {}),
      });

      return record;
    };
    return opts?.tx ? run(opts.tx) : prisma.$transaction(run);
  },

  // Symmetric unarchive — mirror of archiveJob. Idempotent on already-
  // active rows so cascades can pass over independently-active Jobs
  // without erroring.
  async unarchiveJob(
    currentUserId: string,
    jobId: string,
    opts?: { cascadeGroupId?: string; tx?: Prisma.TransactionClient },
  ) {
    const run = async (tx: Prisma.TransactionClient) => {
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) throw new ServiceError("NOT_FOUND", "Job not found.", 404);
      if (job.status !== JobStatus.ARCHIVED) {
        // Idempotent — the cascade may hit a Job that was already
        // returned to active by a prior manual action.
        return job;
      }

      // On unarchive we return the Job to ACCEPTED — the safest
      // "resumed service" state. PROPOSED Jobs were already accepted
      // at some point to be archived-through-cascade, so ACCEPTED is
      // a truthful landing state for the whole population.
      const record = await tx.job.update({
        where: { id: jobId },
        data: { status: JobStatus.ACCEPTED },
      });

      // Unarchive parity with unpause: rebuild the recurring chain
      // so the operator doesn't have to manually click "Generate Next"
      // on a formerly-archived Job. Same helper as unpause with a
      // distinct audit label.
      await applyJobResumeSideEffectsInTx(
        tx,
        currentUserId,
        jobId,
        opts?.cascadeGroupId ? { cascadeGroupId: opts.cascadeGroupId } : undefined,
        "UNARCHIVED_REGENERATED_NEXT_OCCURRENCE",
      );

      await writeAudit(tx, AUDIT.JOB.UNARCHIVED, currentUserId, {
        jobId,
        record,
        ...(opts?.cascadeGroupId ? { cascadeGroupId: opts.cascadeGroupId } : {}),
      });

      return record;
    };
    return opts?.tx ? run(opts.tx) : prisma.$transaction(run);
  },

  async listArchivedJobs(params?: { page?: number; pageSize?: number }) {
    const page = Math.max(params?.page ?? 1, 1);
    const pageSize = Math.min(Math.max(params?.pageSize ?? 25, 1), 100);
    const skip = (page - 1) * pageSize;

    const where: Prisma.JobWhereInput = { status: JobStatus.ARCHIVED };

    const [rows, total] = await prisma.$transaction([
      prisma.job.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        skip,
        take: pageSize,
        include: {
          property: {
            select: {
              id: true,
              displayName: true,
              street1: true,
              city: true,
              state: true,
              status: true,
            },
          },
          schedule: true,
          _count: { select: { defaultAssignees: true } },
        },
      }),
      prisma.job.count({ where }),
    ]);

    return {
      items: rows.map((j) => ({
        ...j,
        nextOccurrence: null,
        assigneeCount: j._count.defaultAssignees,
      })),
      total,
      page,
      pageSize,
    };
  },

  async deleteJob(jobId: string) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new ServiceError("NOT_FOUND", "Job not found.", 404);
    const occurrenceCount = await prisma.jobOccurrence.count({ where: { jobId } });
    if (occurrenceCount > 0) {
      throw new ServiceError(
        "HAS_OCCURRENCES",
        "Delete all job occurrences before deleting the job.",
        409
      );
    }
    await prisma.jobSchedule.deleteMany({ where: { jobId } });
    await prisma.job.delete({ where: { id: jobId } });
    return { deleted: true as const };
  },

  async deleteOccurrence(occurrenceId) {
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId } });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
    await prisma.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
    await prisma.jobOccurrence.delete({ where: { id: occurrenceId } });
    return { deleted: true as const };
  },
};
