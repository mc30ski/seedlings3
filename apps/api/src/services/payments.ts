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

      // Create payment + splits
      const payment = await tx.payment.create({
        data: {
          occurrenceId,
          amountPaid,
          method: method as PaymentMethod,
          note: note || null,
          collectedById: currentUserId,
          splits: {
            create: splits.map((sp) => ({
              userId: sp.userId,
              amount: sp.amount,
            })),
          },
        },
        include: {
          splits: { include: { user: { select: { id: true, displayName: true, email: true } } } },
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
      if (params.from) where.createdAt.gte = new Date(params.from);
      if (params.to) where.createdAt.lte = new Date(params.to + "T23:59:59.999Z");
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
              },
            },
            splits: {
              include: {
                user: { select: { id: true, displayName: true, email: true } },
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
      if (params.from) where.createdAt.gte = new Date(params.from);
      if (params.to) where.createdAt.lte = new Date(params.to + "T23:59:59.999Z");
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
        collectedBy: { select: { id: true, displayName: true } },
        splits: {
          include: {
            user: { select: { id: true, displayName: true, email: true } },
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
          },
        },
      },
    });

    // Compute per-person totals
    const totalsMap = new Map<string, { displayName: string | null; total: number }>();
    for (const p of payments) {
      for (const sp of p.splits) {
        const existing = totalsMap.get(sp.userId);
        if (existing) {
          existing.total += sp.amount;
        } else {
          totalsMap.set(sp.userId, {
            displayName: sp.user.displayName ?? sp.user.email ?? null,
            total: sp.amount,
          });
        }
      }
    }
    const personTotals = Array.from(totalsMap.entries()).map(([userId, v]) => ({
      userId,
      displayName: v.displayName,
      total: v.total,
    }));

    return { items: payments, personTotals };
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
          splits: { include: { user: { select: { id: true, displayName: true, email: true } } } },
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
            user: { select: { id: true, displayName: true, email: true } },
          },
        },
      },
    });
  },
};
