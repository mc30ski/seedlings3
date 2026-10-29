import type { Prisma } from "@prisma/client";

/**
 * WHICH PORTFOLIOS DOES A VISIT COUNT TOWARD?
 *
 * The answer is now short: the ones its property belongs to, right up until
 * the visit completes, after which it is whatever they were at that moment,
 * forever.
 *
 * WHAT THIS REPLACES. There used to be a four-step chain — previous
 * occurrence, then `Job.defaultAreaId`, then the property, then null —
 * with inheritance FIRST so that unattended cron rollover could never hit
 * an unanswerable question. That was the right design for an *area*, which
 * is a place: places do not move, and a property changing district is rare
 * and deliberate, so carrying the last answer forward was free.
 *
 * It is the wrong design for a *portfolio*, which is re-tagged on purpose.
 * Under chain-first, building a round to plan next week's driving would
 * show nothing: every scheduled visit would keep inheriting whatever it had
 * before, and the new portfolio would stay empty until the next 14-day
 * cycle regenerated the lot. The feature would look broken with no error.
 *
 * So inheritance is gone, and with it `Job.defaultAreaId` — a default for a
 * question that no longer has an unanswerable case. Membership is read from
 * the property, and the only thing that stops it moving is completion.
 *
 * ROWS, NOT A DERIVED JOIN. An open visit could have had its portfolios
 * computed through `job.property` on demand, which would need no syncing at
 * all. It would also mean every portfolio-scoped query branching on
 * `completedAt` — one path through the property for open work, another
 * through the snapshot for closed. Keeping real rows for both costs a
 * bounded fan-out write when membership changes and keeps a single query
 * shape everywhere, which is what `portfolioWhere` depends on.
 */

/** The portfolios a property currently belongs to. */
export async function portfolioIdsForProperty(
  tx: Prisma.TransactionClient,
  propertyId: string,
): Promise<string[]> {
  const rows = await tx.propertyPortfolio.findMany({
    where: { propertyId },
    select: { portfolioId: true },
  });
  return rows.map((r) => r.portfolioId);
}

/**
 * Bring one occurrence's rows in line with its property.
 *
 * A no-op once the visit is frozen. Callers do not have to check first —
 * putting the guard here rather than at each callsite is the point, because
 * the callsites are spread across occurrence creation, property edits and
 * the completion path, and only one of them is obviously about money.
 */
export async function syncOccurrencePortfolios(
  tx: Prisma.TransactionClient,
  occurrenceId: string,
): Promise<void> {
  const occ = await tx.jobOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { completedAt: true, job: { select: { propertyId: true } } },
  });
  if (!occ || occ.completedAt) return;

  const want = occ.job?.propertyId
    ? new Set(await portfolioIdsForProperty(tx, occ.job.propertyId))
    : new Set<string>();
  const have = new Set(
    (
      await tx.jobOccurrencePortfolio.findMany({
        where: { occurrenceId },
        select: { portfolioId: true },
      })
    ).map((r) => r.portfolioId),
  );

  const add = [...want].filter((id) => !have.has(id));
  const remove = [...have].filter((id) => !want.has(id));
  if (add.length) {
    await tx.jobOccurrencePortfolio.createMany({
      data: add.map((portfolioId) => ({ occurrenceId, portfolioId })),
      skipDuplicates: true,
    });
  }
  if (remove.length) {
    await tx.jobOccurrencePortfolio.deleteMany({
      where: { occurrenceId, portfolioId: { in: remove } },
    });
  }
}

/**
 * Freeze what a visit counted toward, at completion.
 *
 * Idempotent, and it never adds or removes a row — it only stamps the ones
 * already there. A visit completing is not the moment to discover new
 * membership; it is the moment to stop tracking it.
 */
export async function freezeOccurrencePortfolios(
  tx: Prisma.TransactionClient,
  occurrenceId: string,
  at: Date,
): Promise<void> {
  await tx.jobOccurrencePortfolio.updateMany({
    where: { occurrenceId, frozenAt: null },
    data: { frozenAt: at },
  });
}

/**
 * Re-sync every OPEN visit on a property, after its membership changed.
 *
 * Bounded by the property's open work — a handful of rows in practice, 67
 * across the whole business at the time of writing. Completed visits are
 * excluded by the query, not merely by `syncOccurrencePortfolios` refusing
 * them, so the common case does no per-row reads.
 */
export async function resyncPortfoliosForProperty(
  tx: Prisma.TransactionClient,
  propertyId: string,
): Promise<number> {
  const open = await tx.jobOccurrence.findMany({
    where: { completedAt: null, job: { propertyId } },
    select: { id: true },
  });
  for (const o of open) await syncOccurrencePortfolios(tx, o.id);
  return open.length;
}
