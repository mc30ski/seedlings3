import { prisma } from "../db/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// THE AREA LENS — "show me only Durham", for someone allowed to see more.
//
// A GRANT AND A LENS ARE DIFFERENT THINGS, and keeping them different is the
// whole design:
//
//   A GRANT (AreaAssignment) decides what you are ALLOWED to see. It only
//   ever widens — an assignment adds a territory, it never cages someone who
//   already holds the capability company-wide.
//
//   A LENS decides what you are CURRENTLY LOOKING AT. It only ever narrows,
//   and only inside what your grants already reach.
//
// WHY THE HEADER CANNOT ESCALATE. The chosen path is INTERSECTED with the
// granted subtrees in areaScope.visibleAreaPaths. A lens pointing somewhere
// the grants do not cover yields an empty path list — "see nothing" — never
// that territory's rows. So no validation here is load-bearing; the worst a
// crafted header achieves is showing its sender less than they are owed.
//
// WHY IT RIDES ON THE PRINCIPAL rather than being a query param each route
// reads. There are 100+ query sites already calling areaWhere(principal, …).
// On the principal, every one of them honours the lens with no edit — and,
// more to the point, a view added next year honours it too. A per-route
// param would have to be remembered at every single one, and the failure
// mode of forgetting is the silent one this feature exists to avoid:
// "Chapel Hill earned nothing" is indistinguishable from "you were looking
// at Durham".
//
// IT MUST NEVER CAUSE A 403. `can()` does not read the lens. It is a `where`
// fragment and nothing else, so a viewer looking at Durham who opens a
// Chapel Hill visit by its link can still act on it. A lens may hide a row;
// it may not refuse an action.
// ─────────────────────────────────────────────────────────────────────────────

export const AREA_LENS_HEADER = "x-area-lens";

/**
 * Parse the header into a candidate area ID. Shape check only — whether the
 * caller may look there is settled by the intersection, not here.
 */
export function parseAreaLensHeader(
  value: string | string[] | undefined | null,
): string | null {
  if (!value) return null;
  const raw = (Array.isArray(value) ? value[0] : value).trim();
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(raw)) return null;
  return raw;
}

/**
 * id → materialized path, memoized for the life of the process.
 *
 * Safe to cache forever because AREAS ARE NEVER REPARENTED (G14) and never
 * deleted — a path is immutable once written, so an entry cannot go stale.
 * Only new areas can appear, and those simply miss and fetch. Retiring an
 * area does not change its path either: retirement hides it from pickers and
 * leaves history resolvable.
 */
const pathById = new Map<string, string>();

/** Resolve the header's area ID to a path, or null if there is no such area. */
export async function resolveAreaLensPath(areaId: string | null): Promise<string | null> {
  if (!areaId) return null;
  const hit = pathById.get(areaId);
  if (hit !== undefined) return hit;
  const row = await prisma.area.findUnique({
    where: { id: areaId },
    select: { path: true },
  });
  // MISSES ARE NOT CACHED. A hit is immutable and safe to keep forever; a
  // miss only means "not yet", and caching it would make an area created a
  // moment ago permanently unselectable for this process.
  if (!row) return null;
  pathById.set(areaId, row.path);
  return row.path;
}

/** Test seam — the cache outlives a test's database otherwise. */
export function __resetAreaLensCache() {
  pathById.clear();
}
