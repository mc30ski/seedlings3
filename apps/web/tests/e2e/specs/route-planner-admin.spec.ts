// ─────────────────────────────────────────────────────────────────────────────
// Route planner — Super → Work → Routes.
//
// Workers open this every morning, so the bar is not "the output looks good"
// but "it cannot go down, and it cannot lose work".
//
// This had NO e2e coverage at all while it was an LLM call, which is part of
// how it shipped a day where 22 claimed jobs were silently cut to fit a
// 4-hour default the worker never set. The planner is deterministic now
// (lib/routePlanner.ts, 329 unit tests incl. 300 fuzz cases); these specs
// cover the thing unit tests cannot — that the real endpoint, the real data
// and the real screen still agree.
//
// Runs under the `super` project (filename carries the `-admin` token).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

async function gotoRoutes(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("routes"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3500);
}

/**
 * Press the planner's own button.
 *
 * NOT a loose /Plan/i match: the explainer button "How Routes plans a day"
 * sits above it in the DOM and matched first, so the spec clicked a help
 * panel and then waited a minute for a request nobody had made.
 */
async function clickPlan(page: Page) {
  await page.getByRole("button", { name: /^(Plan route|Re-plan)$/ }).first().click();
}

/** The endpoint's own answer, captured from the browser's request. */
async function captureSuggestions(page: Page, act: () => Promise<void>) {
  const waiter = page.waitForResponse(
    (r) => r.url().includes("/route-suggestions") && r.status() === 200,
    { timeout: 60_000 },
  );
  await act();
  const res = await waiter;
  return await res.json();
}

test.describe("Route planner", () => {
  test("plans a day without calling a model, and says why each stop is where it is", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoRoutes(page);

    const body = await captureSuggestions(page, async () => {
      await clickPlan(page);
    });

    // The endpoint answered with a plan, not an apology. Under the LLM this
    // could come back null with an error for a truncation or a parse failure.
    expect(body.error, `planner returned an error: ${body.error}`).toBeFalsy();
    expect(body.suggestions, "no plan returned").toBeTruthy();
    // `raw` only ever existed to dump unparseable model output.
    expect(body.raw, "raw model output has no meaning any more").toBeFalsy();

    const days = body.suggestions.days;
    expect(Array.isArray(days)).toBe(true);
    // ONE day. The old schema invited a week and got one.
    expect(days).toHaveLength(1);

    const route = days[0].route;
    if (route.length === 0) {
      test.info().annotations.push({ type: "note", description: "no jobs in range — structural checks only" });
      return;
    }

    // Orders are contiguous from 1, with no duplicates and no invented stops.
    expect(route.map((s: any) => s.order)).toEqual(route.map((_: any, i: number) => i + 1));
    const ids = route.map((s: any) => s.occurrenceId);
    expect(new Set(ids).size, "a stop was emitted twice").toBe(ids.length);
    const realIds = new Set((body.jobs ?? []).map((j: any) => j.id));
    for (const id of ids) expect(realIds.has(id), `stop ${id} matches no real job`).toBe(true);

    // Every stop explains itself, and the explanation is built from measured
    // values — a drive leg, a date, a history lookup — never narrated.
    for (const s of route) {
      expect(s.reason?.length ?? 0).toBeGreaterThan(0);
      expect(s.reason).not.toMatch(/NaN|undefined|\[object/);
    }
    const measured = route.filter((s: any) => /\d+\s*(min|h)\b|No address/.test(s.reason));
    expect(measured.length, "no stop quoted a measured drive time").toBeGreaterThan(0);

    // Totals are real.
    expect(Number.isFinite(days[0].estimatedHours)).toBe(true);
    expect(days[0].estimatedHours).toBeGreaterThanOrEqual(0);
    expect(days[0].daySummary).not.toMatch(/NaN|undefined/);
    expect(body.suggestions.summary).not.toMatch(/NaN|undefined/);
  });

  test("claimed mode never drops a job the worker already took", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoRoutes(page);

    const body = await captureSuggestions(page, async () => {
      await clickPlan(page);
    });
    expect(body.suggestions, "no plan returned").toBeTruthy();

    const claimed = (body.jobs ?? []).filter((j: any) => j.type === "claimed");
    const planned = new Set(body.suggestions.days[0].route.map((s: any) => s.occurrenceId));
    // THE PROMISE. Every claimed job appears, whatever the budget said.
    for (const j of claimed) {
      expect(planned.has(j.id), `claimed job ${j.property} was dropped from the route`).toBe(true);
    }
    // And none of them is marked optional — a claimed job is committed work.
    for (const s of body.suggestions.days[0].route) {
      if (claimed.some((j: any) => j.id === s.occurrenceId)) {
        expect(s.reason).not.toMatch(/optional/i);
        expect(s.dateChanged, "a claimed job is ordered, not rescheduled").toBeFalsy();
      }
    }
  });

  test("the plan reaches the screen — stops and reasons actually render", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoRoutes(page);

    const body = await captureSuggestions(page, async () => {
      await clickPlan(page);
    });
    const route = body?.suggestions?.days?.[0]?.route ?? [];
    test.skip(route.length === 0, "no jobs in range to render");

    await page.waitForTimeout(1500);
    // The first stop's property name is on the page, and so is its reason —
    // a plan that parses but renders blank is still a broken morning.
    const first = route[0];
    await expect(page.getByText(first.property, { exact: false }).first()).toBeVisible();
    const reasonFragment = first.reason.split(" · ")[0];
    await expect(page.getByText(reasonFragment, { exact: false }).first()).toBeVisible();

    // No failure banner anywhere.
    await expect(page.getByText(/couldn't read|failed to run|ran out of room/i)).toHaveCount(0);
  });

  test("it degrades honestly when the day has no work", async ({ page }) => {
    test.setTimeout(180_000);
    await gotoRoutes(page);

    // Driven through the app's OWN date control, not a bare fetch — the app
    // attaches a Clerk token its `apiGet` wrapper adds, and a raw
    // page.evaluate(fetch) comes back 401 without it.
    const far = new Date(Date.now() + 320 * 86_400_000).toISOString().slice(0, 10);
    await page.locator('input[type="date"]').first().fill(far);
    await page.waitForTimeout(500);

    const body = await captureSuggestions(page, () => clickPlan(page));

    // Either a plain "nothing here" message or an empty plan — never a crash,
    // never a half-written answer, never a stack trace on screen.
    if (body.suggestions) {
      expect(body.suggestions.days).toHaveLength(1);
      expect(body.suggestions.days[0].route).toEqual([]);
      expect(body.suggestions.summary).not.toMatch(/NaN|undefined/);
    } else {
      expect(body.message ?? body.error).toBeTruthy();
    }
    await expect(page.getByText(/ran out of room|couldn't read/i)).toHaveCount(0);
  });
});
