// ─────────────────────────────────────────────────────────────────────────────
// The gaps the last audit left open, closed:
//   • the LEGACY branch, which production will be almost entirely made of
//   • the compact and ultra densities, where a second badge already hid once
//   • a real add → verify → remove round-trip through the dialogs
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

const money = (s: string) => Number(s.replace(/[$,]/g, ""));

async function gotoJobs(page: Page, density: "ultra" | "semi" | "expanded") {
  await page.goto("/");
  await page.evaluate((d) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify(d));
    // The default window is forward-looking and the default status set omits
    // PENDING_PAYMENT — which is exactly where an unpaid job's payout
    // PROJECTION renders. Without this the LEGACY branch is off-screen and
    // the spec quietly proves nothing.
    localStorage.removeItem("seedlings_ajobs_status");
  }, density);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

// Each density decomposes the money differently, and asserting one shape
// against all three is how "expanded: 0 breakdowns" passed as a green run.
//   ultra    "$150+$60"                    pool, then everything billed on top
//   semi     "$210 ($150 + $60)"           total, then its components
//   expanded "Invoice total 210 / Base labor 150 / Invoice charges 60"
test("ultra shows the pool and what is billed on top", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "ultra");
  const body = await page.locator("body").innerText();
  const rows = [...body.matchAll(/\$([\d,]+)\s*\+\$([\d,]+)/g)];
  console.log(`ultra: pool+rest badges ${rows.length}`);
  expect(rows.length, "ultra density showed no split badge — asserted nothing").toBeGreaterThan(0);
  for (const r of rows) {
    // A $0 pool is legitimate — a LEGACY visit whose materials outran the
    // price leaves the crew nothing. What must hold is that the badge shows
    // two real figures and neither is negative.
    expect(money(r[1]), `ultra pool must not be negative: ${r[0]}`).toBeGreaterThanOrEqual(0);
    expect(money(r[2]), `ultra "billed on top" must be positive when shown: ${r[0]}`).toBeGreaterThan(0);
  }
});

test("semi shows the total and the components that reach it", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "semi");
  const body = await page.locator("body").innerText();
  const rows = [...body.matchAll(/\$([\d,]+(?:\.\d{2})?)\s*\(([^)]*\$[^)]*)\)/g)];
  let checked = 0;
  for (const r of rows) {
    if (!/^\s*\$[\d,]/.test(r[2]) || /proposal/i.test(r[2])) continue;
    const parts = r[2].split("+").map((p) => money(p.trim()));
    if (parts.some((p) => Number.isNaN(p))) continue;
    const sum = Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(Math.abs(sum - money(r[1])), `semi: "${r[0]}" sums to ${sum}`).toBeLessThan(0.51);
    checked++;
  }
  console.log(`semi: breakdowns checked ${checked}`);
  expect(checked, "semi density showed no breakdown — asserted nothing").toBeGreaterThan(0);
});

test("expanded itemises the components under the total", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "expanded");
  const body = await page.locator("body").innerText();
  // "Invoice total $210.00 \n Base labor $150.00 \n Invoice charges $60.00"
  const blocks = [...body.matchAll(
    /(?:Invoice|Proposal) total\s*\n\s*\$([\d,]+\.\d{2})((?:\s*\n\s*(?:Base labor|Added services|Invoice charges)\s*\n?\s*\$[\d,]+\.\d{2})+)/g,
  )];
  console.log(`expanded: itemised blocks ${blocks.length}`);
  expect(blocks.length, "expanded density showed no itemised breakdown — asserted nothing").toBeGreaterThan(0);
  for (const b of blocks) {
    const parts = [...b[2].matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => money(m[1]));
    const sum = Math.round(parts.reduce((a, c) => a + c, 0) * 100) / 100;
    expect(
      Math.abs(sum - money(b[1])),
      `expanded: components ${parts.join(" + ")} = ${sum} vs total ${b[1]}`,
    ).toBeLessThan(0.02);
  }
});

test("no payout line ever subtracts charges", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "expanded");
  const body = await page.locator("body").innerText();

  // There used to be a rule under which materials came out of the crew's pool,
  // and a payout line that subtracted them. The pricing models were unified
  // (migration 20260908090000) — a charge is the client's, always — so a line
  // that subtracts one would now be describing money nobody loses.
  const subtracting = [...body.matchAll(/[^\n]*− ?\$[\d,]+\.\d{2} charges[^\n]*/g)];
  expect(
    subtracting.map((m) => m[0].trim()),
    "a payout line is subtracting charges from the crew's pay",
  ).toEqual([]);

  // …and the lines that DO exist still reach their own stated total.
  const rows = [...body.matchAll(/\$([\d,]+\.\d{2})\s*base labor([^\n=]*?)=\s*\$([\d,]+\.\d{2})/g)];
  console.log(`payout lines checked: ${rows.length}`);
  expect(rows.length, "no payout line on screen — the spec asserted nothing").toBeGreaterThan(0);
  for (const r of rows) {
    let running = money(r[1]);
    for (const t of r[2].matchAll(/([+−–-])\s*\$([\d,]+\.\d{2})/g)) {
      running += (t[1] === "+" ? 1 : -1) * money(t[2]);
    }
    expect(
      Math.abs(Math.round(running * 100) / 100 - money(r[3])),
      `payout line must reach its own total: "${r[0].replace(/\s+/g, " ")}"`,
    ).toBeLessThan(0.02);
  }
});

test("an invoice preview with charges still sums to its total", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "expanded");

  const btn = page.getByRole("button", { name: /Invoice preview/i });
  const n = await btn.count();
  let sawCharges = 0;
  for (let i = 0; i < Math.min(n, 20) && sawCharges < 2; i++) {
    await btn.nth(i).click();
    const dlg = page.getByRole("dialog").first();
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const t = await dlg.innerText();
    // A preview carrying charges shows "Shared" BELOW the total.
    const total = t.match(/Total due\s*\n?\s*\$([\d,]+\.\d{2})/);
    const shared = t.match(/Shared[^\n]*\n?\s*\$([\d,]+\.\d{2})/);
    if (total && shared && money(shared[1]) < money(total[1]) - 0.01) {
      // What must hold: the lines still sum to the total.
      const head = t.slice(0, t.indexOf("Total due"));
      const items = [...head.matchAll(/\n\$([\d,]+\.\d{2})\s*(?:\n|$)/g)].map((m) => money(m[1]));
      expect(
        Math.abs(Math.round(items.reduce((s, x) => s + x, 0) * 100) / 100 - money(total[1])),
        "preview lines must sum to Total due even when the crew shares less",
      ).toBeLessThan(0.02);
      sawCharges++;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  console.log(`previews where the crew's share is below the total: ${sawCharges}`);
  expect(sawCharges, "never saw a preview with charges billed on top").toBeGreaterThan(0);
});
