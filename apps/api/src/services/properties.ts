import { Prisma, PropertyStatus, PropertyKind, JobStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { randomBytes } from "crypto";
import {
  applyJobPauseSideEffectsInTx,
  applyJobResumeSideEffectsInTx,
} from "./jobs";
import type {
  ServicesProperties,
  PropertyUpsert,
  PropertyListItemParams,
} from "../types/services";

type Tx = Prisma.TransactionClient;

function like(text?: string) {
  return text?.trim()
    ? { contains: text.trim(), mode: "insensitive" as const }
    : undefined;
}

export const properties: ServicesProperties = {
  async list(params: PropertyListItemParams) {
    const q = (params?.q ?? "").trim();
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);

    const where: Prisma.PropertyWhereInput = {};
    if (params?.clientId) where.clientId = params.clientId;

    // status / kind filters (like clients list)
    if (params?.status && params.status !== "ALL") where.status = params.status;
    if (params?.kind && params.kind !== "ALL") where.kind = params.kind;

    if (q) {
      where.OR = [
        { displayName: like(q) },
        { street1: like(q) },
        { city: like(q) },
        { state: like(q) },
        { postalCode: like(q) },
      ];
    }

    const rows = await prisma.property.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        client: { select: { id: true, displayName: true, isVip: true, vipReason: true } },
        pointOfContact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    return rows.map((p) => ({
      ...p,
    }));
  },

  async get(id: string) {
    return prisma.property.findUniqueOrThrow({
      where: { id },
      include: {
        client: { select: { id: true, displayName: true } },
        pointOfContact: true,
      },
    });
  },

  async create(currentUserId: string, payload: PropertyUpsert) {
    return prisma.$transaction(async (tx) => {
      const created = await tx.property.create({
        data: {
          clientId: payload.clientId,
          displayName: payload.displayName,
          kind: payload.kind ?? PropertyKind.SINGLE,
          status: payload.status ?? PropertyStatus.ACTIVE,
          street1: payload.street1 ?? null,
          street2: payload.street2 ?? null,
          city: payload.city ?? null,
          state: payload.state ?? null,
          postalCode: payload.postalCode ?? null,
          country: payload.country ?? null,
          accessNotes: payload.accessNotes ?? null,
          lotSize: payload.lotSize != null ? Number(payload.lotSize) : null,
          lotSizeUnit: payload.lotSizeUnit ?? null,
          pointOfContactId: payload.pointOfContactId ?? null,
        },
      });

      await writeAudit(tx, AUDIT.PROPERTY.CREATED, currentUserId, {
        propertyId: created.id,
        clientId: created.clientId,
        displayName: created.displayName,
      });

      return created;
    });
  },

  async update(currentUserId: string, id: string, payload: PropertyUpsert) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.property.update({
        where: { id },
        data: {
          clientId: payload.clientId, // allow move between clients in MVP if you want; otherwise omit
          displayName: payload.displayName,
          kind: payload.kind,
          status: payload.status,
          street1: payload.street1,
          street2: payload.street2,
          city: payload.city,
          state: payload.state,
          postalCode: payload.postalCode,
          country: payload.country,
          accessNotes: payload.accessNotes,
          lotSize: "lotSize" in payload ? (payload.lotSize != null ? Number(payload.lotSize) : null) : undefined,
          lotSizeUnit: "lotSizeUnit" in payload ? (payload.lotSizeUnit ?? null) : undefined,
          pointOfContactId: payload.pointOfContactId ?? null,
        },
      });

      await writeAudit(tx, AUDIT.PROPERTY.UPDATED, currentUserId, {
        propertyId: id,
        clientId: updated.clientId,
        displayName: updated.displayName,
      });

      return updated;
    });
  },

  async archive(
    currentUserId: string,
    id: string,
    // Optional external cascadeGroupId — set when Client.archive fans
    // out to Properties so every row it touches shares a correlation
    // id. When called directly (Property archive button), we mint a
    // fresh one so the Jobs it cascades to are linked back to this
    // Property archive.
    opts?: { cascadeGroupId?: string; tx?: Prisma.TransactionClient },
  ) {
    const cascadeGroupId = opts?.cascadeGroupId ?? `cg_${randomBytes(9).toString("hex")}`;
    const run = async (tx: Prisma.TransactionClient) => {
      const property = await tx.property.findUnique({ where: { id } });
      if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);
      if (property.status === PropertyStatus.ARCHIVED) {
        // Idempotent — cascades pass over already-archived Properties.
        return { archived: true as const, jobsArchived: 0, cascadeGroupId };
      }
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ARCHIVED, archivedAt: new Date() },
      });
      // Cascade — archive every non-archived Job on this Property in
      // the same transaction. Idempotent per Job (skips already-
      // archived rows). Each row gets its own audit event tagged with
      // the shared cascadeGroupId.
      const jobs = await tx.job.findMany({
        where: { propertyId: id, status: { not: JobStatus.ARCHIVED } },
        select: { id: true },
      });
      let jobsArchived = 0;
      for (const j of jobs) {
        await tx.job.update({
          where: { id: j.id },
          data: { status: JobStatus.ARCHIVED },
        });
        // Archive side effects — delete future SCHEDULED STANDARD
        // occurrences (parity with pause) so no worker gets dispatched
        // to an archived property.
        await applyJobPauseSideEffectsInTx(
          tx,
          currentUserId,
          j.id,
          { cascadeGroupId, triggeredBy: "property_archive", propertyId: id },
          "ARCHIVED_REMOVED_FUTURE_OCCURRENCES",
        );
        await writeAudit(tx, AUDIT.JOB.ARCHIVED, currentUserId, {
          jobId: j.id,
          cascadeGroupId,
          triggeredBy: "property_archive",
          propertyId: id,
        });
        jobsArchived++;
      }
      await writeAudit(tx, AUDIT.PROPERTY.ARCHIVED, currentUserId, {
        propertyId: id,
        cascadeGroupId,
        jobsArchived,
      });
      return { archived: true as const, jobsArchived, cascadeGroupId };
    };
    return opts?.tx ? run(opts.tx) : prisma.$transaction(run);
  },

  async unarchive(
    currentUserId: string,
    id: string,
    opts?: { cascadeGroupId?: string; tx?: Prisma.TransactionClient },
  ) {
    const cascadeGroupId = opts?.cascadeGroupId ?? `cg_${randomBytes(9).toString("hex")}`;
    const run = async (tx: Prisma.TransactionClient) => {
      const property = await tx.property.findUnique({ where: { id } });
      if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);
      if (property.status !== PropertyStatus.ARCHIVED) {
        return { unarchived: true as const, jobsUnarchived: 0, cascadeGroupId };
      }
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ACTIVE, archivedAt: null },
      });
      // Symmetric cascade — return any Jobs that were archived in this
      // cascade (or independently) back to ACCEPTED. Idempotent per Job.
      const jobs = await tx.job.findMany({
        where: { propertyId: id, status: JobStatus.ARCHIVED },
        select: { id: true },
      });
      let jobsUnarchived = 0;
      for (const j of jobs) {
        await tx.job.update({
          where: { id: j.id },
          data: { status: JobStatus.ACCEPTED },
        });
        // Unarchive side effects — rebuild recurring chain (one fresh
        // SCHEDULED occurrence) so the operator doesn't have to force
        // it manually. Parity with unpause.
        await applyJobResumeSideEffectsInTx(
          tx,
          currentUserId,
          j.id,
          { cascadeGroupId, triggeredBy: "property_unarchive", propertyId: id },
          "UNARCHIVED_REGENERATED_NEXT_OCCURRENCE",
        );
        await writeAudit(tx, AUDIT.JOB.UNARCHIVED, currentUserId, {
          jobId: j.id,
          cascadeGroupId,
          triggeredBy: "property_unarchive",
          propertyId: id,
        });
        jobsUnarchived++;
      }
      await writeAudit(tx, AUDIT.PROPERTY.UNARCHIVED, currentUserId, {
        propertyId: id,
        cascadeGroupId,
        jobsUnarchived,
      });
      return { unarchived: true as const, jobsUnarchived, cascadeGroupId };
    };
    return opts?.tx ? run(opts.tx) : prisma.$transaction(run);
  },

  async hardDelete(currentUserId: string, id: string) {
    const jobCount = await prisma.job.count({ where: { propertyId: id } });
    if (jobCount > 0) {
      throw new ServiceError(
        "HAS_DEPENDENCIES",
        `Cannot delete this property because it has ${jobCount} associated ${jobCount === 1 ? "job" : "jobs"}. Please delete the ${jobCount === 1 ? "job" : "jobs"} first.`,
        409
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.property.delete({ where: { id } });
      await writeAudit(tx, AUDIT.PROPERTY.DELETED, currentUserId, {
        propertyId: id,
      });
    });
    return { deleted: true as const };
  },

  async setPrimaryContact(
    currentUserId: string,
    id: string,
    contactId: string | null
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id },
        data: { pointOfContactId: contactId },
      });
      await writeAudit(tx, AUDIT.PROPERTY.PRIMARY_CONTACT_SET, currentUserId, {
        propertyId: id,
        contactId,
      });
    });
    return { primarySet: true as const };
  },
};
