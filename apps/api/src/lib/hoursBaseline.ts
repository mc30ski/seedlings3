// ─────────────────────────────────────────────────────────────────────────────
// WHAT A VISIT IS MEASURED AGAINST for payroll-hours approval.
//
// It used to be the typed estimate, forever. That estimate never moved: nothing
// writes `Job.estimatedMinutes` except a human editing the form, and on jobs
// with five or more visits it sat a median of 50% away from what the work
// actually took. So roughly 59% of completed visits landed in the approval
// queue — every month, all year — and clearing that queue taught you nothing,
// because the thing being compared against was known to be wrong.
//
// A job now measures itself. Once there are enough completed visits, the
// baseline becomes the MEDIAN of the recent ones and the estimate steps aside.
//
// BACKTESTED against production before it was written (355 completed visits):
//
//     always the estimate      59% needed approval
//     rolling after 3 visits   46%        ← this
//     …of the visits that actually had a baseline, 39%
//
// Requiring 5 visits instead of 3 was WORSE (49%) — waiting longer just leaves
// more visits being judged by the stale number.
//
// WHAT THIS DELIBERATELY GIVES UP. The baseline is self-reinforcing: a job that
// drifts to taking 90 minutes stops being flagged, because 90 minutes is now
// normal for that job. That is correct for "did THIS visit go sideways", which
// is the question approval asks. "This job costs more than it used to" is a
// different question, and the stale-estimate audit check still answers it by
// comparing actuals against the typed estimate — it just lives in Tasks now
// rather than in the approval queue.
// ─────────────────────────────────────────────────────────────────────────────

/** Visits needed before a job is trusted to describe itself. */
export const BASELINE_MIN_SAMPLES = 3;

/** How many recent visits the median is taken over. Matches the rolling window
 *  the stale-estimate audit check already uses, so the two agree. */
export const BASELINE_WINDOW = 8;

/**
 * Longest visit that may count as EVIDENCE.
 *
 * A job clock has no "you forgot to stop it" recovery the way a workday does,
 * and production carries a 736-minute visit against a 45-minute estimate. One
 * such row must not define what normal looks like for the next eight visits.
 * The median already resists a single outlier; this stops it becoming the
 * majority on a job with few samples.
 */
export const EVIDENCE_MAX_MINUTES = 480;

export type BaselineSource = "ROLLING_ACTUAL" | "ESTIMATE";

export type HoursBaseline = {
  /** Expected PERSON-minutes for the visit — crew already folded in. */
  personMinutes: number;
  source: BaselineSource;
  /** How many prior visits the rolling figure was taken over. 0 for ESTIMATE. */
  sampleCount: number;
};

/**
 * Is this duration usable as evidence of how long the job normally takes?
 *
 * Rejects the impossible (a negative span, from an admin editing timestamps
 * into the wrong order) and the implausible (a clock left running).
 */
export function isUsableEvidence(personMinutes: number): boolean {
  return Number.isFinite(personMinutes) && personMinutes > 0 && personMinutes <= EVIDENCE_MAX_MINUTES;
}

/** Median. Even counts average the middle pair, matching the audit check. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Pick what this visit is judged against.
 *
 * `priorPersonMinutes` is the job's previous visits, MOST RECENT FIRST. Only
 * the first `BASELINE_WINDOW` usable ones are considered, so a job that has
 * genuinely changed pace is not held to how it went a year ago.
 *
 * EVERYTHING IS PERSON-MINUTES on both sides. `estimatedMinutes` is total
 * labour for the visit, and a recorded duration is wall-clock × crew, so a
 * two-person job that took 30 minutes is 60 person-minutes and compares
 * directly against a 60-minute estimate. Mixing the two units is how a crewed
 * job would appear to take half as long as it should.
 */
export function resolveHoursBaseline(args: {
  estimatedMinutes: number | null;
  priorPersonMinutes: number[];
}): HoursBaseline | null {
  const usable = args.priorPersonMinutes.filter(isUsableEvidence).slice(0, BASELINE_WINDOW);
  if (usable.length >= BASELINE_MIN_SAMPLES) {
    const m = median(usable);
    // A median of zero would make every variance infinite; treat it as no
    // evidence rather than dividing by it.
    if (m > 0) return { personMinutes: m, source: "ROLLING_ACTUAL", sampleCount: usable.length };
  }
  const est = args.estimatedMinutes;
  if (est != null && est > 0) return { personMinutes: est, source: "ESTIMATE", sampleCount: 0 };
  return null;
}
