import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { apiAs } from "../helpers/api";
import {
  guardedEndpoints,
  entitlementsWithRoutes,
  concretePath,
  isMutation,
  type Endpoint,
} from "../helpers/endpoints";
import { personaCapabilities, pickPair, STORAGE_STATE, type PersonaCaps } from "../helpers/personas";
import type { SeedUserKey } from "../helpers/db";

/**
 * EVERY GUARDED ENDPOINT, THROUGH THE WHOLE STACK, BOTH WAYS.
 *
 * WHAT THIS ADDS OVER `scripts/_entitlement-probe.ts`
 * That probe registers the route modules in-process and stubs
 * `requireApproved` to inject a synthetic principal. It proves the guard
 * declaration is right, and it is fast — but it never executes the parts of
 * the stack that turn a browser request into a principal: the Next proxy, the
 * CORS allow-list, `plugins/auth.ts` verifying a real Clerk JWT,
 * `plugins/rbac.ts` reading real grants out of Postgres and flattening role
 * inheritance, and `plugins/clientImpersonation.ts`. A bug in any of those is
 * invisible to the probe and fatal in production — and one of them (the
 * impersonation plugin) has already shipped a hole that only an e2e caught.
 *
 * So this suite sends REAL requests as REAL signed-in people and asserts the
 * authorization outcome only:
 *
 *   - a persona WITHOUT the entitlement gets 403
 *   - a persona WITH it does NOT get 403
 *
 * It deliberately does not assert status codes beyond that. "Allowed" cannot
 * mean 200 when the path carries an id that matches nothing — a 404 or a 400
 * proves the guard let the request through, which is the claim under test.
 * Response SHAPES are asserted by the surface specs next door.
 *
 * MUTATIONS ARE SAFE TO PROBE. Every `:param` becomes a value that matches no
 * row, and bodies are empty, so a write that gets past the guard fails on
 * lookup or validation instead of changing data. Verified against the dev
 * database: these runs create no rows and no audit events.
 */

// NOT `mode: "serial"`.
//
// It was, and that was wrong for a coverage suite: in serial mode the first
// failure SKIPS every remaining test in the group. One broken entitlement hid
// the other 36, so a run reported "1 failed" and said nothing about two
// thirds of the surface — the opposite of what this suite is for.
//
// Sequential execution comes from the config instead (`workers: 1`,
// `fullyParallel: false`), which is what lets the persona contexts below be
// shared across tests without serial's failure semantics.

/** Resolved once per worker, on first use — never during collection. */
let capsPromise: Promise<PersonaCaps> | null = null;
const caps = () => (capsPromise ??= personaCapabilities());

/** One signed-in browser context per persona, created on demand and reused. */
const contexts = new Map<SeedUserKey, { ctx: BrowserContext; page: Page }>();

async function pageFor(browser: any, key: SeedUserKey): Promise<Page> {
  const hit = contexts.get(key);
  if (hit) return hit.page;
  const ctx: BrowserContext = await browser.newContext({
    storageState: STORAGE_STATE(key),
  });
  const page = await ctx.newPage();
  // `apiAs` reads the Clerk session token off the page, so the app has to be
  // loaded and hydrated before the first request.
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  contexts.set(key, { ctx, page });
  return page;
}

test.afterAll(async () => {
  for (const { ctx } of contexts.values()) await ctx.close();
  contexts.clear();
});

const byEntitlement = (ent: string): Endpoint[] =>
  guardedEndpoints().filter((e) => e.bucket.entitlement === ent);

for (const entitlement of entitlementsWithRoutes()) {
  test(`${entitlement} — guards all ${byEntitlement(entitlement).length} of its routes`, async ({
    browser,
  }) => {
    const capsNow: PersonaCaps = await caps();
    const { holder, nonHolder } = pickPair(capsNow, entitlement);

    expect(
      holder,
      `No seeded persona holds \`${entitlement}\`, so the ALLOW direction cannot ` +
        `be tested. Grant it to a persona in prisma/seed.ts rather than ` +
        `deleting this expectation.`,
    ).not.toBeNull();
    expect(
      nonHolder,
      `Every seeded persona holds \`${entitlement}\`, so the REFUSE direction ` +
        `cannot be tested.`,
    ).not.toBeNull();

    const routes = byEntitlement(entitlement);
    const refusedPage = await pageFor(browser, nonHolder!);
    const allowedPage = await pageFor(browser, holder!);

    const notRefused: string[] = [];
    const wronglyRefused: string[] = [];
    const staleScoped: string[] = [];

    for (const e of routes) {
      const url = `/api${concretePath(e.path)}`;
      const label = `${e.verb} ${e.path}`;

      const no = await apiAs(refusedPage, e.verb, url, isMutation(e) ? {} : undefined);
      if (no.status !== 403) notRefused.push(`${label} -> ${no.status} as ${nonHolder}`);

      const yes = await apiAs(allowedPage, e.verb, url, isMutation(e) ? {} : undefined);

      if (e.inHandlerScoped) {
        // The route declares a rule NARROWER than its guard (claimer-only,
        // "you must be on this visit"). Holding the entitlement is correctly
        // not enough — so we assert the narrower rule is actually IN FORCE
        // rather than skipping the check. If this route starts admitting a
        // bare entitlement holder, the annotation has gone stale and is
        // now excusing a widening nobody reviewed.
        //
        // This is the half the in-process probe cannot judge: its synthetic
        // caller never reaches the ownership lookup, so it sees these routes
        // as "allowed" and would call a live annotation stale.
        if (yes.status !== 403) {
          staleScoped.push(`${label} -> ${yes.status} as ${holder} (annotation says: ${e.inHandlerScoped})`);
        }
        continue;
      }

      if (yes.status === 403) wronglyRefused.push(`${label} -> 403 as ${holder}`);
    }

    // ONE ASSERTION, ALL THREE FINDINGS.
    //
    // These were three sequential `expect`s, and the first one to fail
    // aborted the test and hid the others: a run reported a stale annotation
    // on /complete while saying nothing about a real 403 on /accept-payment
    // in the same entitlement. Same failure mode as `mode: "serial"` — the
    // suite knew more than it said. Reporting them together means one run
    // surfaces everything that is wrong with this entitlement.
    const problems: string[] = [];
    if (notRefused.length) {
      problems.push(
        `DID NOT REFUSE a caller lacking \`${entitlement}\` (a guard that ` +
          `does not fire is the bug class this model exists to remove):\n    ` +
          notRefused.join("\n    "),
      );
    }
    if (staleScoped.length) {
      problems.push(
        `STALE \`// in-handler-scoped:\` ANNOTATION — admitted a caller who ` +
          `only holds the entitlement, so the annotation is now excusing a ` +
          `widening nobody reviewed. Delete it, or restore the narrower ` +
          `rule:\n    ` + staleScoped.join("\n    "),
      );
    }
    if (wronglyRefused.length) {
      problems.push(
        `REFUSED a caller who HOLDS \`${entitlement}\` — either the guard asks ` +
          `for something else, or the route applies a narrower rule and needs ` +
          `an \`// in-handler-scoped: <reason>\` annotation above its ` +
          `declaration:\n    ` + wronglyRefused.join("\n    "),
      );
    }

    expect(problems.join("\n\n"), `authorization is wrong for \`${entitlement}\``).toBe("");
  });
}
