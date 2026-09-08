// ─────────────────────────────────────────────────────────────────────────────
// THE PHONE. Runs under `employee-mobile` (iPhone 13 viewport).
//
// Every money spec so far ran at 1280×900, which is the one viewport the
// operator is least often using. The card title was reordered specifically
// because titles truncate on a phone — a claim no test could check until this
// one existed.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { gotoWorkerHome } from "../helpers/nav";

async function gotoJobs(page: import("@playwright/test").Page) {
  await gotoWorkerHome(page);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_workerTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

test("the page never scrolls sideways", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoJobs(page);
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
  }));
  console.log(`document ${overflow.doc}px in a ${overflow.view}px viewport`);
  // A few px of rounding is normal; a card forcing the page wide is not.
  expect(
    overflow.doc - overflow.view,
    "something is forcing the page wider than the phone",
  ).toBeLessThanOrEqual(2);
});

test("money on a card still adds up at phone width", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoJobs(page);
  const body = await page.locator("body").innerText();
  const rows = [...body.matchAll(/\$([\d,]+(?:\.\d{2})?)\s*\(([^)]*\$[^)]*)\)/g)];
  let checked = 0;
  for (const r of rows) {
    if (!/^\s*\$[\d,]/.test(r[2]) || /proposal/i.test(r[2])) continue;
    const parts = r[2].split("+").map((p) => Number(p.trim().replace(/[$,]/g, "")));
    if (parts.some((p) => Number.isNaN(p))) continue;
    const sum = Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
    expect(Math.abs(sum - Number(r[1].replace(/,/g, ""))), `"${r[0]}"`).toBeLessThan(0.51);
    checked++;
  }
  console.log(`mobile breakdowns checked: ${checked}`);
  // A worker may legitimately see no priced card; don't fail on an empty list,
  // but do say so rather than reporting coverage that didn't happen.
  if (checked === 0) console.log("  (no priced card in the worker's list)");
});

test("a card title leads with the client, which is what survives truncation", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoJobs(page);
  const body = await page.locator("body").innerText();
  const clientFirst = [...body.matchAll(/^(.*?) JOB(?: — .+)?$/gm)];
  const propertyFirst = [...body.matchAll(/^.+ — .+ JOB$/gm)];
  console.log(`mobile titles — client-first: ${clientFirst.length}, property-first: ${propertyFirst.length}`);
  expect(propertyFirst.map((m) => m[0]), "a phone card still leads with the property").toEqual([]);
});
