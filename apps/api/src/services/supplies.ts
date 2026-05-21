import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import { parseUserDate } from "../lib/dates";
import { resolvePrivileges } from "../lib/privileges";
import { loadCategoryLabels } from "./expenseCategories";
import type {
  ServicesSupplies,
  SupplyCreateInput,
  SupplyPatchInput,
  SupplyPurchaseInput,
  SupplyAdjustmentInput,
  SupplyHoldInput,
} from "../types/services";

// Workflows whose occurrences don't carry physical supply consumption —
// tasks, reminders, events, followups, and announcements are administrative
// or communication flows, not service work. Inventory holds are blocked on
// these so the connection between them and inventory simply doesn't exist.
const NON_SUPPLY_WORKFLOWS = new Set([
  "TASK",
  "REMINDER",
  "EVENT",
  "FOLLOWUP",
  "ANNOUNCEMENT",
]);

// A Supply's category is validated against the EXPENSE_CATEGORIES taxonomy —
// the same single source of truth used by BusinessExpense and per-job Expense
// rows. Default "Supplies": most lawn-care consumables land on line 22.
const DEFAULT_CATEGORY = "Supplies";

async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true },
  });
  return !!user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
}

async function normalizeCategory(raw: string | null | undefined): Promise<string> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_CATEGORY;
  const labels = await loadCategoryLabels();
  if (!labels.has(trimmed)) {
    throw new ServiceError(
      "INVALID_CATEGORY",
      `Invalid category: "${trimmed}". Must be a Schedule C line.`,
      400,
    );
  }
  return trimmed;
}

function resolveDate(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const d = parseUserDate(raw);
  if (isNaN(d.getTime())) {
    throw new ServiceError("INVALID_DATE", "Invalid date.", 400);
  }
  return d;
}

function requireInt(n: unknown, label: string): number {
  const v = Number(n);
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new ServiceError("INVALID_INPUT", `${label} must be an integer.`, 400);
  }
  return v;
}

function requireNonNegativeNum(n: unknown, label: string): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) {
    throw new ServiceError("INVALID_INPUT", `${label} must be a non-negative number.`, 400);
  }
  return v;
}

const supplyInclude = {
  createdBy: { select: { id: true, displayName: true } },
} as const;

const purchaseInclude = {
  supply: { select: { id: true, name: true, unit: true } },
  businessExpense: true,
  createdBy: { select: { id: true, displayName: true } },
} as const;

const holdInclude = {
  supply: { select: { id: true, name: true, unit: true } },
  expense: true,
  createdBy: { select: { id: true, displayName: true } },
  occurrence: {
    select: {
      id: true,
      startAt: true,
      job: {
        select: {
          id: true,
          property: {
            select: {
              id: true,
              displayName: true,
              client: { select: { displayName: true } },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Compute a supply's currently-held quantity (sum of ACTIVE holds). Used to
 * derive `available = onHand − held` at query/hold-creation time so the
 * physical onHand stays a single source of truth.
 */
async function activeHoldsTotal(tx: any, supplyId: string): Promise<number> {
  const r = await tx.supplyHold.aggregate({
    where: { supplyId, status: "ACTIVE" },
    _sum: { quantity: true },
  });
  return r._sum.quantity ?? 0;
}

export const supplies: ServicesSupplies = {
  async list(opts) {
    const where: any = {};
    if (!opts?.includeArchived) where.archivedAt = null;
    if (opts?.q && opts.q.trim()) {
      const q = opts.q.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { upc: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }
    const rows = await prisma.supply.findMany({
      where,
      orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
      include: supplyInclude,
    });

    // Decorate each row with held + available, computed in a single grouped
    // aggregate to avoid N+1.
    const heldByIdRaw = await prisma.supplyHold.groupBy({
      by: ["supplyId"],
      where: { status: "ACTIVE", supplyId: { in: rows.map((r) => r.id) } },
      _sum: { quantity: true },
    });
    const heldById = new Map<string, number>();
    for (const h of heldByIdRaw) heldById.set(h.supplyId, h._sum.quantity ?? 0);

    // Optional: per-supply ACTIVE hold breakdown for the Admin Inventory view.
    // Single fan-out query (one per call, not per supply) so this stays cheap
    // even with hundreds of supplies.
    let activeHoldsBySupply = new Map<string, any[]>();
    if (opts?.includeHoldDetails && rows.length > 0) {
      const activeHolds = await prisma.supplyHold.findMany({
        where: { status: "ACTIVE", supplyId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          quantity: true,
          jobPayoutCost: true,
          createdAt: true,
          supplyId: true,
          createdBy: { select: { id: true, displayName: true } },
          occurrence: {
            select: {
              id: true,
              startAt: true,
              status: true,
              job: {
                select: {
                  id: true,
                  property: {
                    select: {
                      id: true,
                      displayName: true,
                      client: { select: { id: true, displayName: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      for (const h of activeHolds) {
        const list = activeHoldsBySupply.get(h.supplyId) ?? [];
        list.push(h);
        activeHoldsBySupply.set(h.supplyId, list);
      }
    }

    return rows.map((r) => {
      const held = heldById.get(r.id) ?? 0;
      const decorated: any = { ...r, held, available: r.onHand - held };
      if (opts?.includeHoldDetails) {
        decorated.activeHolds = activeHoldsBySupply.get(r.id) ?? [];
      }
      return decorated;
    });
  },

  async getById(id) {
    const row = await prisma.supply.findUnique({
      where: { id },
      include: supplyInclude,
    });
    if (!row) return null;
    const held = await activeHoldsTotal(prisma, id);
    return { ...row, held, available: row.onHand - held };
  },

  async create(currentUserId, input) {
    const name = (input.name ?? "").trim();
    if (!name) throw new ServiceError("INVALID_INPUT", "Name is required.", 400);
    const unit = (input.unit ?? "").trim();
    if (!unit) throw new ServiceError("INVALID_INPUT", "Unit is required.", 400);

    const category = await normalizeCategory(input.category);
    const businessCost = requireNonNegativeNum(input.businessCost ?? 0, "Business cost");
    const jobPayoutCost = requireNonNegativeNum(input.jobPayoutCost, "Job payout cost");
    const upc = input.upc ? input.upc.trim() || null : null;
    const description = input.description ? input.description.trim() || null : null;

    return prisma.supply.create({
      data: {
        createdById: currentUserId,
        name,
        unit,
        category,
        businessCost,
        jobPayoutCost,
        upc,
        description,
      },
      include: supplyInclude,
    });
  },

  async update(_currentUserId, id, input) {
    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);

    const data: any = {};
    if (input.name !== undefined) {
      const v = input.name.trim();
      if (!v) throw new ServiceError("INVALID_INPUT", "Name is required.", 400);
      data.name = v;
    }
    if (input.unit !== undefined) {
      const v = input.unit.trim();
      if (!v) throw new ServiceError("INVALID_INPUT", "Unit is required.", 400);
      data.unit = v;
    }
    if (input.category !== undefined) data.category = await normalizeCategory(input.category);
    if (input.businessCost !== undefined) {
      data.businessCost = requireNonNegativeNum(input.businessCost ?? 0, "Business cost");
    }
    if (input.jobPayoutCost !== undefined) {
      data.jobPayoutCost = requireNonNegativeNum(input.jobPayoutCost, "Job payout cost");
    }
    if (input.upc !== undefined) {
      data.upc = input.upc ? String(input.upc).trim() || null : null;
    }
    if (input.description !== undefined) {
      data.description = input.description ? String(input.description).trim() || null : null;
    }

    return prisma.supply.update({ where: { id }, data, include: supplyInclude });
  },

  async archive(_currentUserId, id) {
    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    await prisma.supply.update({ where: { id }, data: { archivedAt: new Date() } });
    return { archived: true };
  },

  async unarchive(_currentUserId, id) {
    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    await prisma.supply.update({ where: { id }, data: { archivedAt: null } });
    return { archived: false };
  },

  async recordPurchase(currentUserId, supplyId, input) {
    const supply = await prisma.supply.findUnique({ where: { id: supplyId } });
    if (!supply) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    if (supply.archivedAt) {
      throw new ServiceError("ARCHIVED", "Cannot purchase against an archived supply.", 400);
    }

    const quantity = requireInt(input.quantity, "Quantity");
    if (quantity <= 0) throw new ServiceError("INVALID_INPUT", "Quantity must be positive.", 400);
    const unitCost = requireNonNegativeNum(input.unitCost, "Unit cost");
    if (unitCost <= 0) throw new ServiceError("INVALID_INPUT", "Unit cost must be greater than zero.", 400);

    const date = resolveDate(input.date);
    const vendor = input.vendor ? input.vendor.trim() || null : null;
    const invoiceNumber = input.invoiceNumber ? input.invoiceNumber.trim() || null : null;
    const notes = input.notes ? input.notes.trim() || null : null;
    const totalCost = Math.round(quantity * unitCost * 100) / 100;

    // Dual-write: BusinessExpense (tax ledger) + SupplyPurchase + onHand bump,
    // all in one transaction. The BE description includes the supply name and
    // qty so the ledger reads naturally without joining.
    return prisma.$transaction(async (tx) => {
      const businessExpense = await tx.businessExpense.create({
        data: {
          createdById: currentUserId,
          date,
          cost: totalCost,
          description: `${supply.name} × ${quantity} ${supply.unit}`,
          category: supply.category,
          vendor,
          invoiceNumber,
          notes,
        },
      });
      const purchase = await tx.supplyPurchase.create({
        data: {
          supplyId,
          quantity,
          unitCost,
          totalCost,
          date,
          vendor,
          invoiceNumber,
          notes,
          businessExpenseId: businessExpense.id,
          createdById: currentUserId,
        },
        include: purchaseInclude,
      });
      await tx.supply.update({
        where: { id: supplyId },
        data: {
          onHand: { increment: quantity },
          // last-paid heuristic — keeps the catalog's reference cost current
          businessCost: unitCost,
        },
      });
      return purchase;
    });
  },

  async reversePurchase(_currentUserId, purchaseId) {
    const purchase = await prisma.supplyPurchase.findUnique({
      where: { id: purchaseId },
      include: { supply: true },
    });
    if (!purchase) throw new ServiceError("NOT_FOUND", "Purchase not found.", 404);

    const newOnHand = purchase.supply.onHand - purchase.quantity;
    if (newOnHand < 0) {
      throw new ServiceError(
        "INVENTORY_NEGATIVE",
        `Cannot reverse: would push onHand to ${newOnHand}. Adjust inventory first if some units were already consumed or recorded incorrectly.`,
        409,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.supply.update({
        where: { id: purchase.supplyId },
        data: { onHand: { decrement: purchase.quantity } },
      });
      await tx.supplyPurchase.delete({ where: { id: purchaseId } });
      // Schema FK is Restrict — explicit BE delete required.
      await tx.businessExpense.delete({ where: { id: purchase.businessExpenseId } });
    });
    return { reversed: true };
  },

  async recordAdjustment(currentUserId, supplyId, input) {
    const supply = await prisma.supply.findUnique({ where: { id: supplyId } });
    if (!supply) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);

    const delta = requireInt(input.delta, "Delta");
    if (delta === 0) throw new ServiceError("INVALID_INPUT", "Delta cannot be zero.", 400);
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new ServiceError("INVALID_INPUT", "Reason is required.", 400);

    const newOnHand = supply.onHand + delta;
    if (newOnHand < 0) {
      throw new ServiceError(
        "INVENTORY_NEGATIVE",
        `Adjustment would push onHand to ${newOnHand}.`,
        409,
      );
    }

    return prisma.$transaction(async (tx) => {
      const adjustment = await tx.supplyAdjustment.create({
        data: { supplyId, delta, reason, createdById: currentUserId },
      });
      await tx.supply.update({
        where: { id: supplyId },
        data: { onHand: { increment: delta } },
      });
      return adjustment;
    });
  },

  async listHistory(supplyId) {
    const [purchases, holds, adjustments] = await Promise.all([
      prisma.supplyPurchase.findMany({
        where: { supplyId },
        orderBy: { date: "desc" },
        include: purchaseInclude,
      }),
      prisma.supplyHold.findMany({
        where: { supplyId },
        orderBy: { createdAt: "desc" },
        include: holdInclude,
      }),
      prisma.supplyAdjustment.findMany({
        where: { supplyId },
        orderBy: { createdAt: "desc" },
        include: { createdBy: { select: { id: true, displayName: true } } },
      }),
    ]);
    // Tagged union so the UI can render each kind differently in one timeline.
    const out: Array<{ kind: "PURCHASE" | "HOLD" | "ADJUSTMENT"; at: Date; row: any }> = [];
    for (const p of purchases) out.push({ kind: "PURCHASE", at: p.date, row: p });
    for (const h of holds) out.push({ kind: "HOLD", at: h.createdAt, row: h });
    for (const a of adjustments) out.push({ kind: "ADJUSTMENT", at: a.createdAt, row: a });
    out.sort((a, b) => b.at.getTime() - a.at.getTime());
    return out;
  },

  async addHold(currentUserId, occurrenceId, input) {
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

    if (NON_SUPPLY_WORKFLOWS.has(occ.workflow)) {
      throw new ServiceError(
        "WORKFLOW_NOT_ELIGIBLE",
        `Inventory consumption isn't tracked on ${occ.workflow.toLowerCase()} workflows. Use a custom expense instead.`,
        400,
      );
    }

    const me = await prisma.user.findUnique({
      where: { id: currentUserId },
      include: { roles: true },
    });
    if (!me) throw new ServiceError("NOT_FOUND", "User not found.", 404);
    const priv = resolvePrivileges(me);
    const isClaimer = occ.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId,
    );
    // Admin/super: always allowed. Worker: must be the claimer AND have
    // inventory privilege resolved on (workerType default or override).
    if (!priv.isAdminOrSuper) {
      if (!isClaimer) {
        throw new ServiceError(
          "FORBIDDEN",
          "Only the claimer or an admin can add supplies to an occurrence.",
          403,
        );
      }
      if (!priv.canPullInventory) {
        throw new ServiceError(
          "FORBIDDEN",
          "You don't have permission to pull from inventory. Ask an admin.",
          403,
        );
      }
    }

    const quantity = requireInt(input.quantity, "Quantity");
    if (quantity <= 0) throw new ServiceError("INVALID_INPUT", "Quantity must be positive.", 400);

    const supply = await prisma.supply.findUnique({ where: { id: input.supplyId } });
    if (!supply) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    if (supply.archivedAt) {
      throw new ServiceError("ARCHIVED", "Supply is archived.", 400);
    }

    return prisma.$transaction(async (tx) => {
      // Re-check availability inside the transaction. Two simultaneous holds
      // could otherwise both pass an outer check and combine to over-allocate.
      const held = await activeHoldsTotal(tx, input.supplyId);
      const available = supply.onHand - held;
      if (available < quantity) {
        throw new ServiceError(
          "INSUFFICIENT_INVENTORY",
          `Only ${available} ${supply.unit}(s) of ${supply.name} available (requested ${quantity}).`,
          409,
        );
      }

      const totalCharge = Math.round(quantity * supply.jobPayoutCost * 100) / 100;
      const description = `${supply.name} × ${quantity} ${supply.unit}`;

      // No paired BusinessExpense — the BE was already recorded at purchase
      // time. Recording another here would inflate the tax ledger.
      const expense = await tx.expense.create({
        data: {
          occurrenceId,
          createdById: currentUserId,
          cost: totalCharge,
          description,
        },
      });

      return tx.supplyHold.create({
        data: {
          supplyId: input.supplyId,
          occurrenceId,
          quantity,
          jobPayoutCost: supply.jobPayoutCost,
          status: "ACTIVE",
          expenseId: expense.id,
          createdById: currentUserId,
        },
        include: holdInclude,
      });
    });
  },

  async removeHold(currentUserId, holdId) {
    const hold = await prisma.supplyHold.findUnique({
      where: { id: holdId },
      include: {
        occurrence: { include: { assignees: true } },
      },
    });
    if (!hold) throw new ServiceError("NOT_FOUND", "Hold not found.", 404);

    const isClaimer = hold.occurrence.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId,
    );
    if (!isClaimer && !(await isAdminUser(currentUserId))) {
      throw new ServiceError(
        "FORBIDDEN",
        "Only the claimer or an admin can remove a supply hold.",
        403,
      );
    }

    await prisma.$transaction(async (tx) => {
      // If the hold was already CONSUMED (occurrence completed), removing it
      // means we're undoing the consumption — restore onHand. RELEASED holds
      // already have no inventory effect.
      if (hold.status === "CONSUMED") {
        await tx.supply.update({
          where: { id: hold.supplyId },
          data: { onHand: { increment: hold.quantity } },
        });
      }
      // Delete the paired Expense (cascade to remove payout deduction).
      if (hold.expenseId) {
        await tx.expense.delete({ where: { id: hold.expenseId } }).catch(() => {});
      }
      await tx.supplyHold.delete({ where: { id: holdId } });
    });
    return { removed: true };
  },

  consumeHoldsForOccurrence,
  releaseHoldsForOccurrence,
  reactivateHoldsForOccurrence,
};

// Lifecycle helpers exposed as standalone exports so the jobs service can
// import them directly when status changes, without going through the
// services container (avoids circular imports). Each accepts an optional
// transaction client so callers already inside `prisma.$transaction` can
// pass `tx` and keep all writes in one atomic unit.

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function runInTx<T>(
  tx: TxClient | undefined,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  if (tx) return fn(tx);
  return prisma.$transaction(fn);
}

export async function consumeHoldsForOccurrence(
  occurrenceId: string,
  tx?: TxClient,
): Promise<{ consumed: number }> {
  const reader = tx ?? prisma;
  const active = await reader.supplyHold.findMany({
    where: { occurrenceId, status: "ACTIVE" },
  });
  if (active.length === 0) return { consumed: 0 };

  await runInTx(tx, async (tx) => {
    for (const h of active) {
      await tx.supplyHold.update({
        where: { id: h.id },
        data: { status: "CONSUMED", consumedAt: new Date() },
      });
      await tx.supply.update({
        where: { id: h.supplyId },
        data: { onHand: { decrement: h.quantity } },
      });
    }
  });
  return { consumed: active.length };
}

export async function releaseHoldsForOccurrence(
  occurrenceId: string,
  tx?: TxClient,
): Promise<{ released: number }> {
  const reader = tx ?? prisma;
  const active = await reader.supplyHold.findMany({
    where: { occurrenceId, status: "ACTIVE" },
  });
  if (active.length === 0) return { released: 0 };

  await runInTx(tx, async (tx) => {
    for (const h of active) {
      if (h.expenseId) {
        await tx.expense.delete({ where: { id: h.expenseId } }).catch(() => {});
      }
      await tx.supplyHold.update({
        where: { id: h.id },
        data: { status: "RELEASED", releasedAt: new Date(), expenseId: null },
      });
    }
  });
  return { released: active.length };
}

export async function reactivateHoldsForOccurrence(
  occurrenceId: string,
  tx?: TxClient,
): Promise<{ reactivated: number }> {
  const reader = tx ?? prisma;
  const consumed = await reader.supplyHold.findMany({
    where: { occurrenceId, status: "CONSUMED" },
  });
  if (consumed.length === 0) return { reactivated: 0 };

  await runInTx(tx, async (tx) => {
    for (const h of consumed) {
      await tx.supplyHold.update({
        where: { id: h.id },
        data: { status: "ACTIVE", consumedAt: null },
      });
      await tx.supply.update({
        where: { id: h.supplyId },
        data: { onHand: { increment: h.quantity } },
      });
    }
  });
  return { reactivated: consumed.length };
}
