// Occurrence-level "stream pause" — temporarily hold a single recurring
// stream (e.g. hedging) on a Job without stopping the Job's other
// streams (mowing continues). The chain regenerates from a completed
// occurrence, so freezing the currently-scheduled occurrence for the
// stream freezes the whole stream. See JobOccurrence.streamPausedAt
// on the schema for the field-level docs.
//
// Distinct from `Job.status = PAUSED` (Job-wide pause) and
// `JobOccurrence.status = PAUSED` (worker timer paused mid-visit).
// The three concepts do not interact — a stream-paused occurrence is
// still under an ACTIVE Client + Job.

import { Prisma, JobOccurrenceStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { resolvePauseReason } from "./pauseReasons";

/**
 * Transition SCHEDULED → STREAM_PAUSED on a single occurrence. Both
 * `reason` and `reminderAt` are optional — the operator can pause
 * without a note or reminder, but the UI encourages both.
 */
export async function pauseStream(
  currentUserId: string,
  occurrenceId: string,
  /** `reasonCode` is REQUIRED — a pause you cannot categorise is a pause you
   *  cannot find again, and finding them again (next spring, by reason) is
   *  the whole point. The free-text `reason` stays optional alongside it. */
  opts: { reasonCode: string; reason?: string | null; reminderAt?: Date | null },
) {
  // Resolved OUTSIDE the transaction: it reads a Setting, and a bad code
  // should fail before anything is written.
  const reason = await resolvePauseReason(opts.reasonCode);
  return prisma.$transaction(async (tx) => {
    const occ = await tx.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { id: true, status: true, jobId: true },
    });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);

    // Only SCHEDULED occurrences can enter STREAM_PAUSED — in-progress,
    // completed, or paid occurrences represent work in flight or done,
    // where a "pause the future stream" gesture doesn't apply.
    if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
      throw new ServiceError(
        "INVALID_STATUS",
        `Cannot pause stream — occurrence status is "${occ.status}", expected "SCHEDULED".`,
        409,
      );
    }

    const record = await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: JobOccurrenceStatus.STREAM_PAUSED,
        streamPausedAt: new Date(),
        streamPausedById: currentUserId,
        streamPauseReason: opts.reason?.trim() || null,
        streamPauseReasonCode: reason.code,
        streamResumeReminderAt: opts.reminderAt ?? null,
      },
    });

    // HISTORY. The fields above are cleared on resume, which is right for
    // "is this paused now" and useless for "what did we lose to the season
    // last winter". The label is snapshotted, not joined, so retiring a
    // reason next year cannot rewrite what this pause said.
    // audit-allow: the history row IS the record, written in the same
    // transaction as the STREAM_PAUSED audit below, which already carries the
    // reason code, label, note and reminder. A second audit row describing
    // the same act would double-count every pause in the trail.
    await tx.jobOccurrencePauseEvent.create({
      data: {
        occurrenceId,
        reasonCode: reason.code,
        reasonLabel: reason.label,
        note: opts.reason?.trim() || null,
        pausedById: currentUserId,
        reminderAt: opts.reminderAt ?? null,
      },
    });

    await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
      occurrenceId,
      action: "STREAM_PAUSED",
      reasonCode: reason.code,
      reasonLabel: reason.label,
      reason: opts.reason?.trim() || null,
      reminderAt: opts.reminderAt?.toISOString() ?? null,
    });

    return record;
  });
}

/**
 * Update the reason and/or reminder date on an already-paused stream.
 * Called from the "extend the pause" workflow — when the reminder date
 * arrives, the operator can push it further without resuming/re-pausing.
 */
export async function updateStreamPause(
  currentUserId: string,
  occurrenceId: string,
  opts: { reasonCode?: string; reason?: string | null; reminderAt?: Date | null },
) {
  // Validate the code before opening a transaction, same as pauseStream.
  const resolved = opts.reasonCode ? await resolvePauseReason(opts.reasonCode) : null;
  return prisma.$transaction(async (tx) => {
    const occ = await tx.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { id: true, status: true },
    });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
    if (occ.status !== JobOccurrenceStatus.STREAM_PAUSED) {
      throw new ServiceError(
        "INVALID_STATUS",
        `Cannot update stream pause — occurrence status is "${occ.status}", expected "STREAM_PAUSED".`,
        409,
      );
    }

    // Undefined = don't touch the field. Null = clear. Non-null =
    // replace. Lets the caller pass just one field without wiping
    // the other.
    const data: Prisma.JobOccurrenceUpdateInput = {};
    if (opts.reason !== undefined) {
      data.streamPauseReason = opts.reason?.trim() || null;
    }
    if (opts.reasonCode !== undefined && opts.reasonCode) {
      data.streamPauseReasonCode = opts.reasonCode;
    }
    if (opts.reminderAt !== undefined) {
      data.streamResumeReminderAt = opts.reminderAt;
    }

    const record = await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data,
    });

    // Keep the open history row in step with the live fields — otherwise a
    // corrected reason shows on the card and the old one is what gets counted.
    // audit-allow: mirrors the live-field edit onto the open history row in
    // the same transaction as the STREAM_PAUSE_UPDATED audit below.
    await tx.jobOccurrencePauseEvent.updateMany({
      where: { occurrenceId, resumedAt: null },
      data: {
        ...(resolved ? { reasonCode: resolved.code, reasonLabel: resolved.label } : {}),
        ...(opts.reason !== undefined ? { note: opts.reason?.trim() || null } : {}),
        ...(opts.reminderAt !== undefined ? { reminderAt: opts.reminderAt } : {}),
      },
    });

    await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
      occurrenceId,
      action: "STREAM_PAUSE_UPDATED",
      reason: record.streamPauseReason,
      reminderAt: record.streamResumeReminderAt?.toISOString() ?? null,
    });

    return record;
  });
}

/**
 * Transition STREAM_PAUSED → SCHEDULED with a fresh `startAt`. Clears
 * the stream* fields so the occurrence looks like any other scheduled
 * one going forward. Caller supplies the new startAt — prompting for
 * it in the UI avoids restarting at a stale date.
 */
export async function resumeStream(
  currentUserId: string,
  occurrenceId: string,
  newStartAt: Date,
) {
  return prisma.$transaction(async (tx) => {
    const occ = await tx.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { id: true, status: true, startAt: true, endAt: true },
    });
    if (!occ) throw new ServiceError("NOT_FOUND", "Occurrence not found.", 404);
    if (occ.status !== JobOccurrenceStatus.STREAM_PAUSED) {
      throw new ServiceError(
        "INVALID_STATUS",
        `Cannot resume stream — occurrence status is "${occ.status}", expected "STREAM_PAUSED".`,
        409,
      );
    }

    // Preserve the visit's duration (endAt - startAt) if endAt was set.
    // Rewrites endAt to sit at newStartAt + originalDuration so a "2h
    // hedge visit" stays a 2h visit at the new date.
    let newEndAt: Date | null = null;
    if (occ.endAt && occ.startAt) {
      const duration = occ.endAt.getTime() - occ.startAt.getTime();
      newEndAt = new Date(newStartAt.getTime() + duration);
    }

    const record = await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: JobOccurrenceStatus.SCHEDULED,
        startAt: newStartAt,
        endAt: newEndAt,
        streamPausedAt: null,
        streamPausedById: null,
        streamPauseReason: null,
        streamPauseReasonCode: null,
        streamResumeReminderAt: null,
      },
    });

    // Close the open history row rather than deleting it. The live fields
    // above are cleared because "is this paused" must answer no; the reason
    // survives here so "what did we pause for the season, and did it come
    // back?" stays answerable.
    //
    // updateMany, not update: a row paused before this table existed has no
    // open event, and resuming it must not throw.
    // audit-allow: stamps the open history row closed inside the same
    // transaction as the STREAM_RESUMED audit below, which records who
    // resumed and onto what date.
    await tx.jobOccurrencePauseEvent.updateMany({
      where: { occurrenceId, resumedAt: null },
      data: {
        resumedAt: new Date(),
        resumedById: currentUserId,
        resumedOntoAt: newStartAt,
      },
    });

    await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
      occurrenceId,
      action: "STREAM_RESUMED",
      newStartAt: newStartAt.toISOString(),
    });

    return record;
  });
}

/** Count of paused streams whose reminder date has arrived or passed.
 *  Feeds the alerts-dropdown badge + Tasks-page shortcut. */
export async function countDueStreamPauseReminders(): Promise<number> {
  return prisma.jobOccurrence.count({
    where: {
      status: JobOccurrenceStatus.STREAM_PAUSED,
      streamResumeReminderAt: { not: null, lte: new Date() },
    },
  });
}

/** List of paused streams whose reminder is due. For the Tasks page card. */
export async function listDueStreamPauseReminders() {
  return prisma.jobOccurrence.findMany({
    where: {
      status: JobOccurrenceStatus.STREAM_PAUSED,
      streamResumeReminderAt: { not: null, lte: new Date() },
    },
    select: {
      id: true,
      title: true,
      jobType: true,
      streamPausedAt: true,
      streamPauseReason: true,
      // The categorised reason, so the Tasks card says WHY without the
      // operator opening the row. The free-text note beside it is the
      // detail, not a substitute.
      streamPauseReasonCode: true,
      streamResumeReminderAt: true,
      job: {
        select: {
          id: true,
          description: true,
          property: {
            select: {
              displayName: true,
              client: { select: { id: true, displayName: true } },
            },
          },
        },
      },
    },
    orderBy: { streamResumeReminderAt: "asc" },
  });
}
