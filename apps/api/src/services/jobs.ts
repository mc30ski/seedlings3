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
  JobKind,
  JobOccurrenceStatus,
  JobOccurrenceSource,
} from "@prisma/client";
import type { ServicesJobs } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";

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
    if (params?.status && params.status !== "ALL") where.status = params.status;
    if (params?.kind && params.kind !== "ALL") where.kind = params.kind;

    if (q) {
      where.OR = [
        { property: { displayName: { contains: q, mode: "insensitive" } } },
        { property: { city: { contains: q, mode: "insensitive" } } },
      ];
    }

    const rows = await prisma.job.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        property: {
          select: {
            id: true,
            displayName: true,
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
            windowStart: true,
            status: true,
            kind: true,
          },
          orderBy: [
            { startAt: "asc" },
            { windowStart: "asc" },
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
          select: { defaultAssignees: true },
        },
      },
    });

    return rows.map((j) => ({
      ...j,
      nextOccurrence: j.occurrences[0] ?? null,
      assigneeCount: j._count.defaultAssignees,
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
          kind: payload.kind,
          status: payload.status ?? JobStatus.PROPOSED,
        },
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
        },
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
          kind: input.kind ?? job.kind, // copy from template by default
          windowStart: toDate(input.windowStart),
          windowEnd: toDate(input.windowEnd),
          startAt: toDate(input.startAt),
          endAt: toDate(input.endAt),
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.MANUAL,
          notes: input.notes ?? null,
        },
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
      if ("windowStart" in patch)
        data.windowStart = patch.windowStart
          ? new Date(patch.windowStart)
          : null;
      if ("windowEnd" in patch)
        data.windowEnd = patch.windowEnd ? new Date(patch.windowEnd) : null;
      if ("startAt" in patch)
        data.startAt = patch.startAt ? new Date(patch.startAt) : null;
      if ("endAt" in patch)
        data.endAt = patch.endAt ? new Date(patch.endAt) : null;
      if ("notes" in patch) data.notes = patch.notes ?? null;

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
          windowStart: now,
          status: JobOccurrenceStatus.SCHEDULED,
          source: JobOccurrenceSource.GENERATED,
        },
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
};
