// ─────────────────────────────────────────────────────────────────────────────
// Invoice charges — lines on the CLIENT'S bill for a job.
//
// TWO BOOKS, and this file writes exactly one of them.
//
//   THE LEDGER (BusinessExpense) — real money off a bank/card statement. It
//   IS the Schedule C deduction. Written ONLY by /admin/business-expenses/*.
//
//   THIS (InvoiceCharge) — what the client is billed, on top of labor. It
//   creates NO deduction, ever.
//
// They reconcile in AGGREGATE ONLY. A $500 Lowe's receipt is one ledger row;
// the mulch off it lands on four different jobs. There is no row-to-row
// relationship and there must never be one.
//
// Until 2026-09-06 every function here ALSO wrote a BusinessExpense. That
// meant the same money was deducted twice as soon as the operator entered the
// real card charge from their statement — and the charge came out of the
// crew's payout instead of being billed to the client.
//
// NOTHING IN THIS FILE MAY WRITE, UPDATE OR DELETE A BusinessExpense.
// Enforced by job-materials-build-gate.test.ts.
//
// Canonical spec: docs/features/job-materials.md
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import { resolvePrivileges } from "../lib/privileges";
import type {
  ServicesInvoiceCharges,
  InvoiceChargeInput,
} from "../types/services";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

// NOTE: there is no category / vendor / date handling in this file, and no
// `normalizeCategory`. Those existed only to populate the paired
// BusinessExpense. Collecting them now would gather a Schedule C category
// that reaches nothing.

async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
  return !!user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
}

const chargeInclude = {
  createdBy: { select: { id: true, displayName: true } },
  // The optional, many-to-one ledger breadcrumb. Read for display only.
  businessExpense: true,
  // The inventory link — without this the UI can't tell an inventory-backed
  // charge from a one-off, so the quantity stepper never renders.
  supplyHold: {
    include: { supply: { select: { id: true, name: true, unit: true } } },
  },
} as const;

/** ADMIN-ONLY, on every path. A job line raises what the CLIENT is billed, so
 *  it is not a worker's call to make. The message says WHY — a bare "forbidden"
 *  reads as a bug. */
const ADMIN_ONLY = (verb: string) =>
  new ServiceError(
    "FORBIDDEN",
    `Only an admin can ${verb} an invoice charge — it changes what the client is billed.`,
    403,
  );

export const invoiceCharges: ServicesInvoiceCharges = {
  async addInvoiceCharge(currentUserId, occurrenceId, input) {
    const { cost, description } = input;

    // `NaN <= 0` is FALSE, so NaN walked past this guard and every other one
    // like it, reaching Prisma as a 500 instead of a 400 the operator can act
    // on. Infinity did the same.
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new ServiceError("INVALID_AMOUNT", "The charge must be greater than zero.", 400);
    }
    if (!description || !description.trim()) {
      throw new ServiceError("INVALID_INPUT", "A line name is required.", 400);
    }

    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

    const me = await prisma.user.findUnique({
      where: { id: currentUserId },
      include: { roles: true },
    });
    if (!me) throw new ServiceError("NOT_FOUND", "User not found.", 404);
    if (!resolvePrivileges(me).isAdminOrSuper) throw ADMIN_ONLY("add");

    const trimmedDescription = description.trim();

    return prisma.$transaction(async (tx) => {
      // NO BusinessExpense. See the header.
      const charge = await tx.invoiceCharge.create({
        data: {
          occurrenceId,
          createdById: currentUserId,
          cost,
          actualCost: input.actualCost ?? null,
          detail: input.detail?.trim() || null,
          description: trimmedDescription,
        },
        include: chargeInclude,
      });
      // Raises what the client owes. It does NOT change any worker's payout —
      // the crew splits labor and services only.
      await writeAudit(tx, AUDIT.EXPENSE.CREATED, currentUserId, {
        invoiceChargeId: charge.id,
        occurrenceId,
        jobId: occ.jobId ?? null,
        cost,
        actualCost: input.actualCost ?? null,
        detail: charge.detail,
        description: trimmedDescription,
        via: "admin",
      });
      return charge;
    });
  },

  async updateInvoiceCharge(currentUserId, invoiceChargeId, input) {
    const charge = await prisma.invoiceCharge.findUnique({
      where: { id: invoiceChargeId },
      include: {
        occurrence: { include: { assignees: true } },
        businessExpense: true,
        // Tells a DERIVED (inventory-backed) line from a typed one.
        supplyHold: { select: { id: true } },
      },
    });
    if (!charge) throw new ServiceError("NOT_FOUND", "Invoice charge not found.", 404);

    if (!(await isAdminUser(currentUserId))) throw ADMIN_ONLY("edit");

    return prisma.$transaction(async (tx) => {
      const data: any = {};

      // AN INVENTORY-BACKED LINE IS AN ORDINARY CHARGE.
      //
      // Its amount and name used to be locked — a 409 saying "this line comes
      // from inventory, so its amount follows the quantity". That treated the
      // supplies catalog as though it decided what a client owes. It does not:
      // supplies are a stock-tracking layer, and what a client is billed is
      // chosen per job and can differ between clients for the same item.
      //
      // The only thing the hold still owns is the STOCK. Changing the held
      // quantity re-prices the line from the unit price snapshotted at pull
      // time — but the words stay yours, and so does any amount you type.
      if (input.cost !== undefined) {
        if (!Number.isFinite(input.cost) || input.cost <= 0) {
          throw new ServiceError("INVALID_AMOUNT", "The charge must be greater than zero.", 400);
        }
        data.cost = input.cost;
      }
      if (input.description !== undefined) {
        const trimmed = input.description.trim();
        if (!trimmed) throw new ServiceError("INVALID_INPUT", "A line name is required.", 400);
        data.description = trimmed;
      }
      // `"x" in input` rather than `!== undefined`: null is MEANINGFUL here —
      // it CLEARS the field, which is how an operator removes a detail or a
      // cost they entered by mistake.
      if ("actualCost" in input) {
        const ac = input.actualCost == null ? null : Number(input.actualCost);
        if (ac != null && (!Number.isFinite(ac) || ac < 0)) {
          throw new ServiceError("INVALID_AMOUNT", "Cost must be zero or more.", 400);
        }
        data.actualCost = ac;
      }
      if ("detail" in input) {
        data.detail = input.detail?.trim() || null;
      }

      // NO WRITE-THROUGH TO THE LEDGER. This used to sync cost, description,
      // category, vendor and date onto the linked BusinessExpense — so editing
      // what a client is charged silently re-filed a Schedule C deduction.
      //
      // `businessExpenseId` is a decorative breadcrumb: many lines may point
      // at one receipt, and one line's charge has no bearing on what that
      // receipt was for.

      const updated =
        Object.keys(data).length > 0
          ? await tx.invoiceCharge.update({
              where: { id: invoiceChargeId },
              data,
              include: chargeInclude,
            })
          : await tx.invoiceCharge.findUniqueOrThrow({
              where: { id: invoiceChargeId },
              include: chargeInclude,
            });

      await writeAudit(tx, AUDIT.EXPENSE.UPDATED, currentUserId, {
        invoiceChargeId,
        occurrenceId: charge.occurrenceId,
        costBefore: charge.cost,
        costAfter: updated.cost,
        actualCostBefore: charge.actualCost,
        actualCostAfter: updated.actualCost,
        detailBefore: charge.detail,
        detailAfter: updated.detail,
        descriptionBefore: charge.description,
        descriptionAfter: updated.description,
        fromInventory: !!charge.supplyHold,
        changedFields: Object.keys(data),
      });

      return updated;
    });
  },

  async deleteInvoiceCharge(currentUserId, invoiceChargeId) {
    const charge = await prisma.invoiceCharge.findUnique({
      where: { id: invoiceChargeId },
      include: {
        occurrence: { include: { assignees: true } },
        supplyHold: true,
        businessExpense: true,
      },
    });
    if (!charge) throw new ServiceError("NOT_FOUND", "Invoice charge not found.", 404);

    if (!(await isAdminUser(currentUserId))) throw ADMIN_ONLY("remove");

    await prisma.$transaction(async (tx) => {
      // If backed by a SupplyHold, release it first (and restore onHand if it
      // was already CONSUMED) — otherwise the hold's invoiceChargeId would
      // just be nulled by the FK and the hold would silently keep locking
      // inventory.
      if (charge.supplyHold) {
        const h = charge.supplyHold;
        if (h.status === "CONSUMED") {
          await tx.supply.update({
            where: { id: h.supplyId },
            data: { onHand: { increment: h.quantity } },
          });
        }
        await tx.supplyHold.update({
          where: { id: h.id },
          data: { status: "RELEASED", releasedAt: new Date(), invoiceChargeId: null },
        });
      }
      await tx.invoiceCharge.delete({ where: { id: invoiceChargeId } });

      // NO LEDGER DELETE. With a many-to-one link this would erase a $500
      // receipt the first time any one of four jobs dropped a line. The FK is
      // SetNull; the pointer simply goes away with the row.

      // Lowers what the client owes. Hard delete, so this snapshot is the
      // only surviving record of the line.
      await writeAudit(tx, AUDIT.EXPENSE.DELETED, currentUserId, {
        invoiceChargeId,
        occurrenceId: charge.occurrenceId,
        cost: charge.cost,
        actualCost: charge.actualCost,
        detail: charge.detail,
        description: charge.description,
        // Retained for the trail only — the ledger row itself is untouched.
        businessExpenseId: charge.businessExpenseId,
        ledgerId: charge.businessExpense?.ledgerId ?? null,
        // A supply-backed charge also puts units back on the shelf.
        supplyHoldId: charge.supplyHold?.id ?? null,
        supplyHoldStatusBefore: charge.supplyHold?.status ?? null,
        supplyHoldQuantity: charge.supplyHold?.quantity ?? null,
        via: "admin",
      });
    });
    return { deleted: true as const };
  },

  // ── Admin twins ────────────────────────────────────────────────────────────
  //
  // Reached by /admin/occurrences/:id/invoice-charges. These are SEPARATE
  // implementations, and in the first attempt at this change they were missed
  // entirely — they kept creating BusinessExpense rows with Schedule C
  // categories for weeks after the model said they couldn't.
  //
  // Every rule the functions above obey, these obey.

  async adminAddInvoiceCharge(
    currentUserId: string,
    occurrenceId: string,
    input: InvoiceChargeInput,
  ) {
    const { cost, description } = input;
    // `NaN <= 0` is FALSE, so NaN walked past this guard and every other one
    // like it, reaching Prisma as a 500 instead of a 400 the operator can act
    // on. Infinity did the same.
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new ServiceError("INVALID_AMOUNT", "The charge must be greater than zero.", 400);
    }
    if (!description || !description.trim()) {
      throw new ServiceError("INVALID_INPUT", "A line name is required.", 400);
    }

    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId } });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

    if (!(await isAdminUser(currentUserId))) throw ADMIN_ONLY("add");

    const trimmedDescription = description.trim();

    return prisma.$transaction(async (tx) => {
      // NO BusinessExpense — same as addInvoiceCharge.
      const charge = await tx.invoiceCharge.create({
        data: {
          occurrenceId,
          createdById: currentUserId,
          cost,
          actualCost: input.actualCost ?? null,
          detail: input.detail?.trim() || null,
          description: trimmedDescription,
        },
        include: chargeInclude,
      });
      await writeAudit(tx, AUDIT.EXPENSE.CREATED, currentUserId, {
        invoiceChargeId: charge.id,
        occurrenceId,
        jobId: occ.jobId ?? null,
        cost,
        actualCost: input.actualCost ?? null,
        detail: charge.detail,
        description: trimmedDescription,
        via: "admin",
      });
      return charge;
    });
  },

  async adminDeleteInvoiceCharge(currentUserId, invoiceChargeId) {
    // Delegates rather than duplicating. The twins drifted once already; the
    // permission check and the supply-hold release are identical, so there is
    // nothing here worth a second copy.
    return invoiceCharges.deleteInvoiceCharge(currentUserId, invoiceChargeId);
  },

  async listInvoiceChargesByOccurrence(occurrenceId) {
    return prisma.invoiceCharge.findMany({
      where: { occurrenceId },
      include: chargeInclude,
      orderBy: { createdAt: "asc" },
    });
  },
};
