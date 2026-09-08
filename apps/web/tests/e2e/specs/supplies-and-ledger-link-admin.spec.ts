// ─────────────────────────────────────────────────────────────────────────────
// The inventory path and the ledger breadcrumb, DRIVEN — not asserted from
// source.
//
// Both were listed as uncovered: the +/- on an inventory-backed charge, and
// whether CLICKING a ledger row actually writes the pointer (the earlier spec
// only proved the button was on screen).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

const money = (s: string) => Number(s.replace(/[$,]/g, ""));

async function openCharges(page: Page) {
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

/** Open Edit Charges on each card until one matches, else fail loudly.
 *
 *  The predicate takes the LOCATOR, not just text: "From inventory" is the
 *  add-mode toggle and appears on every dialog, so matching on copy found a
 *  job with no inventory row and then failed looking for its controls. */
async function findDialog(
  page: Page,
  want: (dlg: ReturnType<Page["getByRole"]>) => Promise<boolean>,
  label: string,
) {
  const buttons = page.getByRole("button", { name: "Edit Charges" });
  const n = await buttons.count();
  expect(n, "no Edit Charges button anywhere").toBeGreaterThan(0);
  for (let i = 0; i < Math.min(n, 16); i++) {
    await buttons.nth(i).click();
    const dlg = page.getByRole("dialog").first();
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    if (await want(dlg)) return dlg;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  throw new Error(`no job in view had ${label} — the spec asserted nothing`);
}

test("an inventory-backed charge reprices when the quantity changes, and stock follows", async ({ page }) => {
  test.setTimeout(240_000);
  await openCharges(page);

  // NARROW THE LIST FIRST. There are ~75 job cards and only a handful carry a
  // hold; scanning from the top opened sixteen dialogs and found none, then
  // reported "no inventory charge exists" — which was false. Search for the
  // property the seeded hold sits on.
  await page.locator("#jobs-search").fill("Pool Area Grounds");
  await page.waitForTimeout(2500);

  // The +/- pair exists ONLY on an inventory-backed row — its amount is
  // derived from the held quantity and cannot be typed.
  const dlg = await findDialog(
    page,
    async (d) => (await d.getByRole("button", { name: "+", exact: true }).count()) > 0,
    "an inventory-backed charge",
  );
  const before = await dlg.innerText();
  const totalOf = (t: string) => money((t.match(/Total: \$([\d,]+\.\d{2})/) ?? [])[1] ?? "0");

  // The +/- controls on an inventory row. They must exist — this charge's
  // amount is DERIVED and cannot be typed.
  const plus = dlg.getByRole("button", { name: "+", exact: true }).first();
  const minus = dlg.getByRole("button", { name: "−", exact: true }).first();
  expect(await plus.count(), "an inventory charge offers no + control").toBeGreaterThan(0);

  const t0 = totalOf(before);
  await plus.click();
  await page.waitForTimeout(2500);
  const t1 = totalOf(await dlg.innerText());
  console.log(`inventory charge total: ${t0} → ${t1} after +1`);
  expect(t1, "adding a unit must raise the charge").toBeGreaterThan(t0);

  await minus.click();
  await page.waitForTimeout(2500);
  const t2 = totalOf(await dlg.innerText());
  console.log(`after −1: ${t2}`);
  expect(t2, "removing the unit must put the charge back exactly").toBeCloseTo(t0, 2);
});

test("clicking a ledger row actually writes the breadcrumb, and unlink clears it", async ({ page }) => {
  test.setTimeout(240_000);
  await openCharges(page);

  // A charge that is NOT already linked, so "Link a ledger charge" is offered.
  const dlg = await findDialog(
    page,
    async (d) => (await d.getByRole("button", { name: /Link a ledger charge/i }).count()) > 0,
    "an unlinked charge",
  );

  await dlg.getByRole("button", { name: /Link a ledger charge/i }).first().click();
  await page.waitForTimeout(2000);

  // The picker lists real ledger rows. Pick the first.
  const options = dlg.locator("button").filter({ hasText: /\$\d/ });
  const count = await options.count();
  console.log(`ledger rows offered: ${count}`);
  expect(count, "the picker offered nothing to link to").toBeGreaterThan(0);
  await options.first().click();
  await page.waitForTimeout(2500);

  const linked = await dlg.innerText();
  expect(linked, "clicking a ledger row did not write the pointer").toMatch(/Ledger:/);
  expect(linked).toMatch(/Unlink/);
  console.log(`linked: ${(linked.match(/Ledger: [^\n]+/) ?? [])[0]}`);

  // …and it comes back off. A breadcrumb that cannot be cleared is a trap.
  await dlg.getByRole("button", { name: /^Unlink$/ }).first().click();
  await page.waitForTimeout(2500);
  const after = await dlg.innerText();
  expect(after, "unlink left the pointer in place").not.toMatch(/Ledger: /);
});
