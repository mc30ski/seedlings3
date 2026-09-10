import { test, expect } from "@playwright/test";

/** The merged ledger table: one section, always visible, carrying the
 *  comparison that used to live in a second section further down. */
test("Forecast — one money table with Today / Forecast / Change", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("forecast"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Money"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const table = page.getByText("Where the money went", { exact: true });
  await expect(table).toBeVisible({ timeout: 30_000 });

  // The comparison columns are now on this table.
  for (const col of ["Today", "Forecast", "Change"]) {
    await expect(page.getByText(col, { exact: true }).first()).toBeVisible();
  }
  // The standardised labels.
  await expect(page.getByText("Employer tax + workers comp", { exact: true })).toBeVisible();
  await expect(page.getByText("LLC Owner share", { exact: true }).first()).toBeVisible();
  // NOT asserting the absence of the old labels page-wide. "Employer payroll
  // tax" is ALSO the name of the rate slider further down — it sets
  // employerTaxPercent, with the comp rate as its own control beside it, and
  // that label is right for what it sets. Only the money LINE, which carries
  // tax and comp together, had to change. The build gate asserts the old
  // label is gone from the ledger rows themselves
  // (not.toMatch(/label: "Employer payroll tax"/)), which is the stronger and
  // more precise check; this spec's job is to prove the merged table renders.
  //
  // The duplicate section, though, must be gone from the page entirely.
  await expect(page.getByText("What it does to the books", { exact: true })).toHaveCount(0);

  await page.screenshot({ path: "test-results/forecast-money-table.png", fullPage: false });
});
