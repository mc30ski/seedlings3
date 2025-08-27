// apps/api/src/services/index.ts
import { prisma } from "../db/prisma";
import { Prisma, PrismaClient } from "@prisma/client";
import type { Services } from "../types/services";
import { ServiceError } from "../lib/errors";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Prisma.TransactionClient;

const now = () => new Date();

async function lockEquipment(tx: Tx, id: string) {
  await tx.$queryRawUnsafe(
    `SELECT id FROM "Equipment" WHERE id = $1 FOR UPDATE`,
    id
  );
}

async function hasActiveCheckout(tx: Tx, equipmentId: string) {
  const c = await tx.checkout.count({
    where: { equipmentId, releasedAt: null },
  });
  return c > 0;
}

// Recompute derived status, but keep RETIRED and MAINTENANCE sticky
async function recomputeStatus(tx: Tx, equipmentId: string) {
  const eq = await tx.equipment.findUnique({ where: { id: equipmentId } });
  if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

  if (eq.status === "RETIRED" || eq.retiredAt) return eq;
  if (eq.status === "MAINTENANCE") return eq; // sticky until admin ends

  const activeCheckout = await hasActiveCheckout(tx, equipmentId);
  if (activeCheckout) {
    if (eq.status !== "CHECKED_OUT") {
      return tx.equipment.update({
        where: { id: equipmentId },
        data: { status: "CHECKED_OUT" },
      });
    }
    return eq;
  }

  if (eq.status !== "AVAILABLE") {
    return tx.equipment.update({
      where: { id: equipmentId },
      data: { status: "AVAILABLE" },
    });
  }
  return eq;
}

async function writeAudit(
  db: Db,
  action:
    | "USER_APPROVED"
    | "ROLE_ASSIGNED"
    | "EQUIPMENT_CREATED"
    | "EQUIPMENT_UPDATED"
    | "EQUIPMENT_RETIRED"
    | "EQUIPMENT_DELETED"
    | "EQUIPMENT_CHECKED_OUT"
    | "EQUIPMENT_RELEASED"
    | "MAINTENANCE_START"
    | "MAINTENANCE_END",
  actorUserId?: string,
  equipmentId?: string,
  metadata?: unknown
) {
  try {
    await db.auditEvent.create({
      data: { action, actorUserId, equipmentId, metadata: metadata as any },
    });
  } catch (e) {
    // If equipmentId no longer exists, retry with NULL and stash the id in metadata
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2003"
    ) {
      await db.auditEvent.create({
        data: {
          action,
          actorUserId,
          equipmentId: null,
          metadata: {
            ...(metadata as any),
            deletedEquipmentId: equipmentId,
            note: "FK missing → set null",
          },
        },
      });
      return;
    }
    throw e;
  }
}

export const services: Services = {
  equipment: {
    // Available = AVAILABLE and no active checkout (explicit check is defensive)
    async listAvailable() {
      return prisma.equipment.findMany({
        where: {
          status: "AVAILABLE",
          checkouts: { none: { releasedAt: null } },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    async listAll() {
      return prisma.equipment.findMany({ orderBy: { createdAt: "desc" } });
    },

    async listMine(userId: string) {
      // All equipment (non-retired) that has an active checkout by this user
      return prisma.equipment.findMany({
        where: {
          status: { not: "RETIRED" },
          checkouts: { some: { userId, releasedAt: null } },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    // For worker list: all non-retired (so they see maintenance items too)
    async listForWorkers() {
      return prisma.equipment.findMany({
        where: { status: { not: "RETIRED" } },
        orderBy: { createdAt: "desc" },
      });
    },

    async create(input) {
      return prisma.$transaction(async (tx) => {
        const data: Prisma.EquipmentCreateInput = {
          shortDesc: input.shortDesc,
          longDesc: input.longDesc ?? "",
          ...(input.qrSlug !== undefined ? { qrSlug: input.qrSlug } : {}),
        };
        const created = await tx.equipment.create({ data });
        await writeAudit(tx, "EQUIPMENT_CREATED", undefined, created.id, {
          input,
        });
        return created;
      });
    },

    async update(id, patch) {
      return prisma.$transaction(async (tx) => {
        const before = await tx.equipment.findUnique({ where: { id } });
        if (!before)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

        const data: Prisma.EquipmentUpdateInput = {};
        if (patch.shortDesc !== undefined) data.shortDesc = patch.shortDesc;
        if (patch.longDesc !== undefined) data.longDesc = patch.longDesc;
        if (patch.qrSlug !== undefined) data.qrSlug = patch.qrSlug;

        const updated = await tx.equipment.update({ where: { id }, data });
        await writeAudit(tx, "EQUIPMENT_UPDATED", undefined, id, {
          before,
          patch,
        });
        return updated;
      });
    },

    async retire(id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === "RETIRED") return eq;

        const active = await hasActiveCheckout(tx, id);
        if (active)
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active checkout",
            409
          );

        const updated = await tx.equipment.update({
          where: { id },
          data: { status: "RETIRED", retiredAt: now() },
        });
        await writeAudit(tx, "EQUIPMENT_RETIRED", undefined, id, {});
        return updated;
      });
    },

    async unretire(id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);

        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

        // Idempotent: if it's not retired, just recompute/return current
        if (eq.status !== "RETIRED") {
          return recomputeStatus(tx, id);
        }

        // Clear retired flag and set to AVAILABLE, then recompute
        await tx.equipment.update({
          where: { id },
          data: { status: "AVAILABLE", retiredAt: null },
        });

        await writeAudit(tx, "EQUIPMENT_UPDATED", undefined, id, {
          unretired: true,
        });

        return recomputeStatus(tx, id);
      });
    },

    async hardDelete(id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);

        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status !== "RETIRED")
          throw new ServiceError(
            "NOT_RETIRED",
            "Only retired equipment can be deleted",
            409
          );

        const active = await hasActiveCheckout(tx, id);
        if (active)
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active checkout",
            409
          );

        // Remove dependents that might block the delete
        await tx.checkout.deleteMany({ where: { equipmentId: id } });

        // Write the audit BEFORE deleting the equipment
        await writeAudit(tx, "EQUIPMENT_DELETED", undefined, id, {});

        // Now delete the equipment (DB will SetNull any FK rows that still point to it)
        await tx.equipment.delete({ where: { id } });

        return { deleted: true };
      });
    },

    async assign(id, userId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === "RETIRED")
          throw new ServiceError("RETIRED", "Equipment retired", 409);
        if (eq.status === "MAINTENANCE")
          throw new ServiceError(
            "IN_MAINTENANCE",
            "Equipment in maintenance",
            409
          );

        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user)
          throw new ServiceError("USER_NOT_FOUND", "User not found", 404);

        if (await hasActiveCheckout(tx, id))
          throw new ServiceError(
            "ALREADY_CHECKED_OUT",
            "Equipment already checked out",
            409
          );

        const checkout = await tx.checkout.create({
          data: { equipmentId: id, userId },
        });
        await writeAudit(tx, "EQUIPMENT_CHECKED_OUT", userId, id, {
          via: "assign",
        });

        await recomputeStatus(tx, id);
        return checkout;
      });
    },

    async release(id) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await tx.checkout.findFirst({
          where: { equipmentId: id, releasedAt: null },
          orderBy: { checkedOutAt: "desc" },
        });
        if (active) {
          await tx.checkout.update({
            where: { id: active.id },
            data: { releasedAt: now() },
          });
          await writeAudit(tx, "EQUIPMENT_RELEASED", active.userId, id, {
            via: "admin",
          });
        }
        await recomputeStatus(tx, id);
        return { released: true };
      });
    },

    async claim(id, userId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === "RETIRED")
          throw new ServiceError("RETIRED", "Equipment retired", 409);
        if (eq.status === "MAINTENANCE")
          throw new ServiceError(
            "IN_MAINTENANCE",
            "Equipment in maintenance",
            409
          );

        if (await hasActiveCheckout(tx, id))
          throw new ServiceError(
            "ALREADY_CHECKED_OUT",
            "Equipment already checked out",
            409
          );

        const checkout = await tx.checkout.create({
          data: { equipmentId: id, userId },
        });
        await writeAudit(tx, "EQUIPMENT_CHECKED_OUT", userId, id, {
          via: "worker",
        });

        await recomputeStatus(tx, id);
        return checkout;
      });
    },

    async releaseByUser(id, userId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await tx.checkout.findFirst({
          where: { equipmentId: id, userId, releasedAt: null },
          orderBy: { checkedOutAt: "desc" },
        });
        if (active) {
          await tx.checkout.update({
            where: { id: active.id },
            data: { releasedAt: now() },
          });
          await writeAudit(tx, "EQUIPMENT_RELEASED", userId, id, {
            via: "worker",
          });
        }
        await recomputeStatus(tx, id);
        return { released: true };
      });
    },
  },

  maintenance: {
    // Start maintenance mode (no time range)
    async start(equipmentId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, equipmentId);
        const eq = await tx.equipment.findUnique({
          where: { id: equipmentId },
        });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === "RETIRED")
          throw new ServiceError("RETIRED", "Equipment retired", 409);

        const active = await hasActiveCheckout(tx, equipmentId);
        if (active)
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active checkout",
            409
          );

        const updated = await tx.equipment.update({
          where: { id: equipmentId },
          data: { status: "MAINTENANCE" },
        });
        await writeAudit(tx, "MAINTENANCE_START", undefined, equipmentId, {});
        return updated;
      });
    },

    // End maintenance mode → recompute (AVAILABLE unless a checkout exists somehow)
    async end(equipmentId) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, equipmentId);
        const eq = await tx.equipment.findUnique({
          where: { id: equipmentId },
        });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

        // Clear to AVAILABLE first; recompute will flip to CHECKED_OUT if needed
        await tx.equipment.update({
          where: { id: equipmentId },
          data: { status: "AVAILABLE" },
        });
        await writeAudit(tx, "MAINTENANCE_END", undefined, equipmentId, {});
        const after = await recomputeStatus(tx, equipmentId);
        return after;
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

    async approve(userId) {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { isApproved: true },
      });
      await writeAudit(prisma, "USER_APPROVED", userId, undefined, {});
      return updated;
    },

    async addRole(userId, role) {
      const roleRow = await prisma.userRole.create({
        data: { userId, role: role as any },
      });
      await writeAudit(prisma, "ROLE_ASSIGNED", userId, undefined, { role });
      return roleRow;
    },

    async removeRole(userId, role) {
      const toDelete = await prisma.userRole.findFirst({
        where: { userId, role: role as any },
      });
      if (!toDelete) return { deleted: false };
      await prisma.userRole.delete({ where: { id: toDelete.id } });
      return { deleted: true };
    },

    async me(clerkUserId) {
      const user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });
      return {
        id: user?.id ?? "",
        isApproved: !!user?.isApproved,
        roles: (user?.roles ?? []).map((r) => r.role),
        email: user?.email ?? undefined,
        displayName: user?.displayName ?? undefined,
      };
    },
  },

  audit: {
    async list(params) {
      const where: any = {};
      if (params.actorUserId) where.actorUserId = params.actorUserId;
      if (params.equipmentId) where.equipmentId = params.equipmentId;
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
};
