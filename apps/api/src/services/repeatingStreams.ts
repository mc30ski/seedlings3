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

import { JobOccurrenceStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { withPortfolio } from "../lib/portfolioScope";
import { etFormatDate } from "../lib/dates";
import { ServiceError } from "../lib/errors";
import { computeResumeStartAt } from "./jobs";
import { ACTIVE_STREAM_STATUSES, listPauseReasons } from "./pauseReasons";
import { pauseStream, resumeStream } from "./occurrenceStreamPause";

/**
 * The most occurrences one selection may carry.
 *
 * The live book is 57 streams, so this is headroom rather than a limit
 * anybody will meet. It is here because the handler loops, and a loop whose
 * length comes from the request body is a loop the caller sizes.
 */
export const MAX_SELECTION = 200;

/** Why a row cannot be held right now, in the operator's words.
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
      return "Awaiting payment — settle or write off the visit first, then hold the new one.";
    case JobOccurrenceStatus.IN_PROGRESS:
      return "Someone is on site. Hold it once the visit is finished.";
    case JobOccurrenceStatus.PAUSED:
      // Two different "paused" across two enums; see the note in
      // pauseReasons.ts. This one is a worker's timer mid-visit.
      return "A worker has their timer paused mid-visit. Hold it once the visit is finished.";
    default:
      return "Not in a state that can be held.";
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
};

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
  portfolioWhere: Record<string, unknown> = {},
): Promise<RepeatingStreamRow[]> {
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
      title: true,
      jobType: true,
      frequencyDays: true,
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
              client: { select: { id: true, displayName: true } },
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
  const out: RepeatingStreamRow[] = [];
  for (const o of rows) {
    const freq = o.frequencyDays ?? o.job?.frequencyDays ?? null;
    // THE MEMBERSHIP TEST. Not repeating, not this table's business.
    if (freq === null) continue;
    if (!o.job) continue;

    const held = o.status === JobOccurrenceStatus.STREAM_PAUSED;
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
      suggestedResumeAt:
        held && o.startAt && freq > 0
          ? etFormatDate(computeResumeStartAt(o.startAt, freq, now))
          : null,
    });
  }
  return out;
}

/** What happened to one occurrence in a selection. */
export type SelectionOutcome = {
  occurrenceId: string;
  ok: boolean;
  /** Operator-facing, and only when `ok` is false. */
  message?: string;
};

export type SelectionResult = {
  applied: number;
  refused: number;
  outcomes: SelectionOutcome[];
};

/**
 * Narrow a selection of ids to the ones this caller may actually act on.
 *
 * THIS IS THE SECURITY BOUNDARY OF THE SELECTION PATH, and it exists because
 * `pauseStream` has no idea who is calling. Every other caller of it reaches
 * it through a route holding one occurrence id that the operator had on
 * screen; this one takes a list from the request body. A portfolio-limited
 * holder could otherwise post an id from a district they cannot see and have
 * it written, because the write itself never asks.
 *
 * Returns the ids that survive, so the handler can refuse the rest by name
 * rather than failing the whole call.
 */
async function withinScope(
  occurrenceIds: string[],
  portfolioWhere: Record<string, unknown>,
): Promise<Set<string>> {
  const rows = await prisma.jobOccurrence.findMany({
    where: withPortfolio<Prisma.JobOccurrenceWhereInput>(
      { id: { in: occurrenceIds } },
      portfolioWhere,
    ),
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

function validateSelection(occurrenceIds: unknown): string[] {
  if (!Array.isArray(occurrenceIds) || occurrenceIds.length === 0) {
    throw new ServiceError("INVALID", "Pick at least one repeating job occurrence.", 400);
  }
  const ids = [...new Set(occurrenceIds.map((x) => String(x)))];
  if (ids.length > MAX_SELECTION) {
    throw new ServiceError(
      "INVALID",
      `That is more than ${MAX_SELECTION} services at once. Narrow the filter and do it in passes.`,
      400,
    );
  }
  return ids;
}

/**
 * Hold every stream in the selection, under ONE reason.
 *
 * PER-ROW INDEPENDENT, deliberately. One transaction around all of them
 * would mean a single row whose status moved under the operator — a visit
 * started while they were choosing — rolls back twenty-eight good pauses and
 * reports nothing useful. Each row gets its own transaction (pauseStream
 * opens one) and its own outcome, and the caller is told which ones did not
 * take.
 *
 * SEQUENTIAL, not parallel: these are write transactions against a
 * serverless Postgres, and a selection is a twice-a-year action where being
 * right matters more than being quick.
 *
 * No audit row is written HERE. Each `pauseStream` writes its own, carrying
 * the reason, label, note and reminder; a sweep is already legible in the
 * trail as N rows with one actor and one timestamp. A batch-level row would
 * double-count every pause in it.
 */
export async function pauseSelection(
  currentUserId: string,
  occurrenceIdsRaw: unknown,
  opts: { reasonCode: string; reason?: string | null; reminderAt?: Date | null },
  portfolioWhere: Record<string, unknown> = {},
): Promise<SelectionResult> {
  const ids = validateSelection(occurrenceIdsRaw);
  if (!opts.reasonCode?.trim()) {
    throw new ServiceError(
      "INVALID",
      "Pick a reason for pausing — it is what makes a paused service findable again.",
      400,
    );
  }
  const allowed = await withinScope(ids, portfolioWhere);

  const outcomes: SelectionOutcome[] = [];
  for (const id of ids) {
    if (!allowed.has(id)) {
      outcomes.push({ occurrenceId: id, ok: false, message: "Not found." });
      continue;
    }
    try {
      await pauseStream(currentUserId, id, opts);
      outcomes.push({ occurrenceId: id, ok: true });
    } catch (err) {
      outcomes.push({
        occurrenceId: id,
        ok: false,
        message: err instanceof ServiceError ? err.message : "Could not hold this one.",
      });
    }
  }
  return {
    applied: outcomes.filter((o) => o.ok).length,
    refused: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}

/**
 * Restart every stream in the selection.
 *
 * TWO MODES, and the default is the one that does not pile the book up.
 * `startAt` set restarts them all on that date, which the operator may
 * genuinely want for a handful. Omitted, each stream steps forward from its
 * own last date by its own cadence until it lands today-or-later — the same
 * `computeResumeStartAt` the single-row path uses and the same date the
 * table showed before they committed.
 */
export async function resumeSelection(
  currentUserId: string,
  occurrenceIdsRaw: unknown,
  opts: { startAt?: Date | null },
  portfolioWhere: Record<string, unknown> = {},
): Promise<SelectionResult> {
  const ids = validateSelection(occurrenceIdsRaw);
  const allowed = await withinScope(ids, portfolioWhere);

  // Cadence and current date per row, for the per-stream default. Read once
  // rather than inside the loop.
  const rows = await prisma.jobOccurrence.findMany({
    where: { id: { in: [...allowed] } },
    select: {
      id: true,
      startAt: true,
      frequencyDays: true,
      job: { select: { frequencyDays: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const now = new Date();
  const outcomes: SelectionOutcome[] = [];
  for (const id of ids) {
    if (!allowed.has(id)) {
      outcomes.push({ occurrenceId: id, ok: false, message: "Not found." });
      continue;
    }
    const row = byId.get(id);
    const freq = row?.frequencyDays ?? row?.job?.frequencyDays ?? null;
    let startAt = opts.startAt ?? null;
    if (!startAt) {
      if (!row?.startAt || !freq || freq <= 0) {
        outcomes.push({
          occurrenceId: id,
          ok: false,
          message: "No cadence to restart on — pick a date instead.",
        });
        continue;
      }
      startAt = computeResumeStartAt(row.startAt, freq, now);
    }
    try {
      await resumeStream(currentUserId, id, startAt);
      outcomes.push({ occurrenceId: id, ok: true });
    } catch (err) {
      outcomes.push({
        occurrenceId: id,
        ok: false,
        message: err instanceof ServiceError ? err.message : "Could not restart this one.",
      });
    }
  }
  return {
    applied: outcomes.filter((o) => o.ok).length,
    refused: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}
