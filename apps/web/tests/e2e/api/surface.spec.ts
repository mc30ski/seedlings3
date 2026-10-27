import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { apiAs } from "../helpers/api";
import { allEndpoints, concretePath, isParameterless, type Endpoint } from "../helpers/endpoints";
import { personaCapabilities, pickPair, STORAGE_STATE } from "../helpers/personas";
import type { SeedUserKey } from "../helpers/db";

/**
 * THE REST OF THE SURFACE: ownership routes, the client portal, public
 * routes, and "does a read actually return something".
 *
 * `authz-matrix.spec.ts` covers the 496 entitlement-guarded endpoints. The
 * other 143 are not guarded by an entitlement and so have no matrix to run:
 *
 *   - OWNERSHIP (103) — `approvedUser` plus the `/me/*` routes. Any approved
 *     caller may call them; the handler scopes the query to that caller. The
 *     property worth asserting is that an ordinary worker can reach them and
 *     the server does not fall over, because "approved" is the only gate and
 *     a crash here is a crash for everyone.
 *   - PUBLIC (24) — reachable with NO credentials at all. Asserting that is
 *     the point: these are the pay page, the display board and the promo
 *     links, and if one started requiring auth the client-facing flow breaks
 *     silently.
 *   - CLIENT-PORTAL (10) — `clientGuard`. A team member is NOT a client, so
 *     the assertion is that an employee session cannot read the portal.
 *   - SYSTEM (6) — health checks and the cron endpoints, which authorize on a
 *     shared secret rather than a principal.
 *
 * A 5xx is a failure everywhere in this file. Everything else is tolerated,
 * because a probe id matches no row and 400/404 is the correct answer.
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

let capsPromise: ReturnType<typeof personaCapabilities> | null = null;
const caps = () => (capsPromise ??= personaCapabilities());

const contexts = new Map<SeedUserKey, { ctx: BrowserContext; page: Page }>();
async function pageFor(browser: any, key: SeedUserKey): Promise<Page> {
  const hit = contexts.get(key);
  if (hit) return hit.page;
  const ctx: BrowserContext = await browser.newContext({ storageState: STORAGE_STATE(key) });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  contexts.set(key, { ctx, page });
  return page;
}
test.afterAll(async () => {
  for (const { ctx } of contexts.values()) await ctx.close();
  contexts.clear();
});

const inBucket = (kind: Endpoint["bucket"]["kind"]) =>
  allEndpoints().filter((e) => e.bucket.kind === kind);

const serverErrors = (results: Array<{ label: string; status: number }>) =>
  results.filter((r) => r.status >= 500).map((r) => `${r.label} -> ${r.status}`);

test("OWNERSHIP — an approved worker reaches all 103 caller-scoped routes without a 5xx", async ({
  browser,
}) => {
  const page = await pageFor(browser, "employee");
  const out: Array<{ label: string; status: number }> = [];
  for (const e of inBucket("ownership")) {
    const r = await apiAs(
      page,
      e.verb,
      `/api${concretePath(e.path)}`,
      e.verb === "GET" ? undefined : {},
    );
    out.push({ label: `${e.verb} ${e.path}`, status: r.status });
  }
  // WHAT AN OWNERSHIP ROUTE DOES AND DOES NOT PROMISE.
  //
  // The first version of this test asserted "no 403 on an ownership route",
  // and 13 routes failed it — correctly. `approvedUser` admits any approved
  // caller and the HANDLER then scopes to that caller's own rows, so a 403 is
  // the expected answer when the row belongs to somebody else, which a probe
  // id always does. (`POST /occurrences/:id/completion-splits`,
  // `.../addons/:addonId`, `POST /tasks/:id/close` and the rest all check
  // claimer-or-owner before they check existence.) Asserting those away would
  // have meant deleting a real security property to make a test pass.
  //
  // So the assertions are the two things the bucket genuinely promises:
  // the route is REACHABLE by an approved caller (not 401 — the guard admits
  // them and the stack resolved a principal), and it does not crash.
  // Row-level correctness needs per-route fixtures and belongs in the UI
  // specs that drive the real flows.
  expect(
    out.filter((r) => r.status === 401).map((r) => r.label),
    "an approved worker got 401 from an ownership route. `approvedUser` only " +
      "needs an approved caller, so this means the auth/rbac chain failed to " +
      "resolve a principal for a real signed-in session.",
  ).toEqual([]);
  expect(serverErrors(out), "an ownership route crashed").toEqual([]);

  const scoped = out.filter((r) => r.status === 403).length;
  console.log(
    `  ownership: ${out.length} routes reached; ${scoped} applied row-level ` +
      `scoping to a non-existent row (expected)`,
  );
});

test("PUBLIC — all 24 unauthenticated routes answer without credentials", async ({ browser }) => {
  // A context with NO storage state: genuinely anonymous.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/sign-in");
  const out: Array<{ label: string; status: number }> = [];
  for (const e of inBucket("public")) {
    const r = await page.evaluate(
      async ({ m, p }: { m: string; p: string }) => {
        const res = await fetch(p, {
          method: m,
          // MANUAL, deliberately. The promo click endpoints answer 302 and
          // send the visitor on to a landing page; with the default
          // `follow`, this read the DESTINATION's status and reported a 503
          // from a page that is not the endpoint under test. Observing the
          // redirect itself is the point — that it redirects at all is the
          // behaviour, and where it points is the landing page's business.
          redirect: "manual",
          headers: m === "GET" ? {} : { "Content-Type": "application/json" },
          ...(m === "GET" ? {} : { body: "{}" }),
        });
        return res.status;
      },
      { m: e.verb, p: `/api${concretePath(e.path)}` },
    );
    out.push({ label: `${e.verb} ${e.path}`, status: r });
  }
  await ctx.close();
  // "PUBLIC" MEANS "NO USER SESSION", NOT "NO CREDENTIAL AT ALL.
  //
  // The wall-display routes live under `/public/` because the device has no
  // Clerk identity — but they are not open. A paired display carries a
  // TOKEN (`?token=` or a bearer), hashed and matched against `Display
  // .tokenHash`, and a revoked display reads the same as a never-paired one
  // so the screen falls back to a pairing code. They must therefore 401
  // without a token, and the first version of this test called that a bug.
  //
  // The pairing handshake itself (`/public/display/pair` and `.../pair/poll`)
  // is genuinely open — it is how a device with no token gets one — so it is
  // not on this list and is asserted as open below.
  const DISPLAY_TOKEN_REQUIRED = new Set([
    "GET /public/display/board",
    "GET /public/display/photo/:photoId",
    "GET /public/display/promo-item-photo/:photoId",
    "GET /public/display/promo-photo/:photoId",
  ]);

  const needsToken = out.filter((r) => DISPLAY_TOKEN_REQUIRED.has(r.label));
  const openRoutes = out.filter((r) => !DISPLAY_TOKEN_REQUIRED.has(r.label));

  expect(
    needsToken.filter((r) => r.status !== 401).map((r) => `${r.label} -> ${r.status}`),
    "a paired-display route answered WITHOUT a display token. That token is " +
      "the only thing standing between the public internet and the board, " +
      "which shows client names and addresses.",
  ).toEqual([]);
  expect(
    [...DISPLAY_TOKEN_REQUIRED].filter((l) => !out.some((r) => r.label === l)),
    "a route on the display-token list no longer exists — update the list.",
  ).toEqual([]);

  expect(
    openRoutes.filter((r) => r.status === 401 || r.status === 403).map((r) => r.label),
    "a PUBLIC route demanded credentials. These are the client-facing pay " +
      "page, the promo links and the pairing handshake — requiring auth " +
      "breaks them for the people they exist for.",
  ).toEqual([]);
  expect(serverErrors(out), "a public route crashed").toEqual([]);
  console.log(
    `  public: ${openRoutes.length} open routes answered; ` +
      `${needsToken.length} display routes correctly required a device token`,
  );
});

test("CLIENT-PORTAL — a team member gets no client data", async ({ browser }) => {
  const page = await pageFor(browser, "employee");

  // WHAT `clientGuard` ACTUALLY PROMISES.
  //
  // The first version of this test asserted that the portal REFUSES a team
  // session, and five routes failed it by answering 200. Reading the guard
  // explains why: `clientGuard` only resolves a Clerk identity (honouring
  // client view-as) — it does not require the caller to be a client. Each
  // handler then calls `getLinkedContacts()` and scopes to the Client rows
  // that identity is linked to. An employee is linked to none, so the honest
  // property is not "refused" but "nothing comes back":
  //
  //   GET /client/me          -> { linked: false }
  //   the collection reads    -> { items: [] }
  //
  // Verified against the database: the employee persona has zero
  // ClientContact rows, and `POST /client/link` with an empty body created
  // none — so these calls are not quietly linking a staff account either.
  const me = await apiAs(page, "GET", "/api/client/me");
  expect(me.status, "/client/me should answer an authenticated team member").toBe(200);
  expect(
    me.json?.linked,
    "a team member must not resolve to a client identity. `linked: true` here " +
      "would mean a staff account is being treated as a client.",
  ).toBe(false);

  const leaked: string[] = [];
  for (const e of inBucket("client-portal")) {
    if (e.verb !== "GET") continue; // the POST/DELETE paths need a real contact
    const r = await apiAs(page, e.verb, `/api${concretePath(e.path)}`);
    if (r.status >= 500) leaked.push(`${e.verb} ${e.path} -> ${r.status} (crash)`);
    if (r.status !== 200) continue; // 400 for a missing required query param is fine
    const items = r.json?.items;
    if (Array.isArray(items) && items.length > 0) {
      leaked.push(`${e.verb} ${e.path} returned ${items.length} row(s) to a team session`);
    }
  }
  expect(
    leaked,
    "the client portal returned client rows to a TEAM session. The portal is " +
      "scoped by linked ClientContact, and a staff account has none.",
  ).toEqual([]);
});

test("READS — every parameterless GET returns 2xx for someone who may call it", async ({
  browser,
}) => {
  const capsNow = await caps();
  const failures: string[] = [];
  const needsQuery: string[] = [];
  let answered = 0;

  const reads = allEndpoints().filter(
    (e) => e.verb === "GET" && isParameterless(e.path) && !e.inHandlerScoped,
  );

  for (const e of reads) {
    let persona: SeedUserKey | null = null;
    if (e.bucket.kind === "entitlement") {
      persona = pickPair(capsNow, e.bucket.entitlement).holder;
    } else if (e.bucket.kind === "ownership") {
      persona = "employee";
    }
    if (!persona) continue; // public/system/client-portal covered above

    const page = await pageFor(browser, persona);
    const r = await apiAs(page, "GET", `/api${concretePath(e.path)}`);

    if (r.status >= 200 && r.status < 300) {
      answered++;
      continue;
    }
    // 400 IS A REAL ANSWER, NOT A FAILURE.
    //
    // "Parameterless" here means the PATH has no `:params` — it says nothing
    // about QUERY parameters, and 17 of these reads require them: the CSV
    // exports and the P&L want a date range, `/weather` wants a location,
    // `/receipts/lookup` and `/supplies/upc-lookup` want something to look
    // up. A 400 is the endpoint telling the caller what it needs, which is
    // correct behaviour and the opposite of a broken route.
    //
    // What would be a real failure is a 401 or 403 (the holder was refused
    // after all), a 404 (the route is not mounted where the guard says it
    // is), or a 5xx.
    if (r.status === 400) {
      needsQuery.push(`GET ${e.path}`);
      continue;
    }
    failures.push(`GET ${e.path} -> ${r.status} as ${persona}`);
  }

  expect(
    failures,
    "A caller who HOLDS the entitlement asked one of these reads and got " +
      "neither data nor a request for parameters. A 401/403 means the guard " +
      "and the capability set disagree; a 404 means the route is not where " +
      "the inventory thinks; a 5xx means it crashed.",
  ).toEqual([]);

  expect(answered, "no read returned data — the suite is not exercising anything").toBeGreaterThan(50);
  console.log(
    `  reads: ${answered} returned 2xx; ${needsQuery.length} require query ` +
      `parameters (400): ${needsQuery.join(", ")}`,
  );
});
