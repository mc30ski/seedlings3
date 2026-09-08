// ─────────────────────────────────────────────────────────────────────────────
// ADD → VERIFY → REMOVE, for real. Every other spec reads state; this one
// changes it, which is the only way to find out whether the write path, the
// confirm, the totals and the cleanup actually work together.
//
// It writes to the dev database and removes what it wrote. The finally block
// is not optional — a spec that leaves a charge behind changes what the next
// run measures.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

const money = (s: string) => Number(s.replace(/[$,]/g, ""));
const MARKER = "E2E scrap charge";

async function gotoJobs(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify("expanded"));
    localStorage.removeItem("seedlings_ajobs_status");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

test("adding a charge raises the invoice, not the crew's pool — then removing it puts both back", async ({ page }) => {
  test.setTimeout(240_000);
  await gotoJobs(page);

  const openBtn = page.getByRole("button", { name: "Edit Charges" }).first();
  await expect(openBtn).toBeVisible({ timeout: 30_000 });
  await openBtn.click();

  const dlg = page.getByRole("dialog").first();
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);

  // Read the DIALOG's own total. The first version of this read the first
  // "Invoice total" on the PAGE, which belonged to a different card — so it
  // reported 85 before and 85 after and would have called a broken add a pass.
  const dialogTotal = async () => {
    const t = await dlg.innerText();
    const m = t.match(/Total: \$([\d,]+\.\d{2})/);
    return m ? money(m[1]) : 0;
  };

  const before = await dialogTotal();
  console.log("charges total before:", before);

  let added = false;
  try {
    await dlg.getByRole("button", { name: "One-off" }).click();
    await page.waitForTimeout(600);
    await dlg.getByPlaceholder("e.g. Mulch").fill(MARKER);
    await dlg.getByPlaceholder("0.00").first().fill("7.00");

    const save = dlg.getByRole("button", { name: "Add to invoice" });
    await expect(save, "the save button never enabled").toBeEnabled({ timeout: 10_000 });
    await save.click();
    added = true;
    await page.waitForTimeout(2500);

    const body = await dlg.innerText();
    expect(body, "the charge did not appear after saving").toContain(MARKER);
    expect(
      await dialogTotal(),
      "adding a $7.00 charge must raise the charges total by exactly $7.00",
    ).toBeCloseTo(before + 7, 2);

    // A brand-new charge points at no ledger row — the two books are separate
    // and adding a job line creates no deduction.
    const row = dlg.locator("div").filter({ hasText: MARKER }).last();
    expect(
      await row.getByText(/^Ledger:/).count(),
      "a new job charge must not arrive already linked to a ledger row",
    ).toBe(0);
  } finally {
    if (added) {
      // Remove it the only way there is: the ✕ on the row, then the confirm.
      const del = dlg.getByRole("button", { name: `Remove charge: ${MARKER}` });
      await expect(del, "no remove control on the charge row").toBeVisible({ timeout: 10_000 });
      await del.click();
      await page.waitForTimeout(1000);

      // MANDATORY CONFIRM — removing a line lowers what the client owes.
      const confirm = page.getByRole("button", { name: /^Remove$|^Delete$|^Confirm$/ }).last();
      expect(await confirm.count(), "deleting a charge asked for no confirmation").toBeGreaterThan(0);
      await confirm.click();
      await page.waitForTimeout(2500);

      const after = await dlg.innerText();
      expect(after, "the scrap charge survived its removal — dev data is now dirty")
        .not.toContain(MARKER);
      expect(
        await dialogTotal(),
        "removing the charge must put the total back exactly",
      ).toBeCloseTo(before, 2);
    }
  }
});
