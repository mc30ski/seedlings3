// ─────────────────────────────────────────────────────────────────────────────
// External-value cache
//
// Two tiers. In-memory first, so a warm process never queries; the CacheEntry
// table second, so a cold start reads one row instead of calling a paid or
// rate-limited API. On serverless every cold start is a fresh process, which
// is why memory alone was never enough.
//
// TWO RULES, both enforced by the type system and the build gate:
//
//   1. NAMESPACE IS REQUIRED and must be declared in CACHE_NAMESPACES below.
//      This is the guard against the table becoming the junk drawer that the
//      Settings table briefly became — you cannot drop an untracked blob in.
//
//   2. TTL IS REQUIRED. It comes from the namespace declaration, so an entry
//      with no expiry cannot be written. An unexpiring cache entry is a leak
//      that nobody notices until the value is years stale.
//
// STALE-ON-ERROR IS THE DEFAULT. When a refresh fails and an expired entry
// exists, the expired value is returned with `stale: true` rather than
// throwing. For external reference data — a wage survey published annually, a
// weather alert, a geocode — last week's real answer beats an error or a
// fabricated fallback.
//
// The caller gets `stale` and `fetchedAt` back and is expected to SAY SO in
// the UI. Silent staleness is the failure mode this is meant to avoid, not
// create: a number that is quietly out of date is worse than one that is
// visibly out of date.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";

const DAY = 86_400;

/**
 * Every cache namespace, with the TTL that applies to it.
 *
 * Adding a namespace is a deliberate act: pick a TTL that reflects how often
 * the underlying value actually changes, not how often you happen to read it.
 */
export const CACHE_NAMESPACES = {
  /** NWS severe-weather alerts, keyed by rounded coordinates. Alerts are
   *  issued in roughly hourly cycles and the weather bar renders on every
   *  screen, so this is the highest-volume namespace by far. */
  nwsAlerts: { ttlSeconds: 15 * 60 },

  /** OpenWeather current conditions + 5-day forecast, keyed by rounded
   *  coordinates. Previously uncached server-side — every worker's browser
   *  poll was a fresh pair of API calls. */
  openWeather: { ttlSeconds: 10 * 60 },

  /** BLS OEWS wage percentiles for the business's metro area. Published once
   *  a year, and the keyless API allows only ~25 requests/day. */
  marketRate: { ttlSeconds: 60 * DAY },

  /** Address → coordinates, from whichever routing provider is configured.
   *  Billed per call, and a job's address essentially never moves — this was
   *  re-geocoding the same properties on every route run. */
  geocode: { ttlSeconds: 90 * DAY },
} as const;

export type CacheNamespace = keyof typeof CACHE_NAMESPACES;

export type Cached<T> = {
  value: T;
  /** True when the refresh failed and this is the last known-good value.
   *  Surface it — see the header. */
  stale: boolean;
  /** When the value was actually fetched, for "as of" labelling. */
  fetchedAt: string;
};

/** L1. Holds the value plus its expiry so a warm process short-circuits. */
const memory = new Map<string, { value: unknown; expiresAt: number; fetchedAt: string }>();

/** Test seam — L1 would otherwise leak between runs. */
export function __clearMemoryCache() {
  memory.clear();
}

function fullKey(namespace: CacheNamespace, key: string) {
  return `${namespace}:${key}`;
}

/**
 * Read through the cache, fetching on a miss.
 *
 * Never returns an expired value silently — an expired value comes back only
 * when the refresh failed, and always with `stale: true`.
 *
 * Rethrows only when the fetcher fails AND nothing is cached at all. A caller
 * that wants to degrade further (to a manual override, say) handles that.
 */
export async function cached<T>(
  namespace: CacheNamespace,
  key: string,
  fetcher: () => Promise<T>,
): Promise<Cached<T>> {
  const ttlMs = CACHE_NAMESPACES[namespace].ttlSeconds * 1000;
  const k = fullKey(namespace, key);
  const now = Date.now();

  // L1
  const hot = memory.get(k);
  if (hot && hot.expiresAt > now) {
    return { value: hot.value as T, stale: false, fetchedAt: hot.fetchedAt };
  }

  // L2. Read even when expired — an expired row is what makes stale-on-error
  // possible, so it is fetched up front rather than only in the catch.
  let row: { value: unknown; expiresAt: Date; updatedAt: Date } | null = null;
  try {
    row = await prisma.cacheEntry.findUnique({
      where: { key: k },
      select: { value: true, expiresAt: true, updatedAt: true },
    });
  } catch {
    // A cache read must never be the thing that breaks a request.
  }
  if (row && row.expiresAt.getTime() > now) {
    memory.set(k, {
      value: row.value,
      expiresAt: row.expiresAt.getTime(),
      fetchedAt: row.updatedAt.toISOString(),
    });
    return { value: row.value as T, stale: false, fetchedAt: row.updatedAt.toISOString() };
  }

  try {
    const value = await fetcher();
    const expiresAt = new Date(now + ttlMs);
    const fetchedAt = new Date(now).toISOString();
    memory.set(k, { value, expiresAt: expiresAt.getTime(), fetchedAt });
    try {
      await prisma.cacheEntry.upsert({
        where: { key: k },
        update: { value: value as any, expiresAt, namespace },
        create: { key: k, namespace, value: value as any, expiresAt },
      });
    } catch {
      // Losing the write costs a refetch next cold start, nothing more.
    }
    return { value, stale: false, fetchedAt };
  } catch (err) {
    // STALE-ON-ERROR. An expired entry is better than an error or an invented
    // fallback, provided the caller says it is stale.
    if (row) {
      return { value: row.value as T, stale: true, fetchedAt: row.updatedAt.toISOString() };
    }
    throw err;
  }
}

/** Drop one entry, or a whole namespace. Rarely needed — keys include the
 *  inputs that shape the value, so changing an input misses naturally. */
export async function invalidate(namespace: CacheNamespace, key?: string) {
  if (key) {
    memory.delete(fullKey(namespace, key));
    await prisma.cacheEntry.deleteMany({ where: { key: fullKey(namespace, key) } });
    return;
  }
  for (const k of memory.keys()) if (k.startsWith(`${namespace}:`)) memory.delete(k);
  await prisma.cacheEntry.deleteMany({ where: { namespace } });
}

/**
 * Remove entries that have been expired long enough to be useless.
 *
 * The grace period is deliberate: expired rows are what stale-on-error serves,
 * so pruning on expiry would delete exactly the safety net. Six months is far
 * past the point where a stale weather alert or wage figure is worth showing.
 */
export async function pruneCache(graceDays = 180): Promise<number> {
  const cutoff = new Date(Date.now() - graceDays * DAY * 1000);
  const r = await prisma.cacheEntry.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return r.count;
}
