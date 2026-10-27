import type { Prisma } from "@prisma/client";

/**
 * WHICH AREA DOES A NEW VISIT BELONG TO?
 *
 * Resolution order, and the order is the point:
 *
 *   1. the PREVIOUS occurrence in the chain
 *   2. `Job.defaultAreaId`
 *   3. the property's area
 *   4. null — nobody has said, and the UI should ask
 *
 * INHERITANCE COMES FIRST so that automatic chain rollover can never hit an
 * unanswerable question. Rollover runs unattended on a cron; if it had to
 * prompt, the visit would either not be created or be created wrong, and
 * both failures surface days later as a gap in somebody's schedule.
 *
 * NULL IS A LEGAL ANSWER, not an error. A property nobody has placed in an
 * area produces visits in no area, and the consequence is specific and worth
 * saying out loud: that work appears in NO area rollup. It is not hidden from
 * the people doing it — `work.claim` and `work.complete` are never
 * area-scoped — only from territorial reporting.
 *
 * Why this is one function rather than a line at each creation site: there
 * are four paths that make a real visit and they are spread across three
 * files. The claimer invariant got into production broken through exactly
 * that shape — four write paths, each forgetting something slightly
 * different.
 */
export async function resolveOccurrenceArea(
  tx: Prisma.TransactionClient,
  input: {
    jobId?: string | null;
    propertyId?: string | null;
    /** The occurrence this one follows, for a repeating visit. */
    previousOccurrenceId?: string | null;
  },
): Promise<string | null> {
  // 1. The chain. A repeating visit stays where the last one was, even if
  //    the job's default has since changed — moving history is what
  //    copy-and-retire exists to avoid.
  if (input.previousOccurrenceId) {
    const prev = await tx.jobOccurrence.findUnique({
      where: { id: input.previousOccurrenceId },
      select: { areaId: true },
    });
    if (prev?.areaId) return prev.areaId;
  }

  // 2. The job's default.
  if (input.jobId) {
    const job = await tx.job.findUnique({
      where: { id: input.jobId },
      select: { defaultAreaId: true, propertyId: true },
    });
    if (job?.defaultAreaId) return job.defaultAreaId;
    // Fall through to the job's property when the caller did not name one.
    if (!input.propertyId && job?.propertyId) {
      const p = await tx.property.findUnique({
        where: { id: job.propertyId },
        select: { areaId: true },
      });
      if (p?.areaId) return p.areaId;
    }
  }

  // 3. The property.
  if (input.propertyId) {
    const property = await tx.property.findUnique({
      where: { id: input.propertyId },
      select: { areaId: true },
    });
    if (property?.areaId) return property.areaId;
  }

  // 4. Nobody has said.
  return null;
}
