import { prisma } from "../db/prisma";
import { Prisma, Equipment, EquipmentStatus } from "@prisma/client";
import type { ServicesEquipment, EquipmentWithHolder } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { etMidnight, etEndOfDay } from "../lib/dates";
import { ServiceError } from "../lib/errors";
import { deleteObject } from "../lib/r2";
import { cutoffWhere } from "../lib/businessStartCutoff";

type Tx = Prisma.TransactionClient;

const now = () => new Date();

/** ISO YYYY-MM-DD in Eastern Time for the given Date. */
const ET_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
export function etDayKey(d: Date): string {
  return ET_DAY_FMT.format(d);
}

/** Per-day line in the rental breakdown, for receipts and audit metadata. */
export type RentalBreakdownLine = {
  /** ET calendar day, YYYY-MM-DD. */
  day: string;
  /** Job count counted toward this day. `null` for flat-daily billing
   *  (the model isn't job-driven, so the count is irrelevant). */
  jobs: number | null;
  /** Dollars billed for this day. */
  subtotal: number;
  /** True iff `subtotal` hit the daily cap. Always true for flat-daily. */
  capped: boolean;
};

/** Internal helper: list the ET calendar days in the closed interval
 *  `[from, to]`, inclusive of both ends. Same day = ["yyyy-mm-dd"]. */
function listEtDaysBetween(from: Date, to: Date): string[] {
  const toUtcNoon = (d: Date) => {
    const [y, m, day] = ET_DAY_FMT.format(d).split("-").map(Number);
    return Date.UTC(y, m - 1, day, 12);
  };
  const startUtc = toUtcNoon(from);
  const endUtc = toUtcNoon(to);
  if (endUtc < startUtc) return [];
  const days: string[] = [];
  for (let t = startUtc; t <= endUtc; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Compute the rental cost for a checkout.
 *
 * Two billing models coexist, selected per piece of equipment:
 *
 *   1. **Flat daily** (when `Equipment.equivalentJobs IS NULL`):
 *      `rentalCost = rentalDays × dailyRate`. The legacy model.
 *
 *   2. **Per-job with per-day cap** (when `Equipment.equivalentJobs` is set):
 *      For each ET calendar day in the rental window:
 *        perJob = dailyRate / equivalentJobs
 *        daySubtotal = min(jobsOnThisDay × perJob, dailyRate)
 *      `rentalCost = Σ daySubtotal`
 *      Jobs that count are those whose `completedAt` is within
 *      `[checkedOutAt, releasedAt]` and that match the formal-crew
 *      assignment (`assignedGroupId == checkout.groupId`) for crew
 *      rentals, or have this contractor as an assignee for solo. The
 *      caller is responsible for fetching + bucketing those jobs into
 *      `jobsByDay` keyed on ET calendar day before calling.
 *
 * Worker-type gating is NOT done here. This function returns the
 * **notional** rental cost as if it were billable. The caller (and
 * `writeCheckoutSplits` for groups) decides who actually pays — employees
 * and trainees show up with `amount = 0` because their equipment usage is
 * already covered by the higher business margin on their jobs.
 *
 * Returns null only on missing required inputs (no checkedOutAt, no rate,
 * or zero/negative rate). A zero-cost result (e.g., 0 jobs all days in
 * per-job mode) returns a valid object with `rentalCost = 0`.
 *
 * Exported for unit-test coverage (equipment.test.ts).
 */
export function computeRentalCost(
  checkedOutAt: Date | null,
  releasedAt: Date,
  dailyRate: number | null,
  equivalentJobs: number | null,
  jobsByDay: Record<string, number> | null,
): { rentalDays: number; rentalCost: number; breakdown: RentalBreakdownLine[] } | null {
  if (!checkedOutAt) return null;
  if (!dailyRate || dailyRate <= 0) return null;

  const days = listEtDaysBetween(checkedOutAt, releasedAt);
  const rentalDays = Math.max(1, days.length);

  // Flat-daily mode (legacy). One subtotal per day at the full daily rate.
  if (equivalentJobs == null || equivalentJobs <= 0) {
    const breakdown: RentalBreakdownLine[] = days.map((day) => ({
      day,
      jobs: null,
      subtotal: dailyRate,
      capped: true,
    }));
    // Guard rentalDays >= 1 (matches legacy ET-inclusive math).
    const rentalCost = Math.round(rentalDays * dailyRate * 100) / 100;
    return { rentalDays, rentalCost, breakdown };
  }

  // Per-job mode. Bucketed job counts must be provided by the caller.
  const perJob = dailyRate / equivalentJobs;
  const buckets = jobsByDay ?? {};
  const breakdown: RentalBreakdownLine[] = days.map((day) => {
    const n = buckets[day] ?? 0;
    const raw = n * perJob;
    const capped = raw >= dailyRate;
    const subtotal = capped ? dailyRate : Math.round(raw * 100) / 100;
    return { day, jobs: n, subtotal, capped };
  });
  const rentalCost = Math.round(breakdown.reduce((s, b) => s + b.subtotal, 0) * 100) / 100;
  return { rentalDays, rentalCost, breakdown };
}

/**
 * Fetch the JobOccurrence rows that count toward a given checkout's
 * job-driven billing, and bucket their `completedAt` by ET calendar day.
 *
 * Solo checkouts count jobs where this contractor was an assignee (role
 * != observer) AND the job has no `assignedGroupId` (solo work, not a
 * crew-assigned job — those are billed via the crew checkout, if any).
 *
 * Group checkouts count jobs where `assignedGroupId == groupId` (formal-
 * crew jobs only — solo claims by members don't bleed in).
 *
 * Both are restricted to workflow STANDARD/ONE_OFF in a finished status
 * (COMPLETED/CLOSED/PENDING_PAYMENT). Estimates, tasks, reminders,
 * announcements, events, and followups never count.
 */
export async function fetchJobsByDayForCheckout(
  tx: Tx,
  ctx: { userId: string; groupId: string | null; checkedOutAt: Date; releasedAt: Date },
): Promise<Record<string, number>> {
  const baseWhere: Prisma.JobOccurrenceWhereInput = {
    workflow: { in: ["STANDARD", "ONE_OFF"] as any },
    status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
    completedAt: { gte: ctx.checkedOutAt, lte: ctx.releasedAt },
  };
  const scopeWhere: Prisma.JobOccurrenceWhereInput = ctx.groupId
    ? { assignedGroupId: ctx.groupId }
    : {
        assignedGroupId: null,
        assignees: { some: { userId: ctx.userId, role: { not: "observer" } } },
      };
  const jobs = await tx.jobOccurrence.findMany({
    where: { ...baseWhere, ...scopeWhere },
    select: { completedAt: true },
  });
  const buckets: Record<string, number> = {};
  for (const j of jobs) {
    if (!j.completedAt) continue;
    const key = etDayKey(j.completedAt);
    buckets[key] = (buckets[key] ?? 0) + 1;
  }
  return buckets;
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
/**
 * Pure splitter math. Exported for unit-test coverage (equipment.test.ts);
 * the DB-writing wrapper `writeCheckoutSplits` below calls into this.
 *
 * Given a rental total and the workers in a group (claimer + non-observer
 * members) along with their worker types, returns the per-worker share
 * rows and the actually-billed contractor total.
 *
 * Policy:
 *   • Percent allocation uses each worker's `equipmentCostPercent` when
 *     EVERY worker has one and they sum to 100 (tolerance 0.001). Else
 *     even-split.
 *   • EMPLOYEE / TRAINEE workers get `amount = 0` after allocation. Their
 *     equipment usage is already covered upstream by the higher business
 *     margin charged on their jobs (no actual loss to the business —
 *     it's an accounting note that the cost was paid elsewhere). The row
 *     itself is preserved so the audit trail keeps a record that the
 *     employee was on the crew.
 *   • CONTRACTOR and unclassified-null workers are billable.
 *   • Unbilled shares are NOT redistributed to remaining contractors —
 *     that would punish contractors for crewing with employees.
 */
export function calculateContractorSplits(
  workers: Array<{ userId: string; equipmentCostPercent: number | null; workerType: string | null }>,
  rentalCost: number,
): {
  splits: Array<{ userId: string; percent: number; amount: number }>;
  contractorTotal: number;
} {
  if (workers.length === 0) return { splits: [], contractorTotal: 0 };
  const customSet = workers.filter((w) => w.equipmentCostPercent != null);
  const useCustom =
    customSet.length === workers.length &&
    Math.abs(workers.reduce((s, w) => s + (w.equipmentCostPercent ?? 0), 0) - 100) < 0.001;
  let contractorTotal = 0;
  const seen = new Set<string>();
  const splits: Array<{ userId: string; percent: number; amount: number }> = [];
  for (const w of workers) {
    // De-dupe in case the claimer was also listed in members (the group
    // invariants shouldn't allow this, but stay defensive — without dedup
    // a claimer-as-member would double-bill).
    if (seen.has(w.userId)) continue;
    seen.add(w.userId);
    const percent = useCustom ? (w.equipmentCostPercent ?? 0) : 100 / workers.length;
    const rawShare = Math.round(rentalCost * (percent / 100) * 100) / 100;
    const billable = w.workerType === "CONTRACTOR" || w.workerType === null;
    const amount = billable ? rawShare : 0;
    contractorTotal += amount;
    splits.push({
      userId: w.userId,
      percent: Math.round(percent * 1e4) / 1e4,
      amount,
    });
  }
  return { splits, contractorTotal: Math.round(contractorTotal * 100) / 100 };
}

/**
 * Materialize CheckoutSplit rows for a finished group rental and return
 * the sum of contractor billings (which the caller writes into
 * `Checkout.rentalCost` as the "actual income from this checkout").
 * Math lives in `calculateContractorSplits`; this wrapper just does the
 * DB I/O.
 */
async function writeCheckoutSplits(
  tx: Tx,
  params: { checkoutId: string; groupId: string; rentalCost: number },
): Promise<{ contractorTotal: number }> {
  const { checkoutId, groupId, rentalCost } = params;
  const group = await tx.group.findUnique({
    where: { id: groupId },
    include: { members: { select: { userId: true, role: true, equipmentCostPercent: true } } },
  });
  if (!group) return { contractorTotal: 0 };
  // Claimer counts as a worker for cost-split purposes.
  const baseWorkers: Array<{ userId: string; equipmentCostPercent: number | null }> = [
    { userId: group.claimerUserId, equipmentCostPercent: null },
    ...group.members
      .filter((m) => m.role !== "observer")
      .map((m) => ({ userId: m.userId, equipmentCostPercent: m.equipmentCostPercent })),
  ];
  if (baseWorkers.length === 0) return { contractorTotal: 0 };

  // Resolve workerType for each worker — needed to zero out W-2 / trainee
  // shares. One query for all of them avoids a per-member round-trip.
  const userIds = [...new Set(baseWorkers.map((w) => w.userId))];
  const users = await tx.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, workerType: true },
  });
  const wtById = new Map(users.map((u) => [u.id, u.workerType]));

  const workers = baseWorkers.map((w) => ({
    ...w,
    workerType: wtById.get(w.userId) ?? null,
  }));
  const { splits, contractorTotal } = calculateContractorSplits(workers, rentalCost);

  for (const s of splits) {
    await tx.checkoutSplit.upsert({
      where: { checkoutId_userId: { checkoutId, userId: s.userId } },
      create: { checkoutId, userId: s.userId, percent: s.percent, amount: s.amount },
      update: { percent: s.percent, amount: s.amount },
    });
  }
  return { contractorTotal };
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
      equivalentJobs?: number | null;
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
        ...(input.equivalentJobs !== undefined ? { equivalentJobs: input.equivalentJobs } : {}),
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
        | "equivalentJobs"
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
      if (patch.equivalentJobs !== undefined) data.equivalentJobs = patch.equivalentJobs;
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
        const groupId = (active as any).groupId as string | null;
        // For per-job mode, fetch the formal-crew (or solo) jobs whose
        // completedAt falls in the rental window and bucket them by ET
        // day. Skipped (passed as null) when the piece is on the legacy
        // flat-daily model — the cost helper ignores buckets in that case.
        const jobsByDay =
          active.checkedOutAt && eq?.equivalentJobs != null && eq.equivalentJobs > 0
            ? await fetchJobsByDayForCheckout(tx, {
                userId: active.userId,
                groupId,
                checkedOutAt: active.checkedOutAt,
                releasedAt,
              })
            : null;
        const rental = computeRentalCost(
          active.checkedOutAt,
          releasedAt,
          eq?.dailyRate ?? null,
          eq?.equivalentJobs ?? null,
          jobsByDay,
        );
        // First write rentalDays + the per-day breakdown. The breakdown is
        // load-bearing for receipts + worker money tab — without it the
        // worker just sees a total with no audit trail. rentalCost is
        // overwritten below by the solo / group billing logic.
        const checkout = await tx.checkout.update({
          where: { id: active.id },
          data: {
            releasedAt,
            ...(rental ? { rentalDays: rental.rentalDays, rentalBreakdown: rental.breakdown as any } : {}),
          },
        });
        if (rental) {
          if (groupId) {
            const { contractorTotal } = await writeCheckoutSplits(tx, {
              checkoutId: checkout.id,
              groupId,
              rentalCost: rental.rentalCost,
            });
            // Checkout.rentalCost stores the *actual* billed total — sum
            // of contractor splits, not the notional pre-split cost. That
            // way the QB Income export can keep reading the parent row.
            await tx.checkout.update({
              where: { id: checkout.id },
              data: { rentalCost: contractorTotal },
            });
          } else {
            // Solo: only contractors (or unclassified, treated as
            // contractor for billing) actually pay. Employees + trainees
            // get rentalCost = 0 even though rentalDays is recorded.
            const wt = holder?.workerType ?? null;
            const billable = wt === "CONTRACTOR" || wt === null;
            await tx.checkout.update({
              where: { id: checkout.id },
              data: { rentalCost: billable ? rental.rentalCost : 0 },
            });
          }
        }
        const updated = await tx.equipment.update({
          where: { id },
          data: { status: EquipmentStatus.AVAILABLE },
        });

        await writeAudit(tx, AUDIT.EQUIPMENT.FORCE_RELEASED, currentUserId, {
          equipmentRecord: updated,
          checkoutRecord: checkout,
          // Carry the per-day breakdown so the audit log lets an admin
          // reconstruct any charge (per issue #17 from the design doc).
          rentalBreakdown: rental?.breakdown ?? null,
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

      // 3) Mark returned + compute rental cost. Same dance as release()
      // above: fetch jobs for per-job mode, compute notional, split or
      // direct-bill, write actual contractor total to Checkout.rentalCost.
      const now = new Date();
      const holder = await tx.user.findUnique({ where: { id: userId } });
      const groupId = (active as any).groupId as string | null;
      const jobsByDay =
        active.checkedOutAt && eq.equivalentJobs != null && eq.equivalentJobs > 0
          ? await fetchJobsByDayForCheckout(tx, {
              userId: active.userId,
              groupId,
              checkedOutAt: active.checkedOutAt,
              releasedAt: now,
            })
          : null;
      const rental = computeRentalCost(
        active.checkedOutAt,
        now,
        eq.dailyRate,
        eq.equivalentJobs ?? null,
        jobsByDay,
      );
      const returned = await tx.checkout.update({
        where: { id: active.id },
        data: {
          releasedAt: now,
          ...(rental ? { rentalDays: rental.rentalDays, rentalBreakdown: rental.breakdown as any } : {}),
        },
      });
      if (rental) {
        if (groupId) {
          const { contractorTotal } = await writeCheckoutSplits(tx, {
            checkoutId: returned.id,
            groupId,
            rentalCost: rental.rentalCost,
          });
          await tx.checkout.update({
            where: { id: returned.id },
            data: { rentalCost: contractorTotal },
          });
        } else {
          const wt = holder?.workerType ?? null;
          const billable = wt === "CONTRACTOR" || wt === null;
          await tx.checkout.update({
            where: { id: returned.id },
            data: { rentalCost: billable ? rental.rentalCost : 0 },
          });
        }
      }

      // 4) Flip equipment status back to AVAILABLE (adjust if your app uses a different state machine)
      const updated = await tx.equipment.update({
        where: { id },
        data: { status: EquipmentStatus.AVAILABLE },
      });

      await writeAudit(tx, AUDIT.EQUIPMENT.RETURNED, currentUserId, {
        equipmentRecord: { ...updated },
        checkoutRecord: { ...returned },
        rentalBreakdown: rental?.breakdown ?? null,
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

  async listEquipmentCharges(params?: { userId?: string; from?: string; to?: string; cutoff?: Date | null }) {
    // When userId is supplied we return *that worker's share* — solo rentals
    // (Checkout.userId === userId) plus group rentals where they have a
    // CheckoutSplit row. Without userId we return all rentals (admin view).
    //
    // Business Start Date filter — pre-cutoff charges (by releasedAt) hidden.
    // Anchored on releasedAt because rentalCost only materializes at release;
    // still-active checkouts (releasedAt=null) are already excluded by the
    // `rentalCost: { not: null }` predicate. See lib/businessStartCutoff.ts.
    const cutoff = params?.cutoff ?? null;
    if (params?.userId) {
      const userId = params.userId;
      const dateRange: any = {};
      if (params.from) dateRange.gte = etMidnight(params.from);
      if (params.to) dateRange.lte = etEndOfDay(params.to);
      const hasDate = !!(params.from || params.to);
      // Solo rentals for this user (no groupId set). We filter to
      // `rentalCost: { gt: 0 }` so solo employee rentals (which now record
      // rentalCost = 0 since employees don't pay) don't surface as a
      // confusing "$0 charge" line in the worker money tab.
      const solo = await prisma.checkout.findMany({
        where: {
          userId,
          groupId: null,
          rentalCost: { gt: 0 },
          ...(hasDate ? { releasedAt: dateRange } : {}),
          ...cutoffWhere("Checkout", cutoff),
        },
        orderBy: { releasedAt: "desc" },
        include: {
          equipment: { select: { id: true, shortDesc: true, brand: true, model: true, dailyRate: true, equivalentJobs: true } },
          user: { select: { id: true, displayName: true, email: true, workerType: true } },
          group: { select: { id: true, name: true } },
        },
      });
      // Group rentals where this user has a CheckoutSplit. We require
      // `amount: { gt: 0 }` so employee/trainee splits (which the splitter
      // zeros out — usage covered by their business margin) stay out of
      // the money tab. Their audit-trail row still exists on the parent
      // Checkout; we just don't surface it as a charge to the user.
      const splits = await prisma.checkoutSplit.findMany({
        where: {
          userId,
          amount: { gt: 0 },
          checkout: {
            ...(hasDate ? { releasedAt: dateRange } : {}),
            ...cutoffWhere("Checkout", cutoff),
          },
        },
        orderBy: { checkout: { releasedAt: "desc" } },
        include: {
          checkout: {
            include: {
              equipment: { select: { id: true, shortDesc: true, brand: true, model: true, dailyRate: true, equivalentJobs: true } },
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
          // Per-day breakdown — shape matches RentalBreakdownLine. The
          // worker money tab can render this verbatim for an audit trail
          // of how each day's charge was computed.
          rentalBreakdown: (c as any).rentalBreakdown ?? null,
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
          rentalBreakdown: (s.checkout as any).rentalBreakdown ?? null,
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
    // Business Start Date filter — admin all-charges view.
    if (cutoff) {
      where.releasedAt = { ...(where.releasedAt ?? {}), gte: where.releasedAt?.gte && where.releasedAt.gte.getTime() >= cutoff.getTime() ? where.releasedAt.gte : cutoff };
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
