import { test, expect, devices } from "@playwright/test";

/**
 * Work → Repeating at phone width.
 *
 * WHY THIS EXISTS AS ITS OWN SPEC. The tab shipped with a mobile layout that
 * was unusable and nothing caught it: one grid serves both widths, the phone
 * template declares two tracks, and the row has seven children — so grid
 * auto-placement dealt half the cells into the track sized for a checkbox.
 * A `minmax(0, …)` track shrinks to nothing, so the text wrapped one
 * character per line and every row grew to the height of a page.
 *
 * It typechecked, it passed the build gate, and the desktop spec was green
 * throughout, because every one of those looks at a viewport 1280px wide.
 * The only thing that catches it is rendering the page narrow and MEASURING.
 *
 * It runs under `owner` rather than `employee-mobile` — that project signs
 * in as the employee account, which correctly cannot see this tab at all.
 */
test.use({ ...devices["iPhone 13"] });

async function gotoRepeating(page: any) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("repeating"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Work"));
  });
  await page.goto("/");

  // NAVIGATE BY EVENT, not by trusting the persisted tab.
  //
  // Restoring `seedlings_staffTab` races `/api/me`: until capabilities land
  // `canSeeTab("repeating")` is false, so the stamped tab is not visible yet
  // and the app falls back to Work → Home — which is exactly where this spec
  // landed when it was written the other way. Waiting for the alerts badge
  // means capabilities have resolved; the event is then the same navigation
  // the header shortcuts use.
  await expect(page.getByRole("button", { name: /alerts/i }).first()).toBeVisible({
    timeout: 60_000,
  });
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("navigate:staffTab", {
        detail: { tab: "repeating", category: "Work" },
      }),
    ),
  );
  await expect(page.locator('[data-testid="repeating-summary"]')).toBeVisible({
    timeout: 60_000,
  });
}

test.describe("Work → Repeating on a phone", () => {
  test("rows are readable, the page does not scroll sideways, and sorting is reachable", async ({ page }) => {
    await gotoRepeating(page);
    await expect(page.locator('[data-testid="repeating-rows"]')).toBeVisible({ timeout: 30_000 });

    // ── 1. No horizontal page scroll ─────────────────────────────────
    //
    // A table squeezed into a phone almost always announces itself this
    // way first, and it makes every other interaction awkward.
    const [scrollW, clientW] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scrollW, "the page must not scroll sideways on a phone").toBeLessThanOrEqual(clientW);

    // ── 2. Rows are a sane height ────────────────────────────────────
    //
    // THE MEASUREMENT THAT WOULD HAVE CAUGHT IT. The broken layout made
    // each row ~1700px — text running vertically, one character per line.
    // A correct row is a short labelled stack. The bound is deliberately
    // loose: this is a smoke test for "collapsed into a sliver", not a
    // pixel lock that fails whenever a line of copy is reworded.
    const heights = await page
      .locator('[data-testid="repeating-rows"] > div')
      .evaluateAll((els) => els.slice(0, 8).map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(heights.length, "there must be rows to measure").toBeGreaterThan(0);
    for (const h of heights) {
      expect(h, `a row ${h}px tall means the cells collapsed`).toBeLessThan(700);
      expect(h, "a row with no height never rendered").toBeGreaterThan(40);
    }

    // ── 3. Each cell names itself, since there are no column headers ──
    const firstRow = page.locator('[data-testid="repeating-rows"] > div').first();
    // SOURCE CASING, not what you see. The labels are uppercased by CSS
    // (`textTransform`), so the DOM text — and everything a screen reader or
    // a locator reads — is still "Customer".
    for (const label of ["Customer", "Service", "Next visit", "State"]) {
      await expect(
        firstRow.getByText(label, { exact: true }),
        `${label} must label its value where there is no header`,
      ).toBeVisible();
    }
    // The column headers themselves must NOT be on screen — they are the
    // desk-width affordance and would be a second, dead row here.
    await expect(page.locator('[data-testid="repeating-sort-customer"]')).toBeHidden();

    // ── 4. Sorting is still reachable ────────────────────────────────
    //
    // The headers carry it at desk width, so without the picker the
    // feature would simply not exist on the surface it is read on most.
    await expect(page.locator('[data-testid="repeating-sort-mobile"]')).toBeVisible();
    await expect(page.locator('[data-testid="repeating-sort-dir"]')).toBeVisible();
  });
});
