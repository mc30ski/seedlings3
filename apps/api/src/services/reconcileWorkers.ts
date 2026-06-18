import { prisma } from "../db/prisma";
import { etFormatDate } from "../lib/dates";
import {
  computeBreakdown,
  loadRates,
  type WorkerInput,
} from "./payments";
import { isEmployeeClass } from "./exports";

// ─────────────────────────────────────────────────────────────────────────────
// Worker Reconciliation — a single-window aggregation of hours, jobs,
// and pay per worker, plus period-level totals + the specific numbers
// that need to reconcile against external systems (Gusto + QuickBooks).
//
// The shape mirrors the operator's actual reconciliation flow:
//   1. Open Gusto / QB
//   2. Pick a pay period
//   3. Compare totals → if matched, file ✓
//      If not matched, drill into the worker rows to find the variance
//
// Source-of-truth rules (intentionally consistent with the rest of the
// app):
//   • Hours        — WorkerWorkday active milliseconds (ended rows only)
//   • Earnings     — JobOccurrence.promisedPayouts snapshot (work-anchored,
//                     covers paid + unpaid); falls back to computeBreakdown
//                     when snapshot null (seeded data / legacy rows)
//   • Top-ups      — PaymentSplit.topUpAmount on confirmed payments
//   • Revenue      — Payment.amountPaid (confirmed, !writtenOff)
//   • Rentals      — Checkout.rentalCost where releasedAt in window
//   • Processor fees — Payment.processorFeeAmount
//
// Owner-earnings (the business's own cut) is tracked separately so it
// doesn't pollute personal-wage totals.
// ─────────────────────────────────────────────────────────────────────────────

export type ReconcileJobRow = {
  occurrenceId: string;
  title: string;
  client: string | null;
  property: string | null;
  completedAt: string | null; // ISO
  grossShare: number;          // pre-fee/margin
  feeOrMargin: number;         // contractor fee or business margin
  topUp: number;               // employee/trainee make-whole
  netPaid: number;             // grossShare - feeOrMargin + topUp
  paymentConfirmed: boolean;
  paymentWrittenOff: boolean;
  source: "snapshot" | "computed";
};

export type ReconcileDayRow = {
  date: string;                // YYYY-MM-DD ET
  hoursActive: number;
  jobsCompleted: number;
  grossEarnings: number;
  feesOrMargin: number;
  topUps: number;
  netPaid: number;
  jobs: ReconcileJobRow[];
};

export type ReconcileWorkerRow = {
  userId: string;
  displayName: string | null;
  email: string | null;
  workerType: string | null;

  // Time
  hoursActive: number;
  daysWorked: number;

  // Jobs
  jobsCompleted: number;

  // Earnings
  grossEarnings: number;
  feesOrMargin: number;        // contractor fee OR employee margin
  topUps: number;
  netPaid: number;             // grossEarnings - feesOrMargin + topUps
  ownerEarnings: number;       // business cut (only populated for the LLC owner)

  // Derived
  effectiveHourly: number | null; // netPaid / hoursActive (null when hours = 0)
  preTopUpHourly: number | null;  // (grossEarnings - feesOrMargin) / hoursActive

  // Flags
  belowMinWage: boolean;
  anomalies: string[];

  // Drill-down
  days: ReconcileDayRow[];
};

export type ReconcilePeriod = {
  range: { from: string; to: string };
  minWagePerHour: number;
  totals: {
    workersActive: number;
    totalHours: number;
    totalDaysLogged: number;
    totalJobsCompleted: number;
    totalRevenue: number;          // Payment.amountPaid
    totalEquipmentRental: number;  // Checkout.rentalCost
    totalProcessorFees: number;    // Payment.processorFeeAmount
    totalWorkerGross: number;      // sum of worker gross shares (exc. owner)
    totalBusinessMargin: number;   // sum of employee/trainee margins
    totalContractorFees: number;   // sum of contractor platform fees
    totalTopUps: number;
    totalWorkerNetPaid: number;    // what workers actually received
    totalOwnerEarnings: number;    // business's own cut
    netOperatingIncome: number;    // revenue - worker payouts - processor fees - top-ups
    anomalies: number;
  };
  reconciliationTargets: {
    // Numbers the operator should copy-paste against external systems.
    gustoEmployeeWages: number;    // W-2 (employee+trainee) gross+topUp earnings
    qbServiceIncome: number;        // Payment.amountPaid (sum)
    qbEquipmentRentalIncome: number;
    qbProcessorFees: number;
    qbContractLabor: number;        // contractor splits (non-GP-flagged)
  };
  workers: ReconcileWorkerRow[];
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function loadMinWagePerHour(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: "MIN_WAGE_PER_HOUR" },
  });
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 7.25; // federal floor fallback
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function activeMs(start: Date, end: Date | null, totalPausedMs: number): number {
  if (!end) return 0;
  return Math.max(0, end.getTime() - start.getTime() - totalPausedMs);
}

// Read the JobOccurrence.promisedPayouts snapshot into a map.
type SnapshotEntry = { userId?: string; net?: number; gross?: number; fee?: number; workerType?: string };
function readSnapshot(raw: unknown): Map<string, SnapshotEntry> | null {
  if (!Array.isArray(raw)) return null;
  const m = new Map<string, SnapshotEntry>();
  for (const r of raw as any[]) {
    if (r && typeof r === "object" && typeof r.userId === "string") {
      m.set(r.userId, {
        userId: r.userId,
        gross: Number(r.gross) || 0,
        fee: Number(r.fee) || 0,
        net: Number(r.net) || 0,
        workerType: r.workerType,
      });
    }
  }
  return m.size > 0 ? m : null;
}

// ── Main entry ─────────────────────────────────────────────────────────────

export async function buildReconcileWorkers(
  start: Date,
  end: Date,
  opts: { fromKey: string; toKey: string },
): Promise<ReconcilePeriod> {
  const fromKey = opts.fromKey;
  const toKey = opts.toKey;

  const [workdays, occurrences, payments, rentals, minWage, rates] = await Promise.all([
    prisma.workerWorkday.findMany({
      where: { workdayDate: { gte: fromKey, lte: toKey } },
      include: {
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
      },
    }),
    // Occurrences whose work happened in window — anchored on completedAt
    // so payment-side reconciliation matches PaymentSplit anchoring.
    prisma.jobOccurrence.findMany({
      where: {
        completedAt: { gte: start, lte: end },
        workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
      },
      select: {
        id: true,
        title: true,
        startAt: true,
        completedAt: true,
        price: true,
        completionSplits: true,
        promisedPayouts: true,
        addons: { select: { price: true } },
        expenses: { select: { cost: true } },
        job: {
          select: {
            property: {
              select: {
                displayName: true,
                client: { select: { displayName: true } },
              },
            },
          },
        },
        assignees: {
          where: { role: { not: "observer" } },
          select: {
            userId: true,
            user: { select: { displayName: true, email: true, workerType: true } },
          },
        },
        payment: {
          select: {
            confirmed: true,
            writtenOff: true,
            confirmedAt: true,
            amountPaid: true,
            processorFeeAmount: true,
            splits: {
              select: {
                userId: true,
                amount: true,
                grossAmount: true,
                feeAmount: true,
                topUpAmount: true,
                ownerEarnings: true,
                guaranteedPayoutPaidAt: true,
              },
            },
          },
        },
      },
    }),
    // Confirmed payments in window — drives revenue + processor fees totals.
    // Anchored on confirmedAt (cash basis, same as QB).
    prisma.payment.findMany({
      where: {
        confirmed: true,
        confirmedAt: { gte: start, lte: end },
        writtenOff: false,
      },
      select: { amountPaid: true, processorFeeAmount: true },
    }),
    // Equipment rentals released in window — separate income stream.
    prisma.checkout.findMany({
      where: {
        rentalCost: { gt: 0 },
        releasedAt: { gte: start, lte: end },
      },
      select: { rentalCost: true },
    }),
    loadMinWagePerHour(),
    loadRates(prisma),
  ]);

  // ── Per-worker accumulator ─────────────────────────────────────────────
  type Accum = {
    user: { id: string; displayName: string | null; email: string | null; workerType: string | null };
    hoursMs: number;
    daysSet: Set<string>;
    jobsCompleted: number;
    grossEarnings: number;
    feesOrMargin: number;
    topUps: number;
    ownerEarnings: number;
    // Per-day map for drill-down
    byDay: Map<
      string,
      {
        hoursMs: number;
        jobsCompleted: number;
        grossEarnings: number;
        feesOrMargin: number;
        topUps: number;
        jobs: ReconcileJobRow[];
      }
    >;
  };
  const acc = new Map<string, Accum>();
  function getAcc(user: Accum["user"]): Accum {
    let a = acc.get(user.id);
    if (!a) {
      a = {
        user,
        hoursMs: 0,
        daysSet: new Set(),
        jobsCompleted: 0,
        grossEarnings: 0,
        feesOrMargin: 0,
        topUps: 0,
        ownerEarnings: 0,
        byDay: new Map(),
      };
      acc.set(user.id, a);
    }
    return a;
  }
  function getDay(a: Accum, date: string) {
    let d = a.byDay.get(date);
    if (!d) {
      d = { hoursMs: 0, jobsCompleted: 0, grossEarnings: 0, feesOrMargin: 0, topUps: 0, jobs: [] };
      a.byDay.set(date, d);
    }
    return d;
  }

  // ── Apply workdays → hours + days worked ───────────────────────────────
  for (const w of workdays) {
    const a = getAcc(w.user);
    const ms = activeMs(w.startedAt, w.endedAt, w.totalPausedMs);
    a.hoursMs += ms;
    if (w.endedAt) a.daysSet.add(w.workdayDate);
    const d = getDay(a, w.workdayDate);
    d.hoursMs += ms;
  }

  // ── Apply occurrences → jobs + per-worker earnings ─────────────────────
  for (const occ of occurrences) {
    if (!occ.completedAt) continue;
    const day = etFormatDate(occ.completedAt);
    const clientName = occ.job?.property?.client?.displayName ?? null;
    const propertyName = occ.job?.property?.displayName ?? null;
    const titleLabel = occ.title || propertyName || "(untitled)";
    const paymentConfirmed = !!(occ.payment?.confirmed && !occ.payment.writtenOff);
    const paymentWrittenOff = !!occ.payment?.writtenOff;

    // Build a per-user breakdown for this occurrence. Snapshot first,
    // computeBreakdown fallback. Top-ups + owner-earnings always come
    // from PaymentSplit when available (snapshot doesn't carry top-up).
    const snapshot = readSnapshot((occ as any).promisedPayouts);
    const splitsByUser = new Map<string, {
      amount: number;
      gross: number;
      fee: number;
      topUp: number;
      isOwnerEarnings: boolean;
      gpFlagged: boolean;
    }>();
    if (occ.payment) {
      for (const sp of occ.payment.splits) {
        splitsByUser.set(sp.userId, {
          amount: sp.amount ?? 0,
          gross: sp.grossAmount ?? sp.amount ?? 0,
          fee: sp.feeAmount ?? 0,
          topUp: sp.topUpAmount ?? 0,
          isOwnerEarnings: !!sp.ownerEarnings,
          gpFlagged: sp.guaranteedPayoutPaidAt != null,
        });
      }
    }

    // Compute the computeBreakdown fallback if snapshot absent.
    let computed: Map<string, { gross: number; fee: number; net: number }> | null = null;
    if (!snapshot) {
      const priceTotal =
        (occ.price ?? 0) +
        (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
      const expTotal = (occ.expenses ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
      const cs = (occ as any).completionSplits as Array<{ userId: string; percent: number }> | null;
      const splitPctById = new Map<string, number>(
        Array.isArray(cs) ? cs.map((s) => [s.userId, Number(s.percent) || 0]) : [],
      );
      const fallbackPct = occ.assignees.length > 0 ? 100 / occ.assignees.length : 0;
      const workers: WorkerInput[] = occ.assignees.map((aa: any) => ({
        userId: aa.userId,
        workerType: aa.user?.workerType ?? null,
        splitPercent: splitPctById.get(aa.userId) ?? fallbackPct,
      }));
      const br = computeBreakdown(priceTotal, expTotal, workers, rates);
      computed = new Map(br.map((r) => [r.userId, { gross: r.gross, fee: r.fee, net: r.net }]));
    }

    // Per-assignee row. Owner-earnings tracked separately so personal
    // wage totals stay clean.
    for (const assignee of occ.assignees) {
      const user = assignee.user
        ? {
            id: assignee.userId,
            displayName: assignee.user.displayName,
            email: assignee.user.email,
            workerType: assignee.user.workerType,
          }
        : null;
      if (!user) continue;
      const a = getAcc(user);

      const snap = snapshot?.get(assignee.userId);
      const comp = computed?.get(assignee.userId);
      const split = splitsByUser.get(assignee.userId);

      // Source priority: snapshot → computeBreakdown.
      const gross = snap?.gross ?? comp?.gross ?? split?.gross ?? 0;
      const fee = snap?.fee ?? comp?.fee ?? split?.fee ?? 0;
      const topUp = split?.topUp ?? 0; // top-ups only known at payment time
      const netPaid = round2(gross - fee + topUp);
      const source: "snapshot" | "computed" = snap ? "snapshot" : "computed";

      a.jobsCompleted += 1;
      a.grossEarnings += gross;
      a.feesOrMargin += fee;
      a.topUps += topUp;

      const d = getDay(a, day);
      d.jobsCompleted += 1;
      d.grossEarnings += gross;
      d.feesOrMargin += fee;
      d.topUps += topUp;
      d.jobs.push({
        occurrenceId: occ.id,
        title: titleLabel,
        client: clientName,
        property: propertyName,
        completedAt: occ.completedAt.toISOString(),
        grossShare: round2(gross),
        feeOrMargin: round2(fee),
        topUp: round2(topUp),
        netPaid,
        paymentConfirmed,
        paymentWrittenOff,
        source,
      });
    }

    // Owner-earnings (the LLC owner's cut on this occurrence) gets a
    // separate accumulator on whichever user is flagged as the owner
    // recipient. Doesn't roll into grossEarnings (not personal wage).
    if (occ.payment) {
      for (const sp of occ.payment.splits) {
        if (!sp.ownerEarnings) continue;
        // Find or build accum for this user. They may not be an
        // assignee (owner-earnings can be a separate row).
        const u = occ.assignees.find((a) => a.userId === sp.userId)?.user;
        if (u) {
          const a = getAcc({ id: sp.userId, displayName: u.displayName, email: u.email, workerType: u.workerType });
          a.ownerEarnings += sp.amount ?? 0;
        } else {
          // User not in assignees — still attribute. Look up minimally.
          // Cheap path: load from a small lookup map. We skip the extra
          // DB call and just attribute under the userId without a name;
          // the UI will fall back to "(owner)" when displayName is null.
          const a = getAcc({ id: sp.userId, displayName: null, email: null, workerType: null });
          a.ownerEarnings += sp.amount ?? 0;
        }
      }
    }
  }

  // ── Build per-worker rows + anomalies ──────────────────────────────────
  const workers: ReconcileWorkerRow[] = [];
  let totalAnomalies = 0;

  for (const a of acc.values()) {
    const hoursActive = round2(a.hoursMs / 3600000);
    const grossEarnings = round2(a.grossEarnings);
    const feesOrMargin = round2(a.feesOrMargin);
    const topUps = round2(a.topUps);
    const netPaid = round2(grossEarnings - feesOrMargin + topUps);
    const ownerEarnings = round2(a.ownerEarnings);

    const effectiveHourly = hoursActive > 0 ? round2(netPaid / hoursActive) : null;
    const preTopUpHourly = hoursActive > 0 ? round2((grossEarnings - feesOrMargin) / hoursActive) : null;
    const belowMinWage =
      isEmployeeClass(a.user.workerType) &&
      preTopUpHourly != null &&
      preTopUpHourly < minWage;

    const anomalies: string[] = [];
    if (hoursActive > 0 && a.jobsCompleted === 0) {
      anomalies.push("Logged hours but no completed jobs in window");
    }
    if (a.jobsCompleted > 0 && hoursActive === 0) {
      anomalies.push("Completed jobs but no workday hours recorded");
    }
    if (belowMinWage) {
      anomalies.push(`Pre-top-up hourly $${preTopUpHourly?.toFixed(2)}/h below minimum wage`);
    }
    // Completed jobs whose payment isn't confirmed yet — surface count.
    const unpaidJobs = Array.from(a.byDay.values())
      .flatMap((d) => d.jobs)
      .filter((j) => !j.paymentConfirmed && !j.paymentWrittenOff).length;
    if (unpaidJobs > 0) {
      anomalies.push(`${unpaidJobs} job${unpaidJobs === 1 ? "" : "s"} completed but client payment not confirmed`);
    }
    totalAnomalies += anomalies.length;

    // Sort days asc + assemble.
    const dayKeys = Array.from(a.byDay.keys()).sort();
    const days: ReconcileDayRow[] = dayKeys.map((date) => {
      const d = a.byDay.get(date)!;
      d.jobs.sort((x, y) => (x.completedAt ?? "").localeCompare(y.completedAt ?? ""));
      return {
        date,
        hoursActive: round2(d.hoursMs / 3600000),
        jobsCompleted: d.jobsCompleted,
        grossEarnings: round2(d.grossEarnings),
        feesOrMargin: round2(d.feesOrMargin),
        topUps: round2(d.topUps),
        netPaid: round2(d.grossEarnings - d.feesOrMargin + d.topUps),
        jobs: d.jobs,
      };
    });

    workers.push({
      userId: a.user.id,
      displayName: a.user.displayName,
      email: a.user.email,
      workerType: a.user.workerType,
      hoursActive,
      daysWorked: a.daysSet.size,
      jobsCompleted: a.jobsCompleted,
      grossEarnings,
      feesOrMargin,
      topUps,
      netPaid,
      ownerEarnings,
      effectiveHourly,
      preTopUpHourly,
      belowMinWage,
      anomalies,
      days,
    });
  }

  // Sort: anomalies first, then by net paid desc.
  workers.sort((a, b) => {
    if (a.anomalies.length !== b.anomalies.length) return b.anomalies.length - a.anomalies.length;
    return b.netPaid - a.netPaid;
  });

  // ── Period totals ──────────────────────────────────────────────────────
  const totalRevenue = round2(payments.reduce((s, p) => s + (p.amountPaid ?? 0), 0));
  const totalProcessorFees = round2(payments.reduce((s, p) => s + (p.processorFeeAmount ?? 0), 0));
  const totalEquipmentRental = round2(rentals.reduce((s, r) => s + (r.rentalCost ?? 0), 0));
  const totalHours = round2(workers.reduce((s, w) => s + w.hoursActive, 0));
  const totalJobsCompleted = workers.reduce((s, w) => s + w.jobsCompleted, 0);
  const totalDaysLogged = workers.reduce((s, w) => s + w.daysWorked, 0);
  const totalWorkerGross = round2(workers.reduce((s, w) => s + w.grossEarnings, 0));
  const totalWorkerNetPaid = round2(workers.reduce((s, w) => s + w.netPaid, 0));
  const totalTopUps = round2(workers.reduce((s, w) => s + w.topUps, 0));
  const totalOwnerEarnings = round2(workers.reduce((s, w) => s + w.ownerEarnings, 0));

  // Split fees/margin by worker type.
  let totalBusinessMargin = 0;
  let totalContractorFees = 0;
  for (const w of workers) {
    if (isEmployeeClass(w.workerType)) totalBusinessMargin += w.feesOrMargin;
    else totalContractorFees += w.feesOrMargin;
  }
  totalBusinessMargin = round2(totalBusinessMargin);
  totalContractorFees = round2(totalContractorFees);

  // Net operating income (period-level rough cut): revenue + rentals
  // − worker payouts − processor fees. Top-ups already inside payouts.
  const netOperatingIncome = round2(
    totalRevenue + totalEquipmentRental - totalWorkerNetPaid - totalProcessorFees,
  );

  // ── Reconciliation targets ─────────────────────────────────────────────
  // Gusto employee wages = W-2 (employee+trainee) gross + top-ups, fees
  // not deducted (fees are the business's cut). This is what Gusto will
  // pay through payroll.
  let gustoEmployeeWages = 0;
  let qbContractLabor = 0;
  for (const w of workers) {
    if (isEmployeeClass(w.workerType)) {
      gustoEmployeeWages += w.grossEarnings - w.feesOrMargin + w.topUps;
    } else {
      qbContractLabor += w.netPaid;
    }
  }
  gustoEmployeeWages = round2(gustoEmployeeWages);
  qbContractLabor = round2(qbContractLabor);

  return {
    range: { from: fromKey, to: toKey },
    minWagePerHour: minWage,
    totals: {
      workersActive: workers.length,
      totalHours,
      totalDaysLogged,
      totalJobsCompleted,
      totalRevenue,
      totalEquipmentRental,
      totalProcessorFees,
      totalWorkerGross,
      totalBusinessMargin,
      totalContractorFees,
      totalTopUps,
      totalWorkerNetPaid,
      totalOwnerEarnings,
      netOperatingIncome,
      anomalies: totalAnomalies,
    },
    reconciliationTargets: {
      gustoEmployeeWages,
      qbServiceIncome: totalRevenue,
      qbEquipmentRentalIncome: totalEquipmentRental,
      qbProcessorFees: totalProcessorFees,
      qbContractLabor,
    },
    workers,
  };
}
