import { prisma } from "../db/prisma";
import { Prisma, Equipment, EquipmentStatus } from "@prisma/client";
import type { ServicesEquipment, EquipmentWithHolder } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";

type Tx = Prisma.TransactionClient;

const now = () => new Date();

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
  if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);

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

export const equipment: ServicesEquipment = {
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

  async create(
    currentUserId: string,
    input: {
      shortDesc: string;
      longDesc?: string;
      brand?: string;
      model?: string;
      type?: string;
      energy?: string;
      features?: string;
      condition?: string;
      issues?: string;
      age?: string;
      qrSlug?: string | null;
    }
  ) {
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

      await writeAudit(tx, AUDIT.EQUIPMENT.CREATED, currentUserId, {
        equipmentRecord: { id: created.id, ...input },
      });

      return created;
    });
  },

  async update(
    currentUserId: string,
    id: string,
    patch: Partial<
      Pick<
        Equipment,
        | "shortDesc"
        | "longDesc"
        | "qrSlug"
        | "brand"
        | "model"
        | "type"
        | "energy"
        | "features"
        | "condition"
        | "issues"
        | "age"
      >
    >
  ) {
    return prisma.$transaction(async (tx) => {
      const before = await tx.equipment.findUnique({ where: { id } });
      if (!before)
        throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);

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

      await writeAudit(tx, AUDIT.EQUIPMENT.UPDATED, currentUserId, {
        equipmentRecord: { ...updated },
      });

      return updated;
    });
  },

  async retire(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (eq.status === EquipmentStatus.RETIRED) return eq;

      if (
        eq.status === EquipmentStatus.CHECKED_OUT ||
        eq.status === EquipmentStatus.RESERVED
      ) {
        throw new ServiceError(
          "CANNOT_RETIRE_WHILE_IN_USE",
          "Cannot retire equipment while reserved/checked out.",
          409
        );
      }
      if (await hasActiveCheckout(tx, id)) {
        throw new ServiceError(
          "ACTIVE_CHECKOUT_EXISTS",
          "Equipment has an active reservation/checkout.",
          409
        );
      }

      const updated = await tx.equipment.update({
        where: { id },
        data: { status: EquipmentStatus.RETIRED, retiredAt: now() },
      });

      await writeAudit(tx, AUDIT.EQUIPMENT.RETIRED, currentUserId, {
        equipmentRecord: { ...updated },
      });

      return updated;
    });
  },

  async unretire(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);

      if (eq.status !== EquipmentStatus.RETIRED) {
        return recomputeStatus(tx, id);
      }

      const updated = await tx.equipment.update({
        where: { id },
        data: { status: EquipmentStatus.AVAILABLE, retiredAt: null },
      });

      await writeAudit(tx, AUDIT.EQUIPMENT.UNRETIRED, currentUserId, {
        equipmentRecord: { ...updated },
      });

      return recomputeStatus(tx, id);
    });
  },

  async hardDelete(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (eq.status !== EquipmentStatus.RETIRED)
        throw new ServiceError(
          "NOT_RETIRED",
          "Only retired equipment can be deleted.",
          409
        );

      if (await hasActiveCheckout(tx, id))
        throw new ServiceError(
          "ACTIVE_CHECKOUT_EXISTS",
          "Equipment has an active reservation/checkout.",
          409
        );

      await tx.checkout.deleteMany({ where: { equipmentId: id } });

      await writeAudit(tx, AUDIT.EQUIPMENT.DELETED, currentUserId, {
        equipmentRecord: { ...eq },
      });

      await tx.equipment.delete({ where: { id } });
      return { deleted: true };
    });
  },

  async release(currentUserId: string, id: string) {
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

        await writeAudit(tx, AUDIT.EQUIPMENT.FORCE_RELEASED, currentUserId, {
          equipmentRecord: updated,
          checkoutRecord: checkout,
        });
      }
      return { released: true };
    });
  },

  async reserve(currentUserId: string, id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (eq.retiredAt)
        throw new ServiceError("RETIRED", "Equipment retired.", 409);
      if (eq.status !== EquipmentStatus.AVAILABLE)
        throw new ServiceError(
          "NOT_AVAILABLE",
          "Equipment not available.",
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

      await writeAudit(tx, AUDIT.EQUIPMENT.RESERVED, currentUserId, {
        equipmentRecord: { ...eq },
        checkoutRecord: { ...reserve },
      });

      return { id, userId };
    });
  },

  async cancelReservation(currentUserId: string, id: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const active = await getActiveCheckout(tx, id);
      if (!active || active.checkedOutAt)
        throw new ServiceError(
          "NO_ACTIVE_RESERVATION",
          "No active reservation to cancel.",
          409
        );
      if (active.userId !== userId)
        throw new ServiceError("NOT_OWNER", "Not your reservation.", 403);

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
        currentUserId,
        {
          equipmentRecord: { ...eq },
          checkoutRecord: { ...unreserved },
        }
      );

      return { cancelled: true };
    });
  },

  async checkoutWithQr(
    currentUserId: string,
    id: string,
    userId: string,
    slug: string
  ) {
    if (!slug) throw new ServiceError("INVALID_INPUT", "Missing QR code.", 400);

    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);

      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (!eq.qrSlug)
        throw new ServiceError(
          "NO_QR",
          "This equipment doesn't have a QR code.",
          409
        );
      if (eq.qrSlug.trim().toLowerCase() !== slug.trim().toLowerCase())
        throw new ServiceError(
          "QR_MISMATCH",
          "QR code doesn't match this equipment.",
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
          "Reservation not owned or already checked out.",
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

      await writeAudit(tx, AUDIT.EQUIPMENT.CHECKED_OUT, currentUserId, {
        equipmentRecord: { ...updated },
        checkoutRecord: { ...checkout },
      });

      return { id, userId };
    });
  },

  async returnWithQr(
    currentUserId: string,
    id: string,
    userId: string,
    slug: string
  ) {
    if (!slug) throw new ServiceError("INVALID_INPUT", "Missing QR code.", 400);

    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);

      // 1) Verify item + QR
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (!eq.qrSlug)
        throw new ServiceError(
          "NO_QR",
          "This item doesn't have a QR code",
          409
        );
      if (eq.qrSlug.trim().toLowerCase() !== slug.trim().toLowerCase())
        throw new ServiceError(
          "QR_MISMATCH",
          "QR code doesn't match this item.",
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
          "No active checkout for this user.",
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

      await writeAudit(tx, AUDIT.EQUIPMENT.RETURNED, currentUserId, {
        equipmentRecord: { ...updated },
        checkoutRecord: { ...returned },
      });

      return { released: true };
    });
  },

  async maintenanceStart(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const eq = await tx.equipment.findUnique({
        where: { id: id },
      });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (eq.status === EquipmentStatus.RETIRED)
        throw new ServiceError("RETIRED", "Equipment retired.", 409);

      if (await hasActiveCheckout(tx, id))
        throw new ServiceError(
          "ACTIVE_CHECKOUT_EXISTS",
          "Equipment has an active reservation/checkout.",
          409
        );

      const updated = await tx.equipment.update({
        where: { id: id },
        data: { status: EquipmentStatus.MAINTENANCE },
      });

      await writeAudit(tx, AUDIT.EQUIPMENT.MAINTENANCE_START, currentUserId, {
        equipmentRecord: updated,
      });

      return updated;
    });
  },

  async maintenanceEnd(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const updated = await tx.equipment.update({
        where: { id: id },
        data: { status: EquipmentStatus.AVAILABLE },
      });

      await writeAudit(tx, AUDIT.EQUIPMENT.MAINTENANCE_END, currentUserId, {
        equipmentRecord: updated,
      });

      return recomputeStatus(tx, id);
    });
  },
};
