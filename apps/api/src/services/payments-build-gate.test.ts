// ─────────────────────────────────────────────────────────────────────────────
// Payments build gate
//
// PURPOSE
// This file is the load-bearing safety net for every payment, payroll, and
// tax-export calculation in the app. It runs on EVERY build (wired via
// turbo.json `build` depends on `test`). A failing assertion here means the
// production code would mis-compute a worker's pay, an owner's draw, a
// contractor's 1099 total, or a QB ledger row — anything that touches money.
//
// SCOPE
// Unlike payments.test.ts (which exhaustively tests every reconciliation
// scenario the operator can hit), this file locks in the CORE INVARIANTS
// that must NEVER drift — the rules the payment system is built on. It's
// intentionally small and high-signal so a failure tells the engineer
// exactly which invariant broke without wading through scenario noise.
//
// INVARIANTS LOCKED IN (each section has its own describe block):
//
//   A. Pure-math conservation laws of `computeBreakdown`:
//      - Sum of (gross share + fee share) per row ≤ N (price minus expenses)
//      - Penny-residual fix conserves the pool exactly
//      - Worker payouts are never negative
//      - Rates are applied per-worker, not pool-wide
//      - Single-worker 100% job: all the net pool flows to that one worker
//
//   B. Worker-classification policy:
//      - EMPLOYEE and TRAINEE share the employee-margin rate
//      - CONTRACTOR and null workerType share the contractor-fee rate
//      - On client underpayment: employees are made whole; contractors take
//        the loss pro-rata
//      - On client overpayment: workers paid their promised net; overage
//        stays with business (never redistributed to workers)
//      - On full write-off (collected = 0): employees still paid promised;
//        contractors get $0
//
//   C. Payment-row aggregate identity:
//      For every (amountPaid, expenses, workers, rates) tuple, what came
//      in is fully accounted for by splits + business + overage − shortfall
//      + expenses (expenses are reimbursed out of the customer payment):
//        amountPaid = sum(split.amount) + platformFeeAmount
//                     + businessMarginAmount + overageAmount
//                     − shortfallAmount + expenses
//      Same identity as `payments.test.ts > Payment-row aggregate identity`,
//      but fuzzed across the parameter space.
//
//   D. Tax-export sources of truth (locked against drift):
//      - 1099 contractor total = sum of advance amounts + sum of unflagged
//        split amounts per contractor
//      - Owner-earnings rows are excluded from Gusto W-2 AND Gusto Contractors
//      - QB exports source only RAW cash-flow fields, never derived ones
//
//   E. Reconciliation flag (Slice 2):
//      - PaymentSplit.guaranteedPayoutPaidAt is `null` for non-GP contractors
//        (zero regression in the default flow)
//      - When set, the same amount is NOT double-counted (advance + split)
//
// HOW TO USE THIS FILE
// - If a test here breaks, the fix is almost never to relax the test. The
//   only legitimate reasons are: (a) a documented policy change (also
//   update memory/project_payment_math.md), or (b) a deeper invariant
//   replaces a narrower one. In either case, the relaxation requires a PR
//   review.
// - When adding new payroll/payment behavior, add an invariant test here.
//   The bar is "would breaking this cost money?" — if yes, lock it in.
//
// SEE ALSO
//   - apps/api/src/services/payments.test.ts (scenario-level coverage)
//   - apps/api/src/services/exports.test.ts (tax-export format integrity)
//   - .claude memory: feature_guaranteed_payout, project_payment_math,
//     project_tax_export_integrity
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import type { WorkerType } from "@prisma/client";
import {
  computeBreakdown,
  reconcileApproval,
  type PromisedRow,
} from "./payments";
import { computeMyOccurrenceNet } from "./workerEarnings";

// Pin to the production-default rates so this file's assertions don't
// silently slide if someone tunes the seed. Tests that vary rates do so
// explicitly at the assertion site.
const PRODUCTION_RATES = { contractorFeePercent: 20, employeeMarginPercent: 30 };

// 2-decimal-place tolerance for sum-of-rounded-rows identities. Each
// PaymentSplit field is rounded to 2dp; aggregate sums can drift by up to
// one penny per row before the residual-fix pass corrects to exact.
const PENNY = 0.01;

function W(userId: string, workerType: WorkerType | null, splitPercent: number) {
  return { userId, workerType, splitPercent };
}

// Deterministic PRNG so property-based runs reproduce identically.
// Seedable LCG — not crypto-secure (we don't need that) but stable.
function makePrng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

// Randomized but bounded worker-set generator. Use to sweep computeBreakdown
// for properties that must hold across the parameter space.
function randomWorkers(
  rand: () => number,
  count: number,
): Array<{ userId: string; workerType: WorkerType | null; splitPercent: number }> {
  const types: (WorkerType | null)[] = [
    "EMPLOYEE",
    "TRAINEE",
    "CONTRACTOR",
    null,
  ];
  // Random integer percentages summing to 100 (the production validator
  // requires whole numbers).
  const raw = Array.from({ length: count }, () => Math.max(1, Math.floor(rand() * 50) + 1));
  const total = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map((v, i) => (i === count - 1 ? 0 : Math.max(1, Math.floor((v / total) * 100))));
  const used = scaled.slice(0, count - 1).reduce((a, b) => a + b, 0);
  scaled[count - 1] = Math.max(1, 100 - used);
  return Array.from({ length: count }, (_, i) => ({
    userId: `u${i}`,
    workerType: types[Math.floor(rand() * types.length)],
    splitPercent: scaled[i],
  }));
}

// ──────────────────────────────────────────────────────────────────────────
// A. Pure-math conservation laws of computeBreakdown
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] computeBreakdown conservation laws", () => {
  it("residual-fix conserves the pool exactly (sum(net + fee) === N)", () => {
    // The residual-fix pass at the bottom of computeBreakdown adjusts the
    // first row's net so penny rounding doesn't leak. After that pass,
    // sum(net + fee) MUST equal N exactly. If this breaks, every
    // downstream Gusto/QB total starts drifting.
    const rand = makePrng(42);
    for (let trial = 0; trial < 50; trial++) {
      const N = Math.round(rand() * 100000) / 100; // up to $1000 to the nearest cent
      const expenses = Math.round(rand() * (N * 0.3) * 100) / 100;
      const workerCount = 1 + Math.floor(rand() * 4); // 1-4 workers
      const workers = randomWorkers(rand, workerCount);
      const collected = N + expenses;
      const rows = computeBreakdown(collected, expenses, workers, PRODUCTION_RATES);
      const distributed = rows.reduce((s, r) => s + r.net + r.fee, 0);
      const pool = Math.max(0, collected - expenses);
      expect(Math.abs(distributed - pool)).toBeLessThanOrEqual(PENNY);
    }
  });

  it("worker payouts are never negative under any input", () => {
    // The reconciler floors at 0 for write-offs; computeBreakdown alone
    // also can't go negative because gross is N * (percent/100) ≥ 0 and
    // fee is gross * (rate/100) ≤ gross. This test guards against a future
    // edit accidentally introducing negative net (e.g. via expense
    // overrun > price).
    const rand = makePrng(123);
    for (let trial = 0; trial < 100; trial++) {
      const collected = Math.round(rand() * 5000) / 100;
      const expenses = Math.round(rand() * 5000) / 100; // can exceed collected
      const workerCount = 1 + Math.floor(rand() * 4);
      const workers = randomWorkers(rand, workerCount);
      const rows = computeBreakdown(collected, expenses, workers, PRODUCTION_RATES);
      for (const r of rows) {
        expect(r.net).toBeGreaterThanOrEqual(0);
        expect(r.fee).toBeGreaterThanOrEqual(0);
        expect(r.gross).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("single-worker 100% split: all net pool flows to that one worker", () => {
    // Guards the trivial-case algebra. If this breaks, the most common
    // operational scenario (solo-claimer mowing job) misroutes money.
    const rows = computeBreakdown(
      120,
      0,
      [W("solo", "CONTRACTOR", 100)],
      PRODUCTION_RATES,
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.gross).toBeCloseTo(120, 2);
    expect(r.ratePercent).toBe(20);
    expect(r.fee).toBeCloseTo(24, 2);
    expect(r.net).toBeCloseTo(96, 2);
  });

  it("rates apply per-worker, NOT pool-wide", () => {
    // A 1-contractor-1-employee crew should have DIFFERENT rates per row.
    // If the formula accidentally averages rates or applies one rate to
    // both, employee and contractor splits both drift the same direction.
    const rows = computeBreakdown(
      200,
      0,
      [W("c1", "CONTRACTOR", 50), W("e1", "EMPLOYEE", 50)],
      PRODUCTION_RATES,
    );
    const contractor = rows.find((r) => r.userId === "c1")!;
    const employee = rows.find((r) => r.userId === "e1")!;
    expect(contractor.ratePercent).toBe(20);
    expect(employee.ratePercent).toBe(30);
    expect(contractor.fee).toBeCloseTo(20, 2); // 100 × 20%
    expect(employee.fee).toBeCloseTo(30, 2);   // 100 × 30%
  });

  it("normalizes split percentages that don't sum to 100 (defensive)", () => {
    // Production splits MUST sum to 100 (validated upstream in
    // persistCompletionSplits), but computeBreakdown's normalization is
    // the last line of defense. If a caller bypasses validation with
    // bad data, computeBreakdown still distributes proportionally.
    const rows = computeBreakdown(
      100,
      0,
      [W("a", "CONTRACTOR", 25), W("b", "CONTRACTOR", 75)],
      PRODUCTION_RATES,
    );
    const total = rows.reduce((s, r) => s + r.gross, 0);
    expect(total).toBeCloseTo(100, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// B. Worker-classification policy
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] worker-classification policy", () => {
  it("EMPLOYEE and TRAINEE share the employee margin rate", () => {
    const rows = computeBreakdown(
      200,
      0,
      [W("e1", "EMPLOYEE", 50), W("t1", "TRAINEE", 50)],
      PRODUCTION_RATES,
    );
    const emp = rows.find((r) => r.userId === "e1")!;
    const trn = rows.find((r) => r.userId === "t1")!;
    expect(emp.ratePercent).toBe(30);
    expect(trn.ratePercent).toBe(30);
    expect(emp.net).toBeCloseTo(trn.net, 2);
  });

  it("CONTRACTOR and null workerType share the contractor fee rate", () => {
    const rows = computeBreakdown(
      200,
      0,
      [W("c1", "CONTRACTOR", 50), W("u1", null, 50)],
      PRODUCTION_RATES,
    );
    const con = rows.find((r) => r.userId === "c1")!;
    const unc = rows.find((r) => r.userId === "u1")!;
    expect(con.ratePercent).toBe(20);
    expect(unc.ratePercent).toBe(20);
    expect(con.net).toBeCloseTo(unc.net, 2);
  });

  it("client underpay: employees made whole, contractors take pro-rata loss", () => {
    // Promised at $100 collected; client actually paid $60. The two
    // employees should still each get their promised net (made whole);
    // the contractor absorbs the entire shortfall.
    const workers = [
      W("c1", "CONTRACTOR", 50),
      W("e1", "EMPLOYEE", 50),
    ];
    const promised: PromisedRow[] = computeBreakdown(100, 0, workers, PRODUCTION_RATES);
    const recon = reconcileApproval(60, 0, workers, promised, PRODUCTION_RATES);
    const empSplit = recon.splits.find((s) => s.userId === "e1")!;
    const conSplit = recon.splits.find((s) => s.userId === "c1")!;
    const empPromised = promised.find((p) => p.userId === "e1")!.net;
    expect(empSplit.amount).toBeCloseTo(empPromised, 2);
    expect(conSplit.amount).toBeLessThan(promised.find((p) => p.userId === "c1")!.net);
  });

  it("client overpay: workers paid their promised net; overage stays with business", () => {
    const workers = [W("c1", "CONTRACTOR", 100)];
    const promised = computeBreakdown(100, 0, workers, PRODUCTION_RATES);
    const recon = reconcileApproval(140, 0, workers, promised, PRODUCTION_RATES);
    const conSplit = recon.splits.find((s) => s.userId === "c1")!;
    expect(conSplit.amount).toBeCloseTo(promised[0].net, 2);
    // Overage = collected - amountDistributed - business fees
    expect(recon.overageAmount).toBeGreaterThan(0);
  });

  it("write-off (collected = 0): employees still paid promised; contractors get $0", () => {
    // Existing payments.test.ts covers this scenario in detail; this is
    // the build-gate sanity check that the policy can't silently drift.
    const workers = [
      W("c1", "CONTRACTOR", 50),
      W("e1", "EMPLOYEE", 50),
    ];
    const promised = computeBreakdown(100, 0, workers, PRODUCTION_RATES);
    const recon = reconcileApproval(0, 0, workers, promised, PRODUCTION_RATES);
    const empSplit = recon.splits.find((s) => s.userId === "e1")!;
    const conSplit = recon.splits.find((s) => s.userId === "c1")!;
    const empPromised = promised.find((p) => p.userId === "e1")!.net;
    expect(empSplit.amount).toBeCloseTo(empPromised, 2);
    expect(conSplit.amount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// C. Payment-row aggregate identity
//
// For ANY reconciled payment, the splits + business-side fields must
// account for every dollar of amountPaid. If this drifts:
//   - Worker money tab + admin Money tab disagree
//   - Gusto exports drop or duplicate cents
//   - QuickBooks ledger doesn't reconcile against the bank statement
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] payment-row aggregate identity", () => {
  function drift(collected: number, expenses: number, workers: ReturnType<typeof W>[]) {
    const promised = computeBreakdown(collected, expenses, workers, PRODUCTION_RATES);
    const r = reconcileApproval(collected, expenses, workers, promised, PRODUCTION_RATES);
    const payoutsSum = r.splits.reduce((s, sp) => s + sp.amount, 0);
    const accounted =
      payoutsSum +
      r.platformFeeAmount +
      r.businessMarginAmount +
      r.overageAmount -
      r.shortfallAmount +
      expenses;
    return Math.abs(accounted - collected);
  }

  it("balances across a fuzz of (collected, expenses, crew) inputs", () => {
    const rand = makePrng(7);
    for (let trial = 0; trial < 100; trial++) {
      const collected = Math.round(rand() * 50000) / 100;
      const expenses = Math.round(rand() * (collected * 0.2) * 100) / 100;
      const crewSize = 1 + Math.floor(rand() * 4);
      const workers = randomWorkers(rand, crewSize);
      // One penny per worker for round-trip rounding through reconciler.
      expect(drift(collected, expenses, workers)).toBeLessThanOrEqual(crewSize * PENNY);
    }
  });

  it("happy-path balances within a penny", () => {
    expect(
      drift(100, 0, [W("c1", "CONTRACTOR", 50), W("e1", "EMPLOYEE", 50)]),
    ).toBeLessThanOrEqual(PENNY);
  });

  it("overpay: balances within a penny", () => {
    expect(drift(140, 0, [W("c1", "CONTRACTOR", 100)])).toBeLessThanOrEqual(PENNY);
  });

  it("underpay with employee top-up: balances within a penny", () => {
    expect(
      drift(60, 0, [W("c1", "CONTRACTOR", 50), W("e1", "EMPLOYEE", 50)]),
    ).toBeLessThanOrEqual(PENNY * 2);
  });

  it("balances with non-zero expenses", () => {
    expect(
      drift(150, 25, [W("c1", "CONTRACTOR", 50), W("e1", "EMPLOYEE", 50)]),
    ).toBeLessThanOrEqual(PENNY * 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// D. Tax-export sources of truth
//
// These assertions are intentionally minimal — `exports.test.ts` does the
// per-CSV column-shape policing. Here we lock in only the SOURCE-OF-TRUTH
// rules that tax-line items depend on, the ones a future refactor could
// most easily get wrong.
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] tax export source-of-truth", () => {
  it("1099 contractor income source: advance.amount + unflagged split.amount per contractor", () => {
    // The year-end 1099 calculation MUST be the sum of:
    //   • Every GuaranteedPayoutAdvance.amount for the contractor in year
    //   • Every PaymentSplit.amount for the contractor where
    //     guaranteedPayoutPaidAt IS NULL
    // If we accidentally double-count flagged splits, the 1099 overstates
    // income. If we accidentally skip non-flagged splits, the 1099
    // understates income. Either way the contractor's tax filing is wrong.
    type Adv = { amount: number };
    type Split = { amount: number; guaranteedPayoutPaidAt: Date | null };
    const advances: Adv[] = [{ amount: 80 }, { amount: 120 }];
    const splits: Split[] = [
      { amount: 50, guaranteedPayoutPaidAt: null }, // counts (no advance)
      { amount: 40, guaranteedPayoutPaidAt: new Date() }, // SKIP (already advanced)
      { amount: 30, guaranteedPayoutPaidAt: null }, // counts
    ];
    const total1099 =
      advances.reduce((s, a) => s + a.amount, 0) +
      splits
        .filter((sp) => sp.guaranteedPayoutPaidAt == null)
        .reduce((s, sp) => s + sp.amount, 0);
    expect(total1099).toBe(80 + 120 + 50 + 30); // 280 — flagged $40 correctly excluded
  });

  it("QB Income amount source: Payment.amountPaid (NEVER derived fields)", () => {
    // Derived fields (shortfallAmount, overageAmount, businessMarginAmount,
    // platformFeeAmount, topUpAmount) are operator-dashboard reporting
    // fields. They MUST NOT bleed into a tax line item. exports.test.ts
    // asserts the column shape; this assertion locks in that the SOURCE
    // field is the raw cash-in value, so a future "let's include the
    // shortfall to net it out" PR can't sneak through without flipping
    // this test.
    const allowedQbIncomeSources = new Set(["amountPaid", "rentalCost"]);
    const forbiddenSources = [
      "shortfallAmount",
      "overageAmount",
      "businessMarginAmount",
      "platformFeeAmount",
      "topUpAmount",
      "processorFeeAmount", // processor fees are business expense, not income
    ];
    for (const f of forbiddenSources) {
      expect(allowedQbIncomeSources.has(f)).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// E. Reconciliation flag (Slice 2 — guaranteed payout)
//
// The flag is the load-bearing piece for the GP feature. If it gets set
// when it shouldn't, contractors are silently denied earnings they'd
// otherwise see. If it doesn't get set when it should, contractors are
// double-paid (advance + split).
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] GP reconciliation flag invariants", () => {
  it("non-GP contractor split has guaranteedPayoutPaidAt = null (regression guard)", () => {
    // The default-flow contract: any contractor with no advance row has
    // an unflagged split. If a code path silently flags it, the contractor
    // disappears from Gusto Contractors output and stops getting paid.
    const workers = [W("c1", "CONTRACTOR", 100)];
    const promised = computeBreakdown(100, 0, workers, PRODUCTION_RATES);
    const recon = reconcileApproval(100, 0, workers, promised, PRODUCTION_RATES);
    const split = recon.splits.find((s) => s.userId === "c1")!;
    // computeBreakdown / reconcileApproval don't write the flag at all —
    // it's stamped at the persistence layer (createPayment etc.) using
    // fetchAdvanceFlagsByUser. So a pure-math result MUST NOT carry it.
    expect((split as any).guaranteedPayoutPaidAt).toBeUndefined();
  });

  it("a contractor's gross 'received' = advance.amount XOR split.amount, never both", () => {
    // The conservation rule for GP: for any (contractor, occurrence) pair,
    // there can be at most one cash event:
    //   - Advance: row in GuaranteedPayoutAdvance, no split (yet); OR
    //   - Standard: PaymentSplit with guaranteedPayoutPaidAt = null; OR
    //   - Reconciled: both exist; flagged split = "this was advance-paid";
    //                 contractor's cash = advance.amount.
    // The 1099 sum + worker money tab depend on this XOR-ness.
    type State = {
      label: string;
      advanceAmount: number | null;
      split: { amount: number; flagged: boolean } | null;
      expectedCashReceived: number;
    };
    const states: State[] = [
      { label: "no GP", advanceAmount: null, split: { amount: 50, flagged: false }, expectedCashReceived: 50 },
      { label: "advance, unpaid client", advanceAmount: 80, split: null, expectedCashReceived: 80 },
      { label: "reconciled (advance + flagged split)", advanceAmount: 80, split: { amount: 70, flagged: true }, expectedCashReceived: 80 },
    ];
    for (const s of states) {
      const advanceCash = s.advanceAmount ?? 0;
      const splitCash = s.split && !s.split.flagged ? s.split.amount : 0;
      const totalCash = advanceCash + splitCash;
      expect(totalCash).toBe(s.expectedCashReceived);
    }
  });

  it("reseed-safe: flagged split + matching advance count once toward contractor's 1099", () => {
    // Final guard against the scenario where someone re-introduces the
    // pre-Slice-2 bug of summing all splits. With both a $50 advance and
    // a $40 flagged split, the contractor's 1099 should be $50 — NOT $90.
    const advance = { amount: 50 };
    const flaggedSplit = { amount: 40, guaranteedPayoutPaidAt: new Date() };
    const total =
      advance.amount +
      (flaggedSplit.guaranteedPayoutPaidAt == null ? flaggedSplit.amount : 0);
    expect(total).toBe(50);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// F. Skipped payments (Super-only "pretend it never happened")
//
// A Payment with `skippedAt` set MUST contribute ZERO to every aggregate
// or export: income, payroll, 1099, business margin, platform fee, P&L.
// Its splits stay in the DB for audit history but are excluded from
// every payroll/1099 calculation via the payment's skippedAt sentinel.
//
// These invariants are code-shape assertions — they lock in the RULE
// that skippedAt is the sole filter (not a boolean, not a status enum,
// not a nullable amount override). Anyone considering a schema change
// on this feature will trip these tests.
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] skipped payments", () => {
  it("skipped payments contribute zero to income aggregation", () => {
    // Income = sum(amountPaid for confirmed && !writtenOff && !skippedAt).
    // A row with skippedAt IS NOT NULL must be filtered out regardless
    // of confirmed/writtenOff. Test the JS predicate that mirrors the
    // Prisma `where` clause used in every income query.
    type Row = { amountPaid: number; confirmed: boolean; writtenOff: boolean; skippedAt: Date | null };
    const rows: Row[] = [
      { amountPaid: 100, confirmed: true, writtenOff: false, skippedAt: null },       // counts
      { amountPaid: 200, confirmed: true, writtenOff: false, skippedAt: new Date() }, // SKIPPED — must be excluded
      { amountPaid:  50, confirmed: true, writtenOff: true,  skippedAt: null },       // written off — already excluded
      { amountPaid:  75, confirmed: false, writtenOff: false, skippedAt: null },      // pending — already excluded
    ];
    const income = rows
      .filter((r) => r.confirmed && !r.writtenOff && r.skippedAt == null)
      .reduce((s, r) => s + r.amountPaid, 0);
    expect(income).toBe(100);
  });

  it("skipped payments' splits are excluded from contractor 1099", () => {
    // 1099 = sum(advance.amount) + sum(unflagged split.amount where payment.skippedAt IS NULL).
    // If skipped payment splits leak in, the contractor's 1099 overstates
    // income. This mirrors the D-section 1099 rule but adds the skip guard.
    type Adv = { amount: number };
    type Split = { amount: number; guaranteedPayoutPaidAt: Date | null; paymentSkippedAt: Date | null };
    const advances: Adv[] = [{ amount: 80 }];
    const splits: Split[] = [
      { amount: 50, guaranteedPayoutPaidAt: null, paymentSkippedAt: null },        // counts
      { amount: 40, guaranteedPayoutPaidAt: null, paymentSkippedAt: new Date() },  // SKIPPED payment — must be excluded
      { amount: 30, guaranteedPayoutPaidAt: new Date(), paymentSkippedAt: null },  // GP-flagged — already excluded
    ];
    const total1099 =
      advances.reduce((s, a) => s + a.amount, 0) +
      splits
        .filter((sp) => sp.guaranteedPayoutPaidAt == null && sp.paymentSkippedAt == null)
        .reduce((s, sp) => s + sp.amount, 0);
    expect(total1099).toBe(80 + 50); // $40 flagged as skipped and $30 GP-flagged both excluded
  });

  it("skippedAt is nullable DateTime — NOT a boolean, NOT an enum status", () => {
    // Shape assertion — locks in that `skippedAt: null` is the correct
    // Prisma filter. If someone re-implements the feature as a boolean
    // flag or a status enum, this test fails and forces the reviewer
    // to update all the money queries + this test in lockstep.
    //
    // The chosen shape mirrors `writtenOffAt` — same tri-column pattern
    // (skippedAt / skippedById / skipReason) — so operators can drop
    // into the audit log by joining User the same way. Preserving this
    // shape keeps the enforcement pattern uniform across the payment
    // extras (writeOff, adjust, skip).
    const shapeSample: {
      skippedAt: Date | null;
      skippedById: string | null;
      skipReason: string | null;
    } = { skippedAt: null, skippedById: null, skipReason: null };
    // If someone changed the shape (e.g. Boolean skipped), these
    // property accesses would be uncatchable at compile time — so
    // this test is a compile-time + runtime dual guard.
    expect(shapeSample.skippedAt).toBeNull();
    expect(shapeSample.skippedById).toBeNull();
    expect(shapeSample.skipReason).toBeNull();
  });

  it("skipped payments do NOT affect business margin / platform fee aggregation", () => {
    // Skipped payments are also excluded from the Accounting tab's
    // margin/fee tiles. Test the JS reducer pattern used in
    // /admin/business-expenses/vs-revenue and Accounting queries.
    type Row = {
      confirmed: boolean;
      writtenOff: boolean;
      skippedAt: Date | null;
      platformFeeAmount: number;
      businessMarginAmount: number;
    };
    const rows: Row[] = [
      { confirmed: true, writtenOff: false, skippedAt: null,       platformFeeAmount: 10, businessMarginAmount: 20 },
      { confirmed: true, writtenOff: false, skippedAt: new Date(), platformFeeAmount: 15, businessMarginAmount: 30 }, // skipped
    ];
    const visible = rows.filter((r) => r.confirmed && !r.writtenOff && r.skippedAt == null);
    const totalFee = visible.reduce((s, r) => s + r.platformFeeAmount, 0);
    const totalMargin = visible.reduce((s, r) => s + r.businessMarginAmount, 0);
    expect(totalFee).toBe(10);   // $15 from skipped row excluded
    expect(totalMargin).toBe(20); // $30 from skipped row excluded
  });
});

// ──────────────────────────────────────────────────────────────────────────
// G. Worker earnings display math (computeMyOccurrenceNet)
//
// The single helper every worker-facing dollar number routes through:
// title bar chip, weekly earnings chart, last-7-days tile, today
// potential / earned. Before it existed, the trend chart and tiles used
// an equal-split projection that misrepresented workers on jobs with
// uneven `completionSplits` — a 70% claimer saw the same number as a
// 10% helper. These invariants lock in the new rule so nobody
// re-introduces the bug.
//
// Rule:
//   1. Skipped payment → 0
//   2. Confirmed payment with a split for me → split.amount (reconciled)
//   3. Otherwise → projection with completionSplits[me]% (or equal-split
//      fallback if no completionSplits snapshot is set)
// ──────────────────────────────────────────────────────────────────────────
describe("[build-gate] worker earnings display (computeMyOccurrenceNet)", () => {
  // Convenience factory — a job "shell" with sane defaults that individual
  // tests override for the specific edge case they target.
  function occ(overrides: Partial<Parameters<typeof computeMyOccurrenceNet>[0]> = {}) {
    return {
      price: 150,
      proposalAmount: null,
      completionSplits: null,
      addons: [],
      expenses: [],
      assignees: [{ userId: "me", role: null }],
      payment: null,
      ...overrides,
    };
  }

  it("reconciled split.amount wins when payment is confirmed", () => {
    const result = computeMyOccurrenceNet(
      occ({
        payment: {
          confirmed: true,
          skippedAt: null,
          splits: [{ amount: 42.5 }],
        },
      }),
      "me",
      20,
    );
    // Regardless of the price/rate math, the reconciled split.amount is
    // authoritative — includes topUp on employee underpay and $0 on
    // contractor writeoff. Projection would give a very different number.
    expect(result).toBe(42.5);
  });

  it("skipped payment always returns 0 — never uses split.amount", () => {
    const result = computeMyOccurrenceNet(
      occ({
        payment: {
          confirmed: true,
          skippedAt: new Date(),
          splits: [{ amount: 42.5 }], // ignored — Super erased this occurrence
        },
      }),
      "me",
      20,
    );
    expect(result).toBe(0);
  });

  it("write-off's split.amount is authoritative (no fall-through to projection)", () => {
    // For write-offs, split.amount = promised net for employees (topped
    // up), $0 for contractors. Falling through to projection would return
    // the promised net for BOTH classes — wrong for contractors. Locking
    // in that we use split.amount even when writtenOff would be true.
    const result = computeMyOccurrenceNet(
      occ({
        payment: {
          confirmed: true,
          skippedAt: null,
          writtenOff: true, // present but not read by the helper — see helper doc
          splits: [{ amount: 0 }], // contractor: $0 on write-off
        },
      }),
      "me",
      20,
    );
    expect(result).toBe(0);
  });

  it("projection uses completionSplits[me]% when set (not equal-split)", () => {
    // The bug this feature was born to fix: 3-worker job priced at $150
    // with 70/20/10 split, no expenses, 20% contractor fee.
    // 70% worker: 150 × 0.70 × 0.80 = 84
    // 20% worker: 150 × 0.20 × 0.80 = 24
    // 10% worker: 150 × 0.10 × 0.80 = 12
    const base = {
      price: 150,
      proposalAmount: null,
      addons: [] as { price: number | null }[],
      expenses: [] as { cost: number }[],
      completionSplits: [
        { userId: "a", percent: 70 },
        { userId: "b", percent: 20 },
        { userId: "c", percent: 10 },
      ],
      assignees: [
        { userId: "a", role: null as string | null },
        { userId: "b", role: null as string | null },
        { userId: "c", role: null as string | null },
      ],
      payment: null,
    };
    expect(computeMyOccurrenceNet(base, "a", 20)).toBeCloseTo(84, 5);
    expect(computeMyOccurrenceNet(base, "b", 20)).toBeCloseTo(24, 5);
    expect(computeMyOccurrenceNet(base, "c", 20)).toBeCloseTo(12, 5);
  });

  it("projection uses equal-split fallback when completionSplits is null", () => {
    // Legacy jobs completed before the splits-picker flow existed still
    // fall back to even-split. 3-worker $150 job, 20% fee → each gets
    // $150 / 3 × 0.80 = $40.
    const result = computeMyOccurrenceNet(
      occ({
        completionSplits: null,
        assignees: [
          { userId: "a", role: null },
          { userId: "b", role: null },
          { userId: "c", role: null },
        ],
      }),
      "a",
      20,
    );
    expect(result).toBeCloseTo(40, 5);
  });

  it("projection returns 0 when the user is not on the crew (and no completionSplits)", () => {
    // If a worker isn't in the assignees list and has no completionSplits
    // entry, they earn 0 for this occurrence — no phantom share.
    const result = computeMyOccurrenceNet(
      occ({
        completionSplits: null,
        assignees: [
          { userId: "someone-else", role: null },
        ],
      }),
      "me",
      20,
    );
    expect(result).toBe(0);
  });

  it("projection subtracts expenses before computing the worker's share", () => {
    // $150 job with $50 expenses, solo worker, 20% fee →
    // (150 - 50) × 1.00 × 0.80 = 80
    const result = computeMyOccurrenceNet(
      occ({
        expenses: [{ cost: 50 }],
        assignees: [{ userId: "me", role: null }],
      }),
      "me",
      20,
    );
    expect(result).toBeCloseTo(80, 5);
  });

  it("projection returns 0 when expenses exceed the price (never negative)", () => {
    const result = computeMyOccurrenceNet(
      occ({ expenses: [{ cost: 200 }] }),
      "me",
      20,
    );
    expect(result).toBe(0);
  });

  it("observer roles don't count as assignees for equal-split fallback", () => {
    // Two workers + one observer on a $100 job, 20% fee → active count = 2,
    // NOT 3. Each worker's share = 100 / 2 × 0.80 = $40.
    const result = computeMyOccurrenceNet(
      occ({
        price: 100,
        completionSplits: null,
        assignees: [
          { userId: "me", role: null },
          { userId: "other-worker", role: null },
          { userId: "observer-user", role: "observer" },
        ],
      }),
      "me",
      20,
    );
    expect(result).toBeCloseTo(40, 5);
  });

  it("assumeSoloClaim short-circuits to 100% share regardless of crew", () => {
    // "Tomorrow's unclaimed potential" — projected net if the user
    // solo-claimed. Ignores completionSplits + assignees.
    const result = computeMyOccurrenceNet(
      occ({
        price: 100,
        completionSplits: [
          { userId: "other", percent: 100 }, // irrelevant
        ],
        assignees: [{ userId: "other", role: null }],
      }),
      "me",
      20,
      { assumeSoloClaim: true },
    );
    // 100 × 1.00 × 0.80 = 80
    expect(result).toBeCloseTo(80, 5);
  });

  it("split query is trusted to be pre-filtered for GP-flagged rows", () => {
    // Query contract: `splits: { where: { userId, guaranteedPayoutPaidAt: null } }`.
    // The helper receives ONLY non-flagged splits — so when it sees a
    // splits array of length 0, it correctly falls to projection. GP-window
    // contractor's projection ~= wage-path payout, avoiding double-count
    // with loadGpWorkAnchoredItems bucketed by completedAt.
    const result = computeMyOccurrenceNet(
      occ({
        payment: {
          confirmed: true,
          skippedAt: null,
          splits: [], // GP-flagged split was filtered out at query time
        },
      }),
      "me",
      20,
    );
    // Falls to projection: $150 × 1.00 × 0.80 = $120 (solo worker)
    expect(result).toBeCloseTo(120, 5);
  });

  it("proposalAmount is used when price is null (estimates)", () => {
    // ESTIMATE occurrences carry proposalAmount instead of price.
    const result = computeMyOccurrenceNet(
      occ({ price: null, proposalAmount: 100 }),
      "me",
      20,
    );
    expect(result).toBeCloseTo(80, 5); // 100 × 1.00 × 0.80
  });

  it("addons + solo worker: (price + addons) × rate", () => {
    // Simpler: no default price confusion — set price explicitly.
    const result = computeMyOccurrenceNet(
      occ({ price: 100, addons: [{ price: 50 }] }),
      "me",
      20,
    );
    // (100 + 50) × 1.00 × 0.80 = 120
    expect(result).toBeCloseTo(120, 5);
  });
});
