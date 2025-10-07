import { prisma } from "../db/prisma";
import type { Services, EquipmentWithHolder } from "../types/services";
import { Role } from "../types/services";
import {
  Prisma,
  PrismaClient,
  AuditAction,
  Role as RoleVal,
  EquipmentStatus,
} from "@prisma/client";
import { verifyToken, createClerkClient } from "@clerk/backend";
import { ServiceError } from "../lib/errors";

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

// Write audit with FK-safe fallback
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

function summarizeEvent(action: string, metadata?: any): string {
  const t = String(action).toUpperCase();
  if (t === "EQUIPMENT_RESERVED")
    return labelWithEq("Reserved equipment", metadata);
  if (t === "RESERVATION_CANCELLED")
    return labelWithEq("Canceled reservation", metadata);
  if (t === "EQUIPMENT_CHECKED_OUT")
    return labelWithEq("Checked out equipment", metadata);
  if (t === "EQUIPMENT_RETURNED")
    return labelWithEq("Returned equipment", metadata);
  if (t === "FORCE_RELEASED")
    return labelWithEq("Force released equipment", metadata);
  if (t === "USER_APPROVED") return "User approved";
  if (t === "ROLE_ASSIGNED")
    return `Role assigned${metadata?.role ? `: ${metadata.role}` : ""}`;
  if (t === "MAINTENANCE_START")
    return labelWithEq("Maintenance started", metadata);
  if (t === "MAINTENANCE_END")
    return labelWithEq("Maintenance ended", metadata);
  return action;
}

function labelWithEq(base: string, metadata?: any) {
  const eq = metadata?.equipment?.shortDesc || metadata?.shortDesc;
  return eq ? `${base} — ${eq}` : base;
}

/**
 * Build compact details for UI:
 *  - equipmentName / equipmentDesc (from metadata OR joined equipment)
 *  - common extras (role, notes, reason, from/to status, qrSlug)
 * No equipmentId is returned (not useful to users).
 */
function buildEventDetails(
  action: string,
  metadata: any,
  equipmentId: string | null | undefined,
  eqMap: Record<
    string,
    {
      shortDesc: string | null;
      longDesc: string | null;
      brand: string | null;
      model: string | null;
      type: string | null;
    }
  >
) {
  const out: Record<string, any> = {};
  const md = (metadata ?? {}) as any;
  const mdEq = (md?.equipment ?? {}) as any;

  // Prefer metadata, then DB join
  const equipmentName =
    mdEq.shortDesc ??
    md.shortDesc ??
    (equipmentId ? eqMap[equipmentId!]?.shortDesc : null);
  const equipmentDesc =
    mdEq.longDesc ??
    md.longDesc ??
    (equipmentId ? eqMap[equipmentId!]?.longDesc : null);

  const brand =
    mdEq.brand ?? md.brand ?? (equipmentId ? eqMap[equipmentId!]?.brand : null);
  const model =
    mdEq.model ?? md.model ?? (equipmentId ? eqMap[equipmentId!]?.model : null);
  const type =
    mdEq.type ?? md.type ?? (equipmentId ? eqMap[equipmentId!]?.type : null);

  if (equipmentName) out.equipmentName = equipmentName;
  if (equipmentDesc) out.equipmentDesc = equipmentDesc;
  if (brand) out.brand = brand;
  if (model) out.model = model;
  if (type) out.type = type;

  // Other common bits you already record
  if (md?.qrSlug) out.qrSlug = md.qrSlug;
  if (md?.role) out.role = md.role;
  if (md?.reason) out.reason = md.reason;
  if (md?.notes) out.notes = md.notes;
  if (md?.fromStatus) out.fromStatus = md.fromStatus;
  if (md?.toStatus) out.toStatus = md.toStatus;

  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------

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

    //TODO: NOT USED ANYWHERE?
    async listAll() {
      return prisma.equipment.findMany({ orderBy: { createdAt: "desc" } });
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

    async create(input) {
      return prisma.$transaction(async (tx) => {
        const data: Prisma.EquipmentCreateInput = {
          shortDesc: input.shortDesc,
          longDesc: input.longDesc ?? "",
          ...(input.qrSlug !== undefined ? { qrSlug: input.qrSlug } : {}),
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
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
        if (patch.brand !== undefined) data.brand = patch.brand;
        if (patch.model !== undefined) data.model = patch.model;
        if (patch.type !== undefined) data.type = patch.type;

        const updated = await tx.equipment.update({ where: { id }, data });

        await writeAudit(tx, AuditAction.EQUIPMENT_UPDATED, undefined, id, {
          before,
          patch,
        });

        return updated;
      });
    },

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
          where: { id }, // ← fixed: use id, not equipmentId
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

    async checkoutWithQr(id: string, userId: string, slug: string) {
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

        await tx.checkout.update({
          where: { id: active.id },
          data: { checkedOutAt: new Date() },
        });
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.CHECKED_OUT },
        });

        await writeAudit(tx, AuditAction.EQUIPMENT_CHECKED_OUT, userId, id, {
          qrSlug: slug,
          via: "qr",
        });
        return { id, userId };
      });
    },

    async returnWithQr(id: string, userId: string, slug: string) {
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
        await tx.checkout.update({
          where: { id: active.id },
          data: { releasedAt: now },
        });

        // 4) Flip equipment status back to AVAILABLE (adjust if your app uses a different state machine)
        await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        // 5) Audit
        await writeAudit(tx, AuditAction.EQUIPMENT_RETURNED, userId, id, {
          qrSlug: slug,
          via: "qr",
        });

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

    async listHoldings() {
      const rows = await prisma.checkout.findMany({
        where: { releasedAt: null },
        include: {
          equipment: {
            select: {
              id: true,
              shortDesc: true,
              brand: true,
              model: true,
              type: true,
            },
          },
        },
        orderBy: { reservedAt: "desc" },
      });

      return rows.map((r) => ({
        userId: r.userId,
        equipmentId: r.equipmentId,
        shortDesc: r.equipment?.shortDesc ?? "",
        brand: r.equipment?.brand ?? null,
        model: r.equipment?.model ?? null,
        type: r.equipment?.type ?? null,
        state: r.checkedOutAt
          ? ("CHECKED_OUT" as const)
          : ("RESERVED" as const),
        reservedAt: r.reservedAt,
        checkedOutAt: r.checkedOutAt ?? null,
      }));
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

      const toDelete = await prisma.userRole.findFirst({
        where: { userId, role: role as any },
      });
      if (!toDelete) return { deleted: false };

      await prisma.userRole.delete({ where: { id: toDelete.id } });
      return { deleted: true };
    },

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

      await prisma.user.delete({ where: { id: userId } });

      return { deleted: true as const, clerkDeleted };
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

  admin: {
    async listUserActivity({
      q,
      limitPerUser,
    }: {
      q?: string;
      limitPerUser: number;
    }) {
      const qStr = (q ?? "").trim();
      const qLower = qStr.toLowerCase();

      // --- 1) Find candidate users by identity (name/email) ---
      const usersByIdentity = await prisma.user.findMany({
        where: qStr
          ? {
              OR: [
                { displayName: { contains: qStr, mode: "insensitive" } },
                { email: { contains: qStr, mode: "insensitive" } },
              ],
            }
          : {},
        orderBy: [{ createdAt: "asc" }],
        select: { id: true, displayName: true, email: true },
      });

      const userIdSet = new Set<string>(usersByIdentity.map((u) => u.id));

      // --- 2) If searching, expand candidates by matching EVENTS too ---
      // 2a) Equipment hits by name/description
      let equipmentHits: { id: string }[] = [];
      if (qStr) {
        equipmentHits = await prisma.equipment.findMany({
          where: {
            OR: [
              { shortDesc: { contains: qStr, mode: "insensitive" } },
              { longDesc: { contains: qStr, mode: "insensitive" } },
            ],
          },
          select: { id: true },
        });
      }
      const equipmentHitIds: string[] = equipmentHits.map((e) => e.id);

      // 2b) Actor userIds for events matching action (enum) or equipment
      if (qStr) {
        // Map text → matching enum values (case-insensitive)
        const matchedActions = (
          Object.values(AuditAction) as AuditAction[]
        ).filter((a) => a.toLowerCase().includes(qLower));

        const evAction =
          matchedActions.length > 0
            ? await prisma.auditEvent.findMany({
                where: {
                  actorUserId: { not: null },
                  action: { in: matchedActions },
                },
                select: { actorUserId: true },
              })
            : [];

        const evEquip =
          equipmentHitIds.length > 0
            ? await prisma.auditEvent.findMany({
                where: {
                  actorUserId: { not: null },
                  equipmentId: { in: equipmentHitIds },
                },
                select: { actorUserId: true },
              })
            : [];

        for (const r of [...evAction, ...evEquip]) {
          if (r.actorUserId) userIdSet.add(r.actorUserId);
        }
      }

      const userIds: string[] = Array.from(userIdSet);
      if (userIds.length === 0) return [];

      // Re-fetch full user rows (union of identity + event-based)
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, displayName: true, email: true },
      });

      // --- 3) Fetch events for those users (desc by time) ---
      const events = await prisma.auditEvent.findMany({
        where: { actorUserId: { in: userIds } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          actorUserId: true,
          createdAt: true,
          action: true,
          metadata: true,
          equipmentId: true,
        },
      });

      // --- 4) Join equipment once for all referenced ids ---
      const eqIds: string[] = Array.from(
        new Set(
          events
            .map((e) => e.equipmentId)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0
            )
        )
      );
      const eqRows = eqIds.length
        ? await prisma.equipment.findMany({
            where: { id: { in: eqIds } },
            select: {
              id: true,
              shortDesc: true,
              longDesc: true,
              brand: true,
              model: true,
              type: true,
            },
          })
        : [];
      const eqMap = Object.fromEntries(
        eqRows.map((e) => [
          e.id,
          {
            shortDesc: e.shortDesc,
            longDesc: e.longDesc,
            brand: e.brand,
            model: e.model,
            type: e.type,
          },
        ])
      );

      // Helper: does an event match q (by action, equipment names, or metadata text)?
      const eventMatchesQuery = (ev: {
        action: string;
        metadata: any;
        equipmentId: string | null;
      }) => {
        if (!qStr) return true;
        // action
        if (String(ev.action).toLowerCase().includes(qLower)) return true;
        // equipment name/desc via join
        if (ev.equipmentId) {
          const eq = eqMap[ev.equipmentId];
          if (
            (eq?.shortDesc && eq.shortDesc.toLowerCase().includes(qLower)) ||
            (eq?.longDesc && (eq.longDesc ?? "").toLowerCase().includes(qLower))
          ) {
            return true;
          }
        }
        // metadata (best-effort text search)
        try {
          const s = JSON.stringify(ev.metadata ?? {}).toLowerCase();
          if (s.includes(qLower)) return true;
        } catch {}
        return false;
      };

      // --- 5) Bucket events per user (apply query filter + per-user limit) ---
      const byUser: Record<
        string,
        { events: typeof events; lastActivityAt: Date | null }
      > = {};
      for (const u of users)
        byUser[u.id] = { events: [], lastActivityAt: null };

      for (const ev of events) {
        const uid = ev.actorUserId!;
        const bucket = byUser[uid];
        if (!bucket) continue;

        // filter by event query when q is set
        if (!eventMatchesQuery(ev)) continue;

        if (bucket.events.length < limitPerUser) bucket.events.push(ev);
        if (!bucket.lastActivityAt) bucket.lastActivityAt = ev.createdAt;
      }

      // --- 6) Map to API shape (NEWEST FIRST per user) ---
      return users.map((u) => {
        const bucket = byUser[u.id] ?? { events: [], lastActivityAt: null };
        const evs = bucket.events; // already newest-first from DB

        return {
          userId: u.id,
          displayName: u.displayName ?? null,
          email: u.email ?? null,
          lastActivityAt: bucket.lastActivityAt,
          count: evs.length,
          events: evs.map((e) => ({
            id: e.id,
            at: e.createdAt,
            type: e.action, // expose action as 'type' for the UI
            summary: summarizeEvent(e.action, e.metadata),
            details: buildEventDetails(
              e.action,
              e.metadata,
              e.equipmentId,
              eqMap
            ),
          })),
        };
      });
    },
  },
};
