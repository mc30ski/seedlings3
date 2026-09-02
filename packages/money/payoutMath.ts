// ─────────────────────────────────────────────────────────────────────────────
// Payout math — the pure, shared core
//
// Extracted from services/payments.ts so that anything which needs to REASON
// about payouts computes them with the exact same code that WRITES them.
// Production payment approval and the Super forecasting tool both call these
// functions; neither is allowed a private copy of the arithmetic.
//
// The rule this module exists to enforce: a simulator that reimplements the
// split math will drift from production the first time a rate rule changes,
// and it will drift silently, while continuing to look authoritative. See
// apps/api/src/services/forecast-build-gate.test.ts, which asserts the forecast service
// contains no payout arithmetic of its own.
//
// Everything here is PURE — no prisma, no settings reads, no clock. Callers
// supply the rates. Policy + worked examples: docs/FINANCIAL_SYSTEM.md §3-4
// and memory/project_payment_math.md.
// ─────────────────────────────────────────────────────────────────────────────

/** Structurally identical to Prisma's WorkerType enum. Declared locally so
 *  this package has ZERO dependencies and can be imported from the browser
 *  bundle as readily as from the Fastify server — a Prisma import would drag
 *  the client into the web build for the sake of a three-member string union.
 *  The API passes Prisma's enum straight in; TypeScript accepts it because
 *  the two types are the same set of strings. */
export type WorkerType = "EMPLOYEE" | "CONTRACTOR" | "TRAINEE";


// ────────────────────────────────────────────────────────────────────
// Payment breakdown math (see memory/project_payment_math.md)
// ────────────────────────────────────────────────────────────────────

export type WorkerInput = { userId: string; splitPercent: number; workerType: WorkerType | null };
export type Rates = { contractorFeePercent: number; employeeMarginPercent: number };

export type PromisedRow = {
  userId: string;
  workerType: WorkerType | null;
  splitPercent: number;
  gross: number;
  ratePercent: number;
  fee: number;
  net: number;
};

export type FinalSplitRow = {
  userId: string;
  workerType: WorkerType | null;
  splitPercent: number;
  grossAmount: number;
  ratePercent: number;
  feeAmount: number;
  netAmount: number;
  topUpAmount: number;
  amount: number; // final payout = netAmount + topUpAmount
  /** This worker's share of a designated tip. Separate from `amount` on
   *  purpose — see PaymentSplit.tipAmount in schema.prisma. */
  tipAmount: number;
};

/**
 * Operator's designation of an overpayment as a tip.
 *
 * `businessPercent` + every `workerPercents[].percent` must total 100.
 * The UI defaults the worker percentages to the job's `completionSplits`
 * with the business at 0, and validates the total before submitting.
 */
export type TipDesignation = {
  /** Total to designate. Clamped to the computed overage — you cannot tip
   *  money the client didn't actually overpay. */
  amount: number;
  businessPercent: number;
  workerPercents: Array<{ userId: string; percent: number }>;
};

/**
 * Split `total` across `percents` so the parts sum to EXACTLY `total`.
 *
 * Independent `round2` calls drift — two workers at 50% of $0.01 each
 * round to $0.01 and sum to $0.02. That would break the payment-row
 * conservation identity (build gate C), which is checked to the cent.
 *
 * Largest-remainder method: floor everyone to cents, then hand the
 * leftover cents out one at a time in descending fractional-part order.
 */
export function allocateExact(
  total: number,
  percents: Array<{ key: string; percent: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (percents.length === 0) return out;
  const totalCents = Math.round(total * 100);
  const raw = percents.map((p) => ({
    key: p.key,
    exact: (totalCents * p.percent) / 100,
  }));
  let assigned = 0;
  const floored = raw.map((r) => {
    const f = Math.floor(r.exact);
    assigned += f;
    return { key: r.key, cents: f, frac: r.exact - f };
  });
  let remainder = totalCents - assigned;
  // Ties broken by the original order, which is stable across runs.
  const order = [...floored].sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < order.length && remainder > 0; i++, remainder--) {
    order[i].cents += 1;
  }
  for (const f of floored) out.set(f.key, f.cents / 100);
  return out;
}

export function isEmployeeClass(wt: WorkerType | null): boolean {
  return wt === "EMPLOYEE" || wt === "TRAINEE";
}

export function rateFor(wt: WorkerType | null, rates: Rates): number {
  return isEmployeeClass(wt) ? rates.employeeMarginPercent : rates.contractorFeePercent;
}

export function round2(n: number): number {
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

  // Penny-residual fix on net — spread across rows one cent at a time.
  //
  // Independent rounding of gross/fee/net per row can leave a small gap
  // vs. the distributable pool (e.g. a 50/50 W-2 split on a $35 pool
  // rounds both fees UP 0.005 and both nets UP 0.005, producing a $0.02
  // over-distribution). The previous implementation dumped the entire
  // residual on row 0, which:
  //   1. Systematically shortchanged the claimer (usually row 0)
  //      cumulatively across jobs, and
  //   2. Produced 2-cent+ spreads between workers on identical splits.
  //
  // Fair allocation instead: distribute one cent per row, wrapping
  // around if the residual magnitude exceeds the row count. Guarantees
  // the max spread between any two workers on the same split% stays
  // within 1 cent. Conservation invariant (sum(net + fee) == N) still
  // holds — that's what payments-build-gate.test.ts locks in.
  if (rows.length > 0) {
    const distributedNet = rows.reduce((s, r) => s + r.net + r.fee, 0);
    const residualCents = Math.round((N - distributedNet) * 100);
    if (residualCents !== 0) {
      const sign = residualCents < 0 ? -1 : 1;
      let remaining = Math.abs(residualCents);
      let i = 0;
      while (remaining > 0) {
        const idx = i % rows.length;
        rows[idx].net = round2(rows[idx].net + sign * 0.01);
        remaining -= 1;
        i += 1;
      }
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
  tip?: TipDesignation | null,
): {
  splits: FinalSplitRow[];
  platformFeeAmount: number;
  businessMarginAmount: number;
  shortfallAmount: number;
  overageAmount: number;
  tipAmount: number;
  tipToBusinessAmount: number;
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
        tipAmount: 0,
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
        tipAmount: 0,
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
      tipAmount: 0,
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

  const shortfallAmount = delta < 0 ? round2(-delta) : 0;
  let overageAmount = delta > 0 ? round2(delta) : 0;

  // TIP DESIGNATION. A tip is carved OUT of the overage — you cannot tip
  // money the client didn't overpay, so the request is clamped to it.
  // Whatever is left stays `overageAmount`: an overpayment nobody called a
  // tip. The two are mutually exclusive by construction.
  //
  // Tips deliberately bypass platform fee and business margin: the
  // business's cut is exactly `businessPercent`, not that plus a rate on
  // the workers' shares.
  let tipAmount = 0;
  let tipToBusinessAmount = 0;
  if (tip && tip.amount > 0 && overageAmount > 0) {
    tipAmount = round2(Math.min(tip.amount, overageAmount));
    const parts = [
      { key: "__business", percent: tip.businessPercent },
      ...tip.workerPercents.map((w) => ({ key: w.userId, percent: w.percent })),
    ];
    const alloc = allocateExact(tipAmount, parts);
    tipToBusinessAmount = alloc.get("__business") ?? 0;
    for (const sp of splits) sp.tipAmount = alloc.get(sp.userId) ?? 0;
    // A percentage aimed at someone who has no split row would silently
    // vanish and break the identity — fold it into the business share,
    // which is where unattributed money belongs.
    const attributed = round2(
      tipToBusinessAmount + splits.reduce((sum, sp) => sum + sp.tipAmount, 0),
    );
    if (attributed !== tipAmount) {
      tipToBusinessAmount = round2(tipToBusinessAmount + (tipAmount - attributed));
    }
    overageAmount = round2(overageAmount - tipAmount);
  }

  return {
    splits,
    platformFeeAmount,
    businessMarginAmount,
    shortfallAmount,
    overageAmount,
    tipAmount,
    tipToBusinessAmount,
  };
}
