import { prisma } from "../db/prisma";
import { Prisma, Equipment, EquipmentStatus } from "@prisma/client";
import type { ServicesEquipment, EquipmentWithHolder } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { etMidnight, etEndOfDay } from "../lib/dates";
import { ServiceError } from "../lib/errors";
import { deleteObject } from "../lib/r2";

type Tx = Prisma.TransactionClient;

const now = () => new Date();

function computeRentalCost(
  checkedOutAt: Date | null,
  releasedAt: Date,
  workerType: string | null | undefined,
  contractorRate: number | null,
): { rentalDays: number; rentalCost: number } | null {
  if (!checkedOutAt) return null;
  // Only contractors are charged for equipment usage. Employees and trainees
  // use equipment at no cost.
  if (workerType !== "CONTRACTOR") return null;
  const rate = contractorRate;
  if (!rate || rate <= 0) return null;
  // Count distinct calendar days in Eastern Time, inclusive of both ends.
  // Same day = 1 day; crossing one midnight = 2 days; etc.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  const toUtcNoon = (d: Date) => {
    const [y, m, day] = fmt.format(d).split("-").map(Number);
    return Date.UTC(y, m - 1, day, 12);
  };
  const rentalDays = Math.max(1, Math.round((toUtcNoon(releasedAt) - toUtcNoon(checkedOutAt)) / 86_400_000) + 1);
  return { rentalDays, rentalCost: rentalDays * rate };
}

/**
 * Materialize CheckoutSplit rows for a finished group rental.
 *
 * Workers in the group split the rental cost. Observers are excluded. If
 * any worker has a non-null `equipmentCostPercent`, every worker must have
 * one (validated at group save time, but we tolerate edge cases here by
 * falling back to even-split when percents don't sum to 100). Otherwise
 * cost is split evenly among all workers (including the claimer).
 */
async function writeCheckoutSplits(
  tx: Tx,
  params: { checkoutId: string; groupId: string; rentalCost: number },
): Promise<void> {
  const { checkoutId, groupId, rentalCost } = params;
  const group = await tx.group.findUnique({
    where: { id: groupId },
    include: { members: { select: { userId: true, role: true, equipmentCostPercent: true } } },
  });
  if (!group) return;
  // Claimer counts as a worker for cost-split purposes.
  const workers: Array<{ userId: string; equipmentCostPercent: number | null }> = [
    { userId: group.claimerUserId, equipmentCostPercent: null },
    ...group.members
      .filter((m) => m.role !== "observer")
      .map((m) => ({ userId: m.userId, equipmentCostPercent: m.equipmentCostPercent })),
  ];
  if (workers.length === 0) return;

  const customSet = workers.filter((w) => w.equipmentCostPercent != null);
  const useCustom =
    customSet.length === workers.length &&
    Math.abs(workers.reduce((s, w) => s + (w.equipmentCostPercent ?? 0), 0) - 100) < 0.001;

  const splits = workers.map((w) => {
    const percent = useCustom
      ? (w.equipmentCostPercent ?? 0)
      : 100 / workers.length;
    return {
      userId: w.userId,
      percent: Math.round(percent * 1e4) / 1e4,
      amount: Math.round(rentalCost * (percent / 100) * 100) / 100,
    };
  });

  // De-dupe in case claimer was also listed in members (shouldn't happen
  // per group invariants, but stay defensive).
  const seen = new Set<string>();
  for (const s of splits) {
    if (seen.has(s.userId)) continue;
    seen.add(s.userId);
    await tx.checkoutSplit.upsert({
      where: { checkoutId_userId: { checkoutId, userId: s.userId } },
      create: { checkoutId, userId: s.userId, percent: s.percent, amount: s.amount },
      update: { percent: s.percent, amount: s.amount },
    });
  }
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
          include: {
            user: true,
            // Group rentals show "Alpha Crew (Alice)" in the holder label;
            // the worker-facing equipment tab pulls from this endpoint.
            group: { select: { id: true, name: true } },
          },
          take: 1,
        },
        _count: { select: { photos: true } },
        instructions: { orderBy: { sortOrder: "asc" } },
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
            groupId: (active as any).groupId ?? null,
            groupName: (active as any).group?.name ?? null,
          }
        : null;

      const { checkouts, auditEvents, _count, ...equip } = e as any;
      return { ...(equip as any), holder, hasPhotos: ((_count as any)?.photos ?? 0) > 0 };
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
          include: {
            user: true,
            group: { select: { id: true, name: true } },
          },
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
            groupId: (active as any).groupId ?? null,
            groupName: (active as any).group?.name ?? null,
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
      dailyRate?: number | null;
      requiresInsurance?: boolean;
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
        ...(input.dailyRate !== undefined ? { dailyRate: input.dailyRate } : {}),
        ...(input.requiresInsurance !== undefined ? { requiresInsurance: input.requiresInsurance } : {}),
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
        | "dailyRate"
        | "requiresInsurance"
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
      if (patch.dailyRate !== undefined) data.dailyRate = patch.dailyRate;
      if (patch.requiresInsurance !== undefined) data.requiresInsurance = patch.requiresInsurance;

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

      // Collect photo R2 keys before deleting (cascade will remove DB rows when equipment is deleted)
      const photos = await tx.equipmentPhoto.findMany({ where: { equipmentId: id }, select: { r2Key: true } });

      await writeAudit(tx, AUDIT.EQUIPMENT.DELETED, currentUserId, {
        equipmentRecord: { ...eq },
      });

      await tx.equipment.delete({ where: { id } });

      // Best-effort R2 cleanup (don't fail the delete if R2 is unreachable)
      for (const p of photos) {
        try { await deleteObject(p.r2Key, "equipment-photos"); } catch (err) {
          console.error("[equipment.hardDelete] R2 cleanup failed for", p.r2Key, err);
        }
      }

      return { deleted: true };
    });
  },

  async release(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);
      const active = await getActiveCheckout(tx, id);
      if (active) {
        const eq = await tx.equipment.findUnique({ where: { id } });
        const holder = await tx.user.findUnique({ where: { id: active.userId } });
        const releasedAt = now();
        const rental = computeRentalCost(active.checkedOutAt, releasedAt, holder?.workerType, eq?.dailyRate ?? null);
        const checkout = await tx.checkout.update({
          where: { id: active.id },
          data: {
            releasedAt,
            ...(rental ? { rentalDays: rental.rentalDays, rentalCost: rental.rentalCost } : {}),
          },
        });
        if ((active as any).groupId && rental?.rentalCost) {
          await writeCheckoutSplits(tx, {
            checkoutId: checkout.id,
            groupId: (active as any).groupId as string,
            rentalCost: rental.rentalCost,
          });
        }
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

  async reserve(currentUserId: string, id: string, userId: string, opts?: { groupId?: string | null }) {
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

      // Trainees cannot reserve any equipment
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.workerType === "TRAINEE") {
        throw new ServiceError("TRAINEE_NOT_ALLOWED", "Trainees cannot reserve equipment.", 403);
      }

      // Group rental gate: only the group's claimer can reserve on behalf of
      // the group. Other group members reserve individually like today.
      let groupId: string | null = null;
      if (opts?.groupId) {
        const group = await tx.group.findUnique({ where: { id: opts.groupId } });
        if (!group) throw new ServiceError("NOT_FOUND", "Group not found.", 404);
        if (group.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);
        if (group.claimerUserId !== userId) {
          throw new ServiceError(
            "FORBIDDEN",
            "Only the group's claimer can reserve equipment on behalf of the group.",
            403,
          );
        }
        groupId = group.id;
      }

      // Insurance gate applies to CONTRACTORs only. Employees (including
      // admins/supers, who are W-2) are covered under the company's general
      // liability policy and don't need a personal certificate. Trainees are
      // already blocked by the TRAINEE_NOT_ALLOWED check above. For group
      // rentals the gate stays on the claimer (== userId here) — group
      // members' insurance status doesn't enter the check.
      if (eq.requiresInsurance && user.workerType === "CONTRACTOR") {
        const now = new Date();
        const insured = !!(user.insuranceCertR2Key && user.insuranceExpiresAt && user.insuranceExpiresAt > now);
        if (!insured) {
          throw new ServiceError(
            "INSURANCE_REQUIRED",
            "As a contractor, you need a valid insurance certificate on file to reserve this equipment.",
            403,
          );
        }
      }

      const reserve = await tx.checkout.create({
        data: { equipmentId: id, userId, groupId },
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
    return prisma.$transaction(async (tx) => {
      await lockEquipment(tx, id);

      // 1) Verify item. The QR slug is only checked when one is supplied —
      // returning ("check-in") from the in-app button doesn't require a
      // scan; the physical-sticker scan path (/e/[slug]) still passes a
      // slug and is verified against the item.
      const eq = await tx.equipment.findUnique({ where: { id } });
      if (!eq) throw new ServiceError("NOT_FOUND", "Equipment not found.", 404);
      if (slug) {
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
      }

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

      // 3) Mark returned + compute rental cost
      const now = new Date();
      const holder = await tx.user.findUnique({ where: { id: userId } });
      const rental = computeRentalCost(active.checkedOutAt, now, holder?.workerType, eq.dailyRate);
      const returned = await tx.checkout.update({
        where: { id: active.id },
        data: {
          releasedAt: now,
          ...(rental ? { rentalDays: rental.rentalDays, rentalCost: rental.rentalCost } : {}),
        },
      });
      // Group rentals: materialize per-worker shares now that the total
      // is known. Falls back to even-split when group percents aren't set
      // or don't sum to 100 (defensive — the group's lock-while-in-flight
      // rule should keep the math consistent).
      if ((active as any).groupId && rental?.rentalCost) {
        await writeCheckoutSplits(tx, {
          checkoutId: returned.id,
          groupId: (active as any).groupId as string,
          rentalCost: rental.rentalCost,
        });
      }

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

  async listEquipmentCharges(params?: { userId?: string; from?: string; to?: string }) {
    // When userId is supplied we return *that worker's share* — solo rentals
    // (Checkout.userId === userId) plus group rentals where they have a
    // CheckoutSplit row. Without userId we return all rentals (admin view).
    if (params?.userId) {
      const userId = params.userId;
      const dateRange: any = {};
      if (params.from) dateRange.gte = etMidnight(params.from);
      if (params.to) dateRange.lte = etEndOfDay(params.to);
      const hasDate = !!(params.from || params.to);
      // Solo rentals for this user (no groupId set, rentalCost recorded).
      const solo = await prisma.checkout.findMany({
        where: {
          userId,
          groupId: null,
          rentalCost: { not: null },
          ...(hasDate ? { releasedAt: dateRange } : {}),
        },
        orderBy: { releasedAt: "desc" },
        include: {
          equipment: { select: { id: true, shortDesc: true, brand: true, model: true, dailyRate: true } },
          user: { select: { id: true, displayName: true, email: true, workerType: true } },
          group: { select: { id: true, name: true } },
        },
      });
      // Group rentals where this user has a CheckoutSplit.
      const splits = await prisma.checkoutSplit.findMany({
        where: {
          userId,
          checkout: {
            rentalCost: { not: null },
            ...(hasDate ? { releasedAt: dateRange } : {}),
          },
        },
        orderBy: { checkout: { releasedAt: "desc" } },
        include: {
          checkout: {
            include: {
              equipment: { select: { id: true, shortDesc: true, brand: true, model: true, dailyRate: true } },
              user: { select: { id: true, displayName: true, email: true, workerType: true } },
              group: { select: { id: true, name: true } },
            },
          },
        },
      });
      // Normalize both shapes into a flat list — each entry represents one
      // charge against this user with an explicit amount (their share).
      return [
        ...solo.map((c) => ({
          id: c.id,
          equipment: c.equipment,
          user: c.user,
          group: (c as any).group ?? null,
          checkedOutAt: c.checkedOutAt,
          releasedAt: c.releasedAt,
          rentalDays: c.rentalDays,
          rentalCost: c.rentalCost,
          shareAmount: c.rentalCost ?? 0,
          sharePercent: 100,
          isGroupRental: false,
        })),
        ...splits.map((s) => ({
          id: s.checkout.id,
          equipment: s.checkout.equipment,
          user: s.checkout.user,
          group: (s.checkout as any).group ?? null,
          checkedOutAt: s.checkout.checkedOutAt,
          releasedAt: s.checkout.releasedAt,
          rentalDays: s.checkout.rentalDays,
          rentalCost: s.checkout.rentalCost,
          shareAmount: s.amount,
          sharePercent: s.percent,
          isGroupRental: true,
        })),
      ].sort((a, b) => {
        const ta = a.releasedAt ? a.releasedAt.getTime() : 0;
        const tb = b.releasedAt ? b.releasedAt.getTime() : 0;
        return tb - ta;
      });
    }

    const where: any = { rentalCost: { not: null } };
    if (params?.from || params?.to) {
      where.releasedAt = {};
      if (params.from) where.releasedAt.gte = etMidnight(params.from);
      if (params.to) where.releasedAt.lte = etEndOfDay(params.to);
    }
    return prisma.checkout.findMany({
      where,
      orderBy: { releasedAt: "desc" },
      include: {
        equipment: { select: { id: true, shortDesc: true, brand: true, model: true, dailyRate: true } },
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        group: { select: { id: true, name: true } },
        splits: {
          include: {
            user: { select: { id: true, displayName: true, email: true } },
          },
        },
      },
    });
  },

  // Equipment-usage history for the Usage dashboard. Returns actual checkouts
  // (checkedOutAt set — reservations that were never picked up don't count as
  // usage) overlapping the requested range. With userId the result is scoped
  // to one worker's own checkouts; without it, every worker (admin view).
  async listUsage(params?: { from?: string; to?: string; userId?: string }) {
    const where: any = { checkedOutAt: { not: null } };
    if (params?.to) where.checkedOutAt.lte = etEndOfDay(params.to);
    if (params?.from) {
      // Overlap: the checkout was still open, or released on/after `from`.
      where.OR = [
        { releasedAt: null },
        { releasedAt: { gte: etMidnight(params.from) } },
      ];
    }
    if (params?.userId) where.userId = params.userId;
    const checkouts = await prisma.checkout.findMany({
      where,
      orderBy: { checkedOutAt: "desc" },
      include: {
        equipment: {
          select: { id: true, shortDesc: true, brand: true, model: true, type: true, qrSlug: true },
        },
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        group: { select: { id: true, name: true } },
      },
    });
    return checkouts.map((c) => ({
      id: c.id,
      equipmentId: c.equipmentId,
      equipment: c.equipment,
      user: c.user,
      group: c.group,
      checkedOutAt: c.checkedOutAt,
      releasedAt: c.releasedAt,
      rentalDays: c.rentalDays,
      active: c.releasedAt == null,
    }));
  },
};
