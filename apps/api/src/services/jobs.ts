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
import { etMidnight, etEndOfDay } from "../lib/dates";
import { ServiceError } from "../lib/errors";

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
    IN_PROGRESS: ["PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["CLOSED", "CANCELED"],
    CLOSED: ["ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["PENDING_PAYMENT", "CLOSED", "CANCELED"],
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
    IN_PROGRESS: ["SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "CLOSED", "CANCELED"],
    CLOSED: ["PENDING_PAYMENT", "ARCHIVED"],
  },
  ONE_OFF: {
    SCHEDULED: ["IN_PROGRESS", "CANCELED"],
    IN_PROGRESS: ["SCHEDULED", "PENDING_PAYMENT", "CLOSED", "CANCELED"],
    PENDING_PAYMENT: ["IN_PROGRESS", "CLOSED", "CANCELED"],
    CLOSED: ["PENDING_PAYMENT", "ARCHIVED"],
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

  async get(id) {
    return prisma.job.findUniqueOrThrow({
      where: { id },
      include: {
        property: true,
        schedule: true,
        defaultAssignees: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
        occurrences: {
          orderBy: [{ createdAt: "desc" }],
          take: 50,
          include: {
            assignees: {
              include: {
                user: { select: { id: true, displayName: true, email: true, workerType: true } },
              },
            },
            payment: {
              include: {
                splits: { include: { user: { select: { id: true, displayName: true } } } },
                collectedBy: { select: { id: true, displayName: true } },
              },
            },
            expenses: {
              include: { createdBy: { select: { id: true, displayName: true } } },
              orderBy: { createdAt: "asc" as const },
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
          notes: payload.notes ?? null,
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
      const record = await tx.job.update({
        where: { id },
        data: {
          kind: payload.kind,
          status: payload.status,
          propertyId: payload.propertyId,
          frequencyDays: "frequencyDays" in (payload as any) ? ((payload as any).frequencyDays ?? null) : undefined,
          notes: payload.notes ?? undefined,
          defaultPrice: payload.defaultPrice ?? undefined,
          estimatedMinutes: "estimatedMinutes" in (payload as any) ? ((payload as any).estimatedMinutes ?? null) : undefined,
          defaultJobType: "defaultJobType" in (payload as any) ? ((payload as any).defaultJobType ?? null) : undefined,
        } as any,
      });

      // When pausing, remove future scheduled repeating occurrences
      if (payload.status === "PAUSED") {
        const deleted = await tx.jobOccurrence.deleteMany({
          where: {
            jobId: id,
            status: JobOccurrenceStatus.SCHEDULED,
            workflow: OccurrenceWorkflow.STANDARD,
            startAt: { gt: new Date() },
          },
        });
        if (deleted.count > 0) {
          await writeAudit(tx, AUDIT.JOB.UPDATED, currentUserId, {
            id,
            action: "PAUSED_REMOVED_FUTURE_OCCURRENCES",
            removedCount: deleted.count,
          });
        }
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
        include: { defaultAssignees: true },
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

      // If caller passed assignees, use those; otherwise copy defaults (with roles).
      const useCallerIds = input.assigneeUserIds?.length;
      const assigneeSource = useCallerIds
        ? input.assigneeUserIds!.map((uid) => ({ userId: uid, role: null as string | null }))
        : job.defaultAssignees.filter((d) => d.active).map((d) => ({ userId: d.userId, role: d.role ?? null }));

      for (const a of assigneeSource) {
        await assertWorkerAssignable(tx, a.userId);
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

      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED, completedAt: new Date() },
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

      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED, completedAt: new Date() },
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

      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED, completedAt: new Date() },
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

      if (data.status === JobOccurrenceStatus.CANCELED) {
        await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
      }

      // If reverting from CLOSED to a pre-payment state, clean up the payment
      if (data.status && data.status !== JobOccurrenceStatus.CLOSED && data.status !== JobOccurrenceStatus.ARCHIVED) {
        const existingPayment = await tx.payment.findUnique({ where: { occurrenceId } });
        if (existingPayment) {
          await tx.paymentSplit.deleteMany({ where: { paymentId: existingPayment.id } });
          await tx.payment.delete({ where: { id: existingPayment.id } });
        }
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

    return prisma.jobOccurrence.findMany({
      where: {
        status: { not: JobOccurrenceStatus.ARCHIVED },
        ...(hasDates ? { startAt: dateRange } : {}),
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: { select: { id: true, displayName: true, isVip: true, vipReason: true, adminTags: true } },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
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
          include: { createdBy: { select: { id: true, displayName: true } } },
          orderBy: { createdAt: "asc" as const },
        },
        linkedOccurrence: {
          select: {
            id: true, startAt: true, status: true, workflow: true, jobType: true, price: true,
            job: { include: { property: { select: { id: true, displayName: true, client: { select: { displayName: true } }, pointOfContact: { select: { firstName: true, lastName: true, phone: true, email: true } } } } } },
          },
        },
        _count: { select: { photos: true, comments: true } },
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
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    });
  },

  async getOccurrencesByIds(ids: string[]) {
    if (ids.length === 0) return [];
    return prisma.jobOccurrence.findMany({
      where: { id: { in: ids } },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: { select: { id: true, displayName: true, isVip: true, vipReason: true, adminTags: true } },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
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
          include: { createdBy: { select: { id: true, displayName: true } } },
          orderBy: { createdAt: "asc" as const },
        },
        linkedOccurrence: {
          select: {
            id: true, startAt: true, status: true, workflow: true, jobType: true, price: true,
            job: { include: { property: { select: { id: true, displayName: true, client: { select: { displayName: true } }, pointOfContact: { select: { firstName: true, lastName: true, phone: true, email: true } } } } } },
          },
        },
        _count: { select: { photos: true, comments: true } },
        photos: {
          select: { id: true, r2Key: true, contentType: true, createdAt: true },
          orderBy: { createdAt: "desc" as const },
          take: 3,
        },
      },
    });
  },

  async listMyOccurrences(userId) {
    return prisma.jobOccurrence.findMany({
      where: {
        status: { in: [JobOccurrenceStatus.SCHEDULED, JobOccurrenceStatus.IN_PROGRESS] },
        assignees: { some: { userId } },
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: { select: { id: true, displayName: true, isVip: true, vipReason: true, adminTags: true } },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
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
          include: { createdBy: { select: { id: true, displayName: true } } },
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
        workflow: { not: OccurrenceWorkflow.TASK },
      },
      include: {
        job: {
          include: {
            property: {
              select: {
                id: true, displayName: true, street1: true, city: true, state: true,
                client: { select: { id: true, displayName: true, isVip: true, vipReason: true, adminTags: true } },
                pointOfContact: { select: { firstName: true, lastName: true, nickname: true, phone: true, email: true } },
              },
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
      // Only the claimer (self-assigned) can remove team members
      const callerAssignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!callerAssignee || callerAssignee.assignedById !== currentUserId) {
        throw new ServiceError("FORBIDDEN", "Only the person who claimed this job can remove team members.", 403);
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
      // Only the claimer can unclaim
      const callerAssignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!callerAssignee || callerAssignee.assignedById !== currentUserId) {
        throw new ServiceError("FORBIDDEN", "Only the person who claimed this job can unclaim it.", 403);
      }
      // Can only unclaim if not yet started
      const occ = await tx.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
      if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
        throw new ServiceError("INVALID_STATUS", "Cannot unclaim a job that has already been started.", 409);
      }

      await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        action: "unclaimed",
      });

      return { unclaimed: true as const };
    });
  },

  async claimOccurrence(currentUserId, occurrenceId) {
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

      // Contractors can only claim jobs within 2 days
      {
        const user = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
        if (user.workerType === "CONTRACTOR" && occ.startAt) {
          const now = new Date();
          const daysAhead = Math.ceil((occ.startAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          if (daysAhead > 2) {
            throw new ServiceError("CONTRACTOR_TOO_FAR", "Contractors can only claim jobs within 2 days. This job is " + daysAhead + " days out.", 403);
          }
        }
      }

      // Tier gating for high-value jobs
      const thresholdSetting = await prisma.setting.findUnique({ where: { key: "HIGH_VALUE_JOB_THRESHOLD" } });
      const threshold = Number(thresholdSetting?.value ?? 200);
      const effectivePrice = occ.price ?? (occ.job as any).defaultPrice ?? 0;
      if (effectivePrice >= threshold) {
        const user = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
        if (user.workerType === "CONTRACTOR") {
          const now = new Date();
          const insured = !!(user.insuranceCertR2Key && user.insuranceExpiresAt && user.insuranceExpiresAt > now);
          if (!insured) {
            throw new ServiceError("INSURANCE_REQUIRED", "Contractors must have valid insurance to claim high-value jobs.", 403);
          }
        }
        if (!user.workerType) {
          throw new ServiceError("WORKER_TYPE_REQUIRED", "Your worker type must be assigned before claiming high-value jobs. Contact your admin.", 403);
        }
      }

      // Contractor agreement check
      const user = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
      if (user.workerType === "CONTRACTOR" && !user.contractorAgreedAt) {
        throw new ServiceError("CONTRACTOR_AGREEMENT_REQUIRED", "You must acknowledge the contractor agreement before claiming jobs.", 403);
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

  async updateOccurrenceStatus(currentUserId, occurrenceId, status, notes?: string, location?: { lat: number; lng: number }, timestamps?: { startedAt?: string; completedAt?: string }) {
    return prisma.$transaction(async (tx) => {
      const assignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!assignee) {
        throw new ServiceError("FORBIDDEN", "You are not assigned to this occurrence.", 403);
      }

      // Only the claimer can start, complete, or manage jobs
      const isClaimer = assignee.assignedById === currentUserId && assignee.role !== "observer";
      if (!isClaimer) {
        throw new ServiceError("NOT_CLAIMER", "Only the claimer can perform this action.", 403);
      }

      // Trainees cannot take actions
      const actionUser = await tx.user.findUniqueOrThrow({ where: { id: currentUserId } });
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

      // Validate transition
      if (!isValidTransition(workflow, occ.status, finalStatus)) {
        throw new ServiceError(
          "INVALID_TRANSITION",
          `Cannot transition from ${occ.status} to ${finalStatus} in ${workflow} workflow.`,
          409
        );
      }

      const data: any = { status: finalStatus };
      if (finalStatus === JobOccurrenceStatus.IN_PROGRESS && !occ.startedAt) {
        data.startedAt = timestamps?.startedAt ? new Date(timestamps.startedAt) : new Date();
      }
      if (
        (finalStatus === JobOccurrenceStatus.PENDING_PAYMENT ||
         finalStatus === JobOccurrenceStatus.CLOSED ||
         finalStatus === JobOccurrenceStatus.PROPOSAL_SUBMITTED) &&
        !occ.completedAt
      ) {
        data.completedAt = timestamps?.completedAt ? new Date(timestamps.completedAt) : new Date();
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

      const updated = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data,
      });

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
        include: { schedule: true, defaultAssignees: true },
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

      // copy default assignees to the occurrence (with roles)
      const defaults = job.defaultAssignees.filter((d) => d.active);
      for (const d of defaults) {
        await assertWorkerAssignable(tx, d.userId);
      }
      if (defaults.length) {
        const claimerId = defaults[0].userId;
        await tx.jobOccurrenceAssignee.createMany({
          data: defaults.map((d, i) => ({
            occurrenceId: occ.id,
            userId: d.userId,
            role: d.role ?? null,
            assignedById: i === 0 ? d.userId : claimerId,
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

  async archiveJob(currentUserId: string, jobId: string) {
    return prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) throw new ServiceError("NOT_FOUND", "Job not found.", 404);
      if (job.status === JobStatus.ARCHIVED) {
        throw new ServiceError("INVALID_STATUS", "Job is already archived.", 409);
      }
      if (job.status !== JobStatus.ACCEPTED) {
        throw new ServiceError("INVALID_STATUS", "Only accepted jobs can be archived.", 409);
      }

      const record = await tx.job.update({
        where: { id: jobId },
        data: { status: JobStatus.ARCHIVED },
      });

      await writeAudit(tx, AUDIT.JOB.ARCHIVED, currentUserId, {
        jobId,
        record,
      });

      return record;
    });
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
