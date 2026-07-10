// ─────────────────────────────────────────────────────────────────────────────
// Recurrence-series build gate
//
// PURPOSE
// Locks in the two invariants that keep the "Due to record" panel from
// forking a recurring expense series into phantom siblings:
//
//   1. The POST /admin/business-expenses handler MUST use
//      `recurrenceSeriesId` when persisting a new row. Without it, no
//      series-id is written and the panel falls back to the fragile
//      legacy (type, description, vendor) key that produced the Vercel
//      2026-07-13 incident.
//
//   2. The POST handler MUST inherit the source row's series id when
//      `sourceExpenseId` is provided (the Record-flow path). Otherwise
//      a subsequent Record on the Vercel series would mint a new
//      series id and instantly split the stream.
//
// SCOPE
// Pure text scans on the /admin/business-expenses route file. Not a
// runtime test — no DB, no HTTP. The scan is coarse but sufficient
// because the invariants are localised to a handful of tokens in one
// file. A more thorough test would spin up a Fastify app and call
// inject(); Playwright regressions in the web app cover that shape
// end-to-end.
//
// EXTENDING
// If the create route is refactored (e.g. moved into a service, or
// split into a "record" endpoint), update the FILE_PATH + tokens
// below to match the new location. The concept — "inheriting series
// id must be code-visible somewhere in the create path" — stays.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const FILE_PATH = resolve(__dirname, "../routes/admin.ts");

describe("recurrence-series build gate", () => {
  const src = readFileSync(FILE_PATH, "utf8");

  it("the /admin/business-expenses create handler writes recurrenceSeriesId", () => {
    // Locate the create handler body. If the route name changes we want
    // this test to fail loudly rather than silently pass.
    const routeMatch = /app\.post\(\s*"\/admin\/business-expenses"\s*,/.exec(src);
    expect(routeMatch, "POST /admin/business-expenses handler not found in admin.ts").not.toBeNull();

    const startIdx = routeMatch!.index;
    // Read forward until the create({ data: { ... } }) block. Simple
    // substring check: within a reasonable window from the handler
    // start, the string `recurrenceSeriesId` must appear at least twice —
    // once in the mint/inherit logic, once in the Prisma data object.
    const window = src.slice(startIdx, startIdx + 5000);
    const matches = (window.match(/recurrenceSeriesId/g) ?? []).length;
    expect(
      matches,
      "POST /admin/business-expenses must reference recurrenceSeriesId in the create body (mint + persist). Found " +
        matches +
        " occurrences within the handler window.",
    ).toBeGreaterThanOrEqual(2);
  });

  it("the /admin/business-expenses create handler inherits from sourceExpenseId when provided", () => {
    // Locate the create handler body.
    const routeMatch = /app\.post\(\s*"\/admin\/business-expenses"\s*,/.exec(src);
    expect(routeMatch, "POST /admin/business-expenses handler not found in admin.ts").not.toBeNull();
    const startIdx = routeMatch!.index;
    const window = src.slice(startIdx, startIdx + 5000);

    // The Record-flow inheritance path must reference sourceExpenseId.
    // A refactor that renames the param without updating the handler
    // (or drops the inheritance entirely) would silently regress the
    // Vercel-style bug fix.
    expect(
      window.includes("sourceExpenseId"),
      "POST /admin/business-expenses must read sourceExpenseId from the request body to inherit the source row's recurrenceSeriesId. Missing the token entirely.",
    ).toBe(true);

    // Also require that the handler actually consults the source row's
    // recurrenceSeriesId — a token check catches "we read sourceExpenseId
    // but forgot to plumb it through Prisma".
    expect(
      /source(Expense)?\.recurrenceSeriesId/.test(window),
      "POST /admin/business-expenses must read the source row's recurrenceSeriesId (looks like `source.recurrenceSeriesId`). Missing the plumbing.",
    ).toBe(true);
  });

  it("both /due-soon endpoints group by recurrenceSeriesId when present", () => {
    // Both due-soon endpoints must key their Map by the explicit series
    // id when set. A fallback to the legacy key is allowed (defensive
    // for pre-backfill rows), but the sid-based key must be reachable
    // for the recurrenceSeriesId model to actually take effect.
    for (const route of ["/admin/business-expenses/due-soon", "/admin/business-expenses/due-soon/count"]) {
      const routeMatch = new RegExp(`app\\.get\\(\\s*"${route.replace(/\//g, "\\/")}"\\s*,`).exec(src);
      expect(routeMatch, `${route} not found in admin.ts`).not.toBeNull();
      const startIdx = routeMatch!.index;
      const window = src.slice(startIdx, startIdx + 4000);
      expect(
        window.includes("recurrenceSeriesId"),
        `${route} must key its dedup Map by recurrenceSeriesId; missing the token entirely.`,
      ).toBe(true);
      expect(
        window.includes("sid::"),
        `${route} must prefix series-id-keyed entries so they don't collide with legacy (type, description, vendor) keys. Missing the "sid::" prefix.`,
      ).toBe(true);
    }
  });
});
