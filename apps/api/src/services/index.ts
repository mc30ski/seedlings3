import { prisma } from "../db/prisma";
import type { Services, EquipmentWithHolder } from "../types/services";
import { Role, AdminActivityEvent, AdminActivityUser } from "../types/services";
import {
  Prisma,
  PrismaClient,
  Role as RoleVal,
  EquipmentStatus,
  AuditScope,
  AuditVerb,
  ClientStatus,
  ContactRole,
} from "@prisma/client";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { ServiceError } from "../lib/errors";
import { AUDIT, toActionString, AuditTuple } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY for server-side Clerk client");
}
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Prisma.TransactionClient;

// ---- helpers ---------------------------------------------------------------

const now = () => new Date();

function parseBootstrapList() {
  return (process.env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Row-level lock helper
async function lockEquipment(tx: Tx, id: string) {
  await tx.$queryRawUnsafe(
    `SELECT id FROM "Equipment" WHERE id = $1 FOR UPDATE`,
    id
  );
}

// Return the single active reservation/checkout row (releasedAt is NULL)
async function getActiveCheckout(tx: Tx, equipmentId: string) {
  return tx.checkout.findFirst({
    where: { equipmentId, releasedAt: null },
  });
}

// True if any active reservation/checkout exists
async function hasActiveCheckout(tx: Tx, equipmentId: string) {
  const c = await tx.checkout.count({
    where: { equipmentId, releasedAt: null },
  });
  return c > 0;
}

// Recompute derived status...
async function recomputeStatus(tx: Tx, equipmentId: string) {
  const eq = await tx.equipment.findUnique({ where: { id: equipmentId } });
  if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

  if (eq.status === EquipmentStatus.RETIRED || eq.retiredAt) return eq;
  if (eq.status === EquipmentStatus.MAINTENANCE) return eq;

  const active = await getActiveCheckout(tx, equipmentId);
  if (active) {
    const target = active.checkedOutAt
      ? EquipmentStatus.CHECKED_OUT
      : EquipmentStatus.RESERVED;
    if (eq.status !== target) {
      return tx.equipment.update({
        where: { id: equipmentId },
        data: { status: target },
      });
    }
    return eq;
  }

  if (eq.status !== EquipmentStatus.AVAILABLE) {
    return tx.equipment.update({
      where: { id: equipmentId },
      data: { status: EquipmentStatus.AVAILABLE },
    });
  }
  return eq;
}

function normalizePhone(raw?: string | null): string | null {
  const s = (raw ?? "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  return "+1" + s;
}

/**
 * Accept either { firstName,lastName } or a single { name } and split it.
 */
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

// ---------- CLIENTS ----------------------------------------------------------
const clients = {
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
        contacts: {
          //where: { active: true },
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            normalizedPhone: true,
            isPrimary: true,
            active: true,
          },
        },
      },
    });

    return rows.map((c) => ({
      ...c,
      contactCount: c.contacts.length,
      primaryContact:
        c.contacts.find((x) => x.isPrimary) ?? c.contacts[0] ?? null,
    }));
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

  async create(actorId: string, payload: any) {
    return prisma.$transaction(async (tx) => {
      const data = {
        type: payload.type,
        displayName: payload.displayName,
        status: payload.status ?? "ACTIVE",
        notesInternal: payload.notesInternal,
      };
      const created = await tx.client.create({
        data: data,
      });
      await writeAudit(tx, AUDIT.CLIENT.CREATED, actorId, {
        clientRecord: { ...created },
      });
      return created;
    });
  },

  async update(actorId: string, id: string, payload: any) {
    return prisma.$transaction(async (tx) => {
      const data = {
        type: payload.type,
        displayName: payload.displayName,
        status: payload.status,
        notesInternal: payload.notesInternal,
      };
      const updated = await tx.client.update({
        where: { id },
        data: data,
      });
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, actorId, {
        clientRecord: { ...updated },
      });
      return updated;
    });
  },

  async hardDelete(actorId: string, id: string) {
    await prisma.$transaction(async (tx) => {
      await tx.client.delete({ where: { id } });
      await writeAudit(tx, AUDIT.CLIENT.DELETED, actorId, { id: id });
    });
    return { deleted: true as const };
  },

  async addContact(actorId: string, clientId: string, payload: any) {
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
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_CREATED, actorId, {
        contactRecord: { ...contact },
      });
      return contact;
    });
  },

  async updateContact(
    actorId: string,
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
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_UPDATED, actorId, {
        clientId,
        contactId,
        contactRecord: { ...updated },
      });

      return updated;
    });
  },

  async deleteContact(actorId: string, clientId: string, contactId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.clientContact.delete({ where: { id: contactId } });
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_DELETED, actorId, {
        clientId,
        contactId,
      });
    });
    return { deleted: true as const };
  },

  async setPrimaryContact(
    actorId: string,
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
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, actorId, {
        clientId,
        contactId,
        primary: true,
      });
    });
    return { primarySet: true as const };
  },
};

export const services: Services = {
  equipment: {
    async listAvailable() {
      return prisma.equipment.findMany({
        where: {
          status: EquipmentStatus.AVAILABLE,
          checkouts: { none: { releasedAt: null } },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    async listAllAdmin() {
      const rows = await prisma.equipment.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          checkouts: {
            where: { releasedAt: null },
            include: { user: true },
            take: 1,
          },
        },
      });

      const mapped: EquipmentWithHolder[] = rows.map((e) => {
        const active = e.checkouts[0];
        const holder = active
          ? {
              userId: active.userId,
              displayName: active.user?.displayName ?? null,
              email: active.user?.email ?? null,
              reservedAt: active.reservedAt,
              checkedOutAt: active.checkedOutAt ?? null,
              state: active.checkedOutAt
                ? EquipmentStatus.CHECKED_OUT
                : EquipmentStatus.RESERVED,
            }
          : null;

        const { checkouts, auditEvents, ...equip } = e as any;
        return { ...(equip as any), holder };
      });

      return mapped;
    },

    async listForWorkers() {
      return prisma.equipment.findMany({
        where: { status: { in: [EquipmentStatus.AVAILABLE] } },
        orderBy: { createdAt: "desc" },
      });
    },

    async listMine(userId: string) {
      return prisma.equipment
        .findMany({
          where: { status: { not: EquipmentStatus.RETIRED } },
          orderBy: { createdAt: "desc" },
          include: {
            checkouts: { where: { userId, releasedAt: null }, take: 1 },
          },
        })
        .then((rows) =>
          rows
            .filter((r) => r.checkouts.length > 0)
            .map((r) => {
              const { checkouts, ...rest } = r as any;
              return rest as typeof r;
            })
        );
    },

    // Items workers cannot reserve RESERVED/CHECKED_OUT/MAINTENANCE/RETIRED
    async listUnavailableForWorkers() {
      return prisma.equipment.findMany({
        where: {
          status: {
            in: [
              EquipmentStatus.RESERVED,
              EquipmentStatus.CHECKED_OUT,
              EquipmentStatus.MAINTENANCE,
              EquipmentStatus.RETIRED,
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    async create(clerkUserId, input) {
      return prisma.$transaction(async (tx) => {
        const data: Prisma.EquipmentCreateInput = {
          shortDesc: input.shortDesc,
          longDesc: input.longDesc ?? "",
          ...(input.qrSlug !== undefined ? { qrSlug: input.qrSlug } : {}),
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.energy !== undefined ? { energy: input.energy } : {}),
          ...(input.features !== undefined ? { features: input.features } : {}),
          ...(input.condition !== undefined
            ? { condition: input.condition }
            : {}),
          ...(input.issues !== undefined ? { issues: input.issues } : {}),
          ...(input.age !== undefined ? { age: input.age } : {}),
        };

        const created = await tx.equipment.create({ data });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.CREATED,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { id: created.id, ...input } }
        );

        return created;
      });
    },

    async update(clerkUserId, id, patch) {
      return prisma.$transaction(async (tx) => {
        const before = await tx.equipment.findUnique({ where: { id } });
        if (!before)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

        const data: Prisma.EquipmentUpdateInput = {};
        if (patch.shortDesc !== undefined) data.shortDesc = patch.shortDesc;
        if (patch.longDesc !== undefined) data.longDesc = patch.longDesc;
        if (patch.qrSlug !== undefined) data.qrSlug = patch.qrSlug;
        if (patch.brand !== undefined) data.brand = patch.brand;
        if (patch.model !== undefined) data.model = patch.model;
        if (patch.type !== undefined) data.type = patch.type;
        if (patch.energy !== undefined) data.energy = patch.energy;
        if (patch.features !== undefined) data.features = patch.features;
        if (patch.condition !== undefined) data.condition = patch.condition;
        if (patch.issues !== undefined) data.issues = patch.issues;
        if (patch.age !== undefined) data.age = patch.age;

        const updated = await tx.equipment.update({ where: { id }, data });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.UPDATED,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { ...updated } }
        );

        return updated;
      });
    },

    async retire(clerkUserId, id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === EquipmentStatus.RETIRED) return eq;

        if (
          eq.status === EquipmentStatus.CHECKED_OUT ||
          eq.status === EquipmentStatus.RESERVED
        ) {
          throw new ServiceError(
            "CANNOT_RETIRE_WHILE_IN_USE",
            "Cannot retire equipment while reserved/checked out",
            409
          );
        }
        if (await hasActiveCheckout(tx, id)) {
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active reservation/checkout",
            409
          );
        }

        const updated = await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.RETIRED, retiredAt: now() },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.RETIRED,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { ...updated } }
        );

        return updated;
      });
    },

    async unretire(clerkUserId, id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

        if (eq.status !== EquipmentStatus.RETIRED) {
          return recomputeStatus(tx, id);
        }

        const updated = await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE, retiredAt: null },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.UNRETIRED,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { ...updated } }
        );

        return recomputeStatus(tx, id);
      });
    },

    async hardDelete(clerkUserId, id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status !== EquipmentStatus.RETIRED)
          throw new ServiceError(
            "NOT_RETIRED",
            "Only retired equipment can be deleted",
            409
          );

        if (await hasActiveCheckout(tx, id))
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active reservation/checkout",
            409
          );

        await tx.checkout.deleteMany({ where: { equipmentId: id } });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.DELETED,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { ...eq } }
        );

        await tx.equipment.delete({ where: { id } });
        return { deleted: true };
      });
    },

    async release(clerkUserId, id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await getActiveCheckout(tx, id);
        if (active) {
          const checkout = await tx.checkout.update({
            where: { id: active.id },
            data: { releasedAt: now() },
          });
          const updated = await tx.equipment.update({
            where: { id },
            data: { status: EquipmentStatus.AVAILABLE },
          });

          await writeAudit(
            tx,
            AUDIT.EQUIPMENT.FORCE_RELEASED,
            (await services.currentUser.me(clerkUserId)).id,
            { equipmentRecord: updated, checkoutRecord: checkout }
          );
        }
        return { released: true };
      });
    },

    async reserve(clerkUserId, id, userId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.retiredAt)
          throw new ServiceError("RETIRED", "Equipment retired", 409);
        if (eq.status !== EquipmentStatus.AVAILABLE)
          throw new ServiceError(
            "NOT_AVAILABLE",
            "Equipment not available",
            409
          );

        if (await hasActiveCheckout(tx, id))
          throw new ServiceError(
            "ALREADY_IN_USE",
            "Equipment already reserved/checked out",
            409
          );

        const reserve = await tx.checkout.create({
          data: { equipmentId: id, userId },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.RESERVED },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.RESERVED,
          (await services.currentUser.me(clerkUserId)).id,
          {
            equipmentRecord: { ...eq },
            checkoutRecord: { ...reserve },
          }
        );

        return { id, userId };
      });
    },

    async cancelReservation(clerkUserId, id, userId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await getActiveCheckout(tx, id);
        if (!active || active.checkedOutAt)
          throw new ServiceError(
            "NO_ACTIVE_RESERVATION",
            "No active reservation to cancel",
            409
          );
        if (active.userId !== userId)
          throw new ServiceError("NOT_OWNER", "Not your reservation", 403);

        const unreserved = await tx.checkout.update({
          where: { id: active.id },
          data: { releasedAt: now() },
        });
        const eq = await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.RESERVATION_CANCELLED,
          (await services.currentUser.me(clerkUserId)).id,
          {
            equipmentRecord: { ...eq },
            checkoutRecord: { ...unreserved },
          }
        );

        return { cancelled: true };
      });
    },

    async listUnavailableWithHolder() {
      const rows = await prisma.equipment.findMany({
        where: {
          status: {
            in: [
              EquipmentStatus.MAINTENANCE,
              EquipmentStatus.RESERVED,
              EquipmentStatus.CHECKED_OUT,
              EquipmentStatus.RETIRED,
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        include: {
          checkouts: {
            where: { releasedAt: null },
            include: { user: true },
            take: 1,
          },
        },
      });

      const mapped: EquipmentWithHolder[] = rows.map((e) => {
        const active = e.checkouts[0];
        const holder = active
          ? {
              userId: active.userId,
              displayName: active.user?.displayName ?? null,
              email: active.user?.email ?? null,
              reservedAt: active.reservedAt,
              checkedOutAt: active.checkedOutAt ?? null,
              state: active.checkedOutAt
                ? EquipmentStatus.CHECKED_OUT
                : EquipmentStatus.RESERVED,
            }
          : null;

        // strip relation arrays to satisfy Equipment shape
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { checkouts, auditEvents, ...equip } = e as any;
        return { ...(equip as any), holder };
      });

      return mapped;
    },

    async checkoutWithQr(clerkUserId, id, userId, slug) {
      if (!slug)
        throw new ServiceError("INVALID_INPUT", "Missing QR code", 400);

      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);

        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (!eq.qrSlug)
          throw new ServiceError(
            "NO_QR",
            "This equipment doesn't have a QR code",
            409
          );
        if (eq.qrSlug.trim().toLowerCase() !== slug.trim().toLowerCase())
          throw new ServiceError(
            "QR_MISMATCH",
            "QR code doesn't match this equipment",
            403
          );

        // Find this user's active (unreleased) reservation for the item
        const active = await tx.checkout.findFirst({
          where: { equipmentId: id, userId, releasedAt: null },
          orderBy: { reservedAt: "desc" },
        });
        if (!active || active.checkedOutAt)
          throw new ServiceError(
            "NOT_ALLOWED",
            "Reservation not owned or already checked out",
            403
          );

        const checkout = await tx.checkout.update({
          where: { id: active.id },
          data: { checkedOutAt: new Date() },
        });
        const updated = await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.CHECKED_OUT },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.CHECKED_OUT,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { ...updated }, checkoutRecord: { ...checkout } }
        );

        return { id, userId };
      });
    },

    async returnWithQr(clerkUserId, id, userId, slug) {
      if (!slug)
        throw new ServiceError("INVALID_INPUT", "Missing QR code", 400);

      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);

        // 1) Verify item + QR
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (!eq.qrSlug)
          throw new ServiceError(
            "NO_QR",
            "This item doesn't have a QR code",
            409
          );
        if (eq.qrSlug.trim().toLowerCase() !== slug.trim().toLowerCase())
          throw new ServiceError(
            "QR_MISMATCH",
            "QR code doesn't match this item",
            403
          );

        // 2) Find the active checkout for this user & item
        const active = await tx.checkout.findFirst({
          where: {
            equipmentId: id,
            userId,
            releasedAt: null,
            checkedOutAt: { not: null },
          },
          orderBy: { checkedOutAt: "desc" },
        });
        if (!active) {
          throw new ServiceError(
            "NOT_ALLOWED",
            "No active checkout for this user",
            403
          );
        }

        // 3) Mark returned
        const now = new Date();
        const returned = await tx.checkout.update({
          where: { id: active.id },
          data: { releasedAt: now },
        });

        // 4) Flip equipment status back to AVAILABLE (adjust if your app uses a different state machine)
        const updated = await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.RETURNED,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: { ...updated }, checkoutRecord: { ...returned } }
        );

        return { released: true };
      });
    },
  },

  maintenance: {
    async start(clerkUserId, id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({
          where: { id: id },
        });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === EquipmentStatus.RETIRED)
          throw new ServiceError("RETIRED", "Equipment retired", 409);

        if (await hasActiveCheckout(tx, id))
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active reservation/checkout",
            409
          );

        const updated = await tx.equipment.update({
          where: { id: id },
          data: { status: EquipmentStatus.MAINTENANCE },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.MAINTENANCE_START,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: updated }
        );

        return updated;
      });
    },

    async end(clerkUserId, id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const updated = await tx.equipment.update({
          where: { id: id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        await writeAudit(
          tx,
          AUDIT.EQUIPMENT.MAINTENANCE_END,
          (await services.currentUser.me(clerkUserId)).id,
          { equipmentRecord: updated }
        );

        return recomputeStatus(tx, id);
      });
    },
  },

  users: {
    async list(params) {
      const where: any = {};
      if (params?.approved !== undefined) where.isApproved = params.approved;
      if (params?.role) where.roles = { some: { role: params.role as any } };
      return prisma.user.findMany({ where, include: { roles: true } });
    },

    async listHoldings() {
      const rows = await prisma.checkout.findMany({
        where: { releasedAt: null },
        include: {
          equipment: {
            select: {
              id: true,
              shortDesc: true,
              qrSlug: true,
              brand: true,
              model: true,
              type: true,
              energy: true,
              features: true,
              condition: true,
              issues: true,
              age: true,
            },
          },
        },
        orderBy: { reservedAt: "desc" },
      });

      return rows.map((r) => ({
        userId: r.userId,
        equipmentId: r.equipmentId,
        shortDesc: r.equipment?.shortDesc ?? "",
        qrSlug: r.equipment?.qrSlug ?? "",
        brand: r.equipment?.brand ?? null,
        model: r.equipment?.model ?? null,
        type: r.equipment?.type ?? null,
        energy: r.equipment?.energy ?? null,
        features: r.equipment?.features ?? null,
        condition: r.equipment?.condition ?? null,
        issues: r.equipment?.issues ?? null,
        age: r.equipment?.age ?? null,
        state: r.checkedOutAt
          ? ("CHECKED_OUT" as const)
          : ("RESERVED" as const),
        reservedAt: r.reservedAt,
        checkedOutAt: r.checkedOutAt ?? null,
      }));
    },

    async approve(clerkUserId, userId) {
      return prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data: { isApproved: true },
        });

        await writeAudit(
          tx,
          AUDIT.USER.APPROVED,
          (await services.currentUser.me(clerkUserId)).id,
          { userRecord: { ...updated } }
        );

        return updated;
      });
    },

    async addRole(clerkUserId, userId, role) {
      return prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) {
          throw new ServiceError("NOT_FOUND", "User not found", 404);
        }

        const roleRow = await tx.userRole.create({
          data: { userId, role: role as any },
        });

        await writeAudit(
          tx,
          AUDIT.USER.ROLE_ASSIGNED,
          (await services.currentUser.me(clerkUserId)).id,
          { userRecord: { ...user }, roleRecord: { ...roleRow } }
        );

        return roleRow;
      });
    },

    async removeRole(clerkUserId, userId, role) {
      if (role === "WORKER") {
        const active = await prisma.checkout.count({
          where: { userId, releasedAt: null },
        });
        if (active > 0) {
          throw new ServiceError(
            "USER_HAS_ACTIVE_EQUIPMENT",
            "Cannot remove Worker role while the user has reserved/checked-out equipment.",
            409
          );
        }
      }

      return prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) {
          throw new ServiceError("NOT_FOUND", "User not found", 404);
        }

        const toDelete = await tx.userRole.findFirst({
          where: { userId, role: role as any },
        });
        if (!toDelete) return { deleted: false };

        const roleRecord = await tx.userRole.delete({
          where: { id: toDelete.id },
        });

        await writeAudit(
          tx,
          AUDIT.USER.ROLE_REMOVED,
          (await services.currentUser.me(clerkUserId)).id,
          { userRecord: { ...user }, roleRecord: { ...roleRecord } }
        );

        return { deleted: true };
      });
    },

    async remove(clerkUserId, userId, actorUserId) {
      if (!actorUserId) {
        throw new ServiceError("UNAUTHORIZED", "Missing actor", 401);
      }
      if (actorUserId === userId) {
        throw new ServiceError(
          "CANNOT_DELETE_SELF",
          "You cannot delete your own account",
          400
        );
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { roles: true },
      });
      if (!user) {
        throw new ServiceError("NOT_FOUND", "User not found", 404);
      }

      return prisma.$transaction(async (tx) => {
        const isAdmin = user.roles.some((r) => r.role === "ADMIN");
        if (isAdmin) {
          const otherAdmins = await tx.userRole.count({
            where: { role: "ADMIN", userId: { not: userId } },
          });
          if (otherAdmins === 0) {
            throw new ServiceError(
              "LAST_ADMIN",
              "Cannot delete the last remaining admin",
              409
            );
          }
        }

        let clerkDeleted = false;
        if (user.clerkUserId) {
          try {
            await clerk.users.deleteUser(user.clerkUserId);
            clerkDeleted = true;
          } catch (e: any) {
            clerkDeleted =
              typeof e?.status === "number" ? e.status === 404 : false;
          }
        }

        const userDelete = await tx.user.delete({ where: { id: userId } });

        await writeAudit(
          tx,
          AUDIT.USER.DELETED,
          (await services.currentUser.me(clerkUserId)).id,
          { userRecord: { ...userDelete } }
        );

        return { deleted: true as const, clerkDeleted };
      });
    },

    async pendingApprovalCount(): Promise<{ pending: number }> {
      const count = await prisma.user.count({ where: { isApproved: false } });
      return { pending: count };
    },

    // Implements a GET /me endpoint that authenticates with Clerk (via header or cookie),
    // ensures there’s a matching user in your Prisma DB, optionally bootstraps ADMIN/WORKER roles based on an env list,
    // then returns a normalized “me” object.
    async me(token: string) {
      // Verify token with Clerk
      let clerkUserId: string;
      try {
        const payload = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY,
        });
        clerkUserId = String((payload as any).sub);
        if (!clerkUserId) throw new Error("Missing sub in token");
      } catch (err) {
        throw new ServiceError("UNAUTHORIZED", "Invalid token", 401);
      }

      // Fetch Clerk profile (for email/displayName + bootstrap check)
      let fetchedEmail: string | undefined;
      let fetchedDisplayName: string | undefined;
      try {
        if (clerk) {
          const u = await clerk.users.getUser(clerkUserId);
          fetchedEmail =
            u.primaryEmailAddress?.emailAddress ??
            u.emailAddresses?.[0]?.emailAddress ??
            undefined;
          const name = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(" ")
            .trim();
          fetchedDisplayName = (name || u.username || undefined) ?? undefined;
        }
      } catch (e) {
        console.warn(
          { clerkUserId, error: (e as Error).message },
          "[/me] Clerk profile fetch failed (continuing)"
        );
      }

      // Ensure local DB user exists (create if missing)
      let user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });

      if (!user) {
        user = await prisma.user.create({
          data: {
            clerkUserId,
            email: fetchedEmail,
            displayName: fetchedDisplayName,
            isApproved: false,
          },
          include: { roles: true },
        });
      } else if (
        (!user.email || !user.displayName) &&
        (fetchedEmail || fetchedDisplayName)
      ) {
        user = await prisma.user.update({
          where: { clerkUserId },
          data: {
            email: user.email ?? fetchedEmail,
            displayName: user.displayName ?? fetchedDisplayName,
          },
          include: { roles: true },
        });
      }

      // Bootstrap admins via ADMIN_BOOTSTRAP_EMAILS (idempotent)
      const bootstrapEmails = parseBootstrapList();
      const normalizedEmail = (user.email ?? fetchedEmail ?? "").toLowerCase();
      const shouldBootstrap =
        normalizedEmail && bootstrapEmails.includes(normalizedEmail);

      if (shouldBootstrap) {
        await prisma.$transaction(async (tx) => {
          if (!user!.isApproved) {
            await tx.user.update({
              where: { id: user!.id },
              data: { isApproved: true },
            });
          }
          await tx.userRole.upsert({
            where: { userId_role: { userId: user!.id, role: RoleVal.WORKER } },
            update: {},
            create: { userId: user!.id, role: RoleVal.WORKER },
          });
          await tx.userRole.upsert({
            where: { userId_role: { userId: user!.id, role: RoleVal.ADMIN } },
            update: {},
            create: { userId: user!.id, role: RoleVal.ADMIN },
          });
        });
        user = await prisma.user.findUnique({
          where: { clerkUserId },
          include: { roles: true },
        });
      }

      // Respond
      const me = {
        id: user!.id,
        isApproved: !!user!.isApproved,
        roles: (user!.roles ?? []).map((r) => r.role) as Role[],
        email: user!.email ?? null,
        displayName: user!.displayName ?? null,
      };

      return me;
    },
  },

  currentUser: {
    // The “current user” (aka "me") service.
    // Given a Clerk user ID, it loads or lazily creates a matching User row in your DB (with isApproved: false by default),
    // pulls email/display name from Clerk on first sight, and returns a normalized shape with the user’s roles.
    // Note: Not a route, used by the 'rbac.ts' Fastify plugin.
    async me(clerkUserId: string) {
      if (!clerkUserId) {
        return {
          id: "",
          isApproved: false,
          roles: [] as Role[],
          email: undefined,
          displayName: undefined,
        };
      }

      let user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });

      if (!user) {
        let email: string | null = null;
        let displayName: string | null = null;

        try {
          const u = await clerk.users.getUser(clerkUserId);
          email =
            u.primaryEmailAddress?.emailAddress ??
            u.emailAddresses?.[0]?.emailAddress ??
            null;

          const name = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(" ")
            .trim();
          displayName = name || u.username || null;
        } catch {}

        await prisma.user.create({
          data: {
            clerkUserId,
            email: email ?? undefined,
            displayName: displayName ?? undefined,
            isApproved: false,
          },
        });

        user = await prisma.user.findUnique({
          where: { clerkUserId },
          include: { roles: true },
        });
      }

      return {
        id: user!.id,
        isApproved: !!user!.isApproved,
        roles: (user!.roles ?? []).map((r) => r.role) as Role[],
        email: user!.email ?? undefined,
        displayName: user!.displayName ?? undefined,
      };
    },
  },

  audit: {
    async list(params) {
      const where: any = {};
      if (params.actorUserId) where.actorUserId = params.actorUserId;
      if (params.action) where.action = params.action;
      if (params.from || params.to) {
        where.createdAt = {
          gte: params.from ? new Date(params.from) : undefined,
          lte: params.to ? new Date(params.to) : undefined,
        };
      }
      const page = params.page ?? 1;
      const pageSize = params.pageSize ?? 50;
      const [items, total] = await Promise.all([
        prisma.auditEvent.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.auditEvent.count({ where }),
      ]);
      return { items, total };
    },
  },

  admin: {
    async listUserActivity() {
      const results: AdminActivityUser[] = [];

      const usersById = await prisma.user.findMany({
        where: {
          isApproved: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      for (const user of usersById) {
        const userEvents = await prisma.auditEvent.findMany({
          where: {
            actorUserId: user.id,
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "desc" },
        });

        const latest =
          userEvents.length === 0
            ? null
            : new Date(
                Math.max(...userEvents.map((e) => e.createdAt.getTime()))
              );

        function convert([scope, verb]: AuditTuple, json: any) {
          const out: any = {};
          // Special case because there is no role record yet for an approved user.
          if (scope === AuditScope.USER && verb === AuditVerb.APPROVED) {
            out.role = "APPROVED";
          }
          if (json.roleRecord) {
            out.role = json.roleRecord.role;
          }
          if (json.userRecord) {
            out.email = json.userRecord.email;
          }
          if (json.equipmentRecord) {
            out.qrSlug = json.equipmentRecord.qrSlug;
            out.type = json.equipmentRecord.type;
            out.equipmentName = json.equipmentRecord.shortDesc;
            out.brand = json.equipmentRecord.brand;
            out.model = json.equipmentRecord.model;
          }
          return out;
        }

        const output: AdminActivityEvent[] = userEvents.map((e) => ({
          id: e.id,
          at: e.createdAt,
          type: toActionString([e.scope, e.verb]),
          details: convert([e.scope, e.verb], e.metadata),
        }));

        results.push({
          userId: user.id,
          displayName: user.displayName || undefined,
          email: user.email || undefined,
          lastActivityAt: latest,
          count: userEvents.length,
          events: output,
        });
      }

      return results;
    },
  },

  clients,
};
