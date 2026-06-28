import { fmtDate } from "@/src/lib/lib";

// Shape returned by the API for any payment action that runs the
// approval pipeline (approve / write-off / accept-payment etc). Either
// `nextOccurrence` is populated (with a startAt ISO string) OR
// `nextOccurrenceSkipReason` explains why no next occurrence was
// created. Both can also be absent when the action doesn't touch the
// next-occurrence chain at all (e.g. createPayment before approval).
export type PaymentActionResult = {
  nextOccurrence?: { startAt?: string | null } | null;
  nextOccurrenceSkipReason?: string | null;
} | null | undefined;

// Verb fragment slotted into the base "Payment {verb}." sentence so
// every payment toast in the app reads the same shape.
export type PaymentVerb =
  | "approved"
  | "written off"
  | "submitted for approval"
  | "reverted"
  | "updated"
  | "rejected"
  | "splits recalculated";

const SKIP_REASON_TEXT: Record<string, string> = {
  one_off: "This is a one-off job, so no next occurrence was created.",
  no_frequency_set: "No next occurrence created — no repeat frequency is set on the job.",
  job_paused: "No next occurrence created — the job service is paused.",
  duplicate_exists: "No next occurrence created — a scheduled visit already exists on the same date.",
  occurrence_or_job_not_found: "No next occurrence created — could not find the job service.",
};

/**
 * Returns the single explicit sentence describing what happened to the
 * next occurrence as a result of this payment action. Returns null when
 * the action didn't touch the next-occurrence chain at all (e.g. the
 * worker submitted a payment that's still pending admin approval).
 *
 * The shape is intentionally identical across success and skip paths so
 * toasts read consistently — every sentence ends in a period, every one
 * either confirms a date or names the exact reason no occurrence was
 * created. The user has called out that "next occurrence created if it
 * was a repeating job" without a date is confusing; this helper makes
 * the absence of next-occurrence creation as explicit as the presence.
 */
export function formatNextOccurrenceOutcome(result: PaymentActionResult): string | null {
  if (!result) return null;
  if (result.nextOccurrence?.startAt) {
    return `Next occurrence scheduled for ${fmtDate(result.nextOccurrence.startAt)}.`;
  }
  const reason = result.nextOccurrenceSkipReason;
  if (!reason) return null;
  return SKIP_REASON_TEXT[reason] ?? `No next occurrence created — ${reason}.`;
}

/**
 * Compose the full toast text for a payment action.
 *
 *   composePaymentMessage("approved", result)
 *     → "Payment approved. Next occurrence scheduled for Sat, Jul 4."
 *     → "Payment approved. This is a one-off job, so no next occurrence was created."
 *     → "Payment approved." (when no next-occurrence info is available)
 *
 * The optional `extra` is appended after the next-occurrence sentence
 * (separated by a space) for action-specific addenda — e.g. write-off
 * wants to clarify employees were paid from business funds.
 */
export function composePaymentMessage(
  verb: PaymentVerb,
  result?: PaymentActionResult,
  extra?: string,
): string {
  const parts: string[] = [`Payment ${verb}.`];
  const nextLine = formatNextOccurrenceOutcome(result);
  if (nextLine) parts.push(nextLine);
  if (extra) parts.push(extra);
  return parts.join(" ");
}
