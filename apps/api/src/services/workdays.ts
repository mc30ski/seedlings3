import type { WorkerWorkday } from "@prisma/client";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";
import { etFormatDate, etToday, etMidnight, etEndOfDay, etInstantFromParts, etAddDays } from "../lib/dates";

// ─────────────────────────────────────────────────────────────────────────────
// Worker workday service — per-worker daily clock-in/out tracking.
//
// State model (see WorkerWorkday schema):
//   NOT_STARTED → no row exists for the worker's workdayDate
//   IN_PROGRESS → startedAt set, endedAt null, pausedAt null
//   PAUSED      → pausedAt set (current open pause segment)
//   COMPLETED   → endedAt set
//
// Pause math mirrors JobOccurrence: `totalPausedMs` accumulates closed
// pause segments only; the current open segment is `(now - pausedAt)`. On
// any of pause/resume/end transitions, we close the open segment cleanly
// so the recorded total never drops time.
//
// `workdayDate` (YYYY-MM-DD in ET) anchors the row. It does NOT change
// even if the worker ends past midnight — Tuesday's row stays anchored to
// Tuesday until COMPLETED. Today's start can't overlap because the unique
// constraint (userId, workdayDate) forbids it.
//
// Decoupling from JobOccurrence is INTENTIONAL — see the long comment on
// the schema model + the planning thread. The only forward-direction tie
// is `assertWorkdayActive` (used by the job-start guard).
// ─────────────────────────────────────────────────────────────────────────────

const CLOCK_SKEW_MS = 60 * 1000; // 1 minute — tolerates client clocks drifting slightly ahead

// Default cutoff hour for the worker→admin boundary. Overridden by the
// WORKDAY_APPROVAL_CUTOFF_HOUR_ET setting; this fallback applies when
// the setting is missing, blank, or out of range. 4 AM covers late-night
// work that wraps past midnight without forcing the worker to argue with
// admin for catch-up edits.
const DEFAULT_APPROVAL_CUTOFF_HOUR = 4;

export type WorkdayState =
  | { state: "NOT_STARTED" }
  | { state: "IN_PROGRESS"; workday: WorkdaySummary }
  | { state: "PAUSED"; workday: WorkdaySummary }
  | { state: "COMPLETED"; workday: WorkdaySummary };

export type WorkdaySummary = {
  id: string;
  userId: string;
  workdayDate: string;
  startedAt: string;
  endedAt: string | null;
  pausedAt: string | null;
  totalPausedMs: number;
  approvedAt: string | null;
};

export type JobBlockingSummary = {
  occurrenceId: string;
  title: string;
  status: string;
  propertyName: string | null;
  clientName: string | null;
};

export type EquipmentCheckoutSummary = {
  checkoutId: string;
  equipmentId: string;
  shortDesc: string;
  brand: string | null;
  model: string | null;
  checkedOutAt: string;
};

// ── Time validation helpers ──────────────────────────────────────────────

/** Today's ET calendar date as YYYY-MM-DD. Cached per-call rather than
 *  per-module so daylight-saving / midnight transitions are picked up
 *  without a server restart. */
function todayEt(): string {
  return etToday();
}

function dayMidnightEt(workdayDate: string): Date {
  return etMidnight(workdayDate);
}

function dayEndEt(workdayDate: string): Date {
  return etEndOfDay(workdayDate);
}

// ── Approval cutoff (worker/admin boundary) ─────────────────────────────
// The setting `WORKDAY_APPROVAL_CUTOFF_HOUR_ET` (default 4) marks the
// HOUR ET the next morning at which:
//   • the worker's edit window closes
//   • the admin/super approval window opens
//
// At DST boundaries this MUST route through bizInstantFromEtParts (or
// the equivalent ET-aware helper) — raw `setHours(4)` on the Date would
// shift the UTC instant by an hour around the spring-forward / fall-back
// transitions. See docs/DATE_HANDLING.md.

async function loadApprovalCutoffHour(): Promise<number> {
  const row = await prisma.setting.findUnique({
    where: { key: "WORKDAY_APPROVAL_CUTOFF_HOUR_ET" },
  });
  const n = Number(row?.value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 23) {
    return DEFAULT_APPROVAL_CUTOFF_HOUR;
  }
  return n;
}

/** Returns the UTC instant when admin approval becomes available for a
 *  workday anchored at `workdayDate`. Symmetric with the close of the
 *  worker's edit window (same instant). DST-safe via etInstantFromParts. */
async function approvalOpensAt(workdayDate: string): Promise<Date> {
  const cutoffHour = await loadApprovalCutoffHour();
  const nextDay = etAddDays(workdayDate, 1);
  return etInstantFromParts(nextDay, `${String(cutoffHour).padStart(2, "0")}:00`);
}

/** Whether the admin/super approval window is open for this workday. */
async function isApprovalWindowOpen(workdayDate: string): Promise<boolean> {
  const opensAt = await approvalOpensAt(workdayDate);
  return Date.now() >= opensAt.getTime();
}

/** Sanity-check a worker-supplied DateTime is in [floor, ceiling]. The
 *  ceiling includes a small clock-skew tolerance so a client a few seconds
 *  ahead of the server can still record "now". */
function assertInWindow(
  dt: Date,
  fieldName: string,
  floor: Date,
  ceiling: Date,
): void {
  if (isNaN(dt.getTime())) {
    throw new ServiceError("INVALID_DATE", `${fieldName} is not a valid date.`, 400);
  }
  if (dt.getTime() < floor.getTime()) {
    throw new ServiceError("OUT_OF_RANGE", `${fieldName} can't be before ${floor.toISOString()}.`, 400);
  }
  if (dt.getTime() > ceiling.getTime() + CLOCK_SKEW_MS) {
    throw new ServiceError("OUT_OF_RANGE", `${fieldName} can't be after ${ceiling.toISOString()}.`, 400);
  }
}

/** Serializer — pulls the row into a JSON-safe shape with ISO timestamps. */
function summarize(row: WorkerWorkday): WorkdaySummary {
  return {
    id: row.id,
    userId: row.userId,
    workdayDate: row.workdayDate,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    totalPausedMs: row.totalPausedMs,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
  };
}

function classify(row: WorkerWorkday | null): WorkdayState {
  if (!row) return { state: "NOT_STARTED" };
  if (row.endedAt) return { state: "COMPLETED", workday: summarize(row) };
  if (row.pausedAt) return { state: "PAUSED", workday: summarize(row) };
  return { state: "IN_PROGRESS", workday: summarize(row) };
}

// ── Reads ────────────────────────────────────────────────────────────────

/** Today's workday for the caller (state + the row when one exists). */
export async function getTodayWorkday(userId: string): Promise<WorkdayState> {
  const row = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate: todayEt() } },
  });
  return classify(row);
}

/** Any rows whose workdayDate is BEFORE today and whose endedAt is null —
 *  the "you forgot to end yesterday" set. Sorted oldest-first so the UI
 *  can sequence them one at a time. */
export async function listMyOpenWorkdays(userId: string): Promise<WorkdaySummary[]> {
  const rows = await prisma.workerWorkday.findMany({
    where: {
      userId,
      endedAt: null,
      workdayDate: { lt: todayEt() },
    },
    orderBy: { workdayDate: "asc" },
  });
  return rows.map(summarize);
}

/** Currently-active (IN_PROGRESS or PAUSED) jobs this user CLAIMED.
 *  Surfaced in the End Workday dialog as a soft warning — never blocks.
 *  Non-claimer assignees aren't included; they don't "own" the job. */
export async function checkBlockingActiveJobs(userId: string): Promise<JobBlockingSummary[]> {
  const assignees = await prisma.jobOccurrenceAssignee.findMany({
    where: {
      userId,
      // Only the claimer can mutate an occurrence (see services/jobs.ts).
      // assignedById === userId is the canonical "I claimed this" predicate.
      assignedById: userId,
      // Include rows with role = NULL (default "worker"); SQL would
      // drop them with a bare `role != 'observer'` predicate because
      // NULL comparisons evaluate to UNKNOWN.
      OR: [{ role: null }, { role: { not: "observer" } }],
      occurrence: { status: { in: ["IN_PROGRESS", "PAUSED"] as any } },
    },
    select: {
      occurrenceId: true,
      occurrence: {
        select: {
          title: true,
          status: true,
          job: {
            select: {
              property: {
                select: {
                  displayName: true,
                  client: { select: { displayName: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  return assignees.map((a) => ({
    occurrenceId: a.occurrenceId,
    title: a.occurrence?.title ?? "(untitled)",
    status: a.occurrence?.status ?? "",
    propertyName: a.occurrence?.job?.property?.displayName ?? null,
    clientName: a.occurrence?.job?.property?.client?.displayName ?? null,
  }));
}

/** Today's job counts for the worker — drives the conditional "pulse"
 *  on the workday card so the UI can flag:
 *    - NOT_STARTED + `remaining > 0` → "you have work today, start your day"
 *    - IN_PROGRESS + `scheduled > 0 && remaining === 0` → "you finished
 *      everything for today, time to end your workday"
 *
 *  Working assignments only (role !== "observer"). Counts scheduled
 *  STANDARD/ONE_OFF/ESTIMATE occurrences that start today (ET).
 *  `scheduled` includes completed jobs; `remaining` is the still-open
 *  subset (SCHEDULED/IN_PROGRESS/PAUSED). */
export async function getTodayJobCounts(userId: string): Promise<{
  scheduled: number;
  remaining: number;
}> {
  // Fetch all of the worker's assignments and filter out observers in
  // JS — the Prisma-side "exclude observer" predicate silently drops
  // NULL-role rows under Postgres 3VL. See the observer-filter build
  // gate for the canonical safe pattern.
  const myAssignments = await prisma.jobOccurrenceAssignee.findMany({
    where: { userId },
    select: { occurrenceId: true, role: true },
  });
  const myWorkingOccIds = myAssignments
    .filter((a) => a.role !== "observer")
    .map((a) => a.occurrenceId);
  if (myWorkingOccIds.length === 0) return { scheduled: 0, remaining: 0 };
  const today = todayEt();
  const todayMidnight = etMidnight(today);
  const tomorrowMidnight = etMidnight(etAddDays(today, 1));
  const [scheduled, remaining] = await Promise.all([
    prisma.jobOccurrence.count({
      where: {
        id: { in: myWorkingOccIds },
        startAt: { gte: todayMidnight, lt: tomorrowMidnight },
        status: { notIn: ["CANCELED", "ARCHIVED"] as any },
        workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
      },
    }),
    prisma.jobOccurrence.count({
      where: {
        id: { in: myWorkingOccIds },
        startAt: { gte: todayMidnight, lt: tomorrowMidnight },
        status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED"] as any },
        workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
      },
    }),
  ]);
  return { scheduled, remaining };
}

/** Currently-checked-out equipment for this worker (releasedAt is null).
 *  Soft warning on End Workday — many workers legitimately keep equipment
 *  across days. */
export async function checkActiveEquipmentCheckouts(
  userId: string,
): Promise<EquipmentCheckoutSummary[]> {
  const rows = await prisma.checkout.findMany({
    where: { userId, releasedAt: null },
    select: {
      id: true,
      checkedOutAt: true,
      equipment: { select: { id: true, shortDesc: true, brand: true, model: true } },
    },
    orderBy: { checkedOutAt: "asc" },
  });
  return rows.map((r) => ({
    checkoutId: r.id,
    equipmentId: r.equipment?.id ?? "",
    shortDesc: r.equipment?.shortDesc ?? "",
    brand: r.equipment?.brand ?? null,
    model: r.equipment?.model ?? null,
    checkedOutAt: r.checkedOutAt ? r.checkedOutAt.toISOString() : "",
  }));
}

/** Forward-direction tie to JobOccurrence: callers (the job-start guard,
 *  primarily) ask "is this worker on the clock?" before letting them move
 *  an occurrence into IN_PROGRESS. Returns enough state for the UI to
 *  pick the right prompt without re-fetching. */
export async function assertWorkdayActiveOrPrompt(userId: string): Promise<{
  ok: boolean;
  today: WorkdayState;
  openPrior: WorkdaySummary[];
}> {
  const [today, openPrior] = await Promise.all([
    getTodayWorkday(userId),
    listMyOpenWorkdays(userId),
  ]);
  // ok only when today is IN_PROGRESS and no prior days are dangling.
  // PAUSED is NOT ok — the UI surfaces a "resume to start" dialog
  // separately and calls resume + start in sequence. We don't auto-resume
  // server-side so the worker stays in the loop on what's happening.
  const ok = today.state === "IN_PROGRESS" && openPrior.length === 0;
  return { ok, today, openPrior };
}

// ── Writes ───────────────────────────────────────────────────────────────

type AuditContext = {
  /** The user who actually pushed the button. Same as `userId` for self-service;
   *  the impersonating admin's id during view-as. */
  actorId: string;
  /** Optional — when set on the audit detail tells the log the actor was
   *  impersonating the worker. Pulled from the impersonation header. */
  impersonatedUserId?: string | null;
};

function impersonationDetail(audit: AuditContext, userId: string) {
  if (audit.impersonatedUserId && audit.impersonatedUserId !== audit.actorId) {
    return { impersonatedUserId: userId };
  }
  return {};
}

/**
 * Start (or return-existing-if-already-started) today's workday for `userId`.
 * Idempotent — returns the existing row when one is already in progress,
 * paused, or completed. Caller can detect the "already exists" case via
 * the `created` flag on the return value.
 *
 * `startedAt` is optional and editable backward to today's ET midnight.
 */
export async function startWorkday(
  userId: string,
  input: { startedAt?: string | null },
  audit: AuditContext,
): Promise<{ workday: WorkdaySummary; created: boolean }> {
  const today = todayEt();
  const existing = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate: today } },
  });
  if (existing) {
    return { workday: summarize(existing), created: false };
  }

  const now = new Date();
  const startedAt = input.startedAt ? new Date(input.startedAt) : now;
  assertInWindow(startedAt, "startedAt", dayMidnightEt(today), now);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.workerWorkday.create({
      data: {
        userId,
        workdayDate: today,
        startedAt,
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.CREATED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      workdayDate: today,
      startedAt: startedAt.toISOString(),
      ...impersonationDetail(audit, userId),
    });
    return row;
  });

  return { workday: summarize(created), created: true };
}

/** Pause today's workday. Idempotent for already-paused. Refuses if there
 *  is no row, or the row is COMPLETED. */
export async function pauseWorkday(
  userId: string,
  audit: AuditContext,
): Promise<WorkdaySummary> {
  const today = todayEt();
  const row = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate: today } },
  });
  if (!row) {
    throw new ServiceError("NOT_FOUND", "No workday in progress.", 409);
  }
  if (row.endedAt) {
    throw new ServiceError("INVALID_STATE", "Workday is already ended.", 409);
  }
  if (row.pausedAt) {
    return summarize(row);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: { pausedAt: new Date() },
    });
    await writeAudit(tx, AUDIT.WORKDAY.UPDATED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      action: "pause",
      ...impersonationDetail(audit, userId),
    });
    return updatedRow;
  });
  return summarize(updated);
}

/** Resume today's workday. Closes the open pause segment by accumulating
 *  its duration into totalPausedMs, then clears pausedAt. Refuses if not
 *  currently paused. */
/**
 * Re-open a workday that was ended by mistake. Symmetric with `endWorkday`:
 * clears `endedAt` (back to IN_PROGRESS) and adds the gap between the old
 * endedAt and now to `totalPausedMs` so the accounting honestly reflects
 * the time the worker was off the clock. Audited as `reopen` so the
 * pattern can be spotted by admins (e.g. a worker who repeatedly ends
 * and reopens may need coaching on Pause vs End).
 *
 * Refused once the same-day edit window has closed — past the approval
 * cutoff the worker can't self-correct anymore; an admin must adjust.
 * Refused if the workday has been approved (approved records are
 * final). A row that was never ended falls through as a no-op summary
 * so the caller can invoke this idempotently from a UI that's not sure
 * of the current state.
 */
export async function reopenWorkday(
  userId: string,
  audit: AuditContext,
): Promise<WorkdaySummary> {
  const today = todayEt();
  const row = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate: today } },
  });
  if (!row) {
    throw new ServiceError("NOT_FOUND", "No workday for today.", 404);
  }
  if (!row.endedAt) {
    // Already running — nothing to undo.
    return summarize(row);
  }
  if (row.approvedAt) {
    throw new ServiceError(
      "INVALID_STATE",
      "Workday has been approved and can no longer be reopened.",
      409,
    );
  }
  if (await isApprovalWindowOpen(row.workdayDate)) {
    throw new ServiceError(
      "OUT_OF_WINDOW",
      "Edit window has passed — ask an admin to reopen this workday.",
      409,
    );
  }

  const now = new Date();
  // Time between the bad ending and now becomes pause time: the worker
  // wasn't actively working in that gap, so it shouldn't accrue
  // payable hours. Clamp to 0 in the unlikely case endedAt is in the
  // future (e.g. weird admin edit).
  const gapMs = Math.max(0, now.getTime() - row.endedAt.getTime());

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: {
        endedAt: null,
        totalPausedMs: row.totalPausedMs + gapMs,
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.UPDATED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      action: "reopen",
      previousEndedAt: row.endedAt!.toISOString(),
      gapMsAddedToPause: gapMs,
      ...impersonationDetail(audit, userId),
    });
    return updatedRow;
  });
  return summarize(updated);
}

export async function resumeWorkday(
  userId: string,
  audit: AuditContext,
): Promise<WorkdaySummary> {
  const today = todayEt();
  const row = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate: today } },
  });
  if (!row) {
    throw new ServiceError("NOT_FOUND", "No workday in progress.", 409);
  }
  if (row.endedAt) {
    throw new ServiceError("INVALID_STATE", "Workday is already ended.", 409);
  }
  if (!row.pausedAt) {
    return summarize(row);
  }

  const now = new Date();
  const closedSegmentMs = Math.max(0, now.getTime() - row.pausedAt.getTime());

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: {
        pausedAt: null,
        totalPausedMs: row.totalPausedMs + closedSegmentMs,
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.UPDATED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      action: "resume",
      closedSegmentMs,
      ...impersonationDetail(audit, userId),
    });
    return updatedRow;
  });
  return summarize(updated);
}

/**
 * Cancel today's workday — hard-deletes the row. Used by the worker UI
 * when the worker realizes they tapped Start by mistake (e.g. clearing
 * notifications, fat-fingered the button). Refuses if the workday is
 * already COMPLETED — finished days are real records; the worker has
 * the Edit dialog for time corrections instead.
 *
 * The audit detail preserves what the deleted row looked like so admins
 * can spot patterns (e.g. a worker who cancels and restarts repeatedly).
 */
export async function cancelWorkday(
  userId: string,
  audit: AuditContext,
): Promise<{ cancelled: true }> {
  const today = todayEt();
  const row = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate: today } },
  });
  if (!row) {
    throw new ServiceError("NOT_FOUND", "No workday to cancel.", 409);
  }
  if (row.endedAt) {
    throw new ServiceError(
      "INVALID_STATE",
      "Workday is already ended — use Edit times to correct the recorded times.",
      409,
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.workerWorkday.delete({ where: { id: row.id } });
    await writeAudit(tx, AUDIT.WORKDAY.DELETED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      workdayDate: row.workdayDate,
      action: "cancel",
      // Preserve the deleted shape — useful for spotting abuse patterns
      // or for restoring a row if the cancel was itself a mistake.
      deletedRow: {
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt ? row.endedAt.toISOString() : null,
        pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
        totalPausedMs: row.totalPausedMs,
      },
      ...impersonationDetail(audit, userId),
    });
  });
  return { cancelled: true };
}

type EndInput = {
  workdayId?: string | null; // optional — defaults to today's row; pass to end a prior open row
  startedAt?: string | null;
  endedAt?: string | null;
  totalPausedMs?: number | null;
};

/**
 * End a workday. Closes any currently-open pause segment, validates the
 * times, writes the audit row. By default operates on today's row; pass
 * `workdayId` to close out a prior unfinished workday (the "you forgot to
 * end yesterday" path).
 *
 * `startedAt` is editable so the End dialog can correct mistakes
 * (matches the job hours-review pattern). The end-of-day floor is
 * the row's `workdayDate` midnight; the ceiling is `now + skew`.
 */
export async function endWorkday(
  userId: string,
  input: EndInput,
  audit: AuditContext,
): Promise<WorkdaySummary> {
  const row = input.workdayId
    ? await prisma.workerWorkday.findUnique({ where: { id: input.workdayId } })
    : await prisma.workerWorkday.findUnique({
        where: { userId_workdayDate: { userId, workdayDate: todayEt() } },
      });
  if (!row) {
    throw new ServiceError("NOT_FOUND", "Workday not found.", 404);
  }
  if (row.userId !== userId) {
    // Defense against caller passing someone else's workdayId.
    throw new ServiceError("FORBIDDEN", "Not your workday.", 403);
  }
  if (row.endedAt) {
    throw new ServiceError("INVALID_STATE", "Workday is already ended.", 409);
  }

  const now = new Date();
  const startedAt = input.startedAt ? new Date(input.startedAt) : row.startedAt;
  const endedAt = input.endedAt ? new Date(input.endedAt) : now;

  // Validate windows. startedAt floor is the workdayDate midnight (worker
  // can't shift to a different day). endedAt floor is the new startedAt;
  // ceiling is now + skew (no future-dated ends).
  assertInWindow(startedAt, "startedAt", dayMidnightEt(row.workdayDate), now);
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw new ServiceError("OUT_OF_RANGE", "End time must be after start time.", 400);
  }
  if (endedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    throw new ServiceError("OUT_OF_RANGE", "End time can't be in the future.", 400);
  }

  // Close any open pause segment first so the resulting total is
  // self-consistent. If the worker supplied an explicit totalPausedMs in
  // the End dialog, that wins (matches the job hours-review behavior:
  // operator can hand-edit the paused-minutes field). Otherwise we
  // accumulate the live open segment automatically.
  let totalPausedMs = input.totalPausedMs != null ? input.totalPausedMs : row.totalPausedMs;
  if (input.totalPausedMs == null && row.pausedAt) {
    totalPausedMs += Math.max(0, endedAt.getTime() - row.pausedAt.getTime());
  }
  if (totalPausedMs < 0) {
    throw new ServiceError("OUT_OF_RANGE", "Pause total can't be negative.", 400);
  }
  const elapsedMs = endedAt.getTime() - startedAt.getTime();
  if (totalPausedMs > elapsedMs) {
    throw new ServiceError(
      "OUT_OF_RANGE",
      "Pause total can't exceed the elapsed workday duration.",
      400,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: {
        startedAt,
        endedAt,
        totalPausedMs,
        pausedAt: null,
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.COMPLETED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      workdayDate: row.workdayDate,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      totalPausedMs,
      ...impersonationDetail(audit, userId),
    });
    return updatedRow;
  });
  return summarize(updated);
}

type EditInput = {
  startedAt?: string | null;
  endedAt?: string | null;
  totalPausedMs?: number | null;
};

/**
 * Worker post-end correction. The edit window is open while we're still
 * inside the cutoff buffer (WORKDAY_APPROVAL_CUTOFF_HOUR_ET — default 4
 * AM ET the next morning). Once the buffer passes, the admin/super
 * approval lane takes over and the worker can't silently retroactively
 * change their record.
 *
 * Separate audit row from the original COMPLETED event so an admin can
 * see exactly what changed when they're reviewing.
 */
export async function editWorkdayTimes(
  userId: string,
  workdayId: string,
  input: EditInput,
  audit: AuditContext,
): Promise<WorkdaySummary> {
  const row = await prisma.workerWorkday.findUnique({ where: { id: workdayId } });
  if (!row) throw new ServiceError("NOT_FOUND", "Workday not found.", 404);
  if (row.userId !== userId) throw new ServiceError("FORBIDDEN", "Not your workday.", 403);
  if (!row.endedAt) {
    throw new ServiceError("INVALID_STATE", "Workday must be ended before editing times.", 409);
  }
  // Edit window closes at the approval cutoff (default 4 AM next morning
  // ET, configurable via setting). Symmetric with the admin approval
  // window opening — see approvalOpensAt.
  if (await isApprovalWindowOpen(row.workdayDate)) {
    throw new ServiceError(
      "OUT_OF_WINDOW",
      "Edit window has passed — ask an admin to adjust this workday.",
      409,
    );
  }

  const now = new Date();
  const startedAt = input.startedAt ? new Date(input.startedAt) : row.startedAt;
  const endedAt = input.endedAt ? new Date(input.endedAt) : row.endedAt!;
  const totalPausedMs = input.totalPausedMs != null ? input.totalPausedMs : row.totalPausedMs;

  assertInWindow(startedAt, "startedAt", dayMidnightEt(row.workdayDate), now);
  // Edits allow endedAt up to end-of-day for the workdayDate (covers the
  // legitimate "ended at 11:50 PM, fixing the recorded time after midnight"
  // case — but only while the same-day window is still open).
  assertInWindow(endedAt, "endedAt", startedAt, dayEndEt(row.workdayDate));
  if (endedAt.getTime() <= startedAt.getTime()) {
    throw new ServiceError("OUT_OF_RANGE", "End time must be after start time.", 400);
  }
  if (totalPausedMs < 0 || totalPausedMs > endedAt.getTime() - startedAt.getTime()) {
    throw new ServiceError("OUT_OF_RANGE", "Pause total out of range.", 400);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: { startedAt, endedAt, totalPausedMs },
    });
    await writeAudit(tx, AUDIT.WORKDAY.UPDATED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      workdayDate: row.workdayDate,
      action: "edit",
      before: {
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt!.toISOString(),
        totalPausedMs: row.totalPausedMs,
      },
      after: {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        totalPausedMs,
      },
      ...impersonationDetail(audit, userId),
    });
    return updatedRow;
  });
  return summarize(updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Super-side workday administration — approval queue, edits, bulk
// approve, unapprove.
//
// All functions in this block are gated at the route layer by superGuard
// (or whatever permission you configure). They never touch worker-side
// validation (`isApprovalWindowOpen`) because that's a worker-edit-window
// concept — Super can edit any prior-day row at any time.
//
// Today's workdays are intentionally accessible (Super can browse to see
// who's clocked in), but the routes refuse to mutate them — the 4 AM rule
// applies to admin actions too. Enforced via `assertAdminActionAllowed`.
// ─────────────────────────────────────────────────────────────────────────────

function assertAdminActionAllowed(workdayDate: string, isOpenWindow: boolean): void {
  if (!isOpenWindow) {
    throw new ServiceError(
      "ADMIN_WINDOW_CLOSED",
      "Approval window is not open for this workday yet.",
      409,
    );
  }
  void workdayDate; // referenced for future per-day overrides
}

export type SuperWorkdayRow = WorkdaySummary & {
  user: {
    id: string;
    displayName: string | null;
    email: string | null;
    workerType: string | null;
  };
  approvedBy: { id: string; displayName: string | null; email: string | null } | null;
  // Derived UI state, computed server-side so the client doesn't re-derive.
  uiState: "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "APPROVED";
  // True when the worker never ended this row (open prior). The unified
  // Review dialog uses this to surface the "set an end time" banner.
  isOpen: boolean;
  // True when the admin/super approval window is open for this row's
  // workdayDate. When false the UI disables Review / Approve / Unapprove.
  adminWindowOpen: boolean;
};

function deriveUiState(row: WorkerWorkday): SuperWorkdayRow["uiState"] {
  if (row.endedAt && row.approvedAt) return "APPROVED";
  if (row.endedAt) return "COMPLETED";
  if (row.pausedAt) return "PAUSED";
  return "IN_PROGRESS";
}

/**
 * One day's worth of workday rows, grouped for the Super tab. Returns
 * EVERY user who has ever had a workday (per the loose "DIDN'T WORK"
 * rule) — those without a row on the selected day surface as DIDN'T WORK.
 *
 * Sort within each group: by user display name, then email.
 */
export async function superListWorkdaysForDate(workdayDate: string): Promise<{
  workdayDate: string;
  adminWindowOpen: boolean;
  rows: SuperWorkdayRow[];
  didntWork: { userId: string; displayName: string | null; email: string | null; workerType: string | null }[];
}> {
  const adminWindowOpen = await isApprovalWindowOpen(workdayDate);

  // Pull workdays for the day + the approver join + the worker join, all
  // in one round-trip. Approver join is `approvedById` → User; orderly
  // null when not approved.
  const rows = await prisma.workerWorkday.findMany({
    where: { workdayDate },
    include: {
      user: { select: { id: true, displayName: true, email: true, workerType: true } },
      approvedBy: { select: { id: true, displayName: true, email: true } },
    },
    orderBy: [{ userId: "asc" }],
  });
  const rowsByUserId = new Map(rows.map((r) => [r.userId, r]));

  // "DIDN'T WORK" — every approved worker (workerType set, isApproved)
  // who doesn't have a row on the selected day. Loose semantics: we
  // don't filter out new hires (they appear immediately so the operator
  // can backfill a first-day shift) or departed workers (admin manually
  // archives the User when they leave). Operator handles the edge cases
  // mentally.
  //
  // Previously the eligibility set was derived from `workerWorkday`
  // history (≥1 prior workday) which silently excluded brand-new
  // trainees — making backfill impossible for their first shift. Anchor
  // on the User table instead so first-time workers show up immediately.
  const eligibleWorkers = await prisma.user.findMany({
    where: {
      workerType: { not: null },
      isApproved: true,
    },
    select: { id: true, displayName: true, email: true, workerType: true },
  });
  const didntWorkUsers = eligibleWorkers.filter((u) => !rowsByUserId.has(u.id));
  didntWorkUsers.sort((a, b) =>
    (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? ""),
  );

  const superRows: SuperWorkdayRow[] = rows.map((r) => ({
    ...summarize(r),
    user: r.user,
    approvedBy: r.approvedBy,
    uiState: deriveUiState(r),
    isOpen: r.endedAt == null,
    adminWindowOpen,
  }));
  superRows.sort((a, b) =>
    (a.user.displayName ?? a.user.email ?? "").localeCompare(b.user.displayName ?? b.user.email ?? ""),
  );

  return {
    workdayDate,
    adminWindowOpen,
    rows: superRows,
    didntWork: didntWorkUsers.map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      email: u.email,
      workerType: u.workerType,
    })),
  };
}

/**
 * Validation common to every Super-side edit. Returns the row when ok,
 * throws otherwise. `requireOpenWindow` defaults to true; pass false from
 * read-only paths (none currently — included for future flexibility).
 */
async function loadSuperWorkday(
  workdayId: string,
  opts: { requireOpenWindow?: boolean } = {},
): Promise<WorkerWorkday> {
  const row = await prisma.workerWorkday.findUnique({ where: { id: workdayId } });
  if (!row) throw new ServiceError("NOT_FOUND", "Workday not found.", 404);
  const open = await isApprovalWindowOpen(row.workdayDate);
  if (opts.requireOpenWindow !== false) assertAdminActionAllowed(row.workdayDate, open);
  return row;
}

type SuperEditInput = {
  startedAt?: string | null;
  endedAt?: string | null;
  totalPausedMs?: number | null;
  // Super-only opt-in bypass for the 4 AM ET cutoff. Required by the
  // Workdays tab when an operator approves a same-day workday before the
  // approval window opens (e.g. workers finished early and the operator
  // wants to clear the queue before tomorrow). The route layer surfaces
  // a double-confirm; the bypass is recorded in the audit metadata so
  // the override is traceable.
  allowSameDay?: boolean;
};

/**
 * Edit any time field on a prior-day workday. Works for open rows (sets
 * `endedAt` for the first time → force-end), pending rows (adjusts
 * recorded times), and approved rows (silently changes the approved row
 * — re-approval not required, audit log captures the change).
 *
 * Re-validates the same invariants the worker End path enforces:
 *   • startedAt ≥ workdayDate ET-midnight (and ≤ now + skew)
 *   • endedAt > startedAt (and ≤ now + skew)
 *   • totalPausedMs ∈ [0, endedAt − startedAt]
 */
export async function superEditWorkdayTimes(
  workdayId: string,
  input: SuperEditInput,
  audit: AuditContext,
): Promise<SuperWorkdayRow> {
  const row = await loadSuperWorkday(workdayId, { requireOpenWindow: !input.allowSameDay });
  const now = new Date();
  const startedAt = input.startedAt ? new Date(input.startedAt) : row.startedAt;
  // endedAt: if input supplied use it; else keep existing if any; else null
  // (we don't fabricate an end time when one isn't supplied for an open row).
  const endedAt = input.endedAt
    ? new Date(input.endedAt)
    : row.endedAt;
  const wasOpen = row.endedAt == null;
  const isStillOpen = endedAt == null;

  assertInWindow(startedAt, "startedAt", dayMidnightEt(row.workdayDate), now);
  if (endedAt) {
    if (endedAt.getTime() <= startedAt.getTime()) {
      throw new ServiceError("OUT_OF_RANGE", "End time must be after start time.", 400);
    }
    // Super can record an end time up to the end of the workdayDate (covers
    // late-night work) — `dayEndEt` floors at next midnight ET. Clock skew
    // tolerance handles the live "now" case.
    const ceiling = Math.max(now.getTime() + CLOCK_SKEW_MS, dayEndEt(row.workdayDate).getTime());
    if (endedAt.getTime() > ceiling) {
      throw new ServiceError("OUT_OF_RANGE", "End time is past the workday's end-of-day window.", 400);
    }
  }
  let totalPausedMs = input.totalPausedMs != null ? input.totalPausedMs : row.totalPausedMs;
  // Close any open pause segment if Super is setting endedAt for the
  // first time AND didn't override totalPausedMs explicitly.
  if (input.totalPausedMs == null && wasOpen && endedAt && row.pausedAt) {
    totalPausedMs += Math.max(0, endedAt.getTime() - row.pausedAt.getTime());
  }
  if (totalPausedMs < 0) {
    throw new ServiceError("OUT_OF_RANGE", "Pause total can't be negative.", 400);
  }
  if (endedAt) {
    const elapsedMs = endedAt.getTime() - startedAt.getTime();
    if (totalPausedMs > elapsedMs) {
      throw new ServiceError(
        "OUT_OF_RANGE",
        "Pause total can't exceed the elapsed workday duration.",
        400,
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: {
        startedAt,
        endedAt,
        totalPausedMs,
        // Clear the open pause segment when we're closing the row.
        pausedAt: endedAt ? null : row.pausedAt,
      },
      include: {
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.UPDATED, audit.actorId, {
      workdayId: row.id,
      workerId: row.userId,
      workdayDate: row.workdayDate,
      action: wasOpen && endedAt ? "super-force-end" : "super-edit",
      before: {
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt ? row.endedAt.toISOString() : null,
        totalPausedMs: row.totalPausedMs,
      },
      after: {
        startedAt: startedAt.toISOString(),
        endedAt: endedAt ? endedAt.toISOString() : null,
        totalPausedMs,
      },
      ...(input.allowSameDay ? { sameDayBypass: true } : {}),
      ...impersonationDetail(audit, row.userId),
    });
    return updatedRow;
  });
  return {
    ...summarize(updated),
    user: updated.user,
    approvedBy: updated.approvedBy,
    uiState: deriveUiState(updated),
    isOpen: updated.endedAt == null,
    adminWindowOpen: true,
  };
  // (Unused, but kept for symmetry with read paths.) Suppress lint if
  // `isStillOpen` is reported unused — it's referenced by the audit
  // detail discriminator above.
  void isStillOpen;
}

/**
 * Approve a workday. Optionally edits the times in the same call (the
 * Review dialog's "edit + approve" path). Refuses if the row is still
 * open (endedAt = null) — approver must close it first via
 * superEditWorkdayTimes with an endedAt value (or via the same dialog
 * filling in End).
 */
export async function superApproveWorkday(
  workdayId: string,
  input: SuperEditInput,
  audit: AuditContext,
): Promise<SuperWorkdayRow> {
  // If the caller passed any edits, run those through superEditWorkdayTimes
  // first so the validation lives in one place.
  if (input.startedAt != null || input.endedAt != null || input.totalPausedMs != null) {
    await superEditWorkdayTimes(workdayId, input, audit);
  }

  const row = await loadSuperWorkday(workdayId, { requireOpenWindow: !input.allowSameDay });
  if (!row.endedAt) {
    throw new ServiceError(
      "NOT_CLOSED",
      "Workday must be ended before it can be approved. Set an end time first.",
      409,
    );
  }
  if (row.approvedAt) {
    // Idempotent — already approved, just return current state.
    const fresh = await prisma.workerWorkday.findUnique({
      where: { id: workdayId },
      include: {
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return {
      ...summarize(fresh!),
      user: fresh!.user,
      approvedBy: fresh!.approvedBy,
      uiState: deriveUiState(fresh!),
      isOpen: false,
      adminWindowOpen: true,
    };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: {
        approvedAt: new Date(),
        approvedById: audit.actorId,
      },
      include: {
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.APPROVED, audit.actorId, {
      workdayId: row.id,
      workerId: row.userId,
      workdayDate: row.workdayDate,
      ...(input.allowSameDay ? { sameDayBypass: true } : {}),
      ...impersonationDetail(audit, row.userId),
    });
    return updatedRow;
  });
  return {
    ...summarize(updated),
    user: updated.user,
    approvedBy: updated.approvedBy,
    uiState: deriveUiState(updated),
    isOpen: false,
    adminWindowOpen: true,
  };
}

/**
 * Reverse a prior approval. Clears `approvedAt` + `approvedById`. Row
 * drops back into PENDING APPROVAL. Audited.
 */
export async function superUnapproveWorkday(
  workdayId: string,
  audit: AuditContext,
): Promise<SuperWorkdayRow> {
  const row = await loadSuperWorkday(workdayId);
  if (!row.approvedAt) {
    throw new ServiceError("INVALID_STATE", "Workday is not approved.", 409);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const updatedRow = await tx.workerWorkday.update({
      where: { id: row.id },
      data: { approvedAt: null, approvedById: null },
      include: {
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.UPDATED, audit.actorId, {
      workdayId: row.id,
      workerId: row.userId,
      workdayDate: row.workdayDate,
      action: "super-unapprove",
      previousApprovedAt: row.approvedAt!.toISOString(),
      previousApprovedById: row.approvedById,
      ...impersonationDetail(audit, row.userId),
    });
    return updatedRow;
  });
  return {
    ...summarize(updated),
    user: updated.user,
    approvedBy: updated.approvedBy,
    uiState: deriveUiState(updated),
    isOpen: false,
    adminWindowOpen: true,
  };
}

/**
 * Backfill a workday for a worker who forgot to start one. Used by the
 * Super → Workdays tab's "Didn't work" section: when the operator
 * notices a worker missed their clock-in, they can retroactively
 * create the row with start / end / paused-minutes.
 *
 * Constraints:
 *   • `workdayDate` must be today or earlier — can't create future rows
 *   • Refuses if a row already exists for (userId, workdayDate) — use
 *     superEditWorkdayTimes for those
 *   • Same time-window validation as the worker End path
 *   • Records the backfill in the audit log with `action: "super-create"`
 *     so the trail makes it obvious this wasn't a worker-initiated row
 *
 * NOT subject to the approval-window cutoff — Super needs to be able
 * to fix gaps even on the same day. The created row lands in PENDING
 * APPROVAL until Super approves it.
 */
export async function superCreateWorkday(
  userId: string,
  workdayDate: string,
  input: {
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  },
  audit: AuditContext,
): Promise<SuperWorkdayRow> {
  // Future-date guard. workdayDate is ET YYYY-MM-DD; lexicographic
  // comparison against todayEt() is correct for that format.
  if (workdayDate > todayEt()) {
    throw new ServiceError(
      "OUT_OF_RANGE",
      "Can't create a workday for a future date.",
      400,
    );
  }
  // Duplicate guard. The unique constraint would catch this too, but
  // an explicit check returns a useful error instead of a raw Prisma
  // collision.
  const existing = await prisma.workerWorkday.findUnique({
    where: { userId_workdayDate: { userId, workdayDate } },
  });
  if (existing) {
    throw new ServiceError(
      "CONFLICT",
      "A workday already exists for this worker on this date — edit it instead.",
      409,
    );
  }
  // Verify the worker exists before writing — better error than an FK
  // violation if the operator passed a stale userId.
  const worker = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!worker) throw new ServiceError("NOT_FOUND", "Worker not found.", 404);

  const now = new Date();
  const startedAt = input.startedAt ? new Date(input.startedAt) : null;
  const endedAt = input.endedAt ? new Date(input.endedAt) : null;
  const totalPausedMs = input.totalPausedMs ?? 0;

  if (!startedAt) {
    throw new ServiceError("INVALID_INPUT", "Start time is required.", 400);
  }
  assertInWindow(startedAt, "startedAt", dayMidnightEt(workdayDate), now);
  if (endedAt) {
    if (endedAt.getTime() <= startedAt.getTime()) {
      throw new ServiceError("OUT_OF_RANGE", "End time must be after start time.", 400);
    }
    const ceiling = Math.max(now.getTime() + CLOCK_SKEW_MS, dayEndEt(workdayDate).getTime());
    if (endedAt.getTime() > ceiling) {
      throw new ServiceError(
        "OUT_OF_RANGE",
        "End time is past the workday's end-of-day window.",
        400,
      );
    }
  }
  if (totalPausedMs < 0) {
    throw new ServiceError("OUT_OF_RANGE", "Pause total can't be negative.", 400);
  }
  if (endedAt) {
    const elapsedMs = endedAt.getTime() - startedAt.getTime();
    if (totalPausedMs > elapsedMs) {
      throw new ServiceError(
        "OUT_OF_RANGE",
        "Pause total can't exceed the elapsed workday duration.",
        400,
      );
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.workerWorkday.create({
      data: {
        userId,
        workdayDate,
        startedAt,
        endedAt,
        totalPausedMs,
      },
      include: {
        user: { select: { id: true, displayName: true, email: true, workerType: true } },
        approvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.WORKDAY.CREATED, audit.actorId, {
      workdayId: row.id,
      workerId: userId,
      workdayDate,
      action: "super-create",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt ? endedAt.toISOString() : null,
      totalPausedMs,
      ...impersonationDetail(audit, userId),
    });
    return row;
  });
  const windowOpen = await isApprovalWindowOpen(workdayDate);
  return {
    ...summarize(created),
    user: created.user,
    approvedBy: created.approvedBy,
    uiState: deriveUiState(created),
    isOpen: created.endedAt == null,
    adminWindowOpen: windowOpen,
  };
}

/**
 * Bulk approve N pending workdays in one call. Each row is processed
 * independently — one failure doesn't roll back the others. The return
 * value tells the UI which ids succeeded and which failed (and why).
 *
 * Per-row policy:
 *   • Already-approved → counted under `alreadyApproved` (idempotent skip)
 *   • Open (endedAt = null) → counted under `failed` with a clear reason
 *   • Admin window closed → counted under `failed`
 *   • Otherwise → approved with the row's current times (no edits)
 */
export async function superBulkApprove(
  workdayIds: string[],
  audit: AuditContext,
  opts: { allowSameDay?: boolean } = {},
): Promise<{
  approved: string[];
  alreadyApproved: string[];
  failed: { id: string; reason: string }[];
}> {
  const approved: string[] = [];
  const alreadyApproved: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const id of workdayIds) {
    try {
      const row = await prisma.workerWorkday.findUnique({ where: { id } });
      if (!row) {
        failed.push({ id, reason: "Workday not found." });
        continue;
      }
      if (row.approvedAt) {
        alreadyApproved.push(id);
        continue;
      }
      if (!row.endedAt) {
        failed.push({ id, reason: "Workday must be ended before it can be approved." });
        continue;
      }
      const windowOpen = await isApprovalWindowOpen(row.workdayDate);
      if (!windowOpen && !opts.allowSameDay) {
        failed.push({ id, reason: "Approval window is not open yet." });
        continue;
      }
      const sameDayBypass = !windowOpen && !!opts.allowSameDay;
      await prisma.$transaction(async (tx) => {
        await tx.workerWorkday.update({
          where: { id: row.id },
          data: { approvedAt: new Date(), approvedById: audit.actorId },
        });
        await writeAudit(tx, AUDIT.WORKDAY.APPROVED, audit.actorId, {
          workdayId: row.id,
          workerId: row.userId,
          workdayDate: row.workdayDate,
          bulk: true,
          ...(sameDayBypass ? { sameDayBypass: true } : {}),
          ...impersonationDetail(audit, row.userId),
        });
      });
      approved.push(id);
    } catch (err: any) {
      failed.push({ id, reason: err?.message ?? "Approval failed." });
    }
  }
  return { approved, alreadyApproved, failed };
}

/**
 * Pending-approvals summary for the Super alert badge + the in-tab chip
 * row. Counts COMPLETED workdays whose `workdayDate < today (ET)` and
 * whose `approvedAt` is null. Today's rows are intentionally excluded —
 * they're either still in the worker's edit window OR the cutoff hasn't
 * passed yet (the badge means "actionable right now").
 *
 * Returns totals + a per-day breakdown sorted oldest → newest, so the
 * chip row can render in chronological order.
 *
 * NEEDS_ENDING rows (workdayDate in the past, endedAt null) are NOT
 * counted — they aren't approvable yet (Super has to force-end them
 * first). Different bucket, different action.
 */
export async function superPendingApprovalsSummary(): Promise<{
  totalPending: number;
  byDate: { workdayDate: string; count: number }[];
}> {
  const today = todayEt();
  const rows = await prisma.workerWorkday.findMany({
    where: {
      endedAt: { not: null },
      approvedAt: null,
      workdayDate: { lt: today },
    },
    select: { workdayDate: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.workdayDate, (counts.get(r.workdayDate) ?? 0) + 1);
  }
  const byDate = Array.from(counts.entries())
    .map(([workdayDate, count]) => ({ workdayDate, count }))
    .sort((a, b) => a.workdayDate.localeCompare(b.workdayDate));
  return { totalPending: rows.length, byDate };
}
