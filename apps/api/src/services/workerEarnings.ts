// Worker-earnings display math — the SINGLE source of truth for every
// "how much will this worker actually be paid for this occurrence" number
// that surfaces to a worker on the web.
//
// Consumers:
//   • Title bar money badge (today / week / month / all)
//   • Earnings tiles under Profile → Payments
//   • Dashboard summary: Today Potential / Today Earned
//   • Dashboard summary: Weekly Earnings (Jobs) trend chart
//   • Dashboard summary: Earnings (last 7 days) tile
//
// Before this helper existed, the trend chart + last-7-days tile did an
// equal-split among assignees and ignored the actual PaymentSplit that
// records what each worker is really paid. On a job with an uneven
// `completionSplits` (e.g. 70/20/10) or an adjusted client payment, this
// overstated some workers' earnings and understated others'. The helper
// closes that gap by preferring the reconciled `PaymentSplit.amount` when
// available and, when it isn't, computing a projection that uses the
// occurrence's true `completionSplits` percentages.
//
// The rule (mirrors the title bar's employee path exactly):
//
//   1. If the Payment is SKIPPED (Super "pretended it never happened") →
//      return 0. Guarantees every display agrees with the sentinel-filter
//      aggregates so a skipped occurrence never contributes to any tile
//      or bar.
//
//   2. Else if the Payment is confirmed and a PaymentSplit exists for this
//      user, return that split's `amount`. This is the FINAL post-topUp,
//      post-adjustment net that will actually hit the worker's paycheck —
//      correct for underpay (employees made whole via topUp; contractors
//      absorb the shortfall pro-rata) AND for write-offs (employees still
//      paid promised via topUp; contractors get $0).
//
//   3. Otherwise project the worker's expected net from the occurrence:
//        N          = max(0, (price ?? proposalAmount ?? 0) + Σaddons - Σexpenses)
//        myPercent  = completionSplits[me].percent (when set)
//                     ELSE  100 / non-observer-assignees (if I'm on the crew)
//                     ELSE  0
//        myGross    = N × myPercent%
//        myFee      = myGross × rate%          // contractor fee OR employee margin
//        return       max(0, myGross - myFee)
//
// The rate is passed in — callers resolve it once per handler from
// `CONTRACTOR_PLATFORM_FEE_PERCENT` or `EMPLOYEE_BUSINESS_MARGIN_PERCENT`.
//
// GP double-count trap: for a contractor in-GP at completion, the split
// carries `guaranteedPayoutPaidAt IS NOT NULL` because the cash was also
// paid via the wage-path (loadGpWorkAnchoredItems). Callers MUST filter
// GP-flagged splits at query time — `splits: { where: { userId,
// guaranteedPayoutPaidAt: null }, ... }`. When no non-flagged split
// exists the helper falls through to projection, whose per-worker share ×
// rate approximates the wage-path payout closely enough for a trend
// display. Passing an unfiltered splits array double-counts GP jobs.

/** Shape every caller must supply. Payment sub-select is nullable — omit
 *  the payment include entirely for surfaces where no reconciliation
 *  data exists (e.g. tomorrow's unclaimed jobs). */
export type OccurrenceForEarnings = {
  price: number | null;
  proposalAmount: number | null;
  /** JSON — see JobOccurrence.completionSplits in schema.prisma. Nullable
   *  and treated defensively (any non-array value is ignored). */
  completionSplits: unknown;
  addons: { price: number | null }[];
  expenses: { cost: number }[];
  /** Non-observer assignees only don't have to be pre-filtered — the
   *  helper does that itself. userId is required so we can locate the
   *  current worker in the crew. */
  assignees: { userId: string; role: string | null }[];
  /** Include `payment` when the caller has reconciliation data. Its
   *  `splits` sub-array MUST be pre-filtered by `{ userId: me,
   *  guaranteedPayoutPaidAt: null }` at query time — the helper trusts
   *  the array is already scoped correctly. */
  payment?: {
    confirmed: boolean;
    skippedAt: Date | null;
    splits: { amount: number }[];
    /** Optional — the helper no longer reads it (split.amount is
     *  authoritative for both write-offs and normal approvals), but
     *  callers may still select it for their own display logic. */
    writtenOff?: boolean;
  } | null;
};

/** Options that steer projection edge cases. */
export type ComputeMyOccurrenceNetOpts = {
  /** Treat the caller as the sole worker on the occurrence — used by the
   *  "if I solo-claimed this tomorrow" projection where the caller is not
   *  yet in the assignees list. Short-circuits to 100% share and skips
   *  the completionSplits + assignees lookup. */
  assumeSoloClaim?: boolean;
};

export function computeMyOccurrenceNet(
  occ: OccurrenceForEarnings,
  userId: string,
  rate: number,
  opts?: ComputeMyOccurrenceNetOpts,
): number {
  const p = occ.payment;

  // 1) Skipped payments contribute zero everywhere — matches the
  //    `skippedAt: null` sentinel filter every money aggregate uses.
  if (p?.skippedAt) return 0;

  // 2) Confirmed payment with a split for me → reconciled paycheck value.
  //    Split.amount is authoritative even when the payment was written
  //    off: employees are still paid their promised net via topUp,
  //    contractors get $0. Sub-select is unique on (paymentId, userId).
  if (p && p.confirmed && p.splits.length > 0) {
    return Math.max(0, p.splits[0]?.amount ?? 0);
  }

  // 3) Projection path — used for unpaid occurrences and payments whose
  //    reconciliation hasn't landed a split for this user yet.
  const basePrice = occ.price ?? occ.proposalAmount ?? 0;
  const addonsTotal = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
  const displayPrice = basePrice + addonsTotal;
  if (displayPrice <= 0) return 0;
  const expTotal = (occ.expenses ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
  const N = Math.max(0, displayPrice - expTotal);
  if (N <= 0) return 0;

  let myPercent = 0;
  if (opts?.assumeSoloClaim) {
    myPercent = 100;
  } else {
    const cs = occ.completionSplits as
      | Array<{ userId: string; percent: number }>
      | null
      | undefined;
    if (Array.isArray(cs) && cs.length > 0) {
      const mine = cs.find((s) => s.userId === userId);
      myPercent = Number(mine?.percent ?? 0);
    } else {
      // Legacy fallback: no completionSplits snapshot exists yet
      // (job not completed via the splits-picker flow). Even-split among
      // active (non-observer) assignees, matching the pre-helper
      // behavior. If the current worker isn't on the crew, return 0 —
      // they wouldn't be paid for this occurrence.
      const active = (occ.assignees ?? []).filter((a) => a.role !== "observer");
      if (active.some((a) => a.userId === userId) && active.length > 0) {
        myPercent = 100 / active.length;
      }
    }
  }
  if (myPercent <= 0) return 0;

  const myGross = N * (myPercent / 100);
  const myFee = myGross * (rate / 100);
  return Math.max(0, myGross - myFee);
}
