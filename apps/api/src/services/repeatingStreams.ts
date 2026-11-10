// ─────────────────────────────────────────────────────────────────────────────
// EVERY REPEATING SERVICE IN THE BOOK, IN ONE LIST.
//
// Pausing a repeating service lives on the occurrence, one card at a time,
// and that is the right place for the decision — see
// `occurrenceStreamPause.ts` for why there is nowhere else it could live.
// It is the wrong place for the DECISION YOU MAKE ONCE A SEASON: at the end
// of a growing year the operator holds most of the book, which meant opening
// 29 cards across two tabs and remembering which ones were done.
//
// So this module is a LENS, not a second kind of pause. It reads the live
// repeating streams flat, and its two write paths loop the very same
// `pauseStream` / `resumeStream` the card buttons call. Nothing here records
// that a batch happened, and no occurrence carries a batch id.
//
// THAT RESTRAINT IS THE WHOLE DESIGN, and it is the lesson of the feature
// this replaces. A client-level "Pause services" / "Resume services" pair
// shipped and was removed: it was a loop over Jobs that read as a standing
// switch, and the `Job.clientBulkPausedAt` bookkeeping it needed in order to
// undo itself became a SECOND way to pause a job that had to stay in step
// with the first. It did not stay in step — a stale stamp swept up a job the
// operator had deliberately stopped. Two dead columns are still on the Job
// model from it. The failure was not batching; it was a batch that
// remembered itself.
//
// The AuditEvent trail carries a sweep perfectly well without help: N rows,
// one actor, one second. That is what the removed feature's own schema
// comment said it was relying on anyway.
// ─────────────────────────────────────────────────────────────────────────────

import { JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { withPortfolio } from "../lib/portfolioScope";
import { etDaysBetween, etFormatDate, etToday, type EtDateKey } from "../lib/dates";
import { ServiceError } from "../lib/errors";
import { computeResumeStartAt } from "./jobs";
import { computeNextOccurrenceStart } from "./payments";
import { describePaymentWait, type PaymentWait } from "../lib/paymentWait";
import { ACTIVE_STREAM_STATUSES, listPauseReasons } from "./pauseReasons";
import { pauseStream, resumeStream } from "./occurrenceStreamPause";

/** Why a row's repeating cannot be paused right now, in the operator's words.
 *
 *  `pauseStream` refuses anything but SCHEDULED, and it is right to: an
 *  in-flight or unpaid visit is work that has already happened or is
 *  happening, where "hold the future" has no meaning. The table has to say
 *  so on the row, though — a disabled checkbox with no reason reads as a
 *  bug, and the operator cannot act on a rule they cannot see. */
function blockedReasonFor(status: JobOccurrenceStatus): string | null {
  switch (status) {
    case JobOccurrenceStatus.SCHEDULED:
      return null;
    case JobOccurrenceStatus.STREAM_PAUSED:
      return null;
    case JobOccurrenceStatus.PENDING_PAYMENT:
      // It is already holding the chain by itself — the next visit is only
      // created when the payment is approved — so nothing is running away
      // today. It is not held EITHER, and that is the trap: settle the
      // payment in December and a fresh visit is scheduled mid-winter.
      return "Awaiting payment — settle or write off the visit first, then pause the new one.";
    case JobOccurrenceStatus.IN_PROGRESS:
      return "Someone is on site. Pause it once the visit is finished.";
    case JobOccurrenceStatus.PAUSED:
      // Two different "paused" across two enums; see the note in
      // pauseReasons.ts. This one is a worker's timer mid-visit.
      return "A worker has their timer paused mid-visit. Pause the repeating once the visit is finished.";
    default:
      return "Not in a state that can be paused.";
  }
}

/**
 * One row.
 *
 * THE FIELD NAMES ARE THE OCCURRENCE'S OWN, deliberately. They were
 * `occurrenceId` / `pauseReasonCode` / `pauseNote` — tidier read alone and
 * wrong read in company: the shared pause helpers every surface uses
 * (`passesPauseFilter`, `StreamPauseActions`) read `streamPauseReasonCode`,
 * and their parameter types mark every field optional — so a row spelling it
 * differently type-checked perfectly and matched nothing. Filtering by a
 * specific pause reason returned zero rows for every reason while "any
 * reason" worked, because that branch returns before it reads the field.
 *
 * Speaking one vocabulary also lets a row go straight to
 * `StreamPauseActions`, which removes the `as any` that hid the mismatch.
 */
export type RepeatingStreamRow = {
  id: string;
  jobId: string;
  clientId: string | null;
  clientName: string;
  propertyName: string;
  /**
   * What the operator calls this stream — the occurrence's own job type or
   * title, falling back to the service description.
   *
   * NULL WHEN NOTHING NAMES IT, rather than a placeholder word. This read
   * "Service" when all three were empty, which is every row this business
   * has: 0 of 51 live streams in dev and 44 of 45 in production carry any of
   * the three. A column repeating one noise word down its whole length is
   * worse than an empty one — it reads as data until you notice it never
   * changes. The cadence beside it is what actually distinguishes the rows.
   */
  service: string | null;
  /** The occurrence's own cadence when it overrides, else the service's. */
  frequencyDays: number | null;
  status: string;
  /** The date it is scheduled for — or, when held, the date it was holding. */
  startAt: string | null;
  /** SCHEDULED only. */
  canPause: boolean;
  /** STREAM_PAUSED only. */
  canResume: boolean;
  blockedReason: string | null;
  streamPauseReasonCode: string | null;
  /**
   * The reason's LABEL, resolved here.
   *
   * Every other surface renders this by fetching the taxonomy from
   * `/pause-reasons` — which requires `schedule.manage`. This table is
   * readable on `schedule.view-all`, which an oversight role holds WITHOUT
   * manage (the live book has one such role), and for them that fetch 403s
   * and caches an empty list. Resolving server-side means the read-only
   * reader sees "Season over" rather than `season_over`, and the table needs
   * no capability it does not already have.
   */
  streamPauseReasonLabel: string | null;
  streamPauseReason: string | null;
  streamPausedAt: string | null;
  streamResumeReminderAt: string | null;
  /** Reminder date has arrived or passed — the row is asking for an answer. */
  reminderDue: boolean;
  /**
   * PENDING_PAYMENT only — when the wait for money began.
   *
   * ANCHORED ON `completedAt`, NOT ON THE INVOICE, and the live data is what
   * settles it. The money clock starts when the work was finished: that is
   * the moment the visit became a receivable, whether or not anybody got
   * round to asking for the money. `paymentRequestFirstSentAt` reads like the
   * truer anchor and is documented on the model as powering an "originally
   * requested N days ago" display, but it is null for 10 of the 12 pending
   * rows in dev — a clock hung on it would show nothing at all on most of the
   * list, and nothing precisely where the operator most needs a number: the
   * visit nobody ever invoiced. `completedAt` is non-null on every pending
   * row in both databases, and the schema keeps it that way deliberately
   * (`updateOccurrence` stamps it on any transition into a completion state,
   * because a null one hid completed work from the customer's history).
   *
   * The later timestamps are kept as fallbacks for a legacy row, in the
   * order they would have been written.
   */
  awaitingPaymentSince: string | null;
  /** Whole ET days since `awaitingPaymentSince`. 0 = finished today. */
  awaitingPaymentDays: number | null;
  /**
   * WHEN WE LAST ASKED FOR THE MONEY, and how long ago.
   *
   * The other half of the pair, and the half Money → Awaiting payment was
   * already showing. A visit finished 27 days ago and invoiced this morning
   * is a different problem from one invoiced 27 days ago and ignored, and
   * the waiting number alone cannot tell them apart — so the two screens
   * disagreed with each other until both carried both numbers. The rule is
   * `lib/paymentWait.ts`, shared rather than reimplemented.
   */
  paymentRequestedAt: string | null;
  paymentRequestedDays: number | null;
  /** The ORIGINAL ask, unchanged by re-sends, plus how many re-sends. */
  paymentFirstRequestedAt: string | null;
  paymentFirstRequestedDays: number | null;
  paymentResendCount: number;
  /**
   * Nobody has asked for this money yet — the operator's move, not the
   * client's. Nine of the twelve pending rows in dev, and Money → Awaiting
   * payment cannot show them at all because it lists invoices that went out.
   */
  paymentNeverRequested: boolean;
  /**
   * The ET day this stream's next visit was due, when the stream has stopped
   * producing them. Null while the stream is still running or held.
   */
  nextVisitDueOn: EtDateKey | null;
  /**
   * How many days past `nextVisitDueOn` we are — null when not expired.
   *
   * WHAT "EXPIRED" MEANS HERE is the app's existing meaning, borrowed whole
   * from the next-visit ghost: the next visit of this stream came due and was
   * never created, so the stream has silently stopped. It is a STALL, not a
   * configuration — no job carries an end date, so there is nothing else the
   * word could mean.
   *
   * It is the other half of the awaiting-payment clock rather than a second
   * subject. The next visit is only created when the current one closes, so a
   * payment left sitting past one cadence period IS the stream stopping: 8 of
   * the 9 expired streams in production are awaiting payment. The pending
   * number says how long nobody acted; this one says what it has cost.
   *
   * Projected with `computeNextOccurrenceStart` and read off its
   * `rawStartAt` — the same function the renewer uses, and the field its own
   * doc comment reserves for "is this late, and by how much?", because
   * `startAt` is a display date that snaps an overdue visit to today and so
   * can never be late.
   */
  expiredDays: number | null;
  /**
   * Somebody with `schedule.manage` has already silenced this stall.
   *
   * Carried rather than obeyed. Suppressing a next-visit warning is what
   * buys silence from the header alert and the Today chip, and re-shouting
   * here would undo a decision the operator deliberately made. But this
   * screen IS the twice-a-year review of the whole book, and hiding the row
   * from the one place it is meant to be reviewed is the worse failure. So it
   * is still shown, and shown quietly.
   */
  expirySuppressed: boolean;
  /**
   * The customer's primary contact, for messaging them from the row.
   *
   * NULL UNLESS THE CALLER HOLDS `clients.view` — "See customers, properties
   * and contacts", which is the capability that owns contact details
   * everywhere else. This table opens on `schedule.view-all`, an oversight
   * READ over the calendar, and the two are genuinely separate: the live
   * book has a role that can see every visit without being trusted with
   * every customer's phone number. Omitted server-side rather than hidden in
   * the UI, because a field the client never receives cannot be read out of
   * a network tab.
   */
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  /**
   * Where this stream would restart if resumed, on its OWN rhythm.
   *
   * Computed by `computeResumeStartAt`, the same function the write path
   * uses, so the date shown before committing is the date written. It
   * matters that this is per-row: give 29 held streams one shared restart
   * date and the whole book lands in one week in April. Stepping each one
   * forward by its own cadence scatters them back onto the rhythm they
   * already had.
   */
  suggestedResumeAt: string | null;

  // ── THE STREAM WITH NO LIVE VISIT ────────────────────────────────────
  /**
   * The occurrence this row is about — **NULL when the stream has none.**
   *
   * `id` is the row key and stays unique either way: the occurrence's id, or
   * `job:<jobId>` for a stream with no occurrence to name it. Read this one,
   * not `id`, when you mean "the visit".
   */
  occurrenceId: string | null;
  /**
   * WHY THIS STREAM HAS NO LIVE VISIT, or null when it has one.
   *
   * THE WHOLE REASON THIS FIELD EXISTS. This table listed live occurrences,
   * so a stream appeared only while it happened to have one — and the moment
   * its last visit closed, was cancelled, or was never created, the customer
   * dropped silently off the board. NINE STREAMS IN PRODUCTION WERE INVISIBLE
   * that way. One was a customer who had been trying to reach the business
   * and could not: her repeating was cancelled in September, her job stayed
   * an ACCEPTED fortnightly, and 73 days and five missed visits later nobody
   * knew. The bad review arrived before the realisation did.
   *
   * So a stream is listed whether or not it has a visit, and this says which
   * kind of nothing it is:
   *   "never-ran"  — accepted, has a cadence, never produced a visit at all
   *   "cancelled"  — its most recent visit was cancelled, nothing since
   *   "stopped"    — its last visit finished and no next one was created
   */
  dormancy: "never-ran" | "cancelled" | "stopped" | null;
  /** When this customer was last actually served. Dormant rows only. */
  lastServedAt: string | null;
  /**
   * Visits missed since `lastServedAt`, in THIS stream's own cadence.
   *
   * The unit is deliberate. "73 days" means nothing without knowing whether
   * somebody is weekly or monthly; "5.2 missed visits" is the same sentence
   * for both, and it is what makes this list sortable across a mixed book.
   */
  missedCycles: number | null;
};

/**
 * The `status` of a stream that has no occurrence to take one from.
 *
 * Deliberately not spelled like anything in `JobOccurrenceStatus`: it is not
 * a visit state, it is the absence of a visit. Which KIND of absence is
 * `dormancy`'s job.
 */
export const NO_VISIT = "NO_VISIT";

/** The one person to message about this stream, or nulls.
 *
 *  `nickname` wins because it is what the operator actually calls them, and
 *  a message that opens with a name they do not use reads as a mail merge. */
function contactFor(client: unknown): {
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
} {
  const c = (client as { contacts?: Array<Record<string, string | null>> } | null)?.contacts?.[0];
  if (!c) return { contactName: null, contactPhone: null, contactEmail: null };
  const name =
    c.nickname?.trim() ||
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
    null;
  return {
    contactName: name,
    contactPhone: c.phone?.trim() || null,
    contactEmail: c.email?.trim() || null,
  };
}

/**
 * Every live repeating stream the caller may see.
 *
 * REPEATING ONLY. A one-off has nothing to hold — you do it or you cancel it
 * — so cadence is the membership test, not a filter the UI applies on top.
 * The cadence is the occurrence's own when it overrides and the service's
 * otherwise, which is why this cannot be a `where` clause on the Job alone.
 *
 * `portfolioWhere` is the OCCURRENCE-ROOTED fragment — the route builds it
 * with `occurrencePortfolioWhere`, which resolves to the property's CURRENT
 * membership. Not the occurrence's own frozen rows: a property that moved
 * into somebody's district last week is their work to hold this autumn, and
 * the frozen basis is the one that was deleted for having no referent.
 */
export async function listRepeatingStreams(
  /**
   * BOTH ROOTINGS OF ONE SCOPE, passed together on purpose.
   *
   * This function now asks two questions — "which live visits?" and "which
   * streams have none?" — and they are rooted differently: an occurrence
   * reaches its portfolio through `job.property`, a job through `property`.
   * Taking them as one object means a caller cannot supply one and forget
   * the other, which would leave half the list unscoped. Both must be built
   * from the SAME capability; the route does that in one place and a gate
   * checks it.
   */
  scope: {
    /** `occurrencePortfolioWhere(principal, cap)` */
    occurrence?: Record<string, unknown>;
    /** `portfolioWhereVia(principal, cap, "property")` */
    job?: Record<string, unknown>;
  } = {},
  /** `clients.view` — see the note on `contactName`. Default closed. */
  includeContact = false,
): Promise<RepeatingStreamRow[]> {
  const portfolioWhere = scope.occurrence ?? {};
  const rows = await prisma.jobOccurrence.findMany({
    where: withPortfolio<Prisma.JobOccurrenceWhereInput>(
      {
        status: { in: [...ACTIVE_STREAM_STATUSES] },
        // A stream belongs to a service; a standalone task has no job and no
        // cadence to repeat on.
        jobId: { not: null },
      },
      portfolioWhere,
    ),
    select: {
      id: true,
      status: true,
      startAt: true,
      // For the next-visit projection: `computeNextOccurrenceStart` carries
      // the visit's own length forward, and honours a one-time date shift
      // somebody with `money.approve` set on the source occurrence.
      endAt: true,
      nextStartOverride: true,
      title: true,
      jobType: true,
      frequencyDays: true,
      // A one-off is excluded on these two, not on cadence — see the
      // membership pass below.
      workflow: true,
      isOneOff: true,
      // The money clock, and its legacy fallbacks.
      completedAt: true,
      paymentRequestFirstSentAt: true,
      paymentRequestSentAt: true,
      paymentRequestResendCount: true,
      nextVisitWarningSuppressedAt: true,
      streamPausedAt: true,
      streamPauseReason: true,
      streamPauseReasonCode: true,
      streamResumeReminderAt: true,
      job: {
        select: {
          id: true,
          description: true,
          frequencyDays: true,
          property: {
            select: {
              displayName: true,
              client: {
                select: {
                  id: true,
                  displayName: true,
                  // THE PRIMARY CONTACT, and only when the caller may see
                  // one. Primary first, then oldest, matching how every
                  // other surface picks "the person to call".
                  ...(includeContact
                    ? {
                        contacts: {
                          where: { status: "ACTIVE" as const },
                          orderBy: [
                            { isPrimary: "desc" as const },
                            { createdAt: "asc" as const },
                          ],
                          take: 1,
                          select: {
                            firstName: true,
                            lastName: true,
                            nickname: true,
                            phone: true,
                            email: true,
                          },
                        },
                      }
                    : {}),
                },
              },
            },
          },
        },
      },
    },
    orderBy: { startAt: "asc" },
  });

  // One taxonomy read for the whole list rather than per row. Retired
  // reasons are INCLUDED here on purpose: they are not offered for new
  // pauses, but a stream held under one last year still has to render its
  // label rather than a bare code.
  const reasons = await listPauseReasons();
  const labelFor = (code: string | null): string | null =>
    code ? reasons.find((r) => r.code === code)?.label ?? code : null;

  const now = new Date();
  const today = etToday();

  // ── PASS ONE: MEMBERSHIP. ─────────────────────────────────────────────
  // Separated out because the expiry question below needs to know, for each
  // stream, whether ANY visit of it is still in the future — which is one
  // grouped query over the surviving jobs rather than a per-row read.
  // The job is non-null by construction — the guard below drops the rows
  // without one — and saying so in the type is what keeps the second pass
  // free of non-null assertions.
  type Candidate = Omit<(typeof rows)[number], "job"> & {
    job: NonNullable<(typeof rows)[number]["job"]>;
    _freq: number;
  };
  const candidates: Candidate[] = [];
  for (const o of rows) {
    if (!o.job) continue;
    const freq = o.frequencyDays ?? o.job.frequencyDays ?? null;
    // NOT REPEATING, NOT THIS TABLE'S BUSINESS.
    if (freq === null) continue;
    // A ONE-OFF IS NOT A STREAM, however its job happens to be configured.
    //
    // Cadence alone was the test, and cadence resolves through the job — so a
    // ONE_OFF occurrence carrying no cadence of its own, on a job that still
    // carries `frequencyDays: 14` from when it did repeat, resolved to 14 and
    // was listed as a repeating stream. PRODUCTION HAD FIVE OF THEM on a
    // screen whose own first paragraph says one-off visits are not listed,
    // and whose whole premise is that every row has a future to hold.
    //
    // This is the identical trap `listNextOccurrenceGhosts` already carries a
    // comment about: it advertised next visits for one-offs for the same
    // reason, and excludes every non-STANDARD workflow for the same fix. The
    // dev database is all STANDARD, which is why nothing here caught it.
    if (o.workflow !== "STANDARD" || o.isOneOff) continue;
    candidates.push({ ...o, job: o.job, _freq: freq });
  }

  // Does this stream have any visit still ahead of it? Asked of ALL of the
  // job's occurrences, not just the active ones this table lists, so the
  // answer does not change with the status filter above. CANCELED and
  // ARCHIVED are excluded because a cancelled future visit is not a visit —
  // the same two the ghost path treats as ending the series.
  const latestByJob = new Map<string, Date | null>();
  const jobIds = [...new Set(candidates.map((o) => o.job.id))];
  if (jobIds.length > 0) {
    const maxes = await prisma.jobOccurrence.groupBy({
      by: ["jobId"],
      where: {
        jobId: { in: jobIds },
        status: { notIn: [JobOccurrenceStatus.CANCELED, JobOccurrenceStatus.ARCHIVED] },
      },
      _max: { startAt: true },
    });
    for (const m of maxes) if (m.jobId) latestByJob.set(m.jobId, m._max.startAt);
  }

  // ── PASS TWO: THE ROWS. ───────────────────────────────────────────────
  const out: RepeatingStreamRow[] = [];
  for (const o of candidates) {
    const freq = o._freq;
    const held = o.status === JobOccurrenceStatus.STREAM_PAUSED;

    // BOTH MONEY CLOCKS, from the shared rule. Only for a row that is
    // actually waiting on money — a scheduled visit has no receivable.
    const wait: PaymentWait | null =
      o.status === JobOccurrenceStatus.PENDING_PAYMENT
        ? describePaymentWait(o, today)
        : null;

    // HAS THE STREAM STOPPED PRODUCING VISITS?
    //
    // Three conditions, and each one is load-bearing:
    //
    //   • Not held. A held stream is a DELIBERATE stop with a reason and a
    //     check-back date attached. Calling that expired would paint the
    //     operator's own decision as a failure — and it is the one thing this
    //     whole screen exists to do.
    //   • This row is the stream's LATEST visit. A stream can briefly show
    //     two rows here (a payment reverted after the next visit was already
    //     started, so the next one survived the revert's cleanup). Projecting
    //     from the older of them would date the stall from the wrong visit.
    //   • That latest visit is in the past. If anything is still ahead, the
    //     stream is running and there is nothing to report.
    const latest = latestByJob.get(o.job.id) ?? null;
    const isLatest = !!latest && !!o.startAt && latest.getTime() === o.startAt.getTime();
    let nextVisitDueOn: EtDateKey | null = null;
    let expiredDays: number | null = null;
    if (!held && isLatest && latest!.getTime() <= now.getTime() && freq > 0) {
      const { rawStartAt } = computeNextOccurrenceStart(
        o.startAt,
        o.endAt,
        freq,
        o.nextStartOverride ?? null,
      );
      nextVisitDueOn = etFormatDate(rawStartAt);
      const daysUntilDue = etDaysBetween(today, nextVisitDueOn);
      // Negative = the day it was due has passed. Due today or later is a
      // stream that is merely between visits, which is its normal state.
      if (daysUntilDue < 0) expiredDays = -daysUntilDue;
    }
    out.push({
      id: o.id,
      jobId: o.job.id,
      clientId: o.job.property?.client?.id ?? null,
      clientName: o.job.property?.client?.displayName ?? "—",
      propertyName: o.job.property?.displayName ?? "—",
      service: o.jobType || o.title || o.job.description || null,
      frequencyDays: freq,
      status: o.status,
      startAt: o.startAt?.toISOString() ?? null,
      canPause: o.status === JobOccurrenceStatus.SCHEDULED,
      canResume: held,
      blockedReason: blockedReasonFor(o.status),
      streamPauseReasonCode: o.streamPauseReasonCode ?? null,
      streamPauseReasonLabel: labelFor(o.streamPauseReasonCode ?? null),
      streamPauseReason: o.streamPauseReason ?? null,
      streamPausedAt: o.streamPausedAt?.toISOString() ?? null,
      streamResumeReminderAt: o.streamResumeReminderAt?.toISOString() ?? null,
      reminderDue: !!o.streamResumeReminderAt && o.streamResumeReminderAt <= now,
      awaitingPaymentSince: wait?.waitingSince?.toISOString() ?? null,
      awaitingPaymentDays: wait?.waitingDays ?? null,
      paymentRequestedAt: wait?.requestedAt?.toISOString() ?? null,
      paymentRequestedDays: wait?.requestedDays ?? null,
      paymentFirstRequestedAt: wait?.firstRequestedAt?.toISOString() ?? null,
      paymentFirstRequestedDays: wait?.firstRequestedDays ?? null,
      paymentResendCount: wait?.resendCount ?? 0,
      paymentNeverRequested: wait ? wait.neverRequested : false,
      nextVisitDueOn,
      expiredDays,
      expirySuppressed: !!o.nextVisitWarningSuppressedAt,
      ...contactFor(o.job.property?.client),
      // This row IS a live visit, so none of the dormancy story applies.
      occurrenceId: o.id,
      dormancy: null,
      lastServedAt: null,
      missedCycles: null,
      suggestedResumeAt:
        held && o.startAt && freq > 0
          ? etFormatDate(computeResumeStartAt(o.startAt, freq, now))
          : null,
    });
  }
  // ── PASS THREE: THE STREAMS WITH NO LIVE VISIT. ──────────────────────
  //
  // Everything above is rooted in an occurrence, so a stream that has none
  // cannot appear there however wrong its silence is. These are found from
  // the JOB instead — the only thing that survives when the visits stop.
  //
  // WHY THE JOB AND NOT A FIXED-UP GHOST. `listNextOccurrenceGhosts` is the
  // existing "a next visit is missing" machinery, and it misses every one of
  // these for three separate reasons of its own: it bails when there are no
  // occurrences, it treats a cancelled latest as ending the series, and it
  // skips a job whose latest occurrence is a ONE-OFF — which is how four
  // real customers went dark while somebody kept serving them by hand. A
  // ghost is a PROJECTION of the next visit; this is a question about the
  // customer, and it wants its own answer.
  out.push(...(await dormantStreams(new Set(out.map((r) => r.jobId)), scope.job ?? {}, includeContact)));
  return out;
}

/**
 * Repeating streams that produced no live visit at all.
 *
 * WHAT COUNTS AS GONE, and the line is the operator's: a thing is allowed to
 * disappear only if somebody deliberately archived it.
 *   · archived CUSTOMER or PROPERTY — excluded. Deliberate.
 *   · archived JOB — excluded. Also deliberate, and the narrower act.
 *   · everything else — listed, whatever state it is in.
 *
 * PROPOSED jobs are excluded because a quote is not yet a customer being
 * served; they would arrive as noise the day proposals get used in anger.
 */
async function dormantStreams(
  alreadyListed: Set<string>,
  jobScope: Record<string, unknown>,
  includeContact: boolean,
): Promise<RepeatingStreamRow[]> {
  const jobs = await prisma.job.findMany({
    where: withPortfolio<Prisma.JobWhereInput>(
      {
        status: JobStatus.ACCEPTED,
        property: { archivedAt: null, client: { archivedAt: null } },
        // REPEATING EITHER WAY ROUND. The cadence usually sits on the job,
        // but one production stream carries it only on its occurrences —
        // a job-only test would have dropped exactly the kind of row this
        // whole pass exists to stop losing.
        OR: [
          { frequencyDays: { not: null } },
          {
            occurrences: {
              some: { frequencyDays: { not: null }, workflow: "STANDARD", isOneOff: false },
            },
          },
        ],
      },
      jobScope,
    ),
    select: {
      id: true,
      description: true,
      frequencyDays: true,
      property: {
        select: {
          displayName: true,
          client: {
            select: {
              id: true,
              displayName: true,
              ...(includeContact
                ? {
                    contacts: {
                      where: { status: "ACTIVE" as const },
                      orderBy: [{ isPrimary: "desc" as const }, { createdAt: "asc" as const }],
                      take: 1,
                      select: {
                        firstName: true,
                        lastName: true,
                        nickname: true,
                        phone: true,
                        email: true,
                      },
                    },
                  }
                : {}),
            },
          },
        },
      },
      occurrences: {
        orderBy: { startAt: "desc" },
        select: {
          status: true,
          startAt: true,
          jobType: true,
          title: true,
          frequencyDays: true,
          workflow: true,
          isOneOff: true,
        },
      },
    },
  });

  const today = etToday();
  const out: RepeatingStreamRow[] = [];
  for (const j of jobs) {
    if (alreadyListed.has(j.id)) continue; // it has a live visit; already above

    // The repeating half of its history, for the cadence and the story.
    const reps = j.occurrences.filter(
      (o) => (o.frequencyDays ?? j.frequencyDays) !== null && o.workflow === "STANDARD" && !o.isOneOff,
    );
    const freq = reps[0]?.frequencyDays ?? j.frequencyDays ?? null;

    // WHAT KIND OF NOTHING. The LATEST event of any kind decides whether
    // this was cancelled, because a cancellation is the operator's own act
    // and reads differently from a visit that simply stopped coming.
    const latest = j.occurrences[0] ?? null;
    const dormancy: NonNullable<RepeatingStreamRow["dormancy"]> = !latest
      ? "never-ran"
      : latest.status === JobOccurrenceStatus.CANCELED
        ? "cancelled"
        : "stopped";

    // SERVED, not merely scheduled — the question is when this customer last
    // had work done, so a cancelled or still-scheduled visit does not count.
    const lastServed =
      j.occurrences.find(
        (o) =>
          o.startAt &&
          (o.status === JobOccurrenceStatus.COMPLETED ||
            o.status === JobOccurrenceStatus.PENDING_PAYMENT ||
            o.status === JobOccurrenceStatus.CLOSED),
      )?.startAt ?? null;
    const missedCycles =
      lastServed && freq && freq > 0
        ? Math.round((etDaysBetween(etFormatDate(lastServed), today) / freq) * 10) / 10
        : null;

    out.push({
      // NOT an occurrence id — there is no occurrence. Prefixed so it can
      // never be mistaken for one by a caller that stopped reading
      // `occurrenceId`.
      id: `job:${j.id}`,
      occurrenceId: null,
      jobId: j.id,
      clientId: j.property?.client?.id ?? null,
      clientName: j.property?.client?.displayName ?? "—",
      propertyName: j.property?.displayName ?? "—",
      service: reps[0]?.jobType || reps[0]?.title || j.description || null,
      frequencyDays: freq,
      // ONE SYNTHETIC VALUE, AND IT CANNOT BE MISTAKEN FOR AN ENUM MEMBER.
      //
      // This field carries a real `JobOccurrenceStatus` on every other row,
      // and the first cut of this one put "STOPPED" and "CANCELLED" in it —
      // invented strings sitting in a field that otherwise holds the enum.
      // "CANCELLED" was the dangerous one: the enum spells it CANCELED, with
      // ONE L. A `status === "CANCELED"` check would silently skip these
      // rows and a `=== "CANCELLED"` check would silently skip the real
      // ones, and neither would fail anywhere.
      //
      // So there is now exactly one synthetic value, named for what is
      // actually true — there is no visit — and `dormancy` beside it carries
      // which of the three kinds of nothing this is. One field, one job.
      status: NO_VISIT,
      startAt: null,
      canPause: false,
      canResume: false,
      blockedReason: null,
      streamPauseReasonCode: null,
      streamPauseReasonLabel: null,
      streamPauseReason: null,
      streamPausedAt: null,
      streamResumeReminderAt: null,
      reminderDue: false,
      awaitingPaymentSince: null,
      awaitingPaymentDays: null,
      paymentRequestedAt: null,
      paymentRequestedDays: null,
      paymentFirstRequestedAt: null,
      paymentFirstRequestedDays: null,
      paymentResendCount: 0,
      paymentNeverRequested: false,
      nextVisitDueOn: null,
      expiredDays: null,
      expirySuppressed: false,
      suggestedResumeAt: null,
      ...contactFor(j.property?.client),
      dormancy,
      lastServedAt: lastServed?.toISOString() ?? null,
      missedCycles,
    });
  }
  return out;
}

/**
 * THE SELECTION WRITE PATHS WERE HERE, AND WERE REMOVED 2026-11-10.
 *
 * `pauseSelection` / `resumeSelection` (plus `withinScope`, which was their
 * security boundary, and `MAX_SELECTION`) let Work → Repeating act on many
 * ticked rows at once. They worked, and they were careful: per-row
 * transactions, per-row outcomes, scoped against the caller's portfolios
 * because the ids came from a request body.
 *
 * They went because the book is not big enough to need them — about forty
 * pausable streams, which is one screenful. The operator: "we don't have
 * enough that make it worth it for now. I can rethink it when there are many
 * more clients."
 *
 * REMOVED, NOT LEFT UNREACHABLE. This module's own header explains what the
 * feature it replaced got wrong, and part of that wrongness is still sitting
 * on the Job model as two dead columns. A route nothing calls is the same
 * debt in a different shape: it stays in the route map, it stays gated, and
 * it is a write surface nobody exercises. `git log` has the whole thing, and
 * `docs/features/repeating.md` records the design if it comes back.
 */
