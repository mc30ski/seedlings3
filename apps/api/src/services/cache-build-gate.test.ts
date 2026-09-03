// ─────────────────────────────────────────────────────────────────────────────
// Cache build gate
//
// The CacheEntry table exists so rate-limited and billed external calls
// survive serverless cold starts. It is one dumping ground away from being
// the problem it solved — the Settings table briefly became exactly that when
// a machine-managed blob was filed next to real operator config.
//
// So: namespace and TTL are both mandatory and both declared in one registry,
// stale-on-error is the default, and staleness is reported rather than hidden.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { CACHE_NAMESPACES } from "../lib/cache";

const ROOT = resolve(__dirname, "../../../..");
const CACHE = readFileSync(join(ROOT, "apps/api/src/lib/cache.ts"), "utf8");
const SCHEMA = readFileSync(join(ROOT, "apps/api/prisma/schema.prisma"), "utf8");

describe("cache build gate — no untracked blobs", () => {
  it("every namespace is declared with a TTL", () => {
    const entries = Object.entries(CACHE_NAMESPACES);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, cfg] of entries) {
      expect(cfg.ttlSeconds, `${name} must declare a positive ttlSeconds`).toBeGreaterThan(0);
    }
  });

  it("the namespace type is derived from the registry, so an undeclared one won't compile", () => {
    expect(CACHE).toMatch(/export type CacheNamespace = keyof typeof CACHE_NAMESPACES/);
    expect(CACHE).toMatch(/namespace: CacheNamespace/);
  });

  it("TTL comes from the registry, never from the call site", () => {
    // A per-call TTL is how two callers end up disagreeing about how long the
    // same value is good for.
    expect(CACHE).toMatch(/CACHE_NAMESPACES\[namespace\]\.ttlSeconds/);
    expect(CACHE).not.toMatch(/ttlSeconds\??:\s*number[,)]/);
  });

  it("expiresAt is required in the schema — an entry without one is a leak", () => {
    const model = SCHEMA.slice(SCHEMA.indexOf("model CacheEntry"), SCHEMA.indexOf("}", SCHEMA.indexOf("model CacheEntry")));
    expect(model).toMatch(/expiresAt\s+DateTime\s*$/m);
    expect(model).not.toMatch(/expiresAt\s+DateTime\?/);
    expect(model).toMatch(/namespace\s+String\s*$/m);
  });
});

describe("cache build gate — stale-on-error is the default and is reported", () => {
  it("an expired entry is served when the refresh throws", () => {
    expect(CACHE).toMatch(/if \(row\) \{[\s\S]{0,200}stale: true/);
  });

  it("the expired row is read up front, not only inside the catch", () => {
    // Fetching it lazily in the catch would mean a second query on the
    // unhappy path, exactly when the system is already struggling.
    const body = CACHE.slice(CACHE.indexOf("export async function cached"));
    expect(body.indexOf("prisma.cacheEntry.findUnique")).toBeLessThan(body.indexOf("try {\n    const value = await fetcher()"));
  });

  it("callers are handed `stale` so the UI can say so", () => {
    expect(CACHE).toMatch(/stale: boolean/);
    expect(CACHE).toMatch(/fetchedAt: string/);
  });

  it("a fresh read never reports itself as stale", () => {
    expect(CACHE).toMatch(/return \{ value: hot\.value as T, stale: false/);
    expect(CACHE).toMatch(/return \{ value: row\.value as T, stale: false/);
  });
});

describe("cache build gate — pruning keeps the safety net", () => {
  it("prunes on a grace period, not on expiry", () => {
    // Deleting rows the moment they expire would remove exactly what
    // stale-on-error depends on.
    expect(CACHE).toMatch(/pruneCache\(graceDays = 180\)/);
    expect(CACHE).toMatch(/expiresAt: \{ lt: cutoff \}/);
  });

  it("a cache failure never breaks the request that used it", () => {
    // Both the read and the write are individually wrapped.
    const body = CACHE.slice(CACHE.indexOf("export async function cached"));
    expect((body.match(/} catch \{/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("cache build gate — the four migrated call sites", () => {
  const sources: Record<string, string> = {
    "services/weatherAlerts.ts": readFileSync(join(ROOT, "apps/api/src/services/weatherAlerts.ts"), "utf8"),
    "services/marketRate.ts": readFileSync(join(ROOT, "apps/api/src/services/marketRate.ts"), "utf8"),
    "lib/routing/mapbox.ts": readFileSync(join(ROOT, "apps/api/src/lib/routing/mapbox.ts"), "utf8"),
    "routes/worker.ts": readFileSync(join(ROOT, "apps/api/src/routes/worker.ts"), "utf8"),
  };

  it("all four go through the shared cache", () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(src, `${name} should use the shared cache`).toMatch(/from "(\.\.\/)+lib\/cache"|from "\.\.\/cache"/);
    }
  });

  it("none of them keeps a private in-memory cache alongside it", () => {
    // Two caches for one value is two TTLs to disagree about.
    for (const [name, src] of Object.entries(sources)) {
      expect(src, `${name} should not hold its own cache Map`)
        .not.toMatch(/const cache = new Map</);
    }
  });

  it("Mapbox geocoding throws on transport failure so stale-on-error can fire", () => {
    // Returning null on a 500 would cache "no such address" as an answer.
    expect(sources["lib/routing/mapbox.ts"]).toMatch(/throw new Error\(`Mapbox geocoding returned/);
  });
});
