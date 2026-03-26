import { prisma } from "../db/prisma";
import { JobOccurrenceStatus, PaymentMethod } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import type { ServicesPayments } from "../types/services";

const VALID_METHODS = Object.values(PaymentMethod);

export const payments: ServicesPayments = {
  async createPayment(currentUserId, input) {
    const { occurrenceId, amountPaid, method, note, splits } = input;

    if (!VALID_METHODS.includes(method as PaymentMethod)) {
      throw new ServiceError("INVALID_METHOD", `Invalid payment method: ${method}`, 400);
    }
    if (amountPaid <= 0) {
      throw new ServiceError("INVALID_AMOUNT", "Amount paid must be greater than zero.", 400);
    }

    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        include: { assignees: true },
      });
      if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
      if (occ.status !== JobOccurrenceStatus.PENDING_PAYMENT) {
        throw new ServiceError("INVALID_STATUS", "Occurrence is not in pending payment status.", 409);
      }

      // Transition occurrence to CLOSED
      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { status: JobOccurrenceStatus.CLOSED },
      });

      // Calculate platform fee only on contractor/unclassified workers' splits
      let platformFeePercent: number | null = null;
      let platformFeeAmount: number | null = null;

      const assigneeUsers = await tx.user.findMany({
        where: { id: { in: occ.assignees.map((a) => a.userId) } },
        select: { id: true, workerType: true },
      });
      const feeableUserIds = new Set(
        assigneeUsers
          .filter((u) => u.workerType !== "EMPLOYEE" && u.workerType !== "TRAINEE")
          .map((u) => u.id)
      );

      if (feeableUserIds.size > 0) {
        const feeSetting = await tx.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } });
        const feePercent = Number(feeSetting?.value ?? 0);
        if (feePercent > 0) {
          // Only apply fee to contractor/unclassified splits
          const feeableSplitTotal = splits
            .filter((sp) => feeableUserIds.has(sp.userId))
            .reduce((s, sp) => s + sp.amount, 0);

          // Pro-rate expenses across all splits, then only fee the contractor portion
          const expensesAgg = await tx.expense.aggregate({
            where: { occurrenceId },
            _sum: { cost: true },
          });
          const totalExpenses = expensesAgg._sum.cost ?? 0;
          const totalSplitAmount = splits.reduce((s, sp) => s + sp.amount, 0);
          const feeableExpenseShare = totalSplitAmount > 0
            ? totalExpenses * (feeableSplitTotal / totalSplitAmount)
            : 0;

          const feeableNet = feeableSplitTotal - feeableExpenseShare;
          platformFeePercent = feePercent;
          platformFeeAmount = Math.round(feeableNet * feePercent) / 100;
        }
      }

      // Create payment + splits
      const payment = await tx.payment.create({
        data: {
          occurrenceId,
          amountPaid,
          method: method as PaymentMethod,
          note: note || null,
          collectedById: currentUserId,
          platformFeePercent,
          platformFeeAmount,
          splits: {
            create: splits.map((sp) => ({
              userId: sp.userId,
              amount: sp.amount,
            })),
          },
        },
        include: {
          splits: { include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } } },
          collectedBy: { select: { id: true, displayName: true } },
        },
      });

      return payment;
    });
  },

  async listMyPayments(userId, params) {
    const where: any = { userId };
    if (params?.from || params?.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = new Date(params.from + "T00:00:00");
      if (params.to) where.createdAt.lte = new Date(params.to + "T23:59:59.999");
    }

    const splits = await prisma.paymentSplit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        payment: {
          include: {
            collectedBy: { select: { id: true, displayName: true } },
            occurrence: {
              select: {
                id: true,
                jobId: true,
                startAt: true,
                job: {
                  select: {
                    id: true,
                    property: { select: { id: true, displayName: true, client: { select: { id: true, displayName: true } } } },
                  },
                },
                expenses: {
                  select: { id: true, cost: true, description: true, createdById: true },
                  orderBy: { createdAt: "asc" as const },
                },
              },
            },
            splits: {
              include: {
                user: { select: { id: true, displayName: true, email: true, workerType: true } },
              },
            },
          },
        },
      },
    });

    const totalAmount = splits.reduce((sum, sp) => sum + sp.amount, 0);

    const items = splits.map((sp) => ({
      splitId: sp.id,
      myAmount: sp.amount,
      payment: {
        id: sp.payment.id,
        amountPaid: sp.payment.amountPaid,
        method: sp.payment.method,
        note: sp.payment.note,
        platformFeePercent: sp.payment.platformFeePercent,
        platformFeeAmount: sp.payment.platformFeeAmount,
        collectedBy: sp.payment.collectedBy,
        createdAt: sp.payment.createdAt,
        splits: sp.payment.splits,
      },
      occurrence: sp.payment.occurrence,
    }));

    return { items, totalAmount };
  },

  async listAllPayments(params) {
    const where: any = {};
    if (params?.from || params?.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = new Date(params.from + "T00:00:00");
      if (params.to) where.createdAt.lte = new Date(params.to + "T23:59:59.999");
    }
    if (params?.method && params.method !== "ALL") {
      where.method = params.method;
    }
    if (params?.userId) {
      where.splits = { some: { userId: params.userId } };
    }

    const payments = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        collectedBy: { select: { id: true, displayName: true, email: true } },
        splits: {
          include: {
            user: { select: { id: true, displayName: true, email: true, workerType: true } },
          },
        },
        occurrence: {
          select: {
            id: true,
            jobId: true,
            startAt: true,
            job: {
              select: {
                id: true,
                property: { select: { id: true, displayName: true, client: { select: { id: true, displayName: true } } } },
              },
            },
            expenses: {
              select: { id: true, cost: true, description: true, createdById: true },
              orderBy: { createdAt: "asc" as const },
            },
          },
        },
      },
    });

    // Compute per-person totals (net of expenses and platform fees) and total platform fees
    const totalsMap = new Map<string, { displayName: string | null; total: number }>();
    let totalPlatformFees = 0;
    for (const p of payments) {
      const fee = p.platformFeeAmount ?? 0;
      const expenses = (p.occurrence?.expenses ?? []).reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
      totalPlatformFees += fee;
      const splitTotal = p.splits.reduce((s, sp) => s + sp.amount, 0);
      // Determine which splits are feeable (contractor/unclassified)
      const feeableSplitTotal = p.splits
        .filter((sp) => sp.user.workerType !== "EMPLOYEE" && sp.user.workerType !== "TRAINEE")
        .reduce((s, sp) => s + sp.amount, 0);
      for (const sp of p.splits) {
        const ratio = splitTotal > 0 ? sp.amount / splitTotal : 0;
        const expenseShare = expenses * ratio;
        // Only apply fee to contractor/unclassified splits
        const isFeeable = sp.user.workerType !== "EMPLOYEE" && sp.user.workerType !== "TRAINEE";
        const feeShare = isFeeable && feeableSplitTotal > 0
          ? fee * (sp.amount / feeableSplitTotal)
          : 0;
        const netAmount = sp.amount - feeShare - expenseShare;
        const existing = totalsMap.get(sp.userId);
        if (existing) {
          existing.total += netAmount;
        } else {
          totalsMap.set(sp.userId, {
            displayName: sp.user.displayName ?? sp.user.email ?? null,
            total: netAmount,
          });
        }
      }
    }
    const personTotals = Array.from(totalsMap.entries()).map(([userId, v]) => ({
      userId,
      displayName: v.displayName,
      total: Math.round(v.total * 100) / 100,
    }));

    return { items: payments, personTotals, totalPlatformFees: Math.round(totalPlatformFees * 100) / 100 };
  },

  async updatePayment(currentUserId, paymentId, input) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { splits: true },
      });
      if (!existing) throw new ServiceError("NOT_FOUND", "Payment not found.", 404);

      const data: any = {};
      if (input.amountPaid !== undefined) {
        if (input.amountPaid <= 0) {
          throw new ServiceError("INVALID_AMOUNT", "Amount paid must be greater than zero.", 400);
        }
        data.amountPaid = input.amountPaid;
      }
      if (input.method !== undefined) {
        if (!VALID_METHODS.includes(input.method as PaymentMethod)) {
          throw new ServiceError("INVALID_METHOD", `Invalid payment method: ${input.method}`, 400);
        }
        data.method = input.method as PaymentMethod;
      }
      if ("note" in input) data.note = input.note || null;

      await tx.payment.update({ where: { id: paymentId }, data });

      if (input.splits) {
        await tx.paymentSplit.deleteMany({ where: { paymentId } });
        await tx.paymentSplit.createMany({
          data: input.splits.map((sp) => ({
            paymentId,
            userId: sp.userId,
            amount: sp.amount,
          })),
        });
      }

      return tx.payment.findUnique({
        where: { id: paymentId },
        include: {
          splits: { include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } } },
          collectedBy: { select: { id: true, displayName: true } },
        },
      });
    });
  },

  async deletePayment(currentUserId, paymentId) {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { id: paymentId },
      });
      if (!existing) throw new ServiceError("NOT_FOUND", "Payment not found.", 404);

      // Revert occurrence back to PENDING_PAYMENT
      await tx.jobOccurrence.update({
        where: { id: existing.occurrenceId },
        data: { status: JobOccurrenceStatus.PENDING_PAYMENT },
      });

      // Delete payment (splits cascade)
      await tx.payment.delete({ where: { id: paymentId } });
    });
  },

  async getPaymentByOccurrence(occurrenceId) {
    return prisma.payment.findUnique({
      where: { occurrenceId },
      include: {
        collectedBy: { select: { id: true, displayName: true } },
        splits: {
          include: {
            user: { select: { id: true, displayName: true, email: true, workerType: true } },
          },
        },
      },
    });
  },
};
