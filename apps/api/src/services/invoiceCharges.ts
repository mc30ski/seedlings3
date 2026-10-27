// ─────────────────────────────────────────────────────────────────────────────
// Invoice charges — lines on the CLIENT'S bill for a job.
//
// TWO BOOKS, and this file writes exactly one of them.
//
//   THE LEDGER (BusinessExpense) — real money off a bank/card statement. It
//   IS the Schedule C deduction. Written ONLY by /business-expenses/*.
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

import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import type { CallerCan } from "../lib/callerCan";
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

/**
 * May this person charge materials on ANYBODY's visit?
 *
 * `schedule.manage` is what that authority was
 * standing in for: you run the schedule, so any visit on it is yours to
 * bill against.
 *
 * NOT `materials.charge`. That one is Trainee-tier and every worker holds
 * it — for their OWN visit, where the ownership check is what bounds them.
 * Using it here would have let a trainee add a line to any customer's bill,
 * which is the opposite of what these four entry points are for.
 */
function mayChargeAnyVisit(callerCan: CallerCan): boolean {
  return callerCan("schedule.manage");
}

const chargeInclude = Prisma.validator<Prisma.InvoiceChargeInclude>()({
  createdBy: { select: { id: true, displayName: true } },
  // The optional, many-to-one ledger breadcrumb. Read for display only.
  businessExpense: true,
  // The inventory link — without this the UI can't tell an inventory-backed
  // charge from a one-off, so the quantity stepper never renders.
  supplyHold: {
    include: { supply: { select: { id: true, name: true, unit: true } } },
  },
});

/** `materials.charge`, on every path. A job line raises what the CLIENT is
 *  billed, so it is not every worker's call to make. The message says WHY —
 *  a bare "forbidden" reads as a bug. */
const NEEDS_CHARGE_AUTHORITY = (verb: string) =>
  new ServiceError(
    "FORBIDDEN",
    `You need charge authority to ${verb} an invoice charge — it changes what the client is billed.`,
    403,
  );

export const invoiceCharges: ServicesInvoiceCharges = {
  async updateInvoiceCharge(currentUserId, callerCan, invoiceChargeId, input) {
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

    if (!mayChargeAnyVisit(callerCan)) throw NEEDS_CHARGE_AUTHORITY("edit");

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
        const typed = input.detail?.trim() || null;
        data.detail = typed;
        // TAKING OVER THE WORDS, or handing them back.
        //
        // An inventory-backed line writes its own detail from the hold and
        // regenerates it whenever the quantity changes. Typing your own stops
        // that — permanently, because otherwise the next quantity change would
        // silently overwrite what you wrote. CLEARING it hands the line back:
        // the next adjustment regenerates, and the line is auto again.
        //
        // On a one-off charge this flag is inert — nothing regenerates a
        // detail that has no hold behind it.
        data.detailIsCustom = typed != null;
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
        detailIsCustomBefore: charge.detailIsCustom,
        detailIsCustomAfter: updated.detailIsCustom,
        descriptionBefore: charge.description,
        descriptionAfter: updated.description,
        fromInventory: !!charge.supplyHold,
        changedFields: Object.keys(data),
      });

      return updated;
    });
  },

  async deleteInvoiceCharge(currentUserId, callerCan, invoiceChargeId) {
    const charge = await prisma.invoiceCharge.findUnique({
      where: { id: invoiceChargeId },
      include: {
        occurrence: { include: { assignees: true } },
        supplyHold: true,
        businessExpense: true,
      },
    });
    if (!charge) throw new ServiceError("NOT_FOUND", "Invoice charge not found.", 404);

    if (!mayChargeAnyVisit(callerCan)) throw NEEDS_CHARGE_AUTHORITY("remove");

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

  // THERE WERE TWINS HERE, AND THEY WERE NOT TWINS.
  //
  // `addInvoiceCharge` and `deleteInvoiceCharge` were each declared TWICE in
  // this one object literal — a duplicate key, so the later declaration
  // silently replaced the earlier and only one of each ever ran. The surviving
  // `delete` was a stub meaning to delegate to its twin, but with the twin
  // overwritten it called ITSELF: `DELETE /invoice-charges/:id` recursed until
  // the stack blew. The surviving `add` was fine, and is the one below.
  //
  // Resolved 2026-10-18 by keeping the implementation that was actually
  // running in each case — the `add` here, the `delete` above — and deleting
  // the shadowed copies. Both are now declared once.
  //
  // NO BusinessExpense rows from either path: an invoice charge is what the
  // CLIENT is billed, never a company deduction. See docs/FINANCIAL_SYSTEM.md.

  async addInvoiceCharge(
    currentUserId,
    callerCan,
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

    if (!mayChargeAnyVisit(callerCan)) throw NEEDS_CHARGE_AUTHORITY("add");

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

  async listInvoiceChargesByOccurrence(occurrenceId) {
    return prisma.invoiceCharge.findMany({
      where: { occurrenceId },
      include: chargeInclude,
      orderBy: { createdAt: "asc" },
    });
  },
};
