// ─────────────────────────────────────────────────────────────────────────────
// Business-mileage tracking.
//
// A MileageEntry is one "start driving → stop driving" session against
// a vehicle. Multiple entries per day per vehicle allowed. `entryDate`
// is the ET calendar date of `startedAt` — the anchor for the daily
// Super approval queue.
//
// Session lifecycle:
//   1. Driver taps Start   → createEntry(startOdometer, startedAt)
//                            Row is "open" (endedAt = null).
//   2. Driver taps Stop    → finalizeEntry(endOdometer, endedAt, notes)
//                            Miles derived. Row becomes closed.
//   3. Super approves      → approveEntry / approveWorkerDay
//                            approvedAt set. Row locked from driver
//                            edits; Super can still edit.
//
// Only one open entry per (driverUserId, vehicleId) at a time. Trying
// to start a second open entry throws — driver must stop the first.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../db/prisma";
import { etFormatDate, etToday } from "../lib/dates";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

const DEFAULT_NOTE = "Using vehicle to service lawns";
// When a worker Stops and Starts back on the same vehicle within
// this window AND enters the same odometer reading as their last
// Stop, we treat the new Start as a continuation of the previous
// session (reopen it) rather than creating a new row. Keeps a day
// of stop-at-every-job fragmentation from turning into 10 review
// rows when the intent was one continuous route. The exact-odometer
// requirement makes this a "hey I forgot to keep the session
// running" detector, not a general merge.
const CONTINUATION_WINDOW_MINUTES = 30;

/** Currently-open entry for this user + vehicle, if any. */
export async function getOpenEntryForUserVehicle(
  userId: string,
  vehicleId: string,
) {
  return prisma.mileageEntry.findFirst({
    where: {
      driverUserId: userId,
      vehicleId,
      endedAt: null,
    },
    orderBy: { startedAt: "desc" },
  });
}

/** All currently-open entries the user has (across any vehicles they're
 *  assigned to). Used by the MileageStrip to decide "resume-open" vs
 *  "start-new". */
export async function listOpenEntriesForUser(userId: string) {
  return prisma.mileageEntry.findMany({
    where: { driverUserId: userId, endedAt: null },
    include: { vehicle: true },
    orderBy: { startedAt: "desc" },
  });
}

/** Start a new business-mileage session. Rejects if the driver already
 *  has an open entry on this vehicle. Smart-merge: if the driver's
 *  last closed session on this vehicle ended within
 *  CONTINUATION_WINDOW_MINUTES at the same odometer reading, reopens
 *  that session (endedAt/endOdometer/miles cleared) instead of
 *  creating a new row — so a worker who stops between jobs and starts
 *  right back doesn't fragment their day into a dozen rows. */
export async function startEntry(params: {
  vehicleId: string;
  driverUserId: string;
  startOdometer: number;
  startedAt?: Date;
}) {
  const startedAt = params.startedAt ?? new Date();
  if (!Number.isFinite(params.startOdometer) || params.startOdometer < 0) {
    throw new Error("startOdometer must be a non-negative number");
  }
  const existingOpen = await getOpenEntryForUserVehicle(
    params.driverUserId,
    params.vehicleId,
  );
  if (existingOpen) {
    throw new Error(
      "There's already an open mileage entry for this vehicle. Stop it first.",
    );
  }
  // Continuation detection — see CONTINUATION_WINDOW_MINUTES for the
  // rationale. Skips already-approved entries; those are audit-locked.
  const lastClosed = await prisma.mileageEntry.findFirst({
    where: {
      driverUserId: params.driverUserId,
      vehicleId: params.vehicleId,
      endedAt: { not: null },
      approvedAt: null,
    },
    orderBy: { endedAt: "desc" },
  });
  if (lastClosed && lastClosed.endedAt) {
    const gapMs = startedAt.getTime() - lastClosed.endedAt.getTime();
    const withinWindow =
      gapMs >= 0 && gapMs <= CONTINUATION_WINDOW_MINUTES * 60 * 1000;
    const sameOdometer =
      lastClosed.endOdometer != null &&
      lastClosed.endOdometer === params.startOdometer;
    if (withinWindow && sameOdometer) {
      // Continuation: reopen the previous entry. The eventual Stop
      // will recompute miles from the original startOdometer to the
      // final endOdometer, so nothing is lost.
      return prisma.$transaction(async (tx) => {
        const reopened = await tx.mileageEntry.update({
          where: { id: lastClosed.id },
          data: {
            endedAt: null,
            endOdometer: null,
            miles: null,
          },
        });
        // A reopen silently destroys an already-computed `miles` figure
        // — the deductible number the entry carried a second ago. The
        // row itself keeps no trace of that, so the audit metadata is
        // the only place the discarded close survives.
        await writeAudit(tx, AUDIT.MILEAGE.CREATED, params.driverUserId, {
          mileageEntryId: reopened.id,
          vehicleId: reopened.vehicleId,
          driverUserId: reopened.driverUserId,
          entryDate: reopened.entryDate,
          reopenedContinuation: true,
          startedAt: reopened.startedAt,
          startOdometer: reopened.startOdometer,
          clearedEndedAt: lastClosed.endedAt,
          clearedEndOdometer: lastClosed.endOdometer,
          clearedMiles: lastClosed.miles,
        });
        return reopened;
      });
    }
  }
  return prisma.$transaction(async (tx) => {
    const created = await tx.mileageEntry.create({
      data: {
        vehicleId: params.vehicleId,
        driverUserId: params.driverUserId,
        entryDate: etFormatDate(startedAt),
        startedAt,
        startOdometer: params.startOdometer,
      },
    });
    // Miles are a tax deduction and a reimbursement basis, so a session
    // needs provenance from the moment it opens — not just when it
    // closes with a number attached.
    await writeAudit(tx, AUDIT.MILEAGE.CREATED, params.driverUserId, {
      mileageEntryId: created.id,
      vehicleId: created.vehicleId,
      driverUserId: created.driverUserId,
      entryDate: created.entryDate,
      reopenedContinuation: false,
      startedAt: created.startedAt,
      startOdometer: created.startOdometer,
    });
    return created;
  });
}

/** Close an open entry. Computes miles = endOdometer − startOdometer
 *  and updates the vehicle's cached currentOdometer. */
export async function finalizeEntry(params: {
  entryId: string;
  endOdometer: number;
  endedAt?: Date;
  notes?: string | null;
  /** Who tapped Stop. Defaults to the entry's own driver — the worker
   *  route verifies ownership before calling. Pass explicitly if an
   *  admin ever closes a session on a worker's behalf. */
  actorUserId?: string;
}) {
  const entry = await prisma.mileageEntry.findUnique({
    where: { id: params.entryId },
  });
  if (!entry) throw new Error("Mileage entry not found.");
  if (entry.endedAt) throw new Error("Entry is already closed.");
  if (!Number.isFinite(params.endOdometer) || params.endOdometer < 0) {
    throw new Error("endOdometer must be a non-negative number");
  }
  if (params.endOdometer < entry.startOdometer) {
    throw new Error(
      `endOdometer (${params.endOdometer}) can't be less than startOdometer (${entry.startOdometer}).`,
    );
  }
  const endedAt = params.endedAt ?? new Date();
  const miles = params.endOdometer - entry.startOdometer;
  // Default the note to the operator-friendly placeholder when blank.
  const notes =
    params.notes == null || params.notes.trim() === "" ? DEFAULT_NOTE : params.notes.trim();

  return prisma.$transaction(async (tx) => {
    const updated = await tx.mileageEntry.update({
      where: { id: entry.id },
      data: {
        endedAt,
        endOdometer: params.endOdometer,
        miles,
        notes,
      },
    });
    // Cache the odometer reading on the vehicle for next-session
    // prefill. Only overwrite when the new reading is at or past the
    // cached value — protects against out-of-order edits (rare, but
    // possible if Super retroactively adjusts an earlier entry).
    await tx.vehicle.updateMany({
      where: {
        id: entry.vehicleId,
        OR: [
          { currentOdometer: null },
          { currentOdometer: { lte: params.endOdometer } },
        ],
      },
      data: { currentOdometer: params.endOdometer },
    });
    // Stop is where `miles` first exists — the figure that flows into
    // the mileage deduction and the worker's reimbursement. Record both
    // odometer endpoints so the derivation can be re-checked later.
    await writeAudit(
      tx,
      AUDIT.MILEAGE.COMPLETED,
      params.actorUserId ?? entry.driverUserId,
      {
        mileageEntryId: updated.id,
        vehicleId: updated.vehicleId,
        driverUserId: updated.driverUserId,
        entryDate: updated.entryDate,
        startedAt: updated.startedAt,
        endedAt: updated.endedAt,
        startOdometer: updated.startOdometer,
        endOdometer: updated.endOdometer,
        miles: updated.miles,
      },
    );
    return updated;
  });
}

/**
 * Super-side create — backfill a closed mileage entry for a worker
 * who forgot to log it in the moment. Same shape a
 * `startEntry → finalizeEntry` pair would produce, but skips the open
 * state entirely and stamps `approvedAt: null` so the row flows
 * through the normal daily-approval queue like any driver-created
 * entry.
 *
 * No worker-assignment check — this is a Super override path. The
 * route layer is Super-guarded; if you want to enforce assignment,
 * add it there.
 */
export async function superCreateMileageEntry(params: {
  vehicleId: string;
  driverUserId: string;
  startedAt: Date;
  endedAt: Date;
  startOdometer: number;
  endOdometer: number;
  notes?: string | null;
  /** The Super doing the backfill. Distinct from driverUserId — the
   *  miles land on the worker's record but somebody else typed them. */
  actorUserId?: string | null;
}) {
  if (!Number.isFinite(params.startOdometer) || params.startOdometer < 0) {
    throw new Error("startOdometer must be a non-negative number");
  }
  if (!Number.isFinite(params.endOdometer) || params.endOdometer < 0) {
    throw new Error("endOdometer must be a non-negative number");
  }
  if (params.endOdometer < params.startOdometer) {
    throw new Error(
      `endOdometer (${params.endOdometer}) can't be less than startOdometer (${params.startOdometer}).`,
    );
  }
  if (params.endedAt.getTime() < params.startedAt.getTime()) {
    throw new Error("endedAt must be at or after startedAt.");
  }
  const miles = params.endOdometer - params.startOdometer;
  const notes =
    params.notes == null || params.notes.trim() === ""
      ? DEFAULT_NOTE
      : params.notes.trim();
  return prisma.$transaction(async (tx) => {
    const created = await tx.mileageEntry.create({
      data: {
        vehicleId: params.vehicleId,
        driverUserId: params.driverUserId,
        entryDate: etFormatDate(params.startedAt),
        startedAt: params.startedAt,
        endedAt: params.endedAt,
        startOdometer: params.startOdometer,
        endOdometer: params.endOdometer,
        miles,
        notes,
      },
    });
    // Advance the vehicle's cached odometer if this entry ended past
    // the current value — same "only forward" rule finalizeEntry
    // uses, so an admin backfill from months ago doesn't rewind the
    // cache.
    await tx.vehicle.updateMany({
      where: {
        id: params.vehicleId,
        OR: [
          { currentOdometer: null },
          { currentOdometer: { lte: params.endOdometer } },
        ],
      },
      data: { currentOdometer: params.endOdometer },
    });
    // Deductible miles invented on someone else's behalf, with no
    // worker action behind them. Both parties go in the metadata so
    // "who claimed these miles?" is answerable.
    await writeAudit(tx, AUDIT.MILEAGE.CREATED, params.actorUserId ?? null, {
      mileageEntryId: created.id,
      vehicleId: created.vehicleId,
      driverUserId: created.driverUserId,
      subjectUserId: created.driverUserId,
      entryDate: created.entryDate,
      superBackfill: true,
      startedAt: created.startedAt,
      endedAt: created.endedAt,
      startOdometer: created.startOdometer,
      endOdometer: created.endOdometer,
      miles: created.miles,
    });
    return created;
  });
}

/** Cancel an open entry without saving miles. Used by the driver when
 *  they tap Start by mistake. */
export async function cancelEntry(entryId: string, actorUserId?: string) {
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  if (entry.endedAt) throw new Error("Can't cancel a closed entry.");
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.mileageEntry.delete({ where: { id: entry.id } });
    // Hard delete — the row is gone, so the snapshot below is the only
    // surviving evidence that a session was ever opened against this
    // vehicle.
    await writeAudit(
      tx,
      AUDIT.MILEAGE.DELETED,
      actorUserId ?? entry.driverUserId,
      {
        mileageEntryId: entry.id,
        vehicleId: entry.vehicleId,
        driverUserId: entry.driverUserId,
        entryDate: entry.entryDate,
        reason: "driver_cancelled_open_entry",
        deletedRow: {
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          startOdometer: entry.startOdometer,
          endOdometer: entry.endOdometer,
          miles: entry.miles,
          notes: entry.notes,
          approvedAt: entry.approvedAt,
        },
      },
    );
    return deleted;
  });
}

/** Driver-side edit — only allowed on entries the driver owns and only
 *  while unapproved. Super uses adminEditEntry for locked-row edits. */
export async function editEntryByDriver(
  entryId: string,
  driverUserId: string,
  patch: { startOdometer?: number; endOdometer?: number; notes?: string | null },
) {
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  if (entry.driverUserId !== driverUserId) {
    throw new Error("You can only edit your own mileage entries.");
  }
  if (entry.approvedAt) {
    throw new Error("Entry has been approved; ask an admin to make changes.");
  }
  return applyEntryPatch(entry.id, patch, driverUserId);
}

/** Super-side edit — overrides even approved entries. Use sparingly. */
export async function adminEditEntry(
  entryId: string,
  patch: {
    startOdometer?: number;
    endOdometer?: number;
    notes?: string | null;
    startedAt?: Date;
    endedAt?: Date | null;
  },
  actorUserId?: string | null,
) {
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  const data: Record<string, any> = await applyEntryPatchData(entry, patch);
  if (patch.startedAt !== undefined) {
    data.startedAt = patch.startedAt;
    data.entryDate = etFormatDate(patch.startedAt);
  }
  if (patch.endedAt !== undefined) {
    data.endedAt = patch.endedAt;
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.mileageEntry.update({
      where: { id: entry.id },
      data,
    });
    // The only path that can rewrite an APPROVED entry — i.e. change a
    // deductible/reimbursable number after it was signed off. Full
    // before/after so the edit is reconstructable at tax time.
    await writeAudit(tx, AUDIT.MILEAGE.ADJUSTED, actorUserId ?? null, {
      mileageEntryId: entry.id,
      vehicleId: entry.vehicleId,
      driverUserId: entry.driverUserId,
      subjectUserId: entry.driverUserId,
      wasApproved: entry.approvedAt != null,
      before: {
        startOdometer: entry.startOdometer,
        endOdometer: entry.endOdometer,
        miles: entry.miles,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        entryDate: entry.entryDate,
        notes: entry.notes,
      },
      after: {
        startOdometer: updated.startOdometer,
        endOdometer: updated.endOdometer,
        miles: updated.miles,
        startedAt: updated.startedAt,
        endedAt: updated.endedAt,
        entryDate: updated.entryDate,
        notes: updated.notes,
      },
    });
    return updated;
  });
}

async function applyEntryPatch(
  entryId: string,
  patch: { startOdometer?: number; endOdometer?: number; notes?: string | null },
  actorUserId: string,
) {
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  const data = await applyEntryPatchData(entry, patch);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.mileageEntry.update({
      where: { id: entry.id },
      data,
    });
    // A driver correcting their own odometers recomputes `miles`, so
    // this is a self-service edit to the number they'll be reimbursed
    // for. Before/after keeps the pre-edit claim visible to review.
    await writeAudit(tx, AUDIT.MILEAGE.UPDATED, actorUserId, {
      mileageEntryId: entry.id,
      vehicleId: entry.vehicleId,
      driverUserId: entry.driverUserId,
      entryDate: entry.entryDate,
      before: {
        startOdometer: entry.startOdometer,
        endOdometer: entry.endOdometer,
        miles: entry.miles,
        notes: entry.notes,
      },
      after: {
        startOdometer: updated.startOdometer,
        endOdometer: updated.endOdometer,
        miles: updated.miles,
        notes: updated.notes,
      },
    });
    return updated;
  });
}

async function applyEntryPatchData(
  entry: { startOdometer: number; endOdometer: number | null },
  patch: { startOdometer?: number; endOdometer?: number; notes?: string | null },
): Promise<Record<string, any>> {
  const data: Record<string, any> = {};
  const nextStart = patch.startOdometer ?? entry.startOdometer;
  const nextEnd = patch.endOdometer ?? entry.endOdometer;
  if (patch.startOdometer !== undefined) {
    if (!Number.isFinite(patch.startOdometer) || patch.startOdometer < 0) {
      throw new Error("startOdometer must be a non-negative number");
    }
    data.startOdometer = patch.startOdometer;
  }
  if (patch.endOdometer !== undefined) {
    if (!Number.isFinite(patch.endOdometer) || patch.endOdometer < 0) {
      throw new Error("endOdometer must be a non-negative number");
    }
    data.endOdometer = patch.endOdometer;
  }
  if (nextEnd != null) {
    if (nextEnd < nextStart) {
      throw new Error(
        `endOdometer (${nextEnd}) can't be less than startOdometer (${nextStart}).`,
      );
    }
    data.miles = nextEnd - nextStart;
  }
  if (patch.notes !== undefined) {
    data.notes =
      patch.notes == null || patch.notes.trim() === "" ? DEFAULT_NOTE : patch.notes.trim();
  }
  return data;
}

/** List entries for a specific driver in a date-key range (inclusive).
 *  Used by the MileageStrip history and by the Super approval queue. */
export async function listEntriesForUser(
  userId: string,
  opts: { fromDate?: string; toDate?: string } = {},
) {
  const where: Record<string, any> = { driverUserId: userId };
  if (opts.fromDate || opts.toDate) {
    where.entryDate = {};
    if (opts.fromDate) where.entryDate.gte = opts.fromDate;
    if (opts.toDate) where.entryDate.lte = opts.toDate;
  }
  return prisma.mileageEntry.findMany({
    where,
    include: {
      vehicle: { select: { id: true, displayName: true } },
    },
    orderBy: [{ entryDate: "desc" }, { startedAt: "desc" }],
  });
}

/** List entries for a specific vehicle in a date range. Admin fleet
 *  view. */
export async function listEntriesForVehicle(
  vehicleId: string,
  opts: { fromDate?: string; toDate?: string } = {},
) {
  const where: Record<string, any> = { vehicleId };
  if (opts.fromDate || opts.toDate) {
    where.entryDate = {};
    if (opts.fromDate) where.entryDate.gte = opts.fromDate;
    if (opts.toDate) where.entryDate.lte = opts.toDate;
  }
  return prisma.mileageEntry.findMany({
    where,
    include: {
      driver: { select: { id: true, displayName: true, email: true } },
      approver: { select: { id: true, displayName: true } },
    },
    orderBy: [{ entryDate: "desc" }, { startedAt: "desc" }],
  });
}

/** Approve a single entry. Idempotent — approving an already-approved
 *  entry is a no-op. */
export async function approveEntry(entryId: string, approverId: string) {
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  if (entry.approvedAt) return entry;
  if (!entry.endedAt) {
    throw new Error("Can't approve an open entry — stop the session first.");
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.mileageEntry.update({
      where: { id: entry.id },
      data: { approvedAt: new Date(), approvedById: approverId },
    });
    // Approval is the sign-off that turns a claim into payable /
    // deductible miles, and it locks the row against driver edits.
    await writeAudit(tx, AUDIT.MILEAGE.APPROVED, approverId, {
      mileageEntryId: updated.id,
      vehicleId: updated.vehicleId,
      driverUserId: updated.driverUserId,
      subjectUserId: updated.driverUserId,
      entryDate: updated.entryDate,
      miles: updated.miles,
      startOdometer: updated.startOdometer,
      endOdometer: updated.endOdometer,
      approvedAt: updated.approvedAt,
    });
    return updated;
  });
}

/** Bulk-approve every closed, unapproved entry for one worker on one
 *  ET calendar day. Called by the unified daily approval flow so the
 *  Super approves hours + mileage in one action. */
export async function approveWorkerDay(
  userId: string,
  entryDate: string,
  approverId: string,
) {
  const now = new Date();
  // Snapshot the target set before the bulk update — afterwards the
  // "unapproved on this date" filter no longer selects these rows, so
  // this is the only chance to name what the batch covered.
  const pending = await prisma.mileageEntry.findMany({
    where: {
      driverUserId: userId,
      entryDate,
      approvedAt: null,
      endedAt: { not: null },
    },
    select: { id: true, miles: true },
  });
  return prisma.$transaction(async (tx) => {
    const result = await tx.mileageEntry.updateMany({
      where: {
        driverUserId: userId,
        entryDate,
        approvedAt: null,
        endedAt: { not: null },
      },
      data: { approvedAt: now, approvedById: approverId },
    });
    // One row for the batch: a bulk sign-off is a single operator
    // decision, but it can move a whole day of deductible miles.
    if (result.count > 0) {
      await writeAudit(tx, AUDIT.MILEAGE.APPROVED, approverId, {
        driverUserId: userId,
        subjectUserId: userId,
        entryDate,
        bulk: true,
        approvedCount: result.count,
        mileageEntryIds: pending.map((e) => e.id),
        totalMiles: pending.reduce((sum, e) => sum + (e.miles ?? 0), 0),
        approvedAt: now,
      });
    }
    return { approvedCount: result.count };
  });
}

/** Reverse an approval — Super only. Unlocks the row for further
 *  edits without deleting the underlying data. */
export async function unapproveEntry(entryId: string, actorUserId?: string | null) {
  // Read first: the update nulls approvedById, so who signed this off
  // is unrecoverable from the row once the write lands.
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  return prisma.$transaction(async (tx) => {
    const updated = await tx.mileageEntry.update({
      where: { id: entry.id },
      data: { approvedAt: null, approvedById: null },
    });
    // Reversing an approval reopens the row for edits and erases the
    // prior approver — preserve both here.
    await writeAudit(tx, AUDIT.MILEAGE.UNAPPROVED, actorUserId ?? null, {
      mileageEntryId: entry.id,
      vehicleId: entry.vehicleId,
      driverUserId: entry.driverUserId,
      subjectUserId: entry.driverUserId,
      entryDate: entry.entryDate,
      miles: entry.miles,
      previousApprovedById: entry.approvedById,
      previousApprovedAt: entry.approvedAt,
    });
    return updated;
  });
}

/** Super-side reject — hard-delete an unapproved entry. Used from the
 *  Review dialog when the operator decides a session is bogus (worker
 *  picked the wrong vehicle and forgot to cancel, junk row, etc.). We
 *  refuse to delete already-approved entries so an approval audit
 *  can't be silently erased; unapprove first, then reject. Symmetric
 *  with the worker's own cancelEntry — same underlying delete, just
 *  gated for the super's use on both open AND closed rows. */
export async function rejectEntry(entryId: string, actorUserId?: string | null) {
  const entry = await prisma.mileageEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new Error("Mileage entry not found.");
  if (entry.approvedAt) {
    throw new Error("Entry is approved — Unapprove it first before rejecting.");
  }
  return prisma.$transaction(async (tx) => {
    const deleted = await tx.mileageEntry.delete({ where: { id: entry.id } });
    // Destructive and unilateral: a worker's logged miles disappear
    // without their involvement. The full destroyed row lives in the
    // metadata so a disputed rejection can be reconstructed.
    await writeAudit(tx, AUDIT.MILEAGE.DELETED, actorUserId ?? null, {
      mileageEntryId: entry.id,
      vehicleId: entry.vehicleId,
      driverUserId: entry.driverUserId,
      subjectUserId: entry.driverUserId,
      entryDate: entry.entryDate,
      reason: "super_rejected_entry",
      deletedRow: {
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        startOdometer: entry.startOdometer,
        endOdometer: entry.endOdometer,
        miles: entry.miles,
        notes: entry.notes,
        approvedAt: entry.approvedAt,
        approvedById: entry.approvedById,
      },
    });
    return deleted;
  });
}

/** Aggregate per-vehicle totals for a date range. Powers the admin
 *  yearly-rollup view. */
export async function vehicleTotalsForRange(
  vehicleId: string,
  fromDate: string,
  toDate: string,
) {
  const rows = await prisma.mileageEntry.findMany({
    where: {
      vehicleId,
      entryDate: { gte: fromDate, lte: toDate },
      endedAt: { not: null },
    },
    select: { miles: true, approvedAt: true },
  });
  const totalMiles = rows.reduce((s, r) => s + (r.miles ?? 0), 0);
  const approvedMiles = rows
    .filter((r) => r.approvedAt != null)
    .reduce((s, r) => s + (r.miles ?? 0), 0);
  return {
    entryCount: rows.length,
    totalMiles,
    approvedMiles,
    unapprovedMiles: totalMiles - approvedMiles,
  };
}

export function todayEntryDate(): string {
  return etToday();
}

/**
 * Pending-approval summary for the Super title-bar alert + Tasks
 * page. Mirrors superPendingApprovalsSummary for workdays: counts
 * closed unapproved entries anchored to past ET calendar dates
 * (today's still-in-progress work is excluded — approval opens
 * after the daily cutoff).
 */
export async function superPendingMileageSummary(): Promise<{
  totalPending: number;
  byDate: { entryDate: string; count: number }[];
}> {
  const today = etToday();
  const rows = await prisma.mileageEntry.findMany({
    where: {
      endedAt: { not: null },
      approvedAt: null,
      entryDate: { lt: today },
    },
    select: { entryDate: true },
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.entryDate, (counts.get(r.entryDate) ?? 0) + 1);
  }
  const byDate = Array.from(counts.entries())
    .map(([entryDate, count]) => ({ entryDate, count }))
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  return { totalPending: rows.length, byDate };
}

/**
 * Per-user mileage entries for a specific ET calendar date. Used by
 * the Super WorkdaysTab + PendingWorkdaysSection so each worker × day
 * row can show its mileage summary + Approve-mileage button inline.
 *
 * Groups by driverUserId with pending entries first (so a mixed row
 * with 1 pending + 2 approved surfaces the actionable state at the
 * top). Returns entries only for workers who have at least one entry
 * on the date — callers rely on presence-of-key to gate the mileage
 * chip render.
 */
export async function superListMileageForDate(
  entryDate: string,
): Promise<Record<string, Array<{
  id: string;
  vehicleId: string;
  vehicleName: string;
  startedAt: Date;
  endedAt: Date | null;
  startOdometer: number;
  endOdometer: number | null;
  miles: number | null;
  notes: string | null;
  approvedAt: Date | null;
}>>> {
  const entries = await prisma.mileageEntry.findMany({
    where: { entryDate },
    include: {
      vehicle: { select: { id: true, displayName: true } },
    },
    orderBy: [{ approvedAt: "asc" }, { startedAt: "asc" }],
  });
  const byUser: Record<string, ReturnType<typeof shapeEntry>[]> = {};
  for (const e of entries) {
    const shaped = shapeEntry(e);
    (byUser[e.driverUserId] ??= []).push(shaped);
  }
  return byUser;
}

/**
 * Team travel rollup for the Routes Next operations panel. Aggregates
 * every closed MileageEntry whose entryDate falls within [from, to]
 * (inclusive, ET calendar dates). Open entries are excluded because
 * we can't compute miles without an endOdometer.
 *
 * All numbers are pre-computed on the server so the client can render
 * a MiniStatCard grid without further math. Per-driver + per-vehicle
 * top-N arrays are included so the panel can call out the leaders.
 */
export async function superRoutesOperationsSummary(
  from: string,
  to: string,
): Promise<{
  totalMiles: number;
  totalDriveMinutes: number;
  entryCount: number;
  approvedCount: number;
  pendingCount: number;
  activeDrivers: number;
  activeVehicles: number;
  avgMilesPerDriver: number;
  avgMilesPerEntry: number;
  topDrivers: Array<{ userId: string; displayName: string; miles: number; entries: number }>;
  topVehicles: Array<{ vehicleId: string; vehicleName: string; miles: number; entries: number }>;
}> {
  const entries = await prisma.mileageEntry.findMany({
    where: {
      entryDate: { gte: from, lte: to },
      endedAt: { not: null },
      miles: { not: null },
    },
    include: {
      driver: { select: { id: true, displayName: true, email: true } },
      vehicle: { select: { id: true, displayName: true } },
    },
  });

  let totalMiles = 0;
  let totalDriveMs = 0;
  let approvedCount = 0;
  const byDriver = new Map<string, { userId: string; displayName: string; miles: number; entries: number }>();
  const byVehicle = new Map<string, { vehicleId: string; vehicleName: string; miles: number; entries: number }>();

  for (const e of entries) {
    const miles = e.miles ?? 0;
    totalMiles += miles;
    if (e.endedAt) {
      totalDriveMs += e.endedAt.getTime() - e.startedAt.getTime();
    }
    if (e.approvedAt) approvedCount++;

    const dName = e.driver.displayName || e.driver.email || e.driverUserId;
    const d = byDriver.get(e.driverUserId) ?? { userId: e.driverUserId, displayName: dName, miles: 0, entries: 0 };
    d.miles += miles;
    d.entries += 1;
    byDriver.set(e.driverUserId, d);

    const vName = e.vehicle.displayName;
    const v = byVehicle.get(e.vehicleId) ?? { vehicleId: e.vehicleId, vehicleName: vName, miles: 0, entries: 0 };
    v.miles += miles;
    v.entries += 1;
    byVehicle.set(e.vehicleId, v);
  }

  const activeDrivers = byDriver.size;
  const activeVehicles = byVehicle.size;
  const totalDriveMinutes = Math.round(totalDriveMs / 60_000);
  const avgMilesPerDriver = activeDrivers > 0 ? totalMiles / activeDrivers : 0;
  const avgMilesPerEntry = entries.length > 0 ? totalMiles / entries.length : 0;

  const topDrivers = Array.from(byDriver.values())
    .sort((a, b) => b.miles - a.miles)
    .slice(0, 5);
  const topVehicles = Array.from(byVehicle.values())
    .sort((a, b) => b.miles - a.miles)
    .slice(0, 5);

  return {
    totalMiles: Math.round(totalMiles * 10) / 10,
    totalDriveMinutes,
    entryCount: entries.length,
    approvedCount,
    pendingCount: entries.length - approvedCount,
    activeDrivers,
    activeVehicles,
    avgMilesPerDriver: Math.round(avgMilesPerDriver * 10) / 10,
    avgMilesPerEntry: Math.round(avgMilesPerEntry * 10) / 10,
    topDrivers,
    topVehicles,
  };
}

function shapeEntry(e: {
  id: string;
  vehicleId: string;
  vehicle: { id: string; displayName: string };
  startedAt: Date;
  endedAt: Date | null;
  startOdometer: number;
  endOdometer: number | null;
  miles: number | null;
  notes: string | null;
  approvedAt: Date | null;
}) {
  return {
    id: e.id,
    vehicleId: e.vehicleId,
    vehicleName: e.vehicle.displayName,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    startOdometer: e.startOdometer,
    endOdometer: e.endOdometer,
    miles: e.miles,
    notes: e.notes,
    approvedAt: e.approvedAt,
  };
}
