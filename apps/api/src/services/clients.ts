import { prisma } from "../db/prisma";
import { Prisma, ClientStatus, ContactRole } from "@prisma/client";
import type { ServicesClients } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { action } from "../lib/services";

function normalizePhone(raw?: string | null): string | null {
  const s = (raw ?? "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  return "+1" + s;
}

// Accept either { firstName,lastName } or a single { name } and split it.
function normalizeContactPayload(payload: any): {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  role: ContactRole | null;
  isPrimary: boolean;
  active: boolean;
} {
  let first = (payload.firstName ?? "").trim();
  let last = (payload.lastName ?? "").trim();

  if (!first && !last && payload.name) {
    const n = String(payload.name).trim();
    const parts = n.split(/\s+/);
    first = (parts.shift() ?? "").trim();
    last = (parts.join(" ") ?? "").trim();
  }

  const phone = payload.phone ?? null;
  const normalizedPhone = normalizePhone(phone);

  // role → enum or null
  let role: ContactRole | null = null;
  if (payload.role) {
    const r = String(payload.role);
    const key = r in ContactRole ? r : r.toUpperCase();
    if (key in ContactRole) role = (ContactRole as any)[key] as ContactRole;
  }

  return {
    firstName: first,
    lastName: last,
    email: payload.email ?? null,
    phone,
    normalizedPhone,
    role,
    isPrimary: !!payload.isPrimary,
    active: payload.active ?? true,
  };
}

export const clients: ServicesClients = {
  async list(params?: {
    q?: string;
    status?: ClientStatus | "ALL";
    limit?: number;
  }) {
    const q = (params?.q ?? "").trim();
    const status =
      params?.status && params.status !== "ALL" ? params.status : undefined;
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);

    const where: Prisma.ClientWhereInput = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { displayName: { contains: q, mode: "insensitive" } },
        {
          contacts: {
            some: {
              OR: [
                { firstName: { contains: q, mode: "insensitive" } },
                { lastName: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
                { phone: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        },
      ];
    }

    const rows = await prisma.client.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        _count: { select: { contacts: true, properties: true } },

        // full contacts list; UI can filter inactive
        contacts: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
            email: true,
            phone: true,
            normalizedPhone: true,
            isPrimary: true,
            active: true,
          },
          orderBy: [
            { isPrimary: "desc" }, // primary first
            { active: "desc" }, // then active
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        },

        // lightweight properties preview (cap the list)
        properties: {
          select: {
            id: true,
            displayName: true,
            street1: true,
            street2: true,
            city: true,
            state: true,
            postalCode: true,
            country: true,
            status: true,
          },
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
          take: 3,
        },
      },
    });

    return rows.map((c) => {
      const { _count, ...client } = c;
      const primaryContact =
        c.contacts.find((ct) => ct.isPrimary) ??
        c.contacts.find((ct) => ct.active) ??
        c.contacts[0] ??
        null;

      return {
        ...client,

        // explicit additions for the UI
        contacts: c.contacts,
        properties: c.properties,

        contactCount: _count.contacts,
        propertyCount: _count.properties,
        primaryContact,
      };
    });
  },

  async get(id: string) {
    return prisma.client.findUniqueOrThrow({
      where: { id },
      include: {
        contacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
      },
    });
  },

  async create(currentUserId: string, payload: any) {
    return prisma.$transaction(async (tx) => {
      const data = {
        type: payload.type,
        displayName: payload.displayName,
        status: payload.status ?? "ACTIVE",
        notesInternal: payload.notesInternal,
      };
      const record = await tx.client.create({
        data: data,
      });
      await writeAudit(tx, AUDIT.CLIENT.CREATED, currentUserId, {
        id: record.id,
        record: record,
      });
      return record;
    });
  },

  async update(currentUserId: string, id: string, payload: any) {
    return prisma.$transaction(async (tx) => {
      const data = {
        type: payload.type,
        displayName: payload.displayName,
        status: payload.status,
        notesInternal: payload.notesInternal,
      };
      const record = await tx.client.update({
        where: { id },
        data: data,
      });
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, currentUserId, {
        id: id,
        record: record,
      });
      return record;
    });
  },

  async pause(currentUserId: string, id: string) {
    return action<ClientStatus>(
      currentUserId,
      id,
      "client",
      ClientStatus.PAUSED,
      AUDIT.CLIENT.PAUSED
    );
  },

  async unpause(currentUserId: string, id: string) {
    return action<ClientStatus>(
      currentUserId,
      id,
      "client",
      ClientStatus.ACTIVE,
      AUDIT.CLIENT.UNPAUSED
    );
  },

  async archive(currentUserId: string, id: string) {
    return action<ClientStatus>(
      currentUserId,
      id,
      "client",
      ClientStatus.ARCHIVED,
      AUDIT.CLIENT.ARCHIVED
    );
  },

  async unarchive(currentUserId: string, id: string) {
    return action<ClientStatus>(
      currentUserId,
      id,
      "client",
      ClientStatus.ACTIVE,
      AUDIT.CLIENT.UNARCHIVED
    );
  },

  async delete(currentUserId: string, id: string) {
    await prisma.$transaction(async (tx) => {
      await tx.client.delete({ where: { id } });
      await writeAudit(tx, AUDIT.CLIENT.DELETED, currentUserId, { id: id });
    });
    return { deleted: true as const };
  },

  async addContact(currentUserId: string, clientId: string, payload: any) {
    const cp = normalizeContactPayload(payload);
    const data = {
      clientId,
      firstName: cp.firstName,
      lastName: cp.lastName,
      email: cp.email,
      phone: cp.phone,
      normalizedPhone: cp.normalizedPhone,
      role: cp.role,
      isPrimary: cp.isPrimary,
      active: cp.active,
    };
    return prisma.$transaction(async (tx) => {
      const contact = await tx.clientContact.create({
        data: data,
      });
      if (cp.isPrimary) {
        const client = await tx.clientContact.updateMany({
          where: { clientId, NOT: { id: contact.id } },
          data: { isPrimary: false },
        });
      }
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_CREATED, currentUserId, {
        contactRecord: { ...contact },
      });
      return contact;
    });
  },

  async updateContact(
    currentUserId: string,
    clientId: string,
    contactId: string,
    payload: any
  ) {
    const cp = normalizeContactPayload(payload);
    const data = {
      firstName: cp.firstName,
      lastName: cp.lastName,
      email: cp.email,
      phone: cp.phone,
      normalizedPhone: cp.normalizedPhone,
      role: cp.role,
      isPrimary: cp.isPrimary,
      active: cp.active,
    };
    return prisma.$transaction(async (tx) => {
      const updated = await tx.clientContact.update({
        where: { id: contactId },
        data: data,
      });
      if (cp.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId, NOT: { id: contactId } },
          data: { isPrimary: false },
        });
      }
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_UPDATED, currentUserId, {
        clientId,
        contactId,
        contactRecord: { ...updated },
      });

      return updated;
    });
  },

  async deleteContact(
    currentUserId: string,
    clientId: string,
    contactId: string
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.clientContact.delete({ where: { id: contactId } });
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_DELETED, currentUserId, {
        clientId,
        contactId,
      });
    });
    return { deleted: true as const };
  },

  async setPrimaryContact(
    currentUserId: string,
    clientId: string,
    contactId: string
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.clientContact.updateMany({
        where: { clientId },
        data: { isPrimary: false },
      });
      await tx.clientContact.update({
        where: { id: contactId },
        data: { isPrimary: true },
      });
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, currentUserId, {
        clientId,
        contactId,
        primary: true,
      });
    });
    return { primarySet: true as const };
  },
};
