/**
 * THE ORDER PORTFOLIOS ARE LISTED IN, decided once and in one place.
 *
 * Every surface that lists portfolios — the tree on the Portfolios tab,
 * the lens menu in the header, the parent picker, the multi-select on a
 * property — reads one of two endpoints. If each sorted for itself the
 * same tree would come out in a different order depending on which control
 * you opened, so the sort happens server-side and every consumer inherits
 * it by doing nothing.
 *
 * WHAT THE ORDER IS. Depth-first: a node, then everything beneath it,
 * then its next sibling. Siblings are ranked by `sortOrder`, ties broken
 * by name so two nodes left at the same number still have a stable,
 * meaningful order rather than whatever the database felt like.
 *
 * WHY DEPTH-FIRST MATTERS. The API returns a FLAT array and the client
 * renders it as rows with an indent computed from `depth` — it never
 * rebuilds the tree. So the array's order IS the rendered order, and a
 * sequence that is not depth-first draws a node above its own parent with
 * nothing to say why.
 *
 * `sortOrder` IS NOT REPARENTING. It is not in any path, nothing filters
 * on it, and no history resolves through it. A child cannot sort above
 * its parent no matter what number it holds, because the walk below
 * places it — which is the whole reason this is safe while moving a node
 * between parents (G14) is not.
 */

/** The least a row must carry to be placed. */
export type OrderablePortfolio = {
  id: string;
  parentId: string | null;
  sortOrder?: number | null;
  name?: string | null;
};

/**
 * Re-sequence a flat list of portfolios into render order.
 *
 * Returns a NEW array holding the same objects — nothing is copied or
 * reshaped, so callers keep whatever extra fields they selected.
 *
 * ORPHANS ARE NOT DROPPED. A node whose parent is missing from the input
 * (a caller that filtered the list before sorting it, a row mid-write) is
 * appended at the end rather than silently discarded: a portfolio that
 * vanishes from a picker is a far worse failure than one in the wrong
 * place, and this function must never be the reason something is
 * unreachable.
 */
export function orderPortfolioTree<T extends OrderablePortfolio>(rows: readonly T[]): T[] {
  const byParent = new Map<string | null, T[]>();
  for (const r of rows) {
    const key = r.parentId ?? null;
    const slot = byParent.get(key);
    if (slot) slot.push(r);
    else byParent.set(key, [r]);
  }
  for (const slot of byParent.values()) {
    slot.sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        (a.name ?? "").localeCompare(b.name ?? "") ||
        a.id.localeCompare(b.id),
    );
  }

  const out: T[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null) => {
    for (const row of byParent.get(parentId) ?? []) {
      // A cycle cannot happen through the UI, but a hand-edited row could
      // make one, and an infinite walk would hang the request rather than
      // show a wrong order.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
      walk(row.id);
    }
  };
  walk(null);

  // Whatever the walk could not reach, in its original order.
  for (const r of rows) if (!seen.has(r.id)) out.push(r);
  return out;
}
