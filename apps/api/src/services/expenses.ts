import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import type { ServicesExpenses } from "../types/services";

export const expenses: ServicesExpenses = {
  async addExpense(currentUserId, occurrenceId, input) {
    const { cost, description } = input;

    if (cost <= 0) {
      throw new ServiceError("INVALID_AMOUNT", "Expense cost must be greater than zero.", 400);
    }
    if (!description || !description.trim()) {
      throw new ServiceError("INVALID_INPUT", "Expense description is required.", 400);
    }

    // Verify the user is the claimer on this occurrence
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

    const isClaimer = occ.assignees.some(
      (a) => a.userId === currentUserId && a.assignedById === currentUserId
    );
    if (!isClaimer) {
      throw new ServiceError("FORBIDDEN", "Only the claimer can add expenses.", 403);
    }

    return prisma.expense.create({
      data: {
        occurrenceId,
        createdById: currentUserId,
        cost,
        description: description.trim(),
      },
      include: {
        createdBy: { select: { id: true, displayName: true } },
      },
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
    if (!isClaimer) {
      throw new ServiceError("FORBIDDEN", "Only the claimer can edit expenses.", 403);
    }

    const data: any = {};
    if (input.cost !== undefined) {
      if (input.cost <= 0) {
        throw new ServiceError("INVALID_AMOUNT", "Expense cost must be greater than zero.", 400);
      }
      data.cost = input.cost;
    }
    if (input.description !== undefined) {
      if (!input.description.trim()) {
        throw new ServiceError("INVALID_INPUT", "Expense description is required.", 400);
      }
      data.description = input.description.trim();
    }

    return prisma.expense.update({
      where: { id: expenseId },
      data,
      include: {
        createdBy: { select: { id: true, displayName: true } },
      },
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
    if (!isClaimer) {
      throw new ServiceError("FORBIDDEN", "Only the claimer can delete expenses.", 403);
    }

    await prisma.expense.delete({ where: { id: expenseId } });
    return { deleted: true as const };
  },

  async adminDeleteExpense(expenseId) {
    const expense = await prisma.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new ServiceError("NOT_FOUND", "Expense not found.", 404);

    await prisma.expense.delete({ where: { id: expenseId } });
    return { deleted: true as const };
  },

  async listExpensesByOccurrence(occurrenceId) {
    return prisma.expense.findMany({
      where: { occurrenceId },
      orderBy: { createdAt: "asc" },
      include: {
        createdBy: { select: { id: true, displayName: true } },
      },
    });
  },
};
