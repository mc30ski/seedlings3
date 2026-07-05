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

/**
 * Transition SCHEDULED → STREAM_PAUSED on a single occurrence. Both
 * `reason` and `reminderAt` are optional — the operator can pause
 * without a note or reminder, but the UI encourages both.
 */
export async function pauseStream(
  currentUserId: string,
  occurrenceId: string,
  opts: { reason?: string | null; reminderAt?: Date | null },
) {
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
        streamResumeReminderAt: opts.reminderAt ?? null,
      },
    });

    await writeAudit(tx, AUDIT.JOB.OCCURRENCE_UPDATED, currentUserId, {
      occurrenceId,
      action: "STREAM_PAUSED",
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
  opts: { reason?: string | null; reminderAt?: Date | null },
) {
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
    if (opts.reminderAt !== undefined) {
      data.streamResumeReminderAt = opts.reminderAt;
    }

    const record = await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data,
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
        streamResumeReminderAt: null,
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
