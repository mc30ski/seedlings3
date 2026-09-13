// ─────────────────────────────────────────────────────────────────────────────
// Carrying instructions onto a newly created visit.
//
// ONE IMPLEMENTATION, because there are four places that create a visit for a
// job — the recurrence generator, a manual add, the next-visit created when a
// payment clears, and the admin duplicate path — and an instruction that only
// travels through one of them is an instruction the crew does not get.
//
// TWO KINDS OF TRAVEL, and they are not the same query:
//
//   EVERY_VISIT       copied from the visit this one follows. Standing orders
//                     — "gate code is 4821", "don't bag the clippings".
//
//   NEXT_VISIT_ONLY   copied from ANY earlier visit of the job that has not
//                     delivered it yet, and then marked delivered so it never
//                     travels again. It lands as THIS_VISIT: once carried out,
//                     it is done.
//
// WHY "ANY EARLIER VISIT" RATHER THAN "THE PREVIOUS ONE". The case this exists
// for is a client asking, as a visit ends, for something next time. That visit
// then sits in pending payment for days or weeks — and the job is deliberately
// not rescheduled until the money arrives. Meanwhile another visit may be
// created by some other route. Tying the request to one specific predecessor
// would drop it whenever the next visit came from anywhere else, which is the
// failure the operator would never see: no error, just a hedge that never got
// trimmed.
//
// NOT DELETED WHEN DELIVERED. The original row stays on the visit where the
// client asked, stamped with when and where it went. The completed job card is
// the only place that conversation is recorded.
// ─────────────────────────────────────────────────────────────────────────────

import { InstructionScope } from "@prisma/client";

/** The subset of a Prisma transaction client this needs. */
type Tx = {
  occurrenceInstruction: {
    findMany: (args: any) => Promise<any[]>;
    createMany: (args: any) => Promise<any>;
    updateMany: (args: any) => Promise<any>;
  };
};

export type CarryResult = {
  /** Standing orders copied from the preceding visit. */
  carriedEveryVisit: number;
  /** One-time requests handed over and marked delivered. */
  carriedNextVisit: number;
};

/**
 * Copy the instructions a new visit should inherit.
 *
 * `sourceOccurrenceId` is the visit this one follows, when there is one — it
 * supplies the standing orders. `jobId` is what the next-visit requests are
 * searched across, so they are found wherever on the job they were left.
 *
 * Safe to call with no source (a job's first visit): standing orders are
 * skipped and pending requests still land.
 */
export async function carryInstructionsToNewOccurrence(
  tx: Tx,
  args: { jobId: string | null; sourceOccurrenceId?: string | null; newOccurrenceId: string },
): Promise<CarryResult> {
  const { jobId, sourceOccurrenceId, newOccurrenceId } = args;
  const result: CarryResult = { carriedEveryVisit: 0, carriedNextVisit: 0 };

  if (sourceOccurrenceId) {
    const standing = await tx.occurrenceInstruction.findMany({
      where: { occurrenceId: sourceOccurrenceId, scope: InstructionScope.EVERY_VISIT },
    });
    if (standing.length > 0) {
      await tx.occurrenceInstruction.createMany({
        data: standing.map((i: any) => ({
          occurrenceId: newOccurrenceId,
          text: i.text,
          isPreset: i.isPreset,
          scope: InstructionScope.EVERY_VISIT,
          sortOrder: i.sortOrder,
        })),
      });
      result.carriedEveryVisit = standing.length;
    }
  }

  // Without a job there is no series to carry anything across — a task, an
  // event, a stand-alone estimate.
  if (!jobId) return result;

  const pending = await tx.occurrenceInstruction.findMany({
    where: {
      scope: InstructionScope.NEXT_VISIT_ONLY,
      deliveredAt: null,
      occurrence: { jobId },
      // Not from the visit being created, which cannot have any yet, but the
      // guard costs nothing and makes re-entrancy harmless.
      NOT: { occurrenceId: newOccurrenceId },
    },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return result;

  await tx.occurrenceInstruction.createMany({
    data: pending.map((i: any, idx: number) => ({
      occurrenceId: newOccurrenceId,
      text: i.text,
      isPreset: i.isPreset,
      // Lands as a plain one-off: it was asked for once and is now due.
      scope: InstructionScope.THIS_VISIT,
      // After the standing orders, in the order they were asked for.
      sortOrder: result.carriedEveryVisit + idx,
    })),
  });
  await tx.occurrenceInstruction.updateMany({
    where: { id: { in: pending.map((i: any) => i.id) } },
    data: { deliveredAt: new Date(), deliveredToOccurrenceId: newOccurrenceId },
  });
  result.carriedNextVisit = pending.length;
  return result;
}
