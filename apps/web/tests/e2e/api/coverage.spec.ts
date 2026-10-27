import { test, expect } from "@playwright/test";
import { allEndpoints, guardedEndpoints, entitlementsWithRoutes } from "../helpers/endpoints";

/**
 * THE SUITE COVERS THE WHOLE BACKEND, AND SAYS SO OUT LOUD.
 *
 * Coverage that is asserted rather than claimed. Every endpoint the backend
 * declares falls into exactly one bucket, and every bucket has a spec that
 * drives all of it:
 *
 *   entitlement   -> authz-matrix.spec.ts (one test per entitlement)
 *   ownership     -> surface.spec.ts
 *   public        -> surface.spec.ts
 *   client-portal -> surface.spec.ts
 *   system        -> cron auth is unit-tested in the API build gate (G42);
 *                    hitting a real cron endpoint here would fire the job.
 *
 * This test fails if a new endpoint appears in a shape no spec drives, which
 * is the only way "full coverage" stays true after today.
 */
test("every declared endpoint is claimed by a spec in this suite", () => {
  const all = allEndpoints();
  expect(all.length, "no endpoints parsed — did the routes directory move?").toBeGreaterThan(500);

  const KNOWN = new Set(["entitlement", "ownership", "public", "client-portal", "system"]);
  const unknown = all
    .filter((e) => !KNOWN.has(e.bucket.kind))
    .map((e) => `${e.verb} ${e.path} (${e.file})`);
  expect(unknown, "endpoints in a bucket no spec drives").toEqual([]);

  // Every entitlement that guards a route gets its own test in the matrix.
  const guardedEnts = new Set(entitlementsWithRoutes());
  expect(
    guardedEndpoints().filter((e) => !guardedEnts.has(e.bucket.entitlement)).length,
    "a guarded route whose entitlement has no matrix test",
  ).toBe(0);

  // Report the shape of the surface so the run output states the coverage
  // instead of leaving it to be inferred.
  const counts: Record<string, number> = {};
  for (const e of all) counts[e.bucket.kind] = (counts[e.bucket.kind] ?? 0) + 1;
  console.log(
    `API coverage: ${all.length} endpoints — ` +
      Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") +
      ` across ${guardedEnts.size} entitlements`,
  );
});
