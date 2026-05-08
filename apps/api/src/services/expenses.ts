import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import type { ServicesExpenses, ExpenseInput, ExpensePatchInput } from "../types/services";

// Schedule C-aligned categories. Mirror of the set in routes/admin.ts. Centralized
// here too because adding a per-job expense ALSO writes a BusinessExpense row.
const SCHEDULE_C_CATEGORIES = new Set([
  "Advertising",
  "Car and truck expenses",
  "Contract labor",
  "Depreciation",
  "Insurance",
  "Legal and professional services",
  "Office expense",
  "Rent or lease — vehicles/equipment",
  "Rent or lease — other business property",
  "Repairs and maintenance",
  "Supplies",
  "Taxes and licenses",
  "Travel",
  "Meals",
  "Utilities",
  "Other",
]);
const DEFAULT_CATEGORY = "Supplies";

async function isAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
  return !!user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
}

function normalizeCategory(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_CATEGORY;
  if (!SCHEDULE_C_CATEGORIES.has(trimmed)) {
    throw new ServiceError("INVALID_CATEGORY", `Invalid category: "${trimmed}". Must be a Schedule C line.`, 400);
  }
  return trimmed;
}

function resolveDate(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw new ServiceError("INVALID_DATE", "Invalid date.", 400);
  return d;
}

const expenseInclude = {
  createdBy: { select: { id: true, displayName: true } },
  businessExpense: true,
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

    const isClaimer = occ.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId
    );
    if (!isClaimer && !(await isAdminUser(currentUserId))) {
      throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can add expenses.", 403);
    }

    const category = normalizeCategory(input.category);
    const date = resolveDate(input.date);
    const vendor = input.vendor ? input.vendor.trim() || null : null;
    const trimmedDescription = description.trim();

    // Dual-write: BusinessExpense first (the tax ledger), then the Expense
    // referencing it for payout deduction. Both succeed or fail together.
    return prisma.$transaction(async (tx) => {
      const businessExpense = await tx.businessExpense.create({
        data: {
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
        businessExpenseData.category = normalizeCategory(input.category);
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

    const category = normalizeCategory(input.category);
    const date = resolveDate(input.date);
    const vendor = input.vendor ? input.vendor.trim() || null : null;
    const trimmedDescription = description.trim();

    return prisma.$transaction(async (tx) => {
      const businessExpense = await tx.businessExpense.create({
        data: {
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
    const expense = await prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new ServiceError("NOT_FOUND", "Expense not found.", 404);

    await prisma.$transaction(async (tx) => {
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
