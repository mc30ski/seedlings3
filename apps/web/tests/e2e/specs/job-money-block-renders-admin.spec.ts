// ─────────────────────────────────────────────────────────────────────────────
// The money block on a job card, READ OFF THE SCREEN.
//
// Everything else guarding this feature scans source and asserts on shapes the
// author intended to write. That is how a second price badge shipped with its
// parts not summing to its own total, and how a payout line came to print a
// subtraction the math does not perform: the source gates agreed with the
// author, and nobody opened a card.
//
// These read the rendered strings and do the arithmetic the operator would do.
// A scan that finds nothing FAILS — a spec that checks zero cards and reports
// green is worse than no spec, because it is counted as coverage.
//
// Runs under the `super` project (filename carries the `-admin` token).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

const money = (s: string) => Number(s.replace(/[$,]/g, ""));

async function gotoJobs(page: Page, density: "semi" | "expanded") {
  await page.goto("/");
  await page.evaluate((d) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify(d));
    // The payout PROJECTION only renders on a job with no payment yet, and
    // those sit in PENDING_PAYMENT — which the default status filter omits.
    // Without this the spec found nothing and its own guard failed it, which
    // is the behaviour we want from a spec that cannot see its subject.
    localStorage.removeItem("seedlings_ajobs_status");
  }, density);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

test("a price badge's components add up to the total it states", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "semi");
  const body = await page.locator("body").innerText();

  // "$125 ($85 + $15 + $25)" compact, "$125.00 (...)" expanded.
  const rows = [...body.matchAll(/\$([\d,]+(?:\.\d{2})?)\s*\(([^)]*\$[^)]*)\)/g)];
  let checked = 0;
  for (const r of rows) {
    if (!/^\s*\$[\d,]/.test(r[2])) continue;      // parts must be money
    if (/proposal/i.test(r[2])) continue;
    const parts = r[2].split("+").map((p) => money(p.trim()));
    if (parts.some((p) => Number.isNaN(p))) continue;
    const sum = Math.round(parts.reduce((s, p) => s + p, 0) * 100) / 100;
    expect(
      Math.abs(sum - money(r[1])),
      `badge parts must reach their own total — "${r[0]}" sums to ${sum}`,
    ).toBeLessThan(0.51); // compact rounds each part up to whole dollars
    checked++;
  }
  console.log(`price badges with a breakdown checked: ${checked}`);
  expect(checked, "found no price badge carrying a breakdown — the spec asserted nothing").toBeGreaterThan(0);
});

test("a payout line's arithmetic reaches the payout it states", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "expanded");
  const body = await page.locator("body").innerText();

  // "$85.00 base labor + $15.00 services − $30.00 margin (30% of …) = $70.00"
  const rows = [...body.matchAll(/\$([\d,]+\.\d{2})\s*base labor([^\n=]*?)=\s*\$([\d,]+\.\d{2})/g)];
  for (const r of rows) {
    let running = money(r[1]);
    for (const t of r[2].matchAll(/([+−–-])\s*\$([\d,]+\.\d{2})/g)) {
      running += (t[1] === "+" ? 1 : -1) * money(t[2]);
    }
    running = Math.round(running * 100) / 100;
    expect(
      Math.abs(running - money(r[3])),
      `payout line must reach its own stated total — "${r[0].replace(/\s+/g, " ")}" computes ${running}`,
    ).toBeLessThan(0.02);
  }
  console.log(`payout lines checked: ${rows.length}`);
  expect(rows.length, "found no payout line — the spec asserted nothing").toBeGreaterThan(0);
});

test("job profit is revenue minus crew minus materials, on screen", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "expanded");
  const body = await page.locator("body").innerText();

  // "$125.00 invoice − $70.00 crew − $20.00 materials"  above  "$35.00"
  const rows = [...body.matchAll(
    /(Est\. )?Job profit\s*\n?\s*\$(-?[\d,]+\.\d{2})\s*\n?\s*\$([\d,]+\.\d{2}) (?:invoice|collected)([^\n]*)/g,
  )];
  for (const r of rows) {
    let running = money(r[3]);
    for (const t of r[4].matchAll(/([−–-])\s*\$([\d,]+\.\d{2})/g)) running -= money(t[2]);
    running = Math.round(running * 100) / 100;
    expect(
      Math.abs(running - money(r[2])),
      `job profit must equal its own breakdown — "${r[0].replace(/\s+/g, " ")}" computes ${running}`,
    ).toBeLessThan(0.02);
  }
  console.log(`job-profit blocks checked: ${rows.length}`);
  expect(rows.length, "found no job-profit block — the spec asserted nothing").toBeGreaterThan(0);
});


test("a job card leads with the client, not the property", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page, "semi");
  const body = await page.locator("body").innerText();

  // "Patty Reed JOB — Main House". The card title truncates from the right on
  // a phone, so the identifying half has to come first; leading with the
  // property left most cards reading "Main House" and nothing else.
  const titles = [...body.matchAll(/^(.*?) JOB — (.+)$/gm)];
  console.log(`client-first titles: ${titles.length}`);
  for (const t of titles.slice(0, 5)) console.log(`  "${t[0].trim()}"`);
  expect(titles.length, "no card title in client-first form").toBeGreaterThan(0);

  // …and none the other way round.
  const wrongWay = [...body.matchAll(/^.+ — .+ JOB$/gm)];
  expect(
    wrongWay.map((m) => m[0]),
    "a card still leads with the property",
  ).toEqual([]);
});
