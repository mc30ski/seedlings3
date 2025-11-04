import { Prisma, PropertyStatus, PropertyKind } from "@prisma/client";
import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
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
        client: { select: { id: true, displayName: true } },
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

  async approve(currentUserId: string, id: string) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ACTIVE, updatedAt: new Date() },
      });
      await writeAudit(tx, AUDIT.PROPERTY.UPDATED, currentUserId, {
        propertyId: id,
      });
    });
    return { updated: true as const };
  },

  async archive(currentUserId: string, id: string) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ARCHIVED, archivedAt: new Date() },
      });
      await writeAudit(tx, AUDIT.PROPERTY.ARCHIVED, currentUserId, {
        propertyId: id,
      });
    });
    return { archived: true as const };
  },

  async unarchive(currentUserId: string, id: string) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ACTIVE, archivedAt: null },
      });
      await writeAudit(tx, AUDIT.PROPERTY.UNARCHIVED, currentUserId, {
        propertyId: id,
      });
    });
    return { unarchived: true as const };
  },

  async hardDelete(currentUserId: string, id: string) {
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
