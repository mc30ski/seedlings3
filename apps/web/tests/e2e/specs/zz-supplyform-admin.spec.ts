// The Add Supply price fields, as they now stand.
//
// They were side by side and their labels wrapped to different heights, so the
// inputs sat on different baselines. They are now STACKED, because the two are
// not a pair: one is a fact about the supply (what you paid) and the other is
// only a default for a price decided per job.
import { test, expect } from "@playwright/test";

test("Add Supply asks what you pay, and only a DEFAULT client charge", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("supplies"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Money"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3500);
  await page.getByRole("button", { name: /Add Supply/i }).first().click();
  const dlg = page.getByRole("dialog").first();
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(800);

  const text = await dlg.innerText();
  expect(text, "the cost you paid must be settable").toMatch(/What you pay/);
  expect(text, "the client charge is a default, not a price").toMatch(/Default charge to a client/);
  expect(text).toMatch(/optional/);
  expect(text, "the catalog cannot know a client's price").not.toMatch(/Set the client price from|Set from cost/);
  expect(text, "a supply files under no tax line").not.toMatch(/Schedule C/);

  // Both are real inputs, not read-only boxes.
  const boxes = dlg.locator('input[placeholder="0.00"]');
  expect(await boxes.count(), "expected two editable money inputs").toBeGreaterThanOrEqual(2);
  for (let i = 0; i < 2; i++) await expect(boxes.nth(i)).toBeEditable();

  // Nothing forces the page sideways at phone width.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(500);
  const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(o.doc - o.view, "the dialog forces the page wider than the phone").toBeLessThanOrEqual(2);
  await page.screenshot({ path: "tests/e2e/screenshots/add-supply-prices.png" });
});
