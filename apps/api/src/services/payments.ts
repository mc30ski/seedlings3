import { prisma } from "../db/prisma";
import { JobOccurrenceStatus, PaymentMethod } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import type { ServicesPayments } from "../types/services";
import { etMidnight, etEndOfDay } from "../lib/dates";

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
    if (!splits || splits.length === 0) {
      throw new ServiceError("INVALID_SPLITS", "At least one payment split is required.", 400);
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

      // Calculate fees on (amountPaid - expenses), not on splits (splits already represent payout)
      let platformFeePercent: number | null = null;
      let platformFeeAmount: number | null = null;
      let businessMarginPercent: number | null = null;
      let businessMarginAmount: number | null = null;

      const activeAssignees = occ.assignees.filter((a) => a.role !== "observer");
      const assigneeUsers = await tx.user.findMany({
        where: { id: { in: activeAssignees.map((a) => a.userId) } },
        select: { id: true, workerType: true },
      });

      const expensesAgg = await tx.expense.aggregate({ where: { occurrenceId }, _sum: { cost: true } });
      const totalExpenses = expensesAgg._sum.cost ?? 0;
      const netAfterExpenses = Math.max(0, amountPaid - totalExpenses);

      const hasContractors = assigneeUsers.some((u) => u.workerType !== "EMPLOYEE" && u.workerType !== "TRAINEE");
      const hasEmployees = assigneeUsers.some((u) => u.workerType === "EMPLOYEE" || u.workerType === "TRAINEE");

      if (hasContractors) {
        const feeSetting = await tx.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } });
        const feePercent = Number(feeSetting?.value ?? 0);
        if (feePercent > 0) {
          platformFeePercent = feePercent;
          platformFeeAmount = Math.round(netAfterExpenses * feePercent) / 100;
        }
      }

      if (hasEmployees) {
        const marginSetting = await tx.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } });
        const marginPercent = Number(marginSetting?.value ?? 0);
        if (marginPercent > 0) {
          businessMarginPercent = marginPercent;
          businessMarginAmount = Math.round(netAfterExpenses * marginPercent) / 100;
        }
      }

      // Remove any existing payment (e.g. if occurrence was reopened after being closed)
      const existingPayment = await tx.payment.findUnique({ where: { occurrenceId } });
      if (existingPayment) {
        await tx.paymentSplit.deleteMany({ where: { paymentId: existingPayment.id } });
        await tx.payment.delete({ where: { id: existingPayment.id } });
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
          businessMarginPercent,
          businessMarginAmount,
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

      // Auto-create next occurrence for repeating jobs
      let nextOccurrence: any = null;
      const fullOcc = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        include: {
          job: {
            select: {
              id: true, status: true, frequencyDays: true, defaultPrice: true, estimatedMinutes: true, notes: true, kind: true,
              defaultAssignees: { where: { active: true }, select: { userId: true, role: true } },
            },
          },
          assignees: true,
        },
      });
      // Use occurrence-level frequency override if set, otherwise fall back to job frequency
      const effectiveFreq = fullOcc?.frequencyDays ?? fullOcc?.job?.frequencyDays;
      if (
        fullOcc &&
        fullOcc.job &&
        effectiveFreq &&
        fullOcc.job.status !== "PAUSED" &&
        !fullOcc.isOneOff &&
        fullOcc.workflow !== "ONE_OFF"
      ) {
        const freq = effectiveFreq;
        const baseDate = fullOcc.startAt ? new Date(fullOcc.startAt) : new Date();
        const nextStart = new Date(baseDate);
        nextStart.setDate(nextStart.getDate() + freq);
        const nextEnd = fullOcc.endAt ? new Date(fullOcc.endAt) : null;
        if (nextEnd) nextEnd.setDate(nextEnd.getDate() + freq);

        const isAdminOnly = !!fullOcc.isAdminOnly;

        // Guard against duplicate: check if a SCHEDULED occurrence already exists at this date
        const existing = await tx.jobOccurrence.findFirst({
          where: {
            jobId: fullOcc.jobId,
            status: JobOccurrenceStatus.SCHEDULED,
            startAt: nextStart,
          },
        });
        if (existing) {
          // Already exists — skip creation, use existing as "next"
          nextOccurrence = existing;
        } else {

        nextOccurrence = await tx.jobOccurrence.create({
          data: {
            jobId: fullOcc.jobId,
            kind: fullOcc.kind,
            startAt: nextStart,
            endAt: nextEnd,
            status: "SCHEDULED",
            source: "GENERATED",
            workflow: "STANDARD",
            isAdminOnly,
            jobType: fullOcc.jobType ?? null,
            jobTags: (fullOcc as any).jobTags ?? null,
            pinnedNote: (fullOcc as any).pinnedNoteRepeats ? ((fullOcc as any).pinnedNote ?? null) : null,
            pinnedNoteRepeats: (fullOcc as any).pinnedNoteRepeats ?? true,
            notes: fullOcc.notes ?? fullOcc.job.notes ?? null,
            price: fullOcc.price ?? fullOcc.job.defaultPrice ?? null,
            estimatedMinutes: fullOcc.estimatedMinutes ?? fullOcc.job.estimatedMinutes ?? null,
            frequencyDays: fullOcc.frequencyDays ?? null,
          } as any,
        });

        // Assign next occurrence from job's default team.
        // If no default team is set, leave unassigned (claimable).
        // Never copy from current occurrence — one-time team changes shouldn't persist.
        const defaults = fullOcc.job?.defaultAssignees ?? [];
        if (defaults.length > 0) {
          const claimerId = defaults[0].userId;
          await tx.jobOccurrenceAssignee.createMany({
            data: defaults.map((d, i) => ({
              occurrenceId: nextOccurrence.id,
              userId: d.userId,
              role: d.role ?? null,
              assignedById: i === 0 ? d.userId : claimerId,
            })),
            skipDuplicates: true,
          });
        }
        } // end else (duplicate guard)
      }

      // Carry over likes to the new occurrence
      if (nextOccurrence) {
        const existingLikes = await tx.likedOccurrence.findMany({
          where: { occurrenceId },
          select: { userId: true },
        });
        if (existingLikes.length > 0) {
          await tx.likedOccurrence.createMany({
            data: existingLikes.map((l) => ({ userId: l.userId, occurrenceId: nextOccurrence.id })),
            skipDuplicates: true,
          });
        }
      }

      return { ...payment, nextOccurrence };
    });
  },

  async listMyPayments(userId, params) {
    const where: any = { userId };
    if (params?.from || params?.to) {
      where.createdAt = {};
      if (params.from) where.createdAt.gte = etMidnight(params.from);
      if (params.to) where.createdAt.lte = etEndOfDay(params.to);
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
        businessMarginPercent: sp.payment.businessMarginPercent,
        businessMarginAmount: sp.payment.businessMarginAmount,
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
      if (params.from) where.createdAt.gte = etMidnight(params.from);
      if (params.to) where.createdAt.lte = etEndOfDay(params.to);
    }
    if (params?.method && params.method !== "ALL") {
      where.method = params.method;
    }
    if (params?.userId) {
      where.OR = [
        { splits: { some: { userId: params.userId } } },
        { occurrence: { assignees: { some: { userId: params.userId } } } },
      ];
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
    let totalBusinessMargin = 0;
    for (const p of payments) {
      const fee = p.platformFeeAmount ?? 0;
      const margin = p.businessMarginAmount ?? 0;
      const expenses = (p.occurrence?.expenses ?? []).reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
      totalPlatformFees += fee;
      totalBusinessMargin += margin;
      const splitTotal = p.splits.reduce((s, sp) => s + sp.amount, 0);
      const feeableSplitTotal = p.splits
        .filter((sp) => sp.user.workerType !== "EMPLOYEE" && sp.user.workerType !== "TRAINEE")
        .reduce((s, sp) => s + sp.amount, 0);
      const employeeSplitTotal = p.splits
        .filter((sp) => sp.user.workerType === "EMPLOYEE" || sp.user.workerType === "TRAINEE")
        .reduce((s, sp) => s + sp.amount, 0);
      for (const sp of p.splits) {
        const ratio = splitTotal > 0 ? sp.amount / splitTotal : 0;
        const expenseShare = expenses * ratio;
        const isFeeable = sp.user.workerType !== "EMPLOYEE" && sp.user.workerType !== "TRAINEE";
        const isEmployee = sp.user.workerType === "EMPLOYEE" || sp.user.workerType === "TRAINEE";
        const feeShare = isFeeable && feeableSplitTotal > 0
          ? fee * (sp.amount / feeableSplitTotal)
          : 0;
        const marginShare = isEmployee && employeeSplitTotal > 0
          ? margin * (sp.amount / employeeSplitTotal)
          : 0;
        const netAmount = sp.amount - feeShare - marginShare - expenseShare;
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

    return {
      items: payments,
      personTotals,
      totalPlatformFees: Math.round(totalPlatformFees * 100) / 100,
      totalBusinessMargin: Math.round(totalBusinessMargin * 100) / 100,
    };
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

      // Find the occurrence to get its jobId
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: existing.occurrenceId },
      });

      // Clean up auto-created next occurrence (if any)
      // The next occurrence was GENERATED, SCHEDULED, created after the payment, for the same job
      if (occ?.jobId) {
        const nextOcc = await tx.jobOccurrence.findFirst({
          where: {
            jobId: occ.jobId,
            source: "GENERATED",
            status: "SCHEDULED",
            startAt: { gt: occ.startAt ?? new Date() },
            createdAt: { gte: existing.createdAt },
          },
          orderBy: { createdAt: "asc" },
        });
        if (nextOcc) {
          // Only delete if it hasn't been modified (started, etc.)
          const isUntouched = nextOcc.status === "SCHEDULED" && !nextOcc.startedAt;
          if (isUntouched) {
            await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId: nextOcc.id } });
            await tx.pinnedOccurrence.deleteMany({ where: { occurrenceId: nextOcc.id } });
            await tx.likedOccurrence.deleteMany({ where: { occurrenceId: nextOcc.id } });
            await tx.occurrenceComment.deleteMany({ where: { occurrenceId: nextOcc.id } });
            await tx.jobOccurrence.delete({ where: { id: nextOcc.id } });
          }
        }
      }

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

  async recalculateSplits(occurrenceId: string) {
    return prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { occurrenceId },
        include: { splits: true },
      });
      if (!payment) throw new ServiceError("NOT_FOUND", "No payment found for this occurrence.", 404);

      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        include: { assignees: true },
      });
      if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

      const assigneeIds = occ.assignees.filter((a) => a.role !== "observer").map((a) => a.userId);
      if (assigneeIds.length === 0) {
        throw new ServiceError("NO_ASSIGNEES", "Cannot recalculate — no assignees on this occurrence.", 400);
      }

      // Even split across current assignees — deduct expenses, commission, and margin first
      const totalPayout = payment.amountPaid
        - (payment.platformFeeAmount ?? 0)
        - (payment.businessMarginAmount ?? 0)
        - ((await tx.expense.aggregate({ where: { occurrenceId }, _sum: { cost: true } }))._sum.cost ?? 0);
      const splitAmount = Math.round((Math.max(0, totalPayout) / assigneeIds.length) * 100) / 100;

      await tx.paymentSplit.deleteMany({ where: { paymentId: payment.id } });
      await tx.paymentSplit.createMany({
        data: assigneeIds.map((uid) => ({
          paymentId: payment.id,
          userId: uid,
          amount: splitAmount,
        })),
      });

      return tx.payment.findUnique({
        where: { id: payment.id },
        include: {
          splits: { include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } } },
          collectedBy: { select: { id: true, displayName: true } },
        },
      });
    });
  },
};
