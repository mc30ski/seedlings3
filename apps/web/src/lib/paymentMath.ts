// ─────────────────────────────────────────────────────────────────────────────
// Client-side payment-math helpers — PROJECTIONS ONLY.
//
// When a JobOccurrence has a `payment` with materialized `splits`, every UI
// surface MUST read `sp.amount` directly. Those numbers came from
// `services/payments.ts → reconcileApproval` on the server (the canonical
// math, covered by `payments.test.ts`). Anything else is a re-derivation
// and is a source of bugs.
//
// Use this file ONLY when a Payment row doesn't exist yet — i.e. you're
// estimating what a worker WOULD earn if this scheduled / completed job
// gets paid in full. Examples:
//   • JobsTab card "Payout: $X" badge on unpaid future jobs
//   • Dashboard "today potential earnings" tile
//   • AdminHome aggregate "what's on the schedule"
//
// Anti-patterns that triggered the prior bugs in this file's history:
//   ✗ applying margin to the FULL price without splitting by worker count
//   ✗ duplicating these formulas inline at each display site
//   ✗ computing a fee on the pool then dividing — the canonical math
//     splits FIRST then applies the per-worker rate (matches the server)
//
// If you find yourself wanting to re-derive a paid payment's worker share
// from scratch, STOP — the server already did this. Read `splits[].amount`.
// ─────────────────────────────────────────────────────────────────────────────

export type ViewerLike = {
  workerType?: "EMPLOYEE" | "TRAINEE" | "CONTRACTOR" | null;
} | null | undefined;

export type ProjectionOcc = {
  price?: number | null;
  proposalAmount?: number | null;
  addons?: Array<{ price?: number | null }> | null;
  expenses?: Array<{ cost: number }> | null;
  assignees?: Array<{ role?: string | null }> | null;
};

export type ProjectionRates = {
  /** Pulled from CONTRACTOR_PLATFORM_FEE_PERCENT setting. Default 0. */
  contractorFeePercent: number;
  /** Pulled from EMPLOYEE_BUSINESS_MARGIN_PERCENT setting. Default 0. */
  employeeMarginPercent: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Effective rate for a viewer's worker type. Employees and trainees pay the
 * business margin; contractors (and unclassified workers) pay the platform
 * fee. Mirrors `rateFor` in services/payments.ts.
 */
export function rateForViewer(viewer: ViewerLike, rates: ProjectionRates): number {
  const wt = viewer?.workerType ?? null;
  return wt === "EMPLOYEE" || wt === "TRAINEE"
    ? rates.employeeMarginPercent
    : rates.contractorFeePercent;
}

/**
 * "Display price" — price (or proposalAmount fallback) plus add-ons. Used
 * by every projection helper below as the gross-revenue starting point.
 * Returns 0 (not null) for occurrences with no price set, so call sites
 * can render "no projection" via the resulting payout being 0.
 */
export function displayPriceOf(occ: ProjectionOcc): number {
  const base = (occ.price ?? null) ?? (occ.proposalAmount ?? null) ?? 0;
  const addons = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
  return base + addons;
}

/** Sum of expenses on the occurrence; null-safe. */
export function expensesTotal(occ: ProjectionOcc): number {
  return (occ.expenses ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
}

/**
 * Count of active (non-observer) assignees on the occurrence. Min 1, so
 * estimate math never divides by zero when an unassigned job is
 * previewed (e.g. tomorrow's unclaimed picks on the Plan tomorrow hero —
 * we project as if the viewer were claiming solo).
 */
export function activeAssigneeCount(occ: ProjectionOcc): number {
  return Math.max(1, (occ.assignees ?? []).filter((a) => a.role !== "observer").length);
}

/**
 * Per-worker share of the distributable pool — gross-of-fee.
 *
 *   share = (displayPrice − expenses) / activeWorkerCount
 *
 * This is the building block every per-worker projection uses. Split
 * FIRST (matches the canonical server formula); fees come off the share,
 * never off the pool.
 */
export function perWorkerShare(occ: ProjectionOcc): number {
  const net = Math.max(0, displayPriceOf(occ) - expensesTotal(occ));
  return net / activeAssigneeCount(occ);
}

/**
 * Estimate the viewer's payout on an unpaid job. Use this on any UI
 * surface that wants to show "Payout: $X" / "Est. your payout" / similar
 * for an occurrence WITHOUT a confirmed payment.
 *
 *   share = perWorkerShare(occ)
 *   fee   = share × viewerRate / 100
 *   payout = share − fee
 *
 * Returns 0 (not null) when the viewer's rate is 0 or no price is set —
 * call sites should hide the badge when payout ≤ 0 unless they're
 * deliberately previewing a $0 case (e.g. write-off scenarios).
 */
export function projectViewerPayout(
  occ: ProjectionOcc,
  viewer: ViewerLike,
  rates: ProjectionRates,
): number {
  const share = perWorkerShare(occ);
  if (share <= 0) return 0;
  const rate = rateForViewer(viewer, rates);
  const fee = round2((share * rate) / 100);
  return round2(Math.max(0, share - fee));
}

/**
 * Estimate the SUM of all active workers' payouts on an unpaid job —
 * used by team-aggregate views (AdminHome) that want to show what the
 * business is on the hook for if this job gets paid.
 *
 * Iterates each non-observer assignee and applies THEIR rate to their
 * share. If individual workerTypes aren't available on the occurrence
 * include shape, pass `defaultRate` and we'll apply that uniformly.
 */
export function projectTeamPayoutsForOcc(
  occ: Omit<ProjectionOcc, "assignees"> & {
    assignees?: Array<{ role?: string | null; user?: { workerType?: string | null } | null }> | null;
  },
  rates: ProjectionRates,
  /** Used for assignees whose workerType wasn't included in the query. */
  defaultRate?: number,
): number {
  const active = (occ.assignees ?? []).filter((a) => a.role !== "observer");
  if (active.length === 0) return 0;
  const sharePer = perWorkerShare(occ as ProjectionOcc);
  if (sharePer <= 0) return 0;
  let total = 0;
  for (const a of active) {
    const wt = a.user?.workerType ?? null;
    const rate =
      wt === "EMPLOYEE" || wt === "TRAINEE"
        ? rates.employeeMarginPercent
        : wt === "CONTRACTOR"
          ? rates.contractorFeePercent
          : (defaultRate ?? rates.contractorFeePercent);
    const fee = round2((sharePer * rate) / 100);
    total += Math.max(0, sharePer - fee);
  }
  return round2(total);
}
