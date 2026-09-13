// The Add Supply form asks what a supply IS — not what it cost.
//
// It used to carry two money fields side by side: "What you pay" and a default
// client charge. The cost field was removed deliberately, because it was a
// number nobody could keep true — it read as a policy the operator set, while
// every recorded purchase silently overwrote it, so entering one receipt
// quietly restated what all existing stock had cost. Cost now arrives through
// Buy, one purchase at a time, and the catalog average is derived from those.
//
// THIS SPEC ASSERTED THE OPPOSITE and had been red ever since that change,
// while `job-materials-build-gate.test.ts` ("the Add/Edit form asks nothing
// about cost or quantity") asserted the removal and passed. Two tests, same
// repo, contradicting each other — the e2e simply lost. Fixed here to agree
// with the design and with the gate.
import { test, expect } from "@playwright/test";

test("Add Supply asks what a supply is, and only a DEFAULT client charge", async ({ page }) => {
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
  // The removal, asserted from the outside. The build gate forbids the field's
  // identifiers; this checks the operator cannot see it either.
  expect(text, "cost belongs to a purchase, not to the catalog entry")
    .not.toMatch(/What you pay/);
  expect(text, "the client charge is a default, not a price")
    .toMatch(/Default charge to a client/);
  expect(text).toMatch(/optional/);
  expect(text, "the catalog cannot know a client's price")
    .not.toMatch(/Set the client price from|Set from cost/);
  expect(text, "a supply files under no tax line").not.toMatch(/Schedule C/);

  // Exactly ONE money input, and it is editable. Two would mean the cost field
  // came back.
  const boxes = dlg.locator('input[placeholder="0.00"]');
  expect(await boxes.count(), "only the default client charge takes money").toBe(1);
  await expect(boxes.first()).toBeEditable();

  // Nothing forces the page sideways at phone width.
  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(500);
  const o = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: window.innerWidth }));
  expect(o.doc - o.view, "the dialog forces the page wider than the phone").toBeLessThanOrEqual(2);
  await page.screenshot({ path: "tests/e2e/screenshots/add-supply-prices.png" });
});
