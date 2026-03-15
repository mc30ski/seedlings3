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
} from "@prisma/client";
import type { ServicesJobs } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
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
      if (params.from) dateRange.gte = new Date(params.from);
      if (params.to) dateRange.lte = new Date(params.to + "T23:59:59.999Z");
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
        defaultAssignees: true,
        occurrences: {
          orderBy: [{ createdAt: "desc" }],
          take: 50,
          include: {
            assignees: {
              include: {
                user: { select: { id: true, displayName: true, email: true } },
              },
            },
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
          name: (payload as any).name ?? null,
          kind: payload.kind,
          status: payload.status ?? JobStatus.PROPOSED,
          frequencyDays: (payload as any).frequencyDays ?? null,
          notes: payload.notes ?? null,
          defaultPrice: payload.defaultPrice ?? null,
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
          name: "name" in payload ? ((payload as any).name ?? null) : undefined,
          frequencyDays: "frequencyDays" in (payload as any) ? ((payload as any).frequencyDays ?? null) : undefined,
          notes: payload.notes ?? undefined,
          defaultPrice: payload.defaultPrice ?? undefined,
        } as any,
      });

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
          name: input.name !== undefined ? input.name : (job as any).name ?? null,
          notes: input.notes !== undefined ? input.notes : (job as any).notes ?? null,
          price: input.price !== undefined ? input.price : (job as any).defaultPrice ?? null,
          isOneOff: input.isOneOff ?? false,
        } as any,
      });

      // If caller passed assignees, use those; otherwise copy defaults.
      const assigneeIds =
        (input.assigneeUserIds?.length
          ? input.assigneeUserIds
          : job.defaultAssignees.map((d) => d.userId)) ?? [];

      for (const uid of assigneeIds) {
        await assertWorkerAssignable(tx, uid);
      }

      if (assigneeIds.length) {
        await tx.jobOccurrenceAssignee.createMany({
          data: assigneeIds.map((uid) => ({
            occurrenceId: occ.id,
            userId: uid,
            assignedById: currentUserId,
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

  async updateOccurrence(
    currentUserId: string,
    occurrenceId: string,
    patch: any
  ) {
    return prisma.$transaction(async (tx) => {
      const data: any = {};

      if (patch.kind != null) data.kind = patch.kind;
      if (patch.status != null) data.status = patch.status;

      // allow null to clear
      if ("name" in patch) data.name = patch.name ?? null;
      if ("startAt" in patch)
        data.startAt = patch.startAt ? new Date(patch.startAt) : null;
      if ("endAt" in patch)
        data.endAt = patch.endAt ? new Date(patch.endAt) : null;
      if ("notes" in patch) data.notes = patch.notes ?? null;
      if ("price" in patch) data.price = patch.price ?? null;

      const updated = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data,
      });

      if (data.status === JobOccurrenceStatus.CANCELED) {
        await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
      }

      await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
        occurrenceId,
        record: updated,
      });

      return updated;
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

      await tx.jobOccurrenceAssignee.createMany({
        data: input.assigneeUserIds.map((uid) => ({
          occurrenceId,
          userId: uid,
          assignedById: input.assignedById ?? currentUserId,
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
    if (params?.from) dateRange.gte = new Date(params.from);
    if (params?.to) dateRange.lte = new Date(params.to + "T23:59:59.999Z");
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
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
        assignees: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
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
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
        assignees: {
          include: { user: { select: { id: true, displayName: true, email: true } } },
        },
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    });
  },

  async listAvailableOccurrences() {
    return prisma.jobOccurrence.findMany({
      where: {
        status: JobOccurrenceStatus.SCHEDULED,
        assignees: { none: {} },
      },
      include: {
        job: {
          include: {
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
      },
      orderBy: [{ startAt: "asc" }, { createdAt: "asc" }],
    });
  },

  async addOccurrenceAssignee(currentUserId, occurrenceId, targetUserId) {
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
        data: { occurrenceId, userId: targetUserId, assignedById: currentUserId },
      });

      await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
        occurrenceId,
        targetUserId,
        action: "added",
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

  async adminAddOccurrenceAssignee(adminUserId, occurrenceId, targetUserId) {
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
        data: { occurrenceId, userId: targetUserId, assignedById },
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

  async unclaimOccurrence(currentUserId, occurrenceId) {
    return prisma.$transaction(async (tx) => {
      // Only the claimer can unclaim
      const callerAssignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!callerAssignee || callerAssignee.assignedById !== currentUserId) {
        throw new ServiceError("FORBIDDEN", "Only the person who claimed this job can unclaim it.", 403);
      }
      // Must be SCHEDULED or IN_PROGRESS to unclaim
      const occ = await tx.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
      if (occ.status === JobOccurrenceStatus.COMPLETED || occ.status === JobOccurrenceStatus.CANCELED) {
        throw new ServiceError("INVALID_STATUS", "Cannot unclaim a completed or canceled occurrence.", 409);
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

      const occ = await tx.jobOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } });
      if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
        throw new ServiceError("INVALID_STATUS", "Only SCHEDULED occurrences can be claimed.", 409);
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

  async updateOccurrenceStatus(currentUserId, occurrenceId, status) {
    return prisma.$transaction(async (tx) => {
      const assignee = await tx.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: currentUserId },
      });
      if (!assignee) {
        throw new ServiceError("FORBIDDEN", "You are not assigned to this occurrence.", 403);
      }

      const updated = await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status },
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
          name: (job as any).name ?? null,
          notes: (job as any).notes ?? null,
          price: (job as any).defaultPrice ?? null,
        } as any,
      });

      // copy default assignees to the occurrence
      const defaultIds = job.defaultAssignees.map((d) => d.userId);
      for (const uid of defaultIds) {
        await assertWorkerAssignable(tx, uid);
      }
      if (defaultIds.length) {
        await tx.jobOccurrenceAssignee.createMany({
          data: defaultIds.map((uid) => ({
            occurrenceId: occ.id,
            userId: uid,
            assignedById: currentUserId,
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
