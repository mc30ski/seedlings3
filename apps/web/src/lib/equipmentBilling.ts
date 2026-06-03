// ─────────────────────────────────────────────────────────────────────────────
// Equipment billing display helpers.
//
// Two billing models coexist per piece of equipment:
//   • flat-daily (Equipment.equivalentJobs is null): $X/day
//   • per-job-with-daily-cap (equivalentJobs is set):
//       perJobRate = dailyRate / equivalentJobs
//       per-day charge = min(jobsCompletedThatDay × perJobRate, dailyRate)
//
// This module exposes the math + display helpers the UI uses so the
// reserve / checkout flow, the equipment chip on cards, and any receipt
// breakdown all read the same source of truth. Server-side math lives in
// apps/api/src/services/equipment.ts computeRentalCost — keep these in
// sync if either side changes.
// ─────────────────────────────────────────────────────────────────────────────

export type BillingMode =
  | { kind: "free" }
  | { kind: "flatDaily"; dailyRate: number }
  | { kind: "perJob"; dailyRate: number; equivalentJobs: number; perJobRate: number };

/**
 * Resolve the billing mode for a piece of equipment given its
 * `dailyRate` + `equivalentJobs` columns. Returns `kind: "free"` when
 * there's no positive daily rate — no rental charge applies to anyone.
 */
export function resolveBillingMode(
  dailyRate: number | null | undefined,
  equivalentJobs: number | null | undefined,
): BillingMode {
  if (!dailyRate || dailyRate <= 0) return { kind: "free" };
  if (equivalentJobs != null && equivalentJobs > 0) {
    return {
      kind: "perJob",
      dailyRate,
      equivalentJobs,
      perJobRate: dailyRate / equivalentJobs,
    };
  }
  return { kind: "flatDaily", dailyRate };
}

/**
 * Short label suitable for an inline chip (`"$4/day"`, `"$1/job · max
 * $4/day"`, or empty when free). Returns `null` for the free case so
 * callers can `if (label) {…}` instead of rendering empty.
 */
export function shortBillingChip(mode: BillingMode): string | null {
  switch (mode.kind) {
    case "free":
      return null;
    case "flatDaily":
      return `$${mode.dailyRate.toFixed(2)}/day`;
    case "perJob":
      return `$${mode.perJobRate.toFixed(2)}/job · max $${mode.dailyRate.toFixed(2)}/day`;
  }
}

/**
 * Longer instructive sentence for the reserve / checkout flow. Reads as
 * a complete user-facing explanation of how the piece bills.
 */
export function instructiveBillingText(mode: BillingMode): string {
  switch (mode.kind) {
    case "free":
      return "No rental charge for this piece.";
    case "flatDaily":
      return `Contractors are charged $${mode.dailyRate.toFixed(2)} per Eastern-Time calendar day this piece is checked out. Employees and trainees use it at no cost (covered by their business margin).`;
    case "perJob":
      return `Contractors are charged $${mode.perJobRate.toFixed(2)} per formal-crew (or solo) job completed while this piece is checked out, capped at $${mode.dailyRate.toFixed(2)} per day. Days with no jobs cost nothing. Jobs you complete after check-in don't count. Employees and trainees use it at no cost (covered by their business margin).`;
  }
}
