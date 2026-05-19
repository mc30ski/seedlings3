import { prisma } from "../db/prisma";
import { JobOccurrenceStatus, PaymentMethod, type WorkerType } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import type { ServicesPayments } from "../types/services";
import { etMidnight, etEndOfDay } from "../lib/dates";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

const VALID_METHODS = Object.values(PaymentMethod);

// ────────────────────────────────────────────────────────────────────
// Payment breakdown math (see memory/project_payment_math.md)
// ────────────────────────────────────────────────────────────────────

type WorkerInput = { userId: string; splitPercent: number; workerType: WorkerType | null };
type Rates = { contractorFeePercent: number; employeeMarginPercent: number };

export type PromisedRow = {
  userId: string;
  workerType: WorkerType | null;
  splitPercent: number;
  gross: number;
  ratePercent: number;
  fee: number;
  net: number;
};

type FinalSplitRow = {
  userId: string;
  workerType: WorkerType | null;
  splitPercent: number;
  grossAmount: number;
  ratePercent: number;
  feeAmount: number;
  netAmount: number;
  topUpAmount: number;
  amount: number; // final payout = netAmount + topUpAmount
};

function isEmployeeClass(wt: WorkerType | null): boolean {
  return wt === "EMPLOYEE" || wt === "TRAINEE";
}

function rateFor(wt: WorkerType | null, rates: Rates): number {
  return isEmployeeClass(wt) ? rates.employeeMarginPercent : rates.contractorFeePercent;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Canonical per-worker breakdown for a given collected amount + expenses.
// Used to compute BOTH the "promised" snapshot (at completion) and the
// "actual" splits (at approval). Fee is applied to each worker's own gross
// share — never to the pool as a whole.
export function computeBreakdown(
  collected: number,
  expenses: number,
  workers: WorkerInput[],
  rates: Rates,
): PromisedRow[] {
  const N = Math.max(0, collected - expenses);
  const totalPct = workers.reduce((s, w) => s + (w.splitPercent || 0), 0) || 100;

  const rows: PromisedRow[] = workers.map((w) => {
    const normalized = ((w.splitPercent || 0) / totalPct) * 100;
    const gross = N * (normalized / 100);
    const ratePercent = rateFor(w.workerType, rates);
    const fee = gross * (ratePercent / 100);
    return {
      userId: w.userId,
      workerType: w.workerType,
      splitPercent: round2(normalized),
      gross: round2(gross),
      ratePercent,
      fee: round2(fee),
      net: round2(gross - fee),
    };
  });

  // Penny-residual fix on net (rounding can leave a 1-cent gap vs. the
  // distributable pool). Apply to the first row.
  if (rows.length > 0) {
    const distributedNet = rows.reduce((s, r) => s + r.net + r.fee, 0);
    const residual = round2(N - distributedNet);
    if (Math.abs(residual) >= 0.01) {
      rows[0].net = round2(rows[0].net + residual);
    }
  }

  return rows;
}

// Reconciles a collected amount against the promised snapshot.
// Employees + trainees are made whole; contractors take pro-rata losses;
// overage stays with the business. Returns the per-worker split rows ready
// to insert + denormalized totals for the Payment row.
export function reconcileApproval(
  collected: number,
  expenses: number,
  workers: WorkerInput[],
  promised: PromisedRow[],
  rates: Rates,
): {
  splits: FinalSplitRow[];
  platformFeeAmount: number;
  businessMarginAmount: number;
  shortfallAmount: number;
  overageAmount: number;
} {
  const actual = computeBreakdown(collected, expenses, workers, rates);
  const promisedById = new Map(promised.map((p) => [p.userId, p]));

  const splits: FinalSplitRow[] = actual.map((a) => {
    const p = promisedById.get(a.userId);
    // No snapshot for this worker: pay actual net as computed (no top-up).
    if (!p) {
      return {
        userId: a.userId,
        workerType: a.workerType,
        splitPercent: a.splitPercent,
        grossAmount: a.gross,
        ratePercent: a.ratePercent,
        feeAmount: a.fee,
        netAmount: a.net,
        topUpAmount: 0,
        amount: a.net,
      };
    }

    if (isEmployeeClass(p.workerType)) {
      // Employee/trainee: always paid the promised net. Overage to business.
      const finalAmount = p.net;
      const topUp = round2(Math.max(0, finalAmount - a.net));
      return {
        userId: a.userId,
        workerType: p.workerType,
        splitPercent: a.splitPercent,
        grossAmount: a.gross,
        ratePercent: a.ratePercent,
        feeAmount: a.fee,
        netAmount: a.net,
        topUpAmount: topUp,
        amount: round2(finalAmount),
      };
    }

    // Contractor: pro-rata loss on underpay; capped at promised on overpay.
    const finalAmount = Math.min(a.net, p.net);
    return {
      userId: a.userId,
      workerType: p.workerType,
      splitPercent: a.splitPercent,
      grossAmount: a.gross,
      ratePercent: a.ratePercent,
      feeAmount: a.fee,
      netAmount: a.net,
      topUpAmount: 0,
      amount: round2(finalAmount),
    };
  });

  // Per-class fee totals on the Payment row use the PROMISED fees, not
  // the actual-breakdown fees. This is so the per-row display adds up:
  //
  //   amountPaid = workerPayouts + promisedMargin + promisedFee + overage − shortfall
  //
  // If we used the actual-breakdown fees here, an overpay would
  // double-count (e.g. $120 paid, $100 invoice, 100% employee with 20%
  // margin: actual margin = $24, overage delta = $20, sum = $44 — but
  // only $40 was actually kept). Using promised: $20 margin + $20
  // overage = $40 ✓. Per-split feeAmount stays as actual (used for
  // per-worker reporting), only these Payment-row aggregates change.
  const platformFeeAmount = round2(
    promised.filter((p) => !isEmployeeClass(p.workerType)).reduce((sum, p) => sum + p.fee, 0),
  );
  const businessMarginAmount = round2(
    promised.filter((p) => isEmployeeClass(p.workerType)).reduce((sum, p) => sum + p.fee, 0),
  );

  // Business retained delta vs. promised. Promised retained = sum of
  // promised fees (the cut the business would have kept on a perfect
  // collection). Actual retained = collected − expenses − all worker
  // payouts. Negative delta = business absorbed loss → shortfall.
  const promisedRetained = promised.reduce((s, p) => s + p.fee, 0);
  const totalPayouts = splits.reduce((s, sp) => s + sp.amount, 0);
  const actualRetained = collected - expenses - totalPayouts;
  const delta = actualRetained - promisedRetained;

  return {
    splits,
    platformFeeAmount,
    businessMarginAmount,
    shortfallAmount: delta < 0 ? round2(-delta) : 0,
    overageAmount: delta > 0 ? round2(delta) : 0,
  };
}

// Reads the two rate settings from the DB. Either may be 0/missing.
async function loadRates(client: typeof prisma | any): Promise<Rates> {
  const [feeSetting, marginSetting] = await Promise.all([
    client.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } }),
    client.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } }),
  ]);
  return {
    contractorFeePercent: Number(feeSetting?.value ?? 0),
    employeeMarginPercent: Number(marginSetting?.value ?? 0),
  };
}

// Resolve which of the given user IDs is flagged as the LLC owner. Returns a
// Set so split-write loops can do a single O(1) lookup per row. The schema
// enforces at most one owner via a partial unique index, but the Set works
// fine either way.
async function loadOwnerSet(client: typeof prisma | any, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await client.user.findMany({
    where: { id: { in: userIds }, isOwner: true },
    select: { id: true },
  });
  return new Set(rows.map((r: any) => r.id));
}

// Resolves the per-worker split list from the occurrence (completionSplits
// preferred; else even split across active assignees). Pairs each entry
// with the worker's current type.
async function resolveWorkers(
  client: typeof prisma | any,
  occ: { id: string; completionSplits: any; assignees: { userId: string; role: string | null }[] },
): Promise<WorkerInput[]> {
  const cs = occ.completionSplits as Array<{ userId: string; percent: number }> | null;
  let pairs: Array<{ userId: string; percent: number }>;
  if (Array.isArray(cs) && cs.length > 0) {
    pairs = cs.map((x) => ({ userId: x.userId, percent: Number(x.percent) || 0 }));
  } else {
    const active = occ.assignees.filter((a) => a.role !== "observer");
    if (active.length === 0) return [];
    const per = 100 / active.length;
    pairs = active.map((a) => ({ userId: a.userId, percent: per }));
  }
  const users = await client.user.findMany({
    where: { id: { in: pairs.map((p) => p.userId) } },
    select: { id: true, workerType: true },
  });
  const typeById = new Map(users.map((u: any) => [u.id, u.workerType]));
  return pairs.map((p) => ({
    userId: p.userId,
    splitPercent: p.percent,
    workerType: (typeById.get(p.userId) ?? null) as WorkerType | null,
  }));
}

// Persists worker-percentage splits onto JobOccurrence.completionSplits AND
// re-snapshots JobOccurrence.promisedPayouts. This is the single canonical
// write path for both fields — called from createPayment (Accept Now),
// paymentRequests.recordClaimerHandoff (CLAIMER Request Payment), and
// paymentRequests.sendForOccurrence (SERVER Request Payment, if splits are
// passed).
//
// Refuses if the occurrence isn't PENDING_PAYMENT or a confirmed Payment
// already exists — splits are immutable post-approval. Validates that
// percentages sum to 100 (±0.01) and every entry refers to a current
// active (non-observer) assignee.
//
// `priceTotal` and `expenses` are used for the snapshot only — they're
// fetched fresh inside the tx so a stale request can't snapshot against
// outdated price.
export async function persistCompletionSplits(
  tx: any,
  occurrenceId: string,
  splits: Array<{ userId: string; percent: number }>,
): Promise<PromisedRow[]> {
  if (!Array.isArray(splits) || splits.length === 0) {
    throw new ServiceError("INVALID_SPLITS", "At least one split entry is required.", 400);
  }
  const sum = splits.reduce((s, x) => s + (Number(x.percent) || 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new ServiceError("INVALID_SPLITS", `Split percentages must sum to 100 (got ${sum.toFixed(2)}).`, 400);
  }
  for (const s of splits) {
    const p = Number(s.percent);
    if (!Number.isFinite(p) || p <= 0) {
      throw new ServiceError("INVALID_SPLITS", "Every split percent must be greater than zero.", 400);
    }
    if (!Number.isInteger(p)) {
      throw new ServiceError("INVALID_SPLITS", "Split percentages must be whole numbers.", 400);
    }
  }

  const occ = await tx.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: {
      id: true,
      status: true,
      price: true,
      addons: { select: { price: true } },
      assignees: { select: { userId: true, role: true } },
      payment: { select: { id: true, confirmed: true } },
    },
  });
  if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
  if (occ.status !== JobOccurrenceStatus.PENDING_PAYMENT) {
    throw new ServiceError(
      "INVALID_STATUS",
      `Splits can only be set while the job is awaiting payment (current: ${occ.status}).`,
      409,
    );
  }
  if (occ.payment?.confirmed) {
    throw new ServiceError(
      "ALREADY_APPROVED",
      "Splits are locked — the payment has already been approved.",
      409,
    );
  }

  const activeIds = new Set(occ.assignees.filter((a: any) => a.role !== "observer").map((a: any) => a.userId));
  for (const s of splits) {
    if (!activeIds.has(s.userId)) {
      throw new ServiceError(
        "INVALID_SPLITS",
        "Split references a worker who isn't an active assignee on this job.",
        400,
      );
    }
  }
  if (activeIds.size !== splits.length) {
    throw new ServiceError(
      "INVALID_SPLITS",
      "Every active worker on this job must have a positive split percentage.",
      400,
    );
  }

  const rates = await loadRates(tx);
  const expensesAgg = await tx.expense.aggregate({ where: { occurrenceId }, _sum: { cost: true } });
  const expenses = expensesAgg._sum.cost ?? 0;
  const priceTotal = (occ.price ?? 0) + (occ.addons ?? []).reduce((s: number, a: any) => s + (a.price ?? 0), 0);

  // Compute promised payouts (the snapshot) using the new splits + current
  // price + current expenses. This is the contract: at approval time the
  // reconciler tops employees up to these net values.
  const users = await tx.user.findMany({
    where: { id: { in: splits.map((s) => s.userId) } },
    select: { id: true, workerType: true },
  });
  const typeById = new Map(users.map((u: any) => [u.id, u.workerType]));
  const workers: WorkerInput[] = splits.map((s) => ({
    userId: s.userId,
    splitPercent: s.percent,
    workerType: (typeById.get(s.userId) ?? null) as WorkerType | null,
  }));
  const promised = computeBreakdown(priceTotal, expenses, workers, rates);

  await tx.jobOccurrence.update({
    where: { id: occurrenceId },
    data: {
      completionSplits: splits as any,
      promisedPayouts: promised as any,
    },
  });

  return promised;
}

export const payments: ServicesPayments = {
  async createPayment(currentUserId, input) {
    const { occurrenceId, amountPaid, method, note, completionSplits } = input;

    if (!VALID_METHODS.includes(method as PaymentMethod)) {
      throw new ServiceError("INVALID_METHOD", `Invalid payment method: ${method}`, 400);
    }
    if (amountPaid < 0) {
      throw new ServiceError("INVALID_AMOUNT", "Amount paid cannot be negative.", 400);
    }
    if (!completionSplits || completionSplits.length === 0) {
      throw new ServiceError("INVALID_SPLITS", "Worker splits are required.", 400);
    }

    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        include: { assignees: true },
      });
      if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
      if (occ.status !== JobOccurrenceStatus.PENDING_PAYMENT) {
        // Common case: already-accepted (CLOSED with existing payment) — likely a duplicate submit.
        if (occ.status === JobOccurrenceStatus.CLOSED) {
          const existing = await tx.payment.findUnique({ where: { occurrenceId } });
          if (existing) {
            throw new ServiceError(
              "ALREADY_PAID",
              `This occurrence was already paid ($${existing.amountPaid.toFixed(2)} on ${existing.createdAt.toISOString().slice(0, 10)}). Refresh to see the recorded payment.`,
              409
            );
          }
        }
        throw new ServiceError(
          "INVALID_STATUS",
          `Cannot accept payment — occurrence status is "${occ.status}", expected "PENDING_PAYMENT". Refresh to see the current state.`,
          409
        );
      }

      // Refuse if a Payment row already exists for this occurrence. The
      // first record wins; admin must Reject before a second can land.
      const existingPayment = await tx.payment.findUnique({ where: { occurrenceId } });
      if (existingPayment) {
        throw new ServiceError(
          existingPayment.confirmed ? "ALREADY_PAID" : "PAYMENT_EXISTS",
          existingPayment.confirmed
            ? `This occurrence was already paid ($${existingPayment.amountPaid.toFixed(2)} on ${existingPayment.createdAt.toISOString().slice(0, 10)}). Refresh to see the recorded payment.`
            : `A payment is already pending admin approval. Reject it from the Pending Approvals queue before recording a new one.`,
          409,
        );
      }

      // Step 1: persist the worker percentages onto the occurrence AND
      // re-snapshot promisedPayouts. This is the single canonical place
      // splits get saved during Take Payment. The same helper is called
      // by paymentRequests for Request Payment.
      const promised = await persistCompletionSplits(tx, occurrenceId, completionSplits);

      // Step 2: compute the RECONCILED breakdown against the reported
      // amount, using the same reconciliation logic admin approval will
      // run. This means the pre-approval PaymentSplit rows already
      // reflect the final payouts:
      //   - Employees / trainees: payout = promised_net (made whole)
      //   - Contractors: payout = min(actual_net, promised_net) (capped on
      //     overpay; pro-rata loss on underpay)
      //   - Business keeps any overage / absorbs any shortfall
      // Previously this path used computeBreakdown(collected) which
      // wrote raw splits (e.g. $96 for an employee on $120 over a $100
      // invoice) that then dropped on approval — confusing for the
      // worker seeing the pending row. Using reconcileApproval here
      // keeps pre- and post-approval values consistent.
      const rates = await loadRates(tx);
      const expensesAgg = await tx.expense.aggregate({ where: { occurrenceId }, _sum: { cost: true } });
      const totalExpenses = expensesAgg._sum.cost ?? 0;
      const users = await tx.user.findMany({
        where: { id: { in: completionSplits.map((s) => s.userId) } },
        select: { id: true, workerType: true },
      });
      const typeById = new Map(users.map((u: any) => [u.id, u.workerType]));
      const workersList: WorkerInput[] = completionSplits.map((s) => ({
        userId: s.userId,
        splitPercent: s.percent,
        workerType: (typeById.get(s.userId) ?? null) as WorkerType | null,
      }));
      const recon = reconcileApproval(amountPaid, totalExpenses, workersList, promised, rates);
      const hasContractors = workersList.some((w) => !isEmployeeClass(w.workerType));
      const hasEmployees = workersList.some((w) => isEmployeeClass(w.workerType));
      const ownerSet = await loadOwnerSet(tx, recon.splits.map((s) => s.userId));

      // Create payment + splits. Always unconfirmed — admin sign-off via
      // approvePayment is the only path to confirmed=true. selfReported
      // tracks the source: false here (an authenticated worker or admin
      // recorded it) vs true for the public /pay/[token] page.
      //
      // splits use the reconciled values from `recon` so the pre-approval
      // numbers (visible in the worker Money tab + admin Money tab while
      // waiting on approval) already reflect the final payouts. The
      // Payment row also stamps shortfall/overage now, so reporting works
      // before approval too.
      const payment = await tx.payment.create({
        data: {
          occurrenceId,
          amountPaid,
          method: method as PaymentMethod,
          note: note || null,
          collectedById: currentUserId,
          platformFeePercent: hasContractors ? rates.contractorFeePercent : null,
          platformFeeAmount: hasContractors ? recon.platformFeeAmount : null,
          businessMarginPercent: hasEmployees ? rates.employeeMarginPercent : null,
          businessMarginAmount: hasEmployees ? recon.businessMarginAmount : null,
          shortfallAmount: recon.shortfallAmount,
          overageAmount: recon.overageAmount,
          confirmed: false,
          confirmedAt: null,
          confirmedById: null,
          selfReported: false,
          splits: {
            create: recon.splits.map((s) => ({
              userId: s.userId,
              amount: s.amount,
              grossAmount: s.grossAmount,
              ratePercent: s.ratePercent,
              feeAmount: s.feeAmount,
              netAmount: s.netAmount,
              topUpAmount: s.topUpAmount,
              ownerEarnings: ownerSet.has(s.userId),
            })),
          },
        },
        include: {
          splits: { include: { user: { select: { id: true, displayName: true, email: true, workerType: true } } } },
          collectedBy: { select: { id: true, displayName: true } },
        },
      });

      // Audit: flag the payment when any split is owner earnings (excluded
      // from Gusto/payroll exports; informational for downstream reporting).
      if (recon.splits.some((s) => ownerSet.has(s.userId))) {
        await writeAudit(tx, AUDIT.PAYMENT.OWNER_EARNINGS_RECORDED, currentUserId, {
          paymentId: payment.id,
          occurrenceId,
          ownerUserIds: recon.splits.filter((s) => ownerSet.has(s.userId)).map((s) => s.userId),
          totalOwnerAmount: round2(
            recon.splits.filter((s) => ownerSet.has(s.userId)).reduce((sum, s) => sum + s.amount, 0),
          ),
        });
      }

      // Auto-create-next is intentionally NOT run here. With every
      // createPayment record landing unconfirmed, the next occurrence
      // is generated downstream — either when admin approves (the
      // standard generation pipeline picks it up) or via the explicit
      // forceCreateNextOccurrence admin action. This keeps the
      // base-date aligned with actual approval and avoids duplicate
      // auto-create paths.
      return payment;
    });
  },

  async forceCreateNextOccurrence(_currentUserId: string, occurrenceId: string) {
    const fullOcc = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: {
        job: {
          select: {
            id: true, status: true, frequencyDays: true, defaultPrice: true, estimatedMinutes: true, notes: true, kind: true,
            defaultAssignees: { where: { active: true }, select: { userId: true, role: true } },
          },
        },
        payment: true,
      },
    });
    if (!fullOcc) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
    if (!fullOcc.job) throw new ServiceError("NOT_FOUND", "Job not found.", 404);

    const effectiveFreq = fullOcc.frequencyDays ?? fullOcc.job.frequencyDays;
    if (!effectiveFreq) throw new ServiceError("NO_FREQUENCY", "No frequency set on job or occurrence.", 400);

    const baseDate = fullOcc.startAt ? new Date(fullOcc.startAt) : new Date();
    const nextStart = new Date(baseDate);
    nextStart.setDate(nextStart.getDate() + effectiveFreq);
    const nextEnd = fullOcc.endAt ? new Date(fullOcc.endAt) : null;
    if (nextEnd) nextEnd.setDate(nextEnd.getDate() + effectiveFreq);

    return prisma.$transaction(async (tx) => {
      const nextOccurrence = await tx.jobOccurrence.create({
        data: {
          jobId: fullOcc.jobId!,
          kind: fullOcc.kind,
          startAt: nextStart,
          endAt: nextEnd,
          status: "SCHEDULED",
          source: "GENERATED",
          workflow: "STANDARD",
          isAdminOnly: !!fullOcc.isAdminOnly,
          jobType: fullOcc.jobType ?? null,
          jobTags: (fullOcc as any).jobTags ?? null,
          pinnedNote: null,
          pinnedNoteRepeats: true,
          notes: fullOcc.notes ?? fullOcc.job.notes ?? null,
          price: fullOcc.price ?? fullOcc.job.defaultPrice ?? null,
          estimatedMinutes: fullOcc.estimatedMinutes ?? fullOcc.job.estimatedMinutes ?? null,
          frequencyDays: fullOcc.frequencyDays ?? null,
        } as any,
      });

      // Assign from job's default team
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

      // Carry forward instructions
      const carryForwardInstructions = await tx.occurrenceInstruction.findMany({
        where: { occurrenceId, repeats: true },
      });
      if (carryForwardInstructions.length > 0) {
        await tx.occurrenceInstruction.createMany({
          data: carryForwardInstructions.map((i) => ({
            occurrenceId: nextOccurrence.id,
            text: i.text,
            isPreset: i.isPreset,
            repeats: i.repeats,
            sortOrder: i.sortOrder,
          })),
        });
      }

      // Clear the skip reason on the payment
      if (fullOcc.payment) {
        await tx.payment.update({
          where: { id: fullOcc.payment.id },
          data: { nextOccurrenceSkipReason: null },
        });
      }

      return { ok: true, nextOccurrence };
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
                // Promised payouts snapshot — lets the worker UI compare
                // their actual split.amount against what was promised at
                // Initiate-Payment time, so contractors can see their
                // pro-rata reduction on underpaid jobs.
                promisedPayouts: true,
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

    const items = splits.map((sp) => {
      // Pull this user's promised net from the occurrence snapshot, if
      // present. Used by the UI to show "Pro-rata reduction" on
      // contractor underpay rows (myAmount < myPromisedNet means they
      // took a hit).
      const pp = (sp.payment.occurrence as any).promisedPayouts as Array<{ userId: string; net: number }> | null;
      const myPromisedNet =
        Array.isArray(pp) ? (pp.find((row) => row.userId === userId)?.net ?? null) : null;
      return {
      splitId: sp.id,
      myAmount: sp.amount,
      myPromisedNet,
      myOwnerEarnings: (sp as any).ownerEarnings === true,
      payment: {
        id: sp.payment.id,
        amountPaid: sp.payment.amountPaid,
        method: sp.payment.method,
        note: sp.payment.note,
        confirmed: sp.payment.confirmed,
        platformFeePercent: sp.payment.platformFeePercent,
        platformFeeAmount: sp.payment.platformFeeAmount,
        businessMarginPercent: sp.payment.businessMarginPercent,
        businessMarginAmount: sp.payment.businessMarginAmount,
        collectedBy: sp.payment.collectedBy,
        createdAt: sp.payment.createdAt,
        splits: sp.payment.splits,
      },
      occurrence: sp.payment.occurrence,
      };
    });

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

    // Compute per-person totals + global fee/margin totals.
    // Per-split rows created after the reconciliation migration carry their
    // own gross/fee/net/topUp fields — we just sum `amount` (the final
    // payout). Pre-migration rows fall back to the old pool-pro-rata math.
    //
    // Total Revenue (the bottom-line "what the business kept") is computed
    // directly from money flow rather than by summing fee+margin+overage,
    // because those components can double-count on overpay (e.g. a $120
    // collection on a $100 invoice with a 20% employee margin produces a
    // $24 "margin" line AND a $20 overage — but the business only kept
    // $40 total). Summing collected − workerPayouts − expenses always
    // yields the correct figure regardless of overpay/underpay/write-off.
    const totalsMap = new Map<string, { displayName: string | null; total: number }>();
    let totalPlatformFees = 0;
    let totalBusinessMargin = 0;
    let totalRevenue = 0;
    let totalOverage = 0;
    let totalShortfall = 0;
    for (const p of payments) {
      // Money-flow Total Revenue: what the business actually kept on this
      // payment. Independent of how fee/margin/overage decompose.
      const expensesSum = (p.occurrence?.expenses ?? []).reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
      const workerPayouts = p.splits.reduce((s, sp) => s + sp.amount, 0);
      totalRevenue += (p.amountPaid ?? 0) - workerPayouts - expensesSum;
      totalOverage += (p as any).overageAmount ?? 0;
      totalShortfall += (p as any).shortfallAmount ?? 0;
      // Fee / margin totals come from the per-Payment denormalized fields
      // (the promised-cut values stamped at approval), NOT from the per-
      // split feeAmount which holds the actual-against-collected fee.
      // Mixing them breaks the decomposition identity
      //   TotalRevenue = totalMargin + totalFee + totalOverage − totalShortfall
      // which is what the Admin Money tab summary relies on for sanity.
      totalPlatformFees += p.platformFeeAmount ?? 0;
      totalBusinessMargin += p.businessMarginAmount ?? 0;
      const splitsHaveBreakdown = p.splits.every((sp: any) => sp.netAmount != null);
      if (splitsHaveBreakdown) {
        // New path — splits provide per-person payouts. Margin/fee totals
        // were already accumulated above from the per-Payment fields.
        for (const sp of p.splits as any[]) {
          const existing = totalsMap.get(sp.userId);
          if (existing) existing.total += sp.amount;
          else
            totalsMap.set(sp.userId, {
              displayName: sp.user.displayName ?? sp.user.email ?? null,
              total: sp.amount,
            });
        }
        continue;
      }
      // Legacy path — re-derive per-person nets from payment-level totals.
      // (Fee/margin totals already accumulated above; don't double-count.)
      const fee = p.platformFeeAmount ?? 0;
      const margin = p.businessMarginAmount ?? 0;
      const expenses = (p.occurrence?.expenses ?? []).reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
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
      totalOverage: Math.round(totalOverage * 100) / 100,
      totalShortfall: Math.round(totalShortfall * 100) / 100,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
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
        if (input.amountPaid < 0) {
          throw new ServiceError("INVALID_AMOUNT", "Amount paid cannot be negative.", 400);
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
        const ownerSet = await loadOwnerSet(tx, input.splits.map((sp) => sp.userId));
        await tx.paymentSplit.deleteMany({ where: { paymentId } });
        await tx.paymentSplit.createMany({
          data: input.splits.map((sp) => ({
            paymentId,
            userId: sp.userId,
            amount: sp.amount,
            ownerEarnings: ownerSet.has(sp.userId),
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

      const ownerSet = await loadOwnerSet(tx, assigneeIds);
      await tx.paymentSplit.deleteMany({ where: { paymentId: payment.id } });
      await tx.paymentSplit.createMany({
        data: assigneeIds.map((uid) => ({
          paymentId: payment.id,
          userId: uid,
          amount: splitAmount,
          ownerEarnings: ownerSet.has(uid),
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

  async selfReportPayment(actorUserId, input) {
    const { occurrenceId, method, amountPaid, note } = input;
    if (!VALID_METHODS.includes(method as PaymentMethod)) {
      throw new ServiceError("INVALID_METHOD", `Invalid payment method: ${method}`, 400);
    }
    if (amountPaid <= 0) {
      throw new ServiceError("INVALID_AMOUNT", "Amount must be positive.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        select: { id: true, status: true },
      });
      if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
      if (occ.status !== JobOccurrenceStatus.PENDING_PAYMENT) {
        throw new ServiceError(
          "INVALID_STATUS",
          `Cannot report payment — occurrence status is "${occ.status}".`,
          409,
        );
      }
      // Refuse if a Payment row already exists for this occurrence.
      // Previously this path updated an existing unconfirmed row, which
      // let two paths (worker Accept Payment + client self-report) stomp
      // on each other. Now whoever creates first wins atomically; the
      // late arrival sees "already received" instead.
      const existing = await tx.payment.findUnique({ where: { occurrenceId } });
      if (existing) {
        throw new ServiceError(
          existing.confirmed ? "ALREADY_PAID" : "PAYMENT_EXISTS",
          existing.confirmed
            ? "This job is already marked paid. Refresh to see the recorded payment."
            : "A payment has already been recorded for this job. The team will be in touch shortly.",
          409,
        );
      }
      const payment = await tx.payment.create({
        data: {
          occurrenceId,
          amountPaid,
          method: method as PaymentMethod,
          note: note ?? null,
          collectedById: actorUserId,
          selfReported: true,
          confirmed: false,
        },
      });
      // Audit write is best-effort — if actor is null (truly anonymous
      // client tap on /pay/[token]) the FK will reject, so we fall back
      // to a direct insert with null actor.
      if (actorUserId) {
        await writeAudit(tx, AUDIT.PAYMENT.SELF_REPORTED, actorUserId, {
          paymentId: payment.id,
          occurrenceId,
          method,
          amountPaid,
        });
      } else {
        await tx.auditEvent.create({
          data: {
            scope: AUDIT.PAYMENT.SELF_REPORTED[0],
            verb: AUDIT.PAYMENT.SELF_REPORTED[1],
            action: `${AUDIT.PAYMENT.SELF_REPORTED[0]}_${AUDIT.PAYMENT.SELF_REPORTED[1]}`,
            actorUserId: null,
            metadata: { paymentId: payment.id, occurrenceId, method, amountPaid } as any,
          },
        });
      }
      return payment;
    });
  },

  async approvePayment(currentUserId, paymentId, overrides) {
    const existing = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { occurrence: { select: { id: true, status: true, completionSplits: true, promisedPayouts: true, price: true, addons: { select: { price: true } }, assignees: true, job: { select: { property: { select: { client: { select: { contacts: { select: { id: true } } } } } } } } } } },
    });
    if (!existing) throw new ServiceError("NOT_FOUND", "Payment not found.", 404);
    if (existing.confirmed) throw new ServiceError("ALREADY_APPROVED", "Payment already approved.", 409);
    if (existing.occurrence.status !== JobOccurrenceStatus.PENDING_PAYMENT) {
      throw new ServiceError("INVALID_STATUS", "Occurrence is not pending payment.", 409);
    }

    const finalAmount = overrides?.amountPaid ?? existing.amountPaid;
    const finalMethod = (overrides?.method ?? existing.method) as PaymentMethod;
    const finalNote = overrides?.note !== undefined ? overrides.note : existing.note;
    const wasAdjusted = overrides?.amountPaid !== undefined && overrides.amountPaid !== existing.amountPaid;
    if (!VALID_METHODS.includes(finalMethod)) {
      throw new ServiceError("INVALID_METHOD", `Invalid payment method: ${finalMethod}`, 400);
    }
    if (finalAmount < 0) {
      throw new ServiceError("INVALID_AMOUNT", "Amount cannot be negative.", 400);
    }

    // Resolve workers + rates + expenses, then either reconcile against the
    // promised-payout snapshot (cleanest path) or compute a plain breakdown
    // if no snapshot exists (pre-snapshot legacy data, or completion that
    // skipped the snapshot for any reason).
    const rates = await loadRates(prisma);
    const expensesAgg = await prisma.expense.aggregate({ where: { occurrenceId: existing.occurrence.id }, _sum: { cost: true } });
    const totalExpenses = expensesAgg._sum.cost ?? 0;
    const workersList = await resolveWorkers(prisma, {
      id: existing.occurrence.id,
      completionSplits: (existing.occurrence as any).completionSplits,
      assignees: existing.occurrence.assignees,
    });
    if (workersList.length === 0) {
      throw new ServiceError("NO_ASSIGNEES", "Cannot approve — no active assignees on the occurrence.", 400);
    }

    const promised = (existing.occurrence as any).promisedPayouts as PromisedRow[] | null;
    const recon = Array.isArray(promised) && promised.length > 0
      ? reconcileApproval(finalAmount, totalExpenses, workersList, promised, rates)
      : (() => {
          // Legacy path: compute against final amount only; no top-ups.
          const rows = computeBreakdown(finalAmount, totalExpenses, workersList, rates);
          const splits: FinalSplitRow[] = rows.map((r) => ({
            userId: r.userId,
            workerType: r.workerType,
            splitPercent: r.splitPercent,
            grossAmount: r.gross,
            ratePercent: r.ratePercent,
            feeAmount: r.fee,
            netAmount: r.net,
            topUpAmount: 0,
            amount: r.net,
          }));
          const platformFeeAmount = round2(
            splits.filter((s) => !isEmployeeClass(s.workerType)).reduce((sum, s) => sum + s.feeAmount, 0),
          );
          const businessMarginAmount = round2(
            splits.filter((s) => isEmployeeClass(s.workerType)).reduce((sum, s) => sum + s.feeAmount, 0),
          );
          return { splits, platformFeeAmount, businessMarginAmount, shortfallAmount: 0, overageAmount: 0 };
        })();

    const hasContractors = workersList.some((w) => !isEmployeeClass(w.workerType));
    const hasEmployees = workersList.some((w) => isEmployeeClass(w.workerType));

    return prisma.$transaction(async (tx) => {
      // Replace splits to reflect the reconciled amounts (gross/fee/net/topUp).
      const ownerSet = await loadOwnerSet(tx, recon.splits.map((s) => s.userId));
      await tx.paymentSplit.deleteMany({ where: { paymentId } });
      if (recon.splits.length > 0) {
        await tx.paymentSplit.createMany({
          data: recon.splits.map((s) => ({
            paymentId,
            userId: s.userId,
            amount: s.amount,
            grossAmount: s.grossAmount,
            ratePercent: s.ratePercent,
            feeAmount: s.feeAmount,
            netAmount: s.netAmount,
            topUpAmount: s.topUpAmount,
            ownerEarnings: ownerSet.has(s.userId),
          })),
        });
      }
      // Flip the row to confirmed. Stamp adjustment fields when the admin
      // changed the amount at approval time.
      const payment = await tx.payment.update({
        where: { id: paymentId },
        data: {
          amountPaid: finalAmount,
          method: finalMethod,
          note: finalNote,
          confirmed: true,
          confirmedAt: new Date(),
          confirmedById: currentUserId,
          platformFeePercent: hasContractors ? rates.contractorFeePercent : null,
          platformFeeAmount: hasContractors ? recon.platformFeeAmount : null,
          businessMarginPercent: hasEmployees ? rates.employeeMarginPercent : null,
          businessMarginAmount: hasEmployees ? recon.businessMarginAmount : null,
          shortfallAmount: recon.shortfallAmount,
          overageAmount: recon.overageAmount,
          ...(wasAdjusted
            ? {
                adjustedAt: new Date(),
                adjustedById: currentUserId,
                adjustedFromAmount: existing.amountPaid,
              }
            : {}),
        },
      });
      // Close the occurrence — same transition the legacy createPayment did.
      // Also clear any prior rejection/revert metadata; the occurrence is
      // now paid, so the "last rejected/reverted" banners aren't relevant.
      await tx.jobOccurrence.update({
        where: { id: existing.occurrence.id },
        data: {
          status: JobOccurrenceStatus.CLOSED,
          lastPaymentRejectionReason: null,
          lastPaymentRejectedAt: null,
          lastPaymentRevertReason: null,
          lastPaymentRevertedAt: null,
        },
      });

      // Update ClientContact.preferredPaymentMethod on every active contact
      // for this property's client. Future payment dialogs pre-select this.
      const contactIds = (existing.occurrence.job?.property?.client?.contacts ?? []).map((c) => c.id);
      if (contactIds.length > 0) {
        await tx.clientContact.updateMany({
          where: { id: { in: contactIds } },
          data: { preferredPaymentMethod: finalMethod },
        });
      }

      await writeAudit(tx, AUDIT.PAYMENT.APPROVED, currentUserId, {
        paymentId,
        occurrenceId: existing.occurrence.id,
        finalAmount,
        finalMethod,
        wasSelfReported: existing.selfReported,
        wasAdjusted,
        adjustedFromAmount: wasAdjusted ? existing.amountPaid : undefined,
        shortfallAmount: recon.shortfallAmount,
        overageAmount: recon.overageAmount,
      });
      if (wasAdjusted) {
        await writeAudit(tx, AUDIT.PAYMENT.ADJUSTED, currentUserId, {
          paymentId,
          occurrenceId: existing.occurrence.id,
          fromAmount: existing.amountPaid,
          toAmount: finalAmount,
        });
      }
      if (recon.splits.some((s) => ownerSet.has(s.userId))) {
        await writeAudit(tx, AUDIT.PAYMENT.OWNER_EARNINGS_RECORDED, currentUserId, {
          paymentId,
          occurrenceId: existing.occurrence.id,
          ownerUserIds: recon.splits.filter((s) => ownerSet.has(s.userId)).map((s) => s.userId),
          totalOwnerAmount: round2(
            recon.splits.filter((s) => ownerSet.has(s.userId)).reduce((sum, s) => sum + s.amount, 0),
          ),
        });
      }

      // Auto-create the next occurrence for repeating jobs. Fires at
      // approval time (previously fired at record time on the now-removed
      // admin direct path). Base date is the original occurrence's
      // startAt + frequencyDays — i.e., anchored to when the service
      // happened, NOT when approval landed. If approval lags by a week,
      // the next occurrence may already be in the past on its calculated
      // date — that's intentional: the cycle is preserved and admin can
      // reschedule or skip the missed date.
      const fullOcc = await tx.jobOccurrence.findUnique({
        where: { id: existing.occurrence.id },
        include: {
          job: {
            select: {
              id: true, status: true, frequencyDays: true, defaultPrice: true,
              estimatedMinutes: true, notes: true, kind: true,
              defaultGroupId: true,
              defaultAssignees: { where: { active: true }, select: { userId: true, role: true } },
            },
          },
          assignees: true,
        },
      });

      let nextOccurrence: any = null;
      let nextOccurrenceSkipReason: string | null = null;
      const effectiveFreq = fullOcc?.frequencyDays ?? fullOcc?.job?.frequencyDays;
      if (!fullOcc || !fullOcc.job) {
        nextOccurrenceSkipReason = "occurrence_or_job_not_found";
      } else if (!effectiveFreq) {
        nextOccurrenceSkipReason = "no_frequency_set";
      } else if (fullOcc.job.status === "PAUSED") {
        nextOccurrenceSkipReason = "job_paused";
      } else if (fullOcc.isOneOff || fullOcc.workflow === "ONE_OFF") {
        nextOccurrenceSkipReason = "one_off";
      }

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

        // Guard against duplicate: skip creation if a SCHEDULED repeating
        // occurrence already exists at this date for this job.
        const existingNext = await tx.jobOccurrence.findFirst({
          where: {
            jobId: fullOcc.jobId,
            status: JobOccurrenceStatus.SCHEDULED,
            startAt: nextStart,
            workflow: "STANDARD",
            isOneOff: false,
          },
        });
        if (existingNext) {
          nextOccurrence = existingNext;
          nextOccurrenceSkipReason = "duplicate_exists";
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
              pinnedNote: null,
              pinnedNoteRepeats: true,
              notes: fullOcc.notes ?? fullOcc.job.notes ?? null,
              price: fullOcc.price ?? fullOcc.job.defaultPrice ?? null,
              estimatedMinutes: fullOcc.estimatedMinutes ?? fullOcc.job.estimatedMinutes ?? null,
              frequencyDays: fullOcc.frequencyDays ?? null,
            } as any,
          });

          // Assign next occurrence from the job's default crew. Group
          // default wins; otherwise per-user defaults. Archived default
          // groups fall through to unassigned (admin can claim).
          let nextAssigneeSource: { userId: string; role: string | null }[] = [];
          let nextAttachedGroupId: string | null = null;
          const defaultGroupId = (fullOcc.job as any)?.defaultGroupId as string | null | undefined;
          if (defaultGroupId) {
            const group = await tx.group.findUnique({
              where: { id: defaultGroupId },
              include: { members: { select: { userId: true, role: true } } },
            });
            if (group && !group.archivedAt) {
              nextAttachedGroupId = group.id;
              nextAssigneeSource = [
                { userId: group.claimerUserId, role: null },
                ...group.members.map((m) => ({
                  userId: m.userId,
                  role: m.role === "observer" ? ("observer" as const) : null,
                })),
              ];
            }
          } else {
            const defaults = fullOcc.job?.defaultAssignees ?? [];
            nextAssigneeSource = defaults.map((d) => ({ userId: d.userId, role: d.role ?? null }));
          }
          if (nextAttachedGroupId) {
            await tx.jobOccurrence.update({
              where: { id: nextOccurrence.id },
              data: { assignedGroupId: nextAttachedGroupId },
            });
          }
          if (nextAssigneeSource.length > 0) {
            const claimerId = nextAssigneeSource[0].userId;
            await tx.jobOccurrenceAssignee.createMany({
              data: nextAssigneeSource.map((d, i) => ({
                occurrenceId: nextOccurrence.id,
                userId: d.userId,
                role: d.role ?? null,
                assignedById: i === 0 ? d.userId : claimerId,
              })),
              skipDuplicates: true,
            });
          }
        }
      }

      // Carry over likes + property photo instructions + repeating
      // occurrence instructions to the new occurrence.
      if (nextOccurrence) {
        const existingLikes = await tx.likedOccurrence.findMany({
          where: { occurrenceId: existing.occurrence.id },
          select: { userId: true },
        });
        if (existingLikes.length > 0) {
          await tx.likedOccurrence.createMany({
            data: existingLikes.map((l) => ({ userId: l.userId, occurrenceId: nextOccurrence.id })),
            skipDuplicates: true,
          });
        }
        const existingPropertyPhotos = await tx.occurrencePropertyPhoto.findMany({
          where: { occurrenceId: existing.occurrence.id },
          select: { propertyPhotoId: true },
        });
        if (existingPropertyPhotos.length > 0) {
          await tx.occurrencePropertyPhoto.createMany({
            data: existingPropertyPhotos.map((p) => ({ occurrenceId: nextOccurrence.id, propertyPhotoId: p.propertyPhotoId })),
            skipDuplicates: true,
          });
        }
        const carryForwardInstructions = await tx.occurrenceInstruction.findMany({
          where: { occurrenceId: existing.occurrence.id, repeats: true },
        });
        if (carryForwardInstructions.length > 0) {
          await tx.occurrenceInstruction.createMany({
            data: carryForwardInstructions.map((i) => ({
              occurrenceId: nextOccurrence.id,
              text: i.text,
              isPreset: i.isPreset,
              repeats: i.repeats,
              sortOrder: i.sortOrder,
            })),
          });
        }
      }

      // Stamp the skip reason on the payment so the card / Payments tab
      // can surface "Next occurrence was NOT auto-created: <reason>" later.
      if (nextOccurrenceSkipReason) {
        await tx.payment.update({
          where: { id: paymentId },
          data: { nextOccurrenceSkipReason },
        });
      }

      return { ...payment, nextOccurrence, nextOccurrenceSkipReason };
    });
  },

  async rejectPayment(currentUserId, paymentId, reason) {
    const existing = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Payment not found.", 404);
    if (existing.confirmed) {
      throw new ServiceError("ALREADY_APPROVED", "Cannot reject — payment is already confirmed.", 409);
    }
    return prisma.$transaction(async (tx) => {
      await tx.paymentSplit.deleteMany({ where: { paymentId } });
      await tx.payment.delete({ where: { id: paymentId } });
      // Stamp the latest-rejection info onto the occurrence so the job
      // card can surface "Payment rejected: <reason>" without a per-card
      // audit query. If the user re-pays and admin approves, these get
      // cleared on the way to CLOSED (see approvePayment / createPayment).
      await tx.jobOccurrence.update({
        where: { id: existing.occurrenceId },
        data: {
          lastPaymentRejectionReason: reason?.trim() || "Rejected",
          lastPaymentRejectedAt: new Date(),
        },
      });
      await writeAudit(tx, AUDIT.PAYMENT.REJECTED, currentUserId, {
        paymentId,
        occurrenceId: existing.occurrenceId,
        reason: reason?.trim() || null,
      });
    });
  },

  async writeOffPayment(currentUserId, paymentId, reason) {
    const existing = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!existing) throw new ServiceError("NOT_FOUND", "Payment not found.", 404);
    if (existing.confirmed) {
      throw new ServiceError("ALREADY_APPROVED", "Cannot write off — payment is already confirmed.", 409);
    }
    if (existing.writtenOff) {
      throw new ServiceError("ALREADY_WRITTEN_OFF", "Payment is already written off.", 409);
    }

    // Run the standard approval path with collected=0 so all downstream
    // logic (close occurrence, next-occurrence creation, employee top-up,
    // contractor zero-payout) fires consistently. Then stamp the write-off
    // metadata so the row can be filtered from genuine approvals in audit
    // and reporting.
    const result = await payments.approvePayment(currentUserId, paymentId, { amountPaid: 0 });

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          writtenOff: true,
          writtenOffAt: new Date(),
          writtenOffById: currentUserId,
          writeOffReason: reason?.trim() || null,
        },
      });
      await writeAudit(tx, AUDIT.PAYMENT.WRITTEN_OFF, currentUserId, {
        paymentId,
        occurrenceId: existing.occurrenceId,
        reason: reason?.trim() || null,
      });
    });

    return result;
  },

  async listPendingApprovals() {
    return prisma.payment.findMany({
      where: { confirmed: false },
      orderBy: { createdAt: "asc" },
      include: {
        collectedBy: { select: { id: true, displayName: true, email: true } },
        occurrence: {
          select: {
            id: true,
            startAt: true,
            completedAt: true,
            price: true,
            addons: { select: { price: true } },
            // Used by the Approve confirm dialog to decide whether to
            // promise "next occurrence will be scheduled" — only true for
            // repeating jobs with a frequency on the occurrence or job.
            frequencyDays: true,
            isOneOff: true,
            workflow: true,
            job: {
              select: {
                id: true,
                frequencyDays: true,
                status: true,
                property: {
                  select: {
                    displayName: true, street1: true, city: true, state: true,
                    client: { select: { displayName: true } },
                  },
                },
              },
            },
            assignees: {
              where: { role: { not: "observer" } },
              select: { userId: true, user: { select: { displayName: true, email: true } } },
            },
          },
        },
      },
    });
  },
};
