import { Prisma } from "@prisma/client";
import { fifoCost, type SupplyCostEvent, type SupplyCostResult } from "../lib/supplyCost";
import { getDownloadUrl } from "../lib/r2";
import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import { parseUserDate } from "../lib/dates";
import { resolvePrivileges } from "../lib/privileges";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
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

/**
 * A supply's category is a GROUPING LABEL — "Fuel", "Chemicals" — and nothing
 * more. Its only consumer is a badge on the Supplies list.
 *
 * It used to be validated against the Schedule C line list and rejected
 * anything else: `Invalid category: "X". Must be a Schedule C line.` That made
 * sense when recording a purchase dual-wrote a BusinessExpense and the label
 * chose the tax line. It stopped writing that ledger row — a purchase tracks
 * stock, not taxes — but the validation stayed, so the service still demanded
 * a tax category for an object that produces no deduction.
 *
 * Removing the picker from the dialog without this would have left a backend
 * that rejects any label a future UI sends.
 */
async function normalizeCategory(raw: string | null | undefined): Promise<string> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_CATEGORY;
  if (trimmed.length > 40) {
    throw new ServiceError("INVALID_CATEGORY", "Category is too long (40 characters max).", 400);
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

/**
 * The client-visible detail for an inventory-backed line.
 *
 * "6 × 1 gallon @ $54.00". The multiplication sign is load-bearing: it reads
 * as "six of these", so the unit never has to be a pluralizable noun. Real
 * production units are "1 ft", "1 gallon", "3 oz (1 gallon mix)" and
 * "2 CU FT" — the obvious `${qty} ${unit}s at $${price}` renders the third as
 * "6 3 oz (1 gallon mix)s at $2.00".
 *
 * PRICED FROM THE HOLD'S SNAPSHOT, not the catalog. What a client pays is
 * chosen per pull and can differ between clients for the same item; the
 * catalog value is only what the pull dialog pre-fills.
 */
export function supplyChargeDetail(
  quantity: number,
  unit: string,
  clientUnitPrice: number,
): string {
  return `${quantity} × ${unit} @ $${clientUnitPrice.toFixed(2)}`;
}

const supplyInclude = Prisma.validator<Prisma.SupplyInclude>()({
  createdBy: { select: { id: true, displayName: true } },
  // FIRST PHOTO ONLY, for the list thumbnail. Equipment lazy-loads its
  // thumbnails per row behind an IntersectionObserver because there can be
  // hundreds of them; a supply catalog is small and presigning is a local
  // signature computation, not a network call, so shipping the URL with the
  // row costs less than one request per row would.
  photos: {
    orderBy: { sortOrder: "asc" },
    take: 1,
    select: { id: true, r2Key: true, description: true },
  },
  _count: { select: { photos: true } },
});

/** Presigned URL of a row's first photo, or null. Never throws — a broken
 *  thumbnail must not take down the Supplies list. */
async function thumbnailFor(row: { photos: Array<{ r2Key: string }> }): Promise<string | null> {
  const first = row.photos?.[0];
  if (!first) return null;
  try {
    return await getDownloadUrl(first.r2Key, 86400, "equipment-photos");
  } catch {
    return null;
  }
}

const purchaseInclude = Prisma.validator<Prisma.SupplyPurchaseInclude>()({
  supply: { select: { id: true, name: true, unit: true } },
  businessExpense: true,
  createdBy: { select: { id: true, displayName: true } },
});

const holdInclude = Prisma.validator<Prisma.SupplyHoldInclude>()({
  supply: { select: { id: true, name: true, unit: true } },
  invoiceCharge: true,
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
});

/**
 * Compute a supply's currently-held quantity (sum of ACTIVE holds). Used to
 * derive `available = onHand − held` at query/hold-creation time so the
 * physical onHand stays a single source of truth.
 */
/**
 * Take a row lock on the supply and return its CURRENT on-hand count.
 *
 * A re-read inside the transaction is not enough, and the code here claimed
 * otherwise for a long time. At READ COMMITTED — Postgres's default, and
 * Prisma's — two concurrent transactions both see the same snapshot, both
 * compute the same availability and both pass. Two workers pulling the last
 * bags of mulch at the same moment took twelve units off a shelf holding ten.
 *
 * `FOR UPDATE` serialises them on the Supply row: the second waits for the
 * first to commit, then reads the state it left behind.
 */
/**
 * Every CATALOG mutation is admin-or-super. Pulling stock onto a job is not —
 * a claimer does that from the field, and the route already scopes it.
 *
 * The routes are all superGuard'd, so this is defence in depth rather than the
 * only lock. It exists because the sibling service (invoiceCharges) guards
 * itself the same way, and an inconsistency there is how a route eventually
 * gets registered without a guard and nobody notices: an adversarial pass
 * found a worker could reprice the catalog, restock it and adjust counts by
 * calling these functions directly.
 */
async function requireCatalogAdmin(currentUserId: string, verb: string): Promise<void> {
  const me = await prisma.user.findUnique({
    where: { id: currentUserId },
    include: { roles: true },
  });
  if (!me) throw new ServiceError("NOT_FOUND", "User not found.", 404);
  if (!resolvePrivileges(me).isAdminOrSuper) {
    throw new ServiceError(
      "FORBIDDEN",
      `Only an admin can ${verb} — it changes what every future job is billed.`,
      403,
    );
  }
}

async function lockSupplyOnHand(tx: any, supplyId: string): Promise<number> {
  const rows: Array<{ onHand: number }> = await tx.$queryRaw`
    SELECT "onHand" FROM "Supply" WHERE "id" = ${supplyId} FOR UPDATE`;
  if (!rows.length) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
  return Number(rows[0].onHand);
}

async function activeHoldsTotal(tx: any, supplyId: string): Promise<number> {
  const r = await tx.supplyHold.aggregate({
    where: { supplyId, status: "ACTIVE" },
    _sum: { quantity: true },
  });
  return r._sum.quantity ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the stock on hand cost, derived from the event log.
//
// THREE QUERIES FOR THE WHOLE PAGE, not three per supply. The Supplies tab
// lists every supply, so a per-row replay would be a textbook N+1.
//
// The average is NEVER stored. `Supply.businessCost` used to hold it and was
// overwritten by each purchase; see lib/supplyCost.ts for why deriving it is
// what makes reverting a payment and correcting a receipt come out right.
// ─────────────────────────────────────────────────────────────────────────────
async function costBySupply(supplyIds: string[]): Promise<Map<string, SupplyCostResult>> {
  const out = new Map<string, SupplyCostResult>();
  if (supplyIds.length === 0) return out;

  const [purchases, consumed, adjustments] = await Promise.all([
    prisma.supplyPurchase.findMany({
      where: { supplyId: { in: supplyIds } },
      // totalCost, NOT unitCost. The stored unitCost is a rounded display
      // derivation; feeding it back in multiplies its rounding error by the
      // unit count. See lib/supplyCost.ts.
      select: { supplyId: true, quantity: true, totalCost: true, date: true },
    }),
    // ONLY status CONSUMED. An ACTIVE hold is stock reserved for a job, not
    // stock off the shelf — drawing its layer would make the average describe
    // available units while the column beside it counts on-hand ones.
    // RELEASED never left at all.
    prisma.supplyHold.findMany({
      where: { supplyId: { in: supplyIds }, status: "CONSUMED" },
      select: { supplyId: true, quantity: true, consumedAt: true, createdAt: true },
    }),
    prisma.supplyAdjustment.findMany({
      where: { supplyId: { in: supplyIds } },
      select: { supplyId: true, delta: true, createdAt: true },
    }),
  ]);

  const events = new Map<string, SupplyCostEvent[]>();
  const push = (id: string, e: SupplyCostEvent) => {
    const list = events.get(id);
    if (list) list.push(e);
    else events.set(id, [e]);
  };
  for (const p of purchases)
    push(p.supplyId, { kind: "BUY", at: p.date, quantity: p.quantity, totalCost: p.totalCost });
  for (const h of consumed)
    // `consumedAt` is set when the hold is consumed and cleared when a payment
    // is reverted, so it is the event's real date. createdAt is a fallback for
    // any row predating that column being populated.
    push(h.supplyId, { kind: "CONSUME", at: h.consumedAt ?? h.createdAt, quantity: h.quantity });
  for (const a of adjustments)
    push(a.supplyId, { kind: "ADJUST", at: a.createdAt, delta: a.delta });

  for (const id of supplyIds) out.set(id, fifoCost(events.get(id) ?? []));
  return out;
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
        // The Group label is rendered as a badge beside the name, so it reads
        // as part of the row — searching "Fuel" and getting nothing back makes
        // the badge look like a filter that does not work.
        { category: { contains: q, mode: "insensitive" } },
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
          clientUnitPrice: true,
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

    const costs = await costBySupply(rows.map((r) => r.id));
    const thumbs = new Map<string, string | null>(
      await Promise.all(
        rows.map(async (r) => [r.id, await thumbnailFor(r)] as [string, string | null]),
      ),
    );

    return rows.map((r) => {
      const held = heldById.get(r.id) ?? 0;
      const cost = costs.get(r.id);
      const decorated: any = {
        ...r,
        held,
        available: r.onHand - held,
        averageCost: cost?.averageCost ?? null,
        valueOnHand: cost?.valueOnHand ?? null,
        thumbnailUrl: thumbs.get(r.id) ?? null,
        photoCount: (r as any)._count?.photos ?? 0,
      };
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
    const cost = (await costBySupply([id])).get(id);
    return {
      ...row,
      held,
      available: row.onHand - held,
      averageCost: cost?.averageCost ?? null,
      valueOnHand: cost?.valueOnHand ?? null,
      thumbnailUrl: await thumbnailFor(row),
      photoCount: (row as any)._count?.photos ?? 0,
    };
  },

  async create(currentUserId, input) {
    await requireCatalogAdmin(currentUserId, "add a supply");
    const name = (input.name ?? "").trim();
    if (!name) throw new ServiceError("INVALID_INPUT", "Name is required.", 400);
    const unit = (input.unit ?? "").trim();
    if (!unit) throw new ServiceError("INVALID_INPUT", "Unit is required.", 400);

    const category = await normalizeCategory(input.category);
    const clientUnitPrice = requireNonNegativeNum(input.clientUnitPrice, "Default client price");
    const upc = input.upc ? input.upc.trim() || null : null;
    const description = input.description ? input.description.trim() || null : null;

    return prisma.$transaction(async (tx) => {
      const supply = await tx.supply.create({
        data: {
          createdById: currentUserId,
          name,
          unit,
          category,
          clientUnitPrice,
          upc,
          description,
        },
        include: supplyInclude,
      });
      // A new catalog row sets the price that flows into money later:
      // clientUnitPrice is what the CLIENT is charged per unit pulled onto a
      // job. `category` is a grouping label only — a supply files under no
      // tax line, because buying one records no deduction.
      await writeAudit(tx, AUDIT.SUPPLY.CREATED, currentUserId, {
        supplyId: supply.id,
        name,
        unit,
        category,
        clientUnitPrice,
        upc,
      });
      return supply;
    });
  },

  async update(currentUserId, id, input) {
    await requireCatalogAdmin(currentUserId, "change a supply");
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
    if (input.clientUnitPrice !== undefined) {
      data.clientUnitPrice = requireNonNegativeNum(input.clientUnitPrice, "Default client price");
    }
    if (input.upc !== undefined) {
      data.upc = input.upc ? String(input.upc).trim() || null : null;
    }
    if (input.description !== undefined) {
      data.description = input.description ? String(input.description).trim() || null : null;
    }

    return prisma.$transaction(async (tx) => {
      const updated = await tx.supply.update({ where: { id }, data, include: supplyInclude });
      // Repricing is a money change with a delayed blast radius:
      // clientUnitPrice sets the DEFAULT a future hold bills the client, and
      // it never comes out of a worker's pay. What the stock cost is not
      // settable here at all — it is derived from the purchases.
      await writeAudit(tx, AUDIT.SUPPLY.UPDATED, currentUserId, {
        supplyId: id,
        nameBefore: existing.name,
        nameAfter: updated.name,
        // Renamed with the column. Audit rows written before 2026-09-08 carry
        // `jobPayoutCostBefore/After` — the History tab renders metadata as
        // raw JSON, so nothing breaks; the old key simply means the same
        // thing under the name that described it wrongly.
        clientUnitPriceBefore: existing.clientUnitPrice,
        clientUnitPriceAfter: updated.clientUnitPrice,
        categoryBefore: existing.category,
        categoryAfter: updated.category,
        unitBefore: existing.unit,
        unitAfter: updated.unit,
        changedFields: Object.keys(data),
      });
      return updated;
    });
  },

  async archive(currentUserId, id) {
    await requireCatalogAdmin(currentUserId, "archive a supply");
    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    await prisma.$transaction(async (tx) => {
      await tx.supply.update({ where: { id }, data: { archivedAt: new Date() } });
      // Archiving blocks new purchases and new holds against this supply —
      // it takes the item out of both the tax-deduction and payout-charge
      // paths, so it needs to be attributable.
      await writeAudit(tx, AUDIT.SUPPLY.ARCHIVED, currentUserId, {
        supplyId: id,
        name: existing.name,
        onHand: existing.onHand,
        clientUnitPrice: existing.clientUnitPrice,
      });
    });
    return { archived: true };
  },

  async unarchive(currentUserId, id) {
    await requireCatalogAdmin(currentUserId, "unarchive a supply");
    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    await prisma.$transaction(async (tx) => {
      await tx.supply.update({ where: { id }, data: { archivedAt: null } });
      // Puts the supply back in circulation: purchases (tax deductions) and
      // holds (payout charges) become possible again.
      await writeAudit(tx, AUDIT.SUPPLY.UNARCHIVED, currentUserId, {
        supplyId: id,
        name: existing.name,
        onHand: existing.onHand,
        clientUnitPrice: existing.clientUnitPrice,
      });
    });
    return { archived: false };
  },

  async recordPurchase(currentUserId, supplyId, input) {
    await requireCatalogAdmin(currentUserId, "record a purchase");
    const supply = await prisma.supply.findUnique({ where: { id: supplyId } });
    if (!supply) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);
    if (supply.archivedAt) {
      throw new ServiceError("ARCHIVED", "Cannot purchase against an archived supply.", 400);
    }

    const quantity = requireInt(input.quantity, "Quantity");
    if (quantity <= 0) throw new ServiceError("INVALID_INPUT", "Quantity must be positive.", 400);
    const totalCost = Math.round(requireNonNegativeNum(input.totalCost, "Total cost") * 100) / 100;
    if (totalCost <= 0) throw new ServiceError("INVALID_INPUT", "Total cost must be greater than zero.", 400);
    // The receipt total (incl. tax and discounts) is the source of truth.
    // Per-unit cost is derived — a reference/display figure only.
    const unitCost = Math.round((totalCost / quantity) * 100) / 100;

    const date = resolveDate(input.date);
    const vendor = input.vendor ? input.vendor.trim() || null : null;
    const invoiceNumber = input.invoiceNumber ? input.invoiceNumber.trim() || null : null;
    const notes = input.notes ? input.notes.trim() || null : null;

    // NO LEDGER ROW. Recording a purchase tracks STOCK, not taxes.
    //
    // This used to dual-write a BusinessExpense, so the same money was
    // deducted twice the moment the operator also entered the real card
    // charge from their bank statement — which they must, because that is
    // the actual record. The deduction is that charge; a purchase here may
    // optionally point at it via `businessExpenseId`, as a MANY-TO-ONE
    // breadcrumb (one $500 receipt covers several purchases).
    //
    // See docs/features/job-materials.md.
    return prisma.$transaction(async (tx) => {
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
          // Optional breadcrumb, set later from the Supplies tab. Never
          // populated automatically — nothing here creates a ledger row.
          businessExpenseId: input.businessExpenseId ?? null,
          createdById: currentUserId,
        },
        include: purchaseInclude,
      });
      await tx.supply.update({
        where: { id: supplyId },
        data: { onHand: { increment: quantity } },
      });
      // NOTHING ELSE IS WRITTEN. This row IS the cost record: it is a FIFO
      // layer of `quantity` units at `unitCost`, and the catalog's average is
      // replayed from it. The catalog used to carry a `businessCost` that
      // every purchase silently overwrote, so recording a receipt quietly
      // restated what all existing stock had cost.
      //
      // Creates NO tax deduction either — that is the card charge in the Ledger.
      await writeAudit(tx, AUDIT.SUPPLY.PURCHASE_RECORDED, currentUserId, {
        supplyId,
        supplyName: supply.name,
        purchaseId: purchase.id,
        businessExpenseId: input.businessExpenseId ?? null,
        quantity,
        unitCost,
        totalCost,
        vendor,
        invoiceNumber,
        date: date.toISOString(),
        onHandBefore: supply.onHand,
        onHandAfter: supply.onHand + quantity,
      });
      return purchase;
    });
  },

  async reversePurchase(currentUserId, purchaseId) {
    await requireCatalogAdmin(currentUserId, "reverse a purchase");
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
      // NO LEDGER DELETE. Recording a purchase creates no BusinessExpense, so
      // reversing one destroys no deduction. `businessExpenseId` is now an
      // optional MANY-TO-ONE breadcrumb — several purchases may point at one
      // $500 receipt, and deleting that receipt because one purchase was
      // reversed would erase a real deduction the operator entered from their
      // bank statement. The FK is SetNull; the pointer simply goes away with
      // the row. See docs/features/job-materials.md.
      //
      // Removes stock that was paid for, so the snapshot below is still the
      // only surviving evidence of the reversed purchase.
      await writeAudit(tx, AUDIT.SUPPLY.PURCHASE_REVERSED, currentUserId, {
        supplyId: purchase.supplyId,
        supplyName: purchase.supply.name,
        purchaseId,
        businessExpenseId: purchase.businessExpenseId,
        quantity: purchase.quantity,
        unitCost: purchase.unitCost,
        totalCost: purchase.totalCost,
        vendor: purchase.vendor,
        invoiceNumber: purchase.invoiceNumber,
        date: purchase.date.toISOString(),
        onHandBefore: purchase.supply.onHand,
        onHandAfter: newOnHand,
      });
    });
    return { reversed: true };
  },

  async recordAdjustment(currentUserId, supplyId, input) {
    await requireCatalogAdmin(currentUserId, "adjust stock");
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
      // Manual stock correction — writes off (or writes on) inventory that
      // was bought with deducted business money without any paired ledger
      // row, so the reason + who typed it is the only accountability.
      await writeAudit(tx, AUDIT.SUPPLY.ADJUSTED, currentUserId, {
        supplyId,
        supplyName: supply.name,
        adjustmentId: adjustment.id,
        delta,
        reason,
        onHandBefore: supply.onHand,
        onHandAfter: newOnHand,
      });
      return adjustment;
    });
  },

  async listHistory(supplyId, opts?: { cutoff?: Date | null }) {
    // Business Start Date filter — pre-cutoff supply purchases hidden so the
    // Supplies tab "purchases" timeline aligns with the paired
    // BusinessExpense filter on the Accounting tab. Holds and adjustments
    // are operational (inventory movement), not money, so they pass through
    // unfiltered. See lib/businessStartCutoff.ts.
    // A MISSING SUPPLY IS NOT AN EMPTY HISTORY. findMany on an id that does
    // not exist returns [], which the UI renders as "No history yet" — the
    // same thing a brand-new supply shows. So a stale row (a list loaded
    // before the supply was deleted, or before a dev reseed rebuilt every id)
    // reports "no history" for a supply that has plenty, and there is nothing
    // on screen to suggest looking further.
    const exists = await prisma.supply.findUnique({ where: { id: supplyId }, select: { id: true } });
    if (!exists) throw new ServiceError("NOT_FOUND", "Supply not found.", 404);

    const cutoff = opts?.cutoff ?? null;
    const [purchases, holds, adjustments] = await Promise.all([
      prisma.supplyPurchase.findMany({
        where: { supplyId, ...(cutoff ? { date: { gte: cutoff } } : {}) },
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
      // LOCK FIRST, then count. The lock is what makes this safe — see
      // lockSupplyOnHand. `supply.onHand` above was read outside the
      // transaction and is stale by definition.
      const onHand = await lockSupplyOnHand(tx, input.supplyId);
      const held = await activeHoldsTotal(tx, input.supplyId);
      const available = onHand - held;
      if (available < quantity) {
        throw new ServiceError(
          "INSUFFICIENT_INVENTORY",
          `Only ${available} ${supply.unit}(s) of ${supply.name} available (requested ${quantity}).`,
          409,
        );
      }

      // THE PRICE IS DECIDED HERE, not in the catalog. The catalog value is a
      // default the operator can override per job, because the same supply is
      // billed differently to different clients. Whatever is used is
      // snapshotted on the hold below, so repricing the catalog later never
      // moves a job that has already committed stock.
      const unitPrice =
        input.clientUnitPrice != null
          ? requireNonNegativeNum(input.clientUnitPrice, "Client price")
          : supply.clientUnitPrice;
      const totalCharge = Math.round(quantity * unitPrice * 100) / 100;
      // The headline a CLIENT reads. Defaults to the supply's name — not
      // "Mulch × 5 bag", which is a stock movement written on an invoice.
      // The quantity belongs in the optional detail, where the operator can
      // phrase it: "5 bags at $5.00 each".
      const description = input.description?.trim() || supply.name;
      const typedDetail = input.detail?.trim() || null;

      // No paired BusinessExpense — the BE was already recorded at purchase
      // time. Recording another here would inflate the tax ledger.
      const invoiceCharge = await tx.invoiceCharge.create({
        data: {
          occurrenceId,
          createdById: currentUserId,
          cost: totalCharge,
          // NO actualCost. What a client is billed has nothing to do with what
          // we paid for the stock — that is the Ledger's business, and the
          // Ledger is what gets reconciled against the accounting software.
          // Recording it here made a client charge look like a cost record.
          description,
          // AUTO-GENERATED unless the operator wrote their own. Regenerated on
          // every quantity change while `detailIsCustom` is false, so a line
          // can never read "6 bags" beside a five-bag price.
          detail: typedDetail ?? supplyChargeDetail(quantity, supply.unit, unitPrice),
          detailIsCustom: typedDetail != null,
        },
      });

      const hold = await tx.supplyHold.create({
        data: {
          supplyId: input.supplyId,
          occurrenceId,
          quantity,
          clientUnitPrice: unitPrice,
          status: "ACTIVE",
          invoiceChargeId: invoiceCharge.id,
          createdById: currentUserId,
        },
        include: holdInclude,
      });
      // Pulling stock onto a job bills the CLIENT: the paired InvoiceCharge
      // (qty x clientUnitPrice) is added to their invoice, on top of labor. It
      // does NOT come out of anyone's payout — the crew splits labor and
      // services only. Snapshot the per-unit cost used, since the catalog
      // price can drift afterwards.
      await writeAudit(tx, AUDIT.SUPPLY.HOLD_CREATED, currentUserId, {
        supplyId: input.supplyId,
        supplyName: supply.name,
        holdId: hold.id,
        invoiceChargeId: invoiceCharge.id,
        occurrenceId,
        jobId: occ.jobId ?? null,
        quantity,
        clientUnitPrice: supply.clientUnitPrice,
        totalCharge,
        onHand: supply.onHand,
        availableBefore: available,
      });
      return hold;
    });
  },

  async removeHold(currentUserId, holdId) {
    const hold = await prisma.supplyHold.findUnique({
      where: { id: holdId },
      include: {
        occurrence: { include: { assignees: true } },
        // Both are hard-deleted below — read them first so the audit row
        // can preserve what the payout deduction actually was.
        invoiceCharge: true,
        supply: { select: { id: true, name: true, unit: true } },
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
      if (hold.invoiceChargeId) {
        await tx.invoiceCharge.delete({ where: { id: hold.invoiceChargeId } }).catch(() => {});
      }
      await tx.supplyHold.delete({ where: { id: holdId } });
      // Reverses a payout deduction: the worker is credited back the paired
      // Expense's cost, and a CONSUMED hold also returns units to stock.
      // Both rows are gone after this tx, so snapshot the amounts.
      await writeAudit(tx, AUDIT.SUPPLY.HOLD_REMOVED, currentUserId, {
        supplyId: hold.supplyId,
        supplyName: hold.supply.name,
        holdId,
        invoiceChargeId: hold.invoiceChargeId,
        occurrenceId: hold.occurrenceId,
        jobId: hold.occurrence.jobId ?? null,
        quantity: hold.quantity,
        clientUnitPrice: hold.clientUnitPrice,
        invoiceChargeCostReversed: hold.invoiceCharge?.cost ?? null,
        holdStatusBefore: hold.status,
        onHandRestored: hold.status === "CONSUMED" ? hold.quantity : 0,
      });
    });
    return { removed: true };
  },

  // Adjust a hold's quantity in place — the claimer reconciling actual usage
  // (e.g. pulled 10 bags of mulch, only used 9). Reprices the paired payout
  // Expense and reconciles physical stock so the unused unit returns to (or
  // an extra unit leaves) inventory.
  async adjustHold(currentUserId, holdId, newQuantity) {
    const hold = await prisma.supplyHold.findUnique({
      where: { id: holdId },
      include: {
        supply: true,
        occurrence: { include: { assignees: true } },
        // Before-value for the repriced payout deduction.
        invoiceCharge: true,
      },
    });
    if (!hold) throw new ServiceError("NOT_FOUND", "Hold not found.", 404);

    const isClaimer = hold.occurrence.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId,
    );
    if (!isClaimer && !(await isAdminUser(currentUserId))) {
      throw new ServiceError(
        "FORBIDDEN",
        "Only the claimer or an admin can adjust a supply hold.",
        403,
      );
    }

    if (hold.status === "RELEASED") {
      throw new ServiceError(
        "INVALID_STATE",
        "This supply hold was released and can no longer be adjusted.",
        409,
      );
    }

    const qty = requireInt(newQuantity, "Quantity");
    if (qty <= 0) {
      throw new ServiceError(
        "INVALID_INPUT",
        "Quantity must be positive — use Remove to take the supply off the job entirely.",
        400,
      );
    }

    const delta = qty - hold.quantity;
    if (delta === 0) {
      return prisma.supplyHold.findUnique({ where: { id: holdId }, include: holdInclude });
    }

    return prisma.$transaction(async (tx) => {
      // Availability guard when increasing. activeHoldsTotal counts ACTIVE
      // holds (including this one when it's still ACTIVE), so onHand − held
      // is the free pool beyond everything already reserved/consumed.
      if (delta > 0) {
        const onHand = await lockSupplyOnHand(tx, hold.supplyId);
        const held = await activeHoldsTotal(tx, hold.supplyId);
        const available = onHand - held;
        if (available < delta) {
          throw new ServiceError(
            "INSUFFICIENT_INVENTORY",
            `Only ${available} more ${hold.supply.unit}(s) of ${hold.supply.name} available.`,
            409,
          );
        }
      }

      // A CONSUMED hold already decremented onHand by its old quantity, so a
      // change reconciles physical stock by the delta: shrinking returns
      // units, growing consumes more. ACTIVE holds only reserve — onHand is
      // untouched until completion, so nothing to reconcile there.
      if (hold.status === "CONSUMED") {
        await tx.supply.update({
          where: { id: hold.supplyId },
          data: { onHand: { decrement: delta } },
        });
      }

      // Reprice the paired payout Expense off the hold's snapshot per-unit
      // cost (not the supply's current cost — snapshots don't drift).
      const newExpenseCost = Math.round(qty * hold.clientUnitPrice * 100) / 100;
      if (hold.invoiceChargeId) {
        // ONLY THE AMOUNT. The hold owns the STOCK, so changing the quantity
        // re-prices the line from the unit price snapshotted at pull time —
        // but the name and detail are the operator's words and appear on the
        // client's invoice, so they are left alone. Overwriting them turned a
        // line someone had written for a client back into "Mulch × 5 bag".
        //
        // No `actualCost` either: what a client is charged has nothing to do
        // with what we paid. Cost lives in the Ledger, which is the tax
        // record; supplies are a stock-tracking layer above it.
        await tx.invoiceCharge.update({
          where: { id: hold.invoiceChargeId },
          data: {
            cost: newExpenseCost,
            // The detail follows the quantity for as long as it is ours.
            // Leaving it behind is what produced "6 bags at $6.00" beside
            // $30.00 — a line contradicting itself on the client's invoice.
            ...(hold.invoiceCharge?.detailIsCustom
              ? {}
              : { detail: supplyChargeDetail(qty, hold.supply.unit, hold.clientUnitPrice) }),
          },
        });
      }

      const updated = await tx.supplyHold.update({
        where: { id: holdId },
        data: { quantity: qty },
        include: holdInclude,
      });
      // Reprices the worker's payout deduction for this job and moves
      // physical stock in the opposite direction. The dollar delta is
      // exactly what the worker gains or loses on this occurrence.
      await writeAudit(tx, AUDIT.SUPPLY.HOLD_ADJUSTED, currentUserId, {
        supplyId: hold.supplyId,
        supplyName: hold.supply.name,
        holdId,
        invoiceChargeId: hold.invoiceChargeId,
        occurrenceId: hold.occurrenceId,
        jobId: hold.occurrence.jobId ?? null,
        quantityBefore: hold.quantity,
        quantityAfter: qty,
        quantityDelta: delta,
        clientUnitPrice: hold.clientUnitPrice,
        invoiceChargeCostBefore: hold.invoiceCharge?.cost ?? null,
        expenseCostAfter: newExpenseCost,
        holdStatus: hold.status,
        onHandDelta: hold.status === "CONSUMED" ? -delta : 0,
      });
      return updated;
    });
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
      if (h.invoiceChargeId) {
        await tx.invoiceCharge.delete({ where: { id: h.invoiceChargeId } }).catch(() => {});
      }
      await tx.supplyHold.update({
        where: { id: h.id },
        data: { status: "RELEASED", releasedAt: new Date(), invoiceChargeId: null },
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
