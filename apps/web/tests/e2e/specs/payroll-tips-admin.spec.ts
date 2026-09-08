// ─────────────────────────────────────────────────────────────────────────────
// Paycheck Tips, ON SCREEN.
//
// The column imported correctly, reconciled against Gusto's totals row, and
// appeared nowhere. Every check that existed was satisfied. The only thing
// that would have caught it is looking at the page.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

async function gotoPayroll(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("payroll"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Money"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

test("tips paid through the paycheck are visible on the Payroll tab", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoPayroll(page);
  const body = await page.locator("body").innerText();

  const onScreen = /TIPS \(IN GROSS\)|Tips \(in gross\)|\bTips\b/.test(body);
  console.log(`payroll page chars: ${body.length}, tips referenced: ${onScreen}`);
  // Landed on payroll at all? Otherwise this proves nothing.
  expect(/Payroll|Gross|Net/i.test(body), "did not land on the Payroll tab").toBe(true);
  expect(onScreen, "the seeded tipped periods render no reference to tips anywhere").toBe(true);

  // And the figure itself, not just the label.
  expect(body, "no tip amount rendered").toMatch(/\$21\.00|\$10\.50|\$42\.00/);
});

test("tips are shown beside gross, never added to it", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoPayroll(page);
  const body = await page.locator("body").innerText();
  // The label has to say the relationship. "Tips $21.00" next to
  // "Gross $550.74" with nothing between them invites adding them.
  expect(
    /IN GROSS|in gross|of gross/.test(body),
    "tips render without saying they are part of gross",
  ).toBe(true);
});
