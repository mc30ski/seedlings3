import { test, expect } from "@playwright/test";

/**
 * Opening a saved forecast must restore its window — and the badge above the
 * dates must agree with them.
 *
 * The dates always did restore; the badge did not. It was separate persisted
 * state updated at each site that moved the dates, and loadScenario was not
 * one of those sites. So a saved window like 11 Jun – 9 Sep came back
 * correctly while the badge still read "Last 3 months", and the whole thing
 * looked like it had failed to restore.
 */
test.describe("Forecast — a saved scenario restores its window", () => {
  test("the dates come back and the badge agrees with them", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
      localStorage.setItem("seedlings_superTab", JSON.stringify("forecast"));
      localStorage.setItem("seedlings_superCategory", JSON.stringify("Money"));
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const saved = page.getByText("Saved forecasts", { exact: true });
    await expect(saved).toBeVisible({ timeout: 30_000 });

    // Open the first saved scenario, whatever it is.
    const openBtn = page.getByRole("button", { name: /^Open$/ }).first();
    if (!(await openBtn.isVisible().catch(() => false))) {
      test.skip(true, "no saved forecast in this environment");
      return;
    }
    await openBtn.click();
    await page.waitForLoadState("networkidle");

    const from = await page.locator('input[type="date"]').first().inputValue();
    const to = await page.locator('input[type="date"]').nth(1).inputValue();
    expect(from, "the window's start must be restored").toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(to, "the window's end must be restored").toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The badge must either name a preset whose range IS this window, or say
    // "Custom dates". It must never name a preset the dates don't match.
    const badge = page.locator("text=/Last month|Last 2 months|Last 3 months|Last 6 months|Year to date|Last 12 months|Custom dates/").first();
    const label = (await badge.textContent())?.trim() ?? "";
    const today = new Date().toISOString().slice(0, 10);
    if (label !== "Custom dates") {
      // Every preset ends today. A saved window that doesn't must read Custom.
      expect(to, `badge says "${label}" so the window must end today`).toBe(today);
    }
  });
});
