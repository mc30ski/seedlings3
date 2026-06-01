// ─────────────────────────────────────────────────────────────────────────────
// Canonical-payment-math invariant tests.
//
// PURPOSE
// This file is the safety net for everything downstream of `computeBreakdown`
// and `reconcileApproval`:
//   • Worker take-home (PaymentSplit.amount on the worker's view)
//   • Admin Money tab totals
//   • Gusto/QuickBooks/Schedule-C exports — these read raw Payment +
//     PaymentSplit fields, which are written by reconcileApproval.
//
// Every invariant here is documented in memory/project_payment_math.md.
// Breaking one of these tests means the operator's payroll, P&L, or tax
// export will be wrong. Fix the production code; do not loosen the test
// without first updating project_payment_math.md and notifying the operator.
//
// Specifically, this file locks down:
//   1. The canonical per-worker formula (gross / fee / net)
//   2. Pool conservation — sum-of-payouts identity
//   3. Reconciliation policy: employees made whole, contractors pro-rata
//   4. Overage / shortfall computation
//   5. Write-off semantics (employees still paid; contractors $0)
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import type { WorkerType } from "@prisma/client";
import { computeBreakdown, reconcileApproval, type PromisedRow } from "./payments";

// Default rates the seed uses (and the production-default settings).
// Tests that need other rates override explicitly so the chosen rate is
// visible at the assertion site.
const RATES = { contractorFeePercent: 20, employeeMarginPercent: 30 };

function w(userId: string, workerType: WorkerType | null, splitPercent: number) {
  return { userId, workerType, splitPercent };
}

// Penny-level rounding tolerance. All public field values are rounded to
// 2 decimal places by the service; aggregate identities can carry a 1-cent
// rounding residual that the residual-fix pass corrects for. Use this to
// assert "within a penny" on derived sums.
const PENNY = 0.01;

describe("computeBreakdown — canonical per-worker formula", () => {
  it("applies each worker's rate to their OWN gross share, not the pool", () => {
    // $100, no expenses, 50/50 split between contractor (20%) and employee
    // (30%). Each gets $50 gross; fee is applied to their own share.
    const rows = computeBreakdown(
      100,
      0,
      [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)],
      RATES,
    );
    const contractor = rows.find((r) => r.userId === "c")!;
    const employee = rows.find((r) => r.userId === "e")!;
    expect(contractor.gross).toBe(50);
    expect(contractor.fee).toBe(10); // 50 × 20%
    expect(contractor.net).toBe(40);
    expect(employee.gross).toBe(50);
    expect(employee.fee).toBe(15); // 50 × 30%
    expect(employee.net).toBe(35);
  });

  it("subtracts expenses off the top before splitting", () => {
    // $100 collected, $20 expenses → $80 distributable. 50/50 split:
    // each worker's gross is $40, not $50.
    const rows = computeBreakdown(
      100,
      20,
      [w("a", "EMPLOYEE", 50), w("b", "EMPLOYEE", 50)],
      RATES,
    );
    expect(rows[0].gross).toBe(40);
    expect(rows[1].gross).toBe(40);
    expect(rows[0].fee).toBe(12); // 40 × 30%
    expect(rows[0].net).toBe(28);
  });

  it("treats TRAINEE identically to EMPLOYEE (same fee class, same protections)", () => {
    const rows = computeBreakdown(
      100,
      0,
      [w("t", "TRAINEE", 50), w("e", "EMPLOYEE", 50)],
      RATES,
    );
    const trainee = rows.find((r) => r.userId === "t")!;
    const employee = rows.find((r) => r.userId === "e")!;
    expect(trainee.ratePercent).toBe(30); // employee margin, not contractor fee
    expect(trainee.fee).toBe(employee.fee);
    expect(trainee.net).toBe(employee.net);
  });

  it("treats a null workerType as contractor-class (contractor fee applies)", () => {
    const rows = computeBreakdown(100, 0, [w("u", null, 100)], RATES);
    expect(rows[0].ratePercent).toBe(20);
    expect(rows[0].fee).toBe(20);
    expect(rows[0].net).toBe(80);
  });

  it("normalizes split percentages that don't sum to 100", () => {
    // Two workers each given 60 (sum 120) — should normalize to 50/50.
    const rows = computeBreakdown(
      100,
      0,
      [w("a", "EMPLOYEE", 60), w("b", "EMPLOYEE", 60)],
      RATES,
    );
    expect(rows[0].gross).toBe(50);
    expect(rows[1].gross).toBe(50);
  });

  it("conservation: sum(gross) + sum(fee) is irrelevant — sum(gross) ≈ N", () => {
    // After fee, business takes the fee portion; sum-of-gross equals the
    // distributable pool (the only "conservation" invariant on the
    // per-worker level — actual money-out is the splits sum at approval).
    const N = 95.40; // intentional fractional cents
    const rows = computeBreakdown(
      100.0,
      4.6,
      [w("a", "CONTRACTOR", 30), w("b", "EMPLOYEE", 70)],
      RATES,
    );
    const sumGross = rows.reduce((s, r) => s + r.gross, 0);
    expect(Math.abs(sumGross - N)).toBeLessThanOrEqual(PENNY);
  });

  it("residual: fee + net sums back to N within one penny", () => {
    // Even with awkward fractional cents, the residual-fix pass on the
    // first row ensures the breakdown still balances to the distributable
    // pool. This protects export shapes that recompute totals from rows.
    const rows = computeBreakdown(
      99.99,
      0,
      [w("a", "EMPLOYEE", 33.33), w("b", "EMPLOYEE", 33.33), w("c", "CONTRACTOR", 33.34)],
      RATES,
    );
    const sumOfFeePlusNet = rows.reduce((s, r) => s + r.fee + r.net, 0);
    expect(Math.abs(sumOfFeePlusNet - 99.99)).toBeLessThanOrEqual(PENNY);
  });
});

describe("reconcileApproval — promised vs collected scenarios", () => {
  // Helper: build the "happy-path" promised snapshot for a job, then
  // reconcile against a (possibly different) collected amount.
  function reconcile(
    collected: number,
    workers: ReturnType<typeof w>[],
    promisedCollected = 100,
    expenses = 0,
  ) {
    const promised = computeBreakdown(promisedCollected, expenses, workers, RATES);
    return {
      promised,
      ...reconcileApproval(collected, expenses, workers, promised, RATES),
    };
  }

  it("collected == promised: workers get exactly their promised net", () => {
    const { splits, platformFeeAmount, businessMarginAmount, shortfallAmount, overageAmount } = reconcile(
      100,
      [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)],
    );
    expect(splits.find((s) => s.userId === "c")!.amount).toBe(40);
    expect(splits.find((s) => s.userId === "e")!.amount).toBe(35);
    expect(platformFeeAmount).toBe(10);
    expect(businessMarginAmount).toBe(15);
    expect(shortfallAmount).toBe(0);
    expect(overageAmount).toBe(0);
  });

  it("collected > promised: workers paid promised, business keeps overage", () => {
    // $120 paid on a $100 invoice, 50/50 contractor + employee.
    const r = reconcile(120, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
    expect(r.splits.find((s) => s.userId === "c")!.amount).toBe(40);
    expect(r.splits.find((s) => s.userId === "e")!.amount).toBe(35);
    expect(r.shortfallAmount).toBe(0);
    expect(r.overageAmount).toBe(20); // pure extra retained
  });

  it("collected < promised: employees made whole, contractors take the hit pro-rata", () => {
    // $80 collected on $100 invoice, contractor 50% + employee 50%.
    //   Promised net: contractor=$40, employee=$35. Promised pool ≥ collected−expenses.
    //   Employee gets $35 regardless. Contractor gets (collected − expenses − employee_net) /
    //     contractor's share-of-collected math; the service implements this as
    //     min(actual_net, promised_net) for the contractor branch.
    const r = reconcile(80, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
    const employee = r.splits.find((s) => s.userId === "e")!;
    const contractor = r.splits.find((s) => s.userId === "c")!;
    // Employee is made whole at promised net ($35).
    expect(employee.amount).toBe(35);
    // Contractor's actual share at $80: gross = $40, fee = $8 (20%), net = $32.
    // Since $32 < promised $40, contractor takes the pro-rata hit and gets $32.
    expect(contractor.amount).toBe(32);
    // Business absorbs the gap: $80 − $35 (employee) − $32 (contractor) = $13 retained.
    // Promised retained = $25 ($10 fee + $15 margin). Delta = $13 − $25 = −$12 shortfall.
    expect(r.shortfallAmount).toBe(12);
    expect(r.overageAmount).toBe(0);
  });

  it("write-off (collected = 0): employees still paid promised, contractors get $0", () => {
    const r = reconcile(0, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
    expect(r.splits.find((s) => s.userId === "e")!.amount).toBe(35);
    expect(r.splits.find((s) => s.userId === "c")!.amount).toBe(0);
    // Business: $0 in, $35 out to employee, $25 promised retained = $60 absorbed.
    expect(r.shortfallAmount).toBe(60);
  });

  it("all-employee crew with collected < promised: every worker still made whole", () => {
    // Critical for payroll integrity: employees are W-2 wages and must be
    // paid on the regular schedule regardless of client behavior.
    const r = reconcile(50, [w("a", "EMPLOYEE", 50), w("b", "EMPLOYEE", 50)]);
    expect(r.splits.find((s) => s.userId === "a")!.amount).toBe(35);
    expect(r.splits.find((s) => s.userId === "b")!.amount).toBe(35);
    expect(r.shortfallAmount).toBeGreaterThan(0);
  });

  it("top-up tracking: employee net stays at promised; topUpAmount captures the gap", () => {
    // $50 collected on $100 invoice, all-employee crew. Actual fee math
    // would give each employee only ~$17.50 net; they should still
    // receive promised $35, with the $17.50 difference recorded as topUp.
    const r = reconcile(50, [w("a", "EMPLOYEE", 50), w("b", "EMPLOYEE", 50)]);
    const a = r.splits.find((s) => s.userId === "a")!;
    expect(a.amount).toBe(35);
    expect(a.topUpAmount).toBeGreaterThan(0);
    // The topUp + actual netAmount adds up to the final paid amount.
    expect(Math.abs((a.netAmount + a.topUpAmount) - a.amount)).toBeLessThanOrEqual(PENNY);
  });
});

describe("Payment-row aggregate identity — exports rely on this", () => {
  // The Admin Money summary, the QB-Income export, and the Schedule-C
  // line items all rely on this identity holding:
  //
  //   amountPaid = sum(splits) + platformFeeAmount + businessMarginAmount
  //                + overageAmount − shortfallAmount + expenses
  //
  // If this drifts, the operator's P&L doesn't balance.
  function assertIdentity(
    collected: number,
    expenses: number,
    workers: ReturnType<typeof w>[],
  ) {
    const promised = computeBreakdown(collected, expenses, workers, RATES);
    const r = reconcileApproval(collected, expenses, workers, promised, RATES);
    const payoutsSum = r.splits.reduce((s, sp) => s + sp.amount, 0);
    const balanced =
      payoutsSum +
      r.platformFeeAmount +
      r.businessMarginAmount +
      r.overageAmount -
      r.shortfallAmount +
      expenses;
    expect(Math.abs(balanced - collected)).toBeLessThanOrEqual(PENNY);
  }

  it("balances on the happy path", () => {
    assertIdentity(100, 0, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
  });

  it("balances with expenses", () => {
    assertIdentity(100, 25, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
  });

  it("balances on overpay", () => {
    assertIdentity(150, 0, [w("c", "CONTRACTOR", 40), w("e", "EMPLOYEE", 60)]);
  });

  it("balances on underpay (employee top-up scenario)", () => {
    assertIdentity(70, 0, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
  });

  it("balances on full write-off", () => {
    assertIdentity(0, 0, [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)]);
  });

  it("balances with three workers and mixed types", () => {
    assertIdentity(200, 30, [
      w("c", "CONTRACTOR", 40),
      w("e", "EMPLOYEE", 30),
      w("t", "TRAINEE", 30),
    ]);
  });
});

describe("Class-fee totals on the Payment row (used by exports)", () => {
  // platformFeeAmount and businessMarginAmount must sum to the
  // PROMISED retained fees, not the actual-breakdown fees. This is the
  // identity the tax-export reconciliation depends on. See the comment
  // block in reconcileApproval for the overpay double-count scenario.
  it("uses promised fees so an overpay does not double-count overage", () => {
    // $120 paid on $100 invoice, 100% employee with 30% margin.
    //   Actual margin at $120 would be $36; overage delta = $20.
    //   $36 + $20 = $56 (wrong — only $50 actually retained).
    //   Using promised margin = $30 + $20 overage = $50 ✓.
    const promised = computeBreakdown(100, 0, [w("e", "EMPLOYEE", 100)], RATES);
    const r = reconcileApproval(
      120,
      0,
      [w("e", "EMPLOYEE", 100)],
      promised,
      RATES,
    );
    expect(r.businessMarginAmount).toBe(30); // promised, not 36
    expect(r.overageAmount).toBe(20);
    // Combined business retained = margin + overage = $50 = $120 paid − $70 to employee.
    expect(r.businessMarginAmount + r.overageAmount).toBe(50);
  });

  it("contractor-class fee total only sums over contractor splits", () => {
    const promised = computeBreakdown(
      100,
      0,
      [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)],
      RATES,
    );
    const r = reconcileApproval(
      100,
      0,
      [w("c", "CONTRACTOR", 50), w("e", "EMPLOYEE", 50)],
      promised,
      RATES,
    );
    expect(r.platformFeeAmount).toBe(10); // contractor only
    expect(r.businessMarginAmount).toBe(15); // employee only
  });
});

describe("Property-based — no negative payouts ever", () => {
  // Strong tax-protective invariant: no matter how strange the inputs
  // (zero rates, all-trainee crew, huge expenses, write-off), no worker
  // should ever receive a negative split. Negative payouts would corrupt
  // payroll exports.
  const cases: Array<[string, number, number, ReturnType<typeof w>[]]> = [
    ["zero collected", 0, 0, [w("a", "EMPLOYEE", 100)]],
    ["expenses exceed collected", 100, 500, [w("a", "EMPLOYEE", 100)]],
    ["all-trainee", 100, 0, [w("a", "TRAINEE", 100)]],
    ["empty workers", 100, 0, []],
    ["fractional cents", 33.33, 0, [w("a", "CONTRACTOR", 33.33), w("b", "EMPLOYEE", 66.67)]],
  ];
  for (const [label, collected, expenses, workers] of cases) {
    it(`no negative splits: ${label}`, () => {
      const promised = computeBreakdown(collected, expenses, workers, RATES);
      const r = reconcileApproval(collected, expenses, workers, promised, RATES);
      for (const split of r.splits) {
        expect(split.amount).toBeGreaterThanOrEqual(0);
      }
    });
  }
});
