import { test, expect } from "@playwright/test";
import { waitForSplashGone } from "../helpers/nav";

/**
 * Work → Now, read by somebody who may see the schedule but not the
 * timeclock.
 *
 * Spec: docs/features/now.md
 *
 * THE SCHEDULER PERSONA IS THE ONE THIS NEEDS. They hold
 * `schedule.view-all`, so the tab opens and the board loads — and they do
 * NOT hold `time.view`, so the attendance half must not reach them. In dev,
 * coordinator and districtLead are in the same position; owner is not,
 * which is why this cannot live beside the main Now spec.
 *
 * (I had written in the owner spec that no dev persona could drive this
 * branch. That was wrong — three of them can, which is how this file came
 * to exist.)
 *
 * WHAT IT ASSERTS, AND WHY IT READS THE WIRE
 *
 *   1. The clock fields are ABSENT FROM THE RESPONSE. This is the whole
 *      claim. A panel the browser declines to draw over data the server
 *      already sent is not a gate — the payload is one `curl` away — so
 *      asserting on the rendered page alone would pass just as happily
 *      against the broken version. The body is the subject here; the
 *      screen is the consequence.
 *   2. `attention` carries no `not_clocked_in` row. That row names the
 *      same people in its `detail`, so leaving it would hand the names
 *      over through the back door while the panels above were withheld.
 *   3. The tab SAYS SO, rather than rendering an empty "On the clock (0)".
 *      Absent and empty must never look alike: one means "you may not see
 *      this" and the other means "nobody is working", and a reader who
 *      cannot tell them apart will believe the yard is empty.
 *   4. The rest of the board still works. Withholding half a screen must
 *      not cost the half that is theirs.
 */

async function gotoNowTab(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("now"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Work"));
  });
  const body = page.waitForResponse(
    (r) => r.url().includes("/api/board/now") && r.status() === 200,
    { timeout: 90_000 },
  );
  await page.goto("/");
  await expect(page.locator('[data-testid="now-as-of"]')).toBeVisible({
    timeout: 90_000,
  });
  await waitForSplashGone(page);
  return (await body).json() as Promise<Record<string, unknown>>;
}

test("the timeclock is withheld from a reader without time.view", async ({ page }) => {
  const payload = await gotoNowTab(page);

  // ── 1 & 2: the wire ──────────────────────────────────────────────────
  expect(
    Object.keys(payload),
    "the board itself must still arrive — if this reader got nothing, the " +
      "test below would pass for the wrong reason",
  ).toEqual(expect.arrayContaining(["jobs", "counts", "attention", "generatedAt"]));

  expect(
    "onTheClock" in payload,
    "who is on the clock reached a reader without `time.view`. Hiding the " +
      "panel in the browser is not a gate — this payload is one `curl` away.",
  ).toBe(false);
  expect(
    "assignedNotClockedIn" in payload,
    "who was assigned work and never clocked in reached a reader without " +
      "`time.view` — same names, same problem",
  ).toBe(false);

  const attention = (payload.attention ?? []) as { kind: string }[];
  expect(
    attention.map((a) => a.kind),
    "the `not_clocked_in` attention row names the same people in its " +
      "`detail`, so it must go with the panels rather than quietly " +
      "surviving them",
  ).not.toContain("not_clocked_in");

  // ── 3: the screen says which case this is ────────────────────────────
  await expect(
    page.locator('[data-testid="now-clock-withheld"]'),
    "an absent panel with no explanation reads as a broken screen — or " +
      "worse, as an empty yard",
  ).toBeVisible();
  await expect(page.locator('[data-testid="now-clock-withheld"]')).toContainText(
    /time-tracking access/i,
  );
  await expect(
    page.locator('[data-testid="now-on-the-clock"]'),
    'an empty "On the clock (0)" panel would say nobody is working, which ' +
      "is a different and much worse claim than saying nothing",
  ).toHaveCount(0);
  await expect(page.locator('[data-testid="now-not-clocked-in"]')).toHaveCount(0);

  // ── 4: the half that IS theirs still works ───────────────────────────
  await expect(page.locator('[data-testid="now-visits"]')).toBeVisible();
  await expect(page.locator('[data-testid="now-refresh"]')).toBeVisible();
  const total = await page
    .locator('[data-testid="now-count-visits-today"]')
    .innerText();
  expect(Number(total.split("\n")[0].trim())).toBeGreaterThanOrEqual(0);
});
