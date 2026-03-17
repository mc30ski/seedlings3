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

    // Validate splits sum
    const splitsSum = splits.reduce((s, sp) => s + sp.amount, 0);
    if (Math.abs(splitsSum - amountPaid) > 0.01) {
      throw new ServiceError(
        "SPLITS_MISMATCH",
        `Splits total ($${splitsSum.toFixed(2)}) does not match amount paid ($${amountPaid.toFixed(2)}).`,
        400
      );
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
