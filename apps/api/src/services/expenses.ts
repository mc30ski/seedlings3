import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import { parseUserDate } from "../lib/dates";
import { resolvePrivileges } from "../lib/privileges";
import type { ServicesExpenses, ExpenseInput, ExpensePatchInput } from "../types/services";
import { loadCategoryLabels } from "./expenseCategories";
import { generateLedgerId } from "../lib/ledgerId";

// Categories are validated against the EXPENSE_CATEGORIES taxonomy (the single
// source of truth, editable in Settings). Default "Supplies" matches the bias
// in the rest of the app: most lawn-care consumables land on line 22.
const DEFAULT_CATEGORY = "Supplies";

async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
  return !!user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
}

async function normalizeCategory(raw: string | null | undefined): Promise<string> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_CATEGORY;
  const labels = await loadCategoryLabels();
  if (!labels.has(trimmed)) {
    throw new ServiceError("INVALID_CATEGORY", `Invalid category: "${trimmed}". Must be a Schedule C line.`, 400);
  }
  return trimmed;
}

function resolveDate(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const d = parseUserDate(raw);
  if (isNaN(d.getTime())) throw new ServiceError("INVALID_DATE", "Invalid date.", 400);
  return d;
}

const expenseInclude = {
  createdBy: { select: { id: true, displayName: true } },
  businessExpense: true,
  // The inventory link — without this the UI can't tell an inventory-backed
  // expense from a custom one, so the quantity stepper never renders.
  supplyHold: {
    include: { supply: { select: { id: true, name: true, unit: true } } },
  },
} as const;

export const expenses: ServicesExpenses = {
  async addExpense(currentUserId, occurrenceId, input) {
    const { cost, description } = input;

    if (cost <= 0) {
      throw new ServiceError("INVALID_AMOUNT", "Expense cost must be greater than zero.", 400);
    }
    if (!description || !description.trim()) {
      throw new ServiceError("INVALID_INPUT", "Expense description is required.", 400);
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
    const priv = resolvePrivileges(me);
    const isClaimer = occ.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId
    );
    if (!priv.isAdminOrSuper) {
      if (!isClaimer) {
        throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can add expenses.", 403);
      }
      // Custom expenses imply paying with the company account.
      if (!priv.canChargeBusinessExpenses) {
        throw new ServiceError(
          "FORBIDDEN",
          "Recording new expenses on the company account requires the \"Charge business expenses\" privilege. Ask an admin.",
          403,
        );
      }
    }

    const category = await normalizeCategory(input.category);
    const date = resolveDate(input.date);
    const vendor = input.vendor ? input.vendor.trim() || null : null;
    const trimmedDescription = description.trim();

    // Dual-write: BusinessExpense first (the tax ledger), then the Expense
    // referencing it for payout deduction. Both succeed or fail together.
    return prisma.$transaction(async (tx) => {
      const businessExpense = await tx.businessExpense.create({
        data: {
          ledgerId: generateLedgerId(),
          createdById: currentUserId,
          date,
          cost,
          description: trimmedDescription,
          category,
          vendor,
          occurrenceId,
        },
      });
      return tx.expense.create({
        data: {
          occurrenceId,
          createdById: currentUserId,
          cost,
          description: trimmedDescription,
          businessExpenseId: businessExpense.id,
        },
        include: expenseInclude,
      });
    });
  },

  async updateExpense(currentUserId, expenseId, input) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: {
        occurrence: { include: { assignees: true } },
      },
    });
    if (!expense) throw new ServiceError("NOT_FOUND", "Expense not found.", 404);

    const isClaimer = expense.occurrence.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId
    );
    if (!isClaimer && !(await isAdminUser(currentUserId))) {
      throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can edit expenses.", 403);
    }

    return prisma.$transaction(async (tx) => {
      const expenseData: any = {};
      const businessExpenseData: any = {};

      if (input.cost !== undefined) {
        if (input.cost <= 0) {
          throw new ServiceError("INVALID_AMOUNT", "Expense cost must be greater than zero.", 400);
        }
        expenseData.cost = input.cost;
        businessExpenseData.cost = input.cost;
      }
      if (input.description !== undefined) {
        const trimmed = input.description.trim();
        if (!trimmed) {
          throw new ServiceError("INVALID_INPUT", "Expense description is required.", 400);
        }
        expenseData.description = trimmed;
        businessExpenseData.description = trimmed;
      }
      if ("category" in input) {
        businessExpenseData.category = await normalizeCategory(input.category);
      }
      if ("vendor" in input) {
        businessExpenseData.vendor = input.vendor ? String(input.vendor).trim() || null : null;
      }
      if ("date" in input && input.date) {
        businessExpenseData.date = resolveDate(input.date);
      }

      // Sync BusinessExpense if any tax-ledger field changed (or shared
      // cost/description). Only if there's a linked BE — older rows might not
      // have one (pre-MVP-2 data).
      if (expense.businessExpenseId && Object.keys(businessExpenseData).length > 0) {
        await tx.businessExpense.update({
          where: { id: expense.businessExpenseId },
          data: businessExpenseData,
        });
      }

      if (Object.keys(expenseData).length > 0) {
        return tx.expense.update({
          where: { id: expenseId },
          data: expenseData,
          include: expenseInclude,
        });
      }
      return tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
        include: expenseInclude,
      });
    });
  },

  async deleteExpense(currentUserId, expenseId) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: {
        occurrence: { include: { assignees: true } },
        supplyHold: true,
      },
    });
    if (!expense) throw new ServiceError("NOT_FOUND", "Expense not found.", 404);

    const isClaimer = expense.occurrence.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId
    );
    if (!isClaimer && !(await isAdminUser(currentUserId))) {
      throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can delete expenses.", 403);
    }

    await prisma.$transaction(async (tx) => {
      // Step-3: if backed by a SupplyHold, release it first (and restore
      // onHand if it was already CONSUMED) — otherwise the hold's
      // expenseId would just be nulled by the FK cascade and the hold
      // would silently keep locking inventory.
      if (expense.supplyHold) {
        const h = expense.supplyHold;
        if (h.status === "CONSUMED") {
          await tx.supply.update({
            where: { id: h.supplyId },
            data: { onHand: { increment: h.quantity } },
          });
        }
        await tx.supplyHold.update({
          where: { id: h.id },
          data: { status: "RELEASED", releasedAt: new Date(), expenseId: null },
        });
      }
      await tx.expense.delete({ where: { id: expenseId } });
      // Cascade: delete the paired BE so the ledger doesn't keep an orphaned
      // tax-ledger entry for a job-spend that no longer exists.
      if (expense.businessExpenseId) {
        await tx.businessExpense.delete({ where: { id: expense.businessExpenseId } }).catch(() => {});
      }
    });
    return { deleted: true as const };
  },

  async adminAddExpense(currentUserId: string, occurrenceId: string, input: ExpenseInput) {
    const { cost, description } = input;
    if (cost <= 0) throw new ServiceError("INVALID_AMOUNT", "Expense cost must be greater than zero.", 400);
    if (!description || !description.trim()) throw new ServiceError("INVALID_INPUT", "Expense description is required.", 400);

    const category = await normalizeCategory(input.category);
    const date = resolveDate(input.date);
    const vendor = input.vendor ? input.vendor.trim() || null : null;
    const trimmedDescription = description.trim();

    return prisma.$transaction(async (tx) => {
      const businessExpense = await tx.businessExpense.create({
        data: {
          ledgerId: generateLedgerId(),
          createdById: currentUserId,
          date,
          cost,
          description: trimmedDescription,
          category,
          vendor,
          occurrenceId,
        },
      });
      return tx.expense.create({
        data: {
          occurrenceId,
          createdById: currentUserId,
          cost,
          description: trimmedDescription,
          businessExpenseId: businessExpense.id,
        },
        include: expenseInclude,
      });
    });
  },

  async adminDeleteExpense(expenseId) {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { supplyHold: true },
    });
    if (!expense) throw new ServiceError("NOT_FOUND", "Expense not found.", 404);

    await prisma.$transaction(async (tx) => {
      if (expense.supplyHold) {
        const h = expense.supplyHold;
        if (h.status === "CONSUMED") {
          await tx.supply.update({
            where: { id: h.supplyId },
            data: { onHand: { increment: h.quantity } },
          });
        }
        await tx.supplyHold.update({
          where: { id: h.id },
          data: { status: "RELEASED", releasedAt: new Date(), expenseId: null },
        });
      }
      await tx.expense.delete({ where: { id: expenseId } });
      if (expense.businessExpenseId) {
        await tx.businessExpense.delete({ where: { id: expense.businessExpenseId } }).catch(() => {});
      }
    });
    return { deleted: true as const };
  },

  async listExpensesByOccurrence(occurrenceId) {
    return prisma.expense.findMany({
      where: { occurrenceId },
      orderBy: { createdAt: "asc" },
      include: expenseInclude,
    });
  },
};
