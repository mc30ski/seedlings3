// ─────────────────────────────────────────────────────────────────────────────
// HOW LONG AN UNPAID VISIT HAS BEEN WAITING — asked once, answered once.
//
// Two screens ask this question about the same rows and used to answer it
// differently:
//
//   • Money → Awaiting payment showed "Requested 3 days ago" — the INVOICE
//     clock. It says how long the client has had the ask.
//   • Work → Repeating showed "Waiting 27 days" — the MONEY clock, measured
//     from the day the work was finished. It says how long the visit has
//     been a receivable at all.
//
// Neither is wrong and neither is enough. A visit finished 27 days ago and
// invoiced this morning reads "Requested today" on one screen and "Waiting 27
// days" on the other, and the operator cannot reconcile the two without
// opening the job. BOTH NUMBERS BELONG ON BOTH SCREENS, which means the rule
// that produces them has to live in one file — a second copy is how the two
// surfaces drifted the first time.
//
// WHY THE ET DAY KEY AND NOT ELAPSED MILLISECONDS. `listOutstanding` used to
// floor a millisecond difference, under a `date-handling-allow: elapsed-time`
// annotation. That is a different number from the one this returns: a request
// sent at 11pm yesterday is "0 days" by milliseconds and "1 day" by the
// calendar, and the operator reading "Requested today" the next morning is
// being told something false. Counting calendar days in ET is also what the
// rest of this codebase does, so the exemption is gone rather than copied.
// ─────────────────────────────────────────────────────────────────────────────

import { etDaysBetween, etFormatDate, etToday, type EtDateKey } from "./dates";

/** The occurrence fields the rule reads. Deliberately a structural type:
 *  both callers select different shapes and neither should have to widen its
 *  query to match the other. */
export type PaymentWaitInput = {
  /**
   * When the work was finished. THE MONEY CLOCK'S ANCHOR — see the note on
   * `waitingSince` for why this and not the invoice.
   */
  completedAt?: Date | null;
  /** Preserved timestamp of the FIRST send; never moves once set. */
  paymentRequestFirstSentAt?: Date | null;
  /** The LATEST send; moves forward on every re-send. */
  paymentRequestSentAt?: Date | null;
  paymentRequestResendCount?: number | null;
  /** Last-resort anchor for a legacy row with no completion stamp. */
  startAt?: Date | null;
};

export type PaymentWait = {
  /**
   * When the wait for money began, which is when the WORK WAS FINISHED.
   *
   * Not the invoice date. The visit became a receivable the moment it was
   * done, whether or not anybody got round to asking for the money — and the
   * row where nobody ever asked is precisely the one worth surfacing.
   * `paymentRequestFirstSentAt` reads like the truer anchor and the schema
   * even documents it as powering an "originally requested N days ago"
   * display, but it is null on 10 of the 12 pending rows in dev, so a clock
   * hung on it goes blank across most of the list.
   *
   * `completedAt` is non-null on every pending row in both databases and the
   * schema keeps it that way deliberately: `updateOccurrence` stamps it on
   * any transition into a completion state, because a null one hid finished
   * work from the customer's own service history.
   */
  waitingSince: Date | null;
  /** Whole ET days since `waitingSince`. 0 = finished today. */
  waitingDays: number | null;
  /** The latest time we asked, and how long ago that was. */
  requestedAt: Date | null;
  requestedDays: number | null;
  /** The FIRST time we asked — unchanged by re-sends. */
  firstRequestedAt: Date | null;
  firstRequestedDays: number | null;
  /** Re-sends since the original. Zero for a one-and-done invoice. */
  resendCount: number;
  /**
   * NOBODY HAS ASKED FOR THIS MONEY YET.
   *
   * Its own field rather than a null `requestedDays`, because the two mean
   * opposite things to an operator: "asked, no answer" is the client's move,
   * "never asked" is theirs. Nine of the twelve pending rows in dev are in
   * this state and no screen said so — Money → Awaiting payment cannot show
   * them at all, since it lists invoices that went out.
   */
  neverRequested: boolean;
};

/** Whole ET calendar days from `d` until `today`, clamped at zero.
 *
 *  Clamped because a `completedAt` a few hours into tomorrow ET — a late
 *  evening visit closed out after midnight — would otherwise read "-1 days".
 */
function daysSince(d: Date | null | undefined, today: EtDateKey): number | null {
  if (!d) return null;
  return Math.max(0, etDaysBetween(etFormatDate(d), today));
}

/**
 * Both clocks for one unpaid visit.
 *
 * `today` is a parameter so a caller looping over rows resolves the ET day
 * ONCE. A per-row `etToday()` can straddle midnight mid-list and report two
 * different "todays" in one table.
 */
export function describePaymentWait(
  o: PaymentWaitInput,
  today: EtDateKey = etToday(),
): PaymentWait {
  // Fallbacks in the order they would have been written, for a legacy row
  // that predates the completion stamp.
  const waitingSince =
    o.completedAt ?? o.paymentRequestFirstSentAt ?? o.paymentRequestSentAt ?? o.startAt ?? null;
  const requestedAt = o.paymentRequestSentAt ?? null;
  // A row sent exactly once has no separate "first" stamp in some legacy
  // data; the latest send IS the first one there.
  const firstRequestedAt = o.paymentRequestFirstSentAt ?? requestedAt;

  return {
    waitingSince,
    waitingDays: daysSince(waitingSince, today),
    requestedAt,
    requestedDays: daysSince(requestedAt, today),
    firstRequestedAt,
    firstRequestedDays: daysSince(firstRequestedAt, today),
    resendCount: o.paymentRequestResendCount ?? 0,
    neverRequested: !requestedAt,
  };
}
