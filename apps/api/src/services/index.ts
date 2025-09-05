// apps/api/src/services/index.ts
import { prisma } from "../db/prisma";
import {
  Prisma,
  PrismaClient,
  AuditAction,
  EquipmentStatus,
} from "@prisma/client";
import type { Services, EquipmentWithHolder } from "../types/services";
import { ServiceError } from "../lib/errors";
import { createClerkClient } from "@clerk/backend";

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("Missing CLERK_SECRET_KEY for server-side Clerk client");
}
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Prisma.TransactionClient;

const now = () => new Date();

/** Row-level lock helper */
async function lockEquipment(tx: Tx, id: string) {
  await tx.$queryRawUnsafe(
    `SELECT id FROM "Equipment" WHERE id = $1 FOR UPDATE`,
    id
  );
}

/** Return the single active reservation/checkout row (releasedAt is NULL) */
async function getActiveCheckout(tx: Tx, equipmentId: string) {
  return tx.checkout.findFirst({
    where: { equipmentId, releasedAt: null },
  });
}

/** True if any active reservation/checkout exists */
async function hasActiveCheckout(tx: Tx, equipmentId: string) {
  const c = await tx.checkout.count({
    where: { equipmentId, releasedAt: null },
  });
  return c > 0;
}

/**
 * Recompute derived status:
 * - RETIRED / MAINTENANCE are sticky
 * - If active row exists:
 *    - checkedOutAt != null  => CHECKED_OUT
 *    - checkedOutAt == null  => RESERVED
 * - Else AVAILABLE
 */
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

/** Write audit with FK-safe fallback */
async function writeAudit(
  db: Db,
  action: AuditAction,
  actorUserId?: string,
  equipmentId?: string,
  metadata?: unknown
) {
  try {
    await db.auditEvent.create({
      data: { action, actorUserId, equipmentId, metadata: metadata as any },
    });
  } catch (e) {
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
    /** AVAILABLE & no active rows */
    async listAvailable() {
      return prisma.equipment.findMany({
        where: {
          status: EquipmentStatus.AVAILABLE,
          checkouts: { none: { releasedAt: null } },
        },
        orderBy: { createdAt: "desc" },
      });
    },

    /** Plain list for general use */
    async listAll() {
      return prisma.equipment.findMany({ orderBy: { createdAt: "desc" } });
    },

    /** Admin list with current holder information (if any) */
    async listAllAdmin() {
      const rows = await prisma.equipment.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          checkouts: {
            where: { releasedAt: null },
            include: { user: true },
            take: 1, // there should be at most one active row
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
              state: active.checkedOutAt ? "CHECKED_OUT" : "RESERVED",
            }
          : null;

        // strip relation arrays to satisfy Equipment shape
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { checkouts, auditEvents, ...equip } = e as any;
        return { ...(equip as any), holder };
      });

      return mapped;
    },

    /** Worker “Available” view only shows AVAILABLE items */
    async listForWorkers() {
      return prisma.equipment.findMany({
        where: { status: { in: [EquipmentStatus.AVAILABLE] } },
        orderBy: { createdAt: "desc" },
      });
    },

    /** My active reservations/checkouts */
    async listMine(userId: string) {
      return prisma.equipment
        .findMany({
          where: {
            status: { not: EquipmentStatus.RETIRED },
          },
          orderBy: { createdAt: "desc" },
          include: {
            checkouts: {
              where: { userId, releasedAt: null },
              take: 1,
            },
          },
        })
        .then((rows) =>
          rows
            .filter((r) => r.checkouts.length > 0)
            .map((r) => {
              // drop the relation to match Equipment[]
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { checkouts, ...rest } = r as any;
              return rest as typeof r;
            })
        );
    },

    async create(input) {
      return prisma.$transaction(async (tx) => {
        const data: Prisma.EquipmentCreateInput = {
          shortDesc: input.shortDesc,
          longDesc: input.longDesc ?? "",
          ...(input.qrSlug !== undefined ? { qrSlug: input.qrSlug } : {}),
        };
        const created = await tx.equipment.create({ data });
        await writeAudit(
          tx,
          AuditAction.EQUIPMENT_CREATED,
          undefined,
          created.id,
          { input }
        );
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
        await writeAudit(tx, AuditAction.EQUIPMENT_UPDATED, undefined, id, {
          before,
          patch,
        });
        return updated;
      });
    },

    /** Retire (blocked if RESERVED or CHECKED_OUT or any active row) */
    async retire(id: string) {
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
        await writeAudit(tx, AuditAction.EQUIPMENT_RETIRED, undefined, id, {});
        return updated;
      });
    },

    async unretire(id: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);

        if (eq.status !== EquipmentStatus.RETIRED) {
          return recomputeStatus(tx, id);
        }

        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE, retiredAt: null },
        });

        await writeAudit(tx, AuditAction.EQUIPMENT_UPDATED, undefined, id, {
          unretired: true,
        });
        return recomputeStatus(tx, id);
      });
    },

    async hardDelete(id: string) {
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
        await writeAudit(tx, AuditAction.EQUIPMENT_DELETED, undefined, id, {});
        await tx.equipment.delete({ where: { id } });
        return { deleted: true };
      });
    },

    /** Admin assign => directly CHECKED_OUT to that user */
    async assign(id: string, userId: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);

        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === EquipmentStatus.RETIRED)
          throw new ServiceError("RETIRED", "Equipment retired", 409);
        if (eq.status === EquipmentStatus.MAINTENANCE)
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
            "ALREADY_IN_USE",
            "Equipment already reserved/checked out",
            409
          );

        await tx.checkout.create({
          data: {
            equipmentId: id,
            userId,
            checkedOutAt: now(),
          },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.CHECKED_OUT },
        });

        await writeAudit(tx, AuditAction.EQUIPMENT_CHECKED_OUT, userId, id, {
          via: "assign",
        });
        return { id, userId };
      });
    },

    /** Admin force release from RESERVED or CHECKED_OUT */
    async release(id: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await getActiveCheckout(tx, id);
        if (active) {
          await tx.checkout.update({
            where: { id: active.id },
            data: { releasedAt: now() },
          });
          await tx.equipment.update({
            where: { id },
            data: { status: EquipmentStatus.AVAILABLE },
          });
          await writeAudit(
            tx,
            AuditAction.FORCE_RELEASED,
            active.userId,
            id,
            {}
          );
        }
        return { released: true };
      });
    },

    // ---------- Worker lifecycle (RESERVE → CHECKOUT → RETURN) ----------

    /** Reserve AVAILABLE equipment */
    async reserve(id: string, userId: string) {
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

        // Create active row with no checkedOutAt -> RESERVED
        await tx.checkout.create({
          data: { equipmentId: id, userId },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.RESERVED },
        });

        await writeAudit(tx, AuditAction.EQUIPMENT_RESERVED, userId, id, {});
        return { id, userId };
      });
    },

    /** Cancel reservation (only if it's yours and not yet checked out) */
    async cancelReservation(id: string, userId: string) {
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

        await tx.checkout.update({
          where: { id: active.id },
          data: { releasedAt: now() },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        await writeAudit(tx, AuditAction.RESERVATION_CANCELLED, userId, id, {});
        return { cancelled: true };
      });
    },

    /** Checkout must follow reservation by same user */
    async checkout(id: string, userId: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const eq = await tx.equipment.findUnique({ where: { id } });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status !== EquipmentStatus.RESERVED)
          throw new ServiceError(
            "NOT_RESERVED",
            "Must reserve before checkout",
            409
          );

        const active = await getActiveCheckout(tx, id);
        if (!active || active.userId !== userId || active.checkedOutAt)
          throw new ServiceError(
            "NOT_ALLOWED",
            "Reservation not owned or already checked out",
            403
          );

        await tx.checkout.update({
          where: { id: active.id },
          data: { checkedOutAt: now() },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.CHECKED_OUT },
        });

        await writeAudit(tx, AuditAction.EQUIPMENT_CHECKED_OUT, userId, id, {});
        return { id, userId };
      });
    },

    /** Return by the same user who checked out */
    async returnByUser(id: string, userId: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await getActiveCheckout(tx, id);
        if (!active || !active.checkedOutAt)
          throw new ServiceError(
            "NO_ACTIVE_CHECKOUT",
            "No active checkout to return",
            409
          );
        if (active.userId !== userId)
          throw new ServiceError(
            "NOT_OWNER",
            "You did not check this out",
            403
          );

        await tx.checkout.update({
          where: { id: active.id },
          data: { releasedAt: now() },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        await writeAudit(tx, AuditAction.EQUIPMENT_RETURNED, userId, id, {});
        return { released: true };
      });
    },

    // ---------- Back-compat shims ----------

    /** Old "claim" => reserve (first step of the new flow) */
    async claim(id: string, userId: string) {
      return this.reserve(id, userId);
    },

    /** Old "release" by worker => cancel reservation OR return if checked out */
    async releaseByUser(id: string, userId: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, id);
        const active = await getActiveCheckout(tx, id);
        if (!active) return { released: true };

        if (active.userId !== userId)
          throw new ServiceError("NOT_OWNER", "Not yours", 403);

        if (active.checkedOutAt) {
          await tx.checkout.update({
            where: { id: active.id },
            data: { releasedAt: now() },
          });
          await tx.equipment.update({
            where: { id },
            data: { status: EquipmentStatus.AVAILABLE },
          });
          await writeAudit(tx, AuditAction.EQUIPMENT_RETURNED, userId, id, {
            via: "legacy_release",
          });
        } else {
          await tx.checkout.update({
            where: { id: active.id },
            data: { releasedAt: now() },
          });
          await tx.equipment.update({
            where: { id },
            data: { status: EquipmentStatus.AVAILABLE },
          });
          await writeAudit(tx, AuditAction.RESERVATION_CANCELLED, userId, id, {
            via: "legacy_release",
          });
        }
        return { released: true };
      });
    },
  },

  maintenance: {
    async start(equipmentId: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, equipmentId);
        const eq = await tx.equipment.findUnique({
          where: { id: equipmentId },
        });
        if (!eq)
          throw new ServiceError("NOT_FOUND", "Equipment not found", 404);
        if (eq.status === EquipmentStatus.RETIRED)
          throw new ServiceError("RETIRED", "Equipment retired", 409);

        if (await hasActiveCheckout(tx, equipmentId))
          throw new ServiceError(
            "ACTIVE_CHECKOUT_EXISTS",
            "Equipment has an active reservation/checkout",
            409
          );

        const updated = await tx.equipment.update({
          where: { id: equipmentId },
          data: { status: EquipmentStatus.MAINTENANCE },
        });
        await writeAudit(
          tx,
          AuditAction.MAINTENANCE_START,
          undefined,
          equipmentId,
          {}
        );
        return updated;
      });
    },

    async end(equipmentId: string) {
      return prisma.$transaction(async (tx) => {
        await lockEquipment(tx, equipmentId);
        await tx.equipment.update({
          where: { id: equipmentId },
          data: { status: EquipmentStatus.AVAILABLE },
        });
        await writeAudit(
          tx,
          AuditAction.MAINTENANCE_END,
          undefined,
          equipmentId,
          {}
        );
        return recomputeStatus(tx, equipmentId);
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

    async approve(userId: string) {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { isApproved: true },
      });
      await writeAudit(
        prisma,
        AuditAction.USER_APPROVED,
        userId,
        undefined,
        {}
      );
      return updated;
    },

    async addRole(userId: string, role: "ADMIN" | "WORKER") {
      const roleRow = await prisma.userRole.create({
        data: { userId, role: role as any },
      });
      await writeAudit(prisma, AuditAction.ROLE_ASSIGNED, userId, undefined, {
        role,
      });
      return roleRow;
    },

    async removeRole(userId: string, role: "ADMIN" | "WORKER") {
      const toDelete = await prisma.userRole.findFirst({
        where: { userId, role: role as any },
      });
      if (!toDelete) return { deleted: false };
      await prisma.userRole.delete({ where: { id: toDelete.id } });
      return { deleted: true };
    },

    async me(clerkUserId: string) {
      if (!clerkUserId) {
        return {
          id: "",
          isApproved: false,
          roles: [] as ("ADMIN" | "WORKER")[],
          email: undefined,
          displayName: undefined,
        };
      }

      // Try to find the user in your DB
      let user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });

      // If missing, create it using Clerk profile as seed data
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
        } catch {
          // If Clerk fetch fails, proceed with minimal row
        }

        await prisma.user.create({
          data: {
            clerkUserId,
            email: email ?? undefined,
            displayName: displayName ?? undefined,
            isApproved: false, // new users need approval
          },
        });

        // re-read including roles
        user = await prisma.user.findUnique({
          where: { clerkUserId },
          include: { roles: true },
        });
      }

      return {
        id: user!.id,
        isApproved: !!user!.isApproved,
        roles: (user!.roles ?? []).map((r) => r.role) as ("ADMIN" | "WORKER")[],
        email: user!.email ?? undefined,
        displayName: user!.displayName ?? undefined,
      };
    },

    /**
     * Hard delete a user from the system:
     * - Prevent deleting yourself.
     * - Prevent deleting the last remaining ADMIN.
     * - Delete Clerk user (best-effort).
     * - Delete DB user (cascades roles & checkouts; audit actor FK is set null).
     */
    async remove(userId: string, actorUserId: string) {
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

      // Block deleting the last admin
      const isAdmin = user.roles.some((r) => r.role === "ADMIN");
      if (isAdmin) {
        const otherAdmins = await prisma.userRole.count({
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

      // Best-effort Clerk deletion first (so they can't sign in again)
      let clerkDeleted = false;
      if (user.clerkUserId) {
        try {
          await clerk.users.deleteUser(user.clerkUserId);
          clerkDeleted = true;
        } catch (e: any) {
          // If Clerk says 404, consider it gone; otherwise continue but report false
          clerkDeleted =
            typeof e?.status === "number" ? e.status === 404 : false;
        }
      }

      // DB delete (roles & checkouts cascade; audit actor is set null)
      await prisma.user.delete({ where: { id: userId } });

      return { deleted: true as const, clerkDeleted };
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
