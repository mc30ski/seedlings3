// ─────────────────────────────────────────────────────────────────────────────
// What a WORKER can see on a job card. Runs under the `employee` project.
//
// The role rules here are enforced only by source-scanning gates today, which
// cannot tell whether a button renders. `showSuperExtras` falling back to
// `forAdmin ||` is a bug class that has shipped repeatedly in this repo.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import { gotoWorkerHome } from "../helpers/nav";

test("a worker sees no admin-only money affordance on a job card", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoWorkerHome(page);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_workerTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);

  const body = await page.locator("body").innerText();
  console.log(`worker page chars: ${body.length}`);

  // The business's take is never a worker's business.
  for (const forbidden of [/Job profit/, /Est\. job profit/, /materials\b.*=/]) {
    expect(body, `worker view leaked: ${forbidden}`).not.toMatch(forbidden);
  }
  // Adjust Price and Invoice preview are admin-only.
  expect(await page.getByRole("button", { name: /Adjust Price/i }).count(),
    "Adjust Price is admin-only").toBe(0);
  expect(await page.getByRole("button", { name: /Invoice preview/i }).count(),
    "Invoice preview is admin-only").toBe(0);

  // …and the page must actually have been the jobs list, or this proved nothing.
  const sawJobs =
    /Repeating|Confirmed|Unclaimed|Claim|payout/i.test(body);
  expect(sawJobs, "did not land on a jobs surface — the spec asserted nothing").toBe(true);
});

test("a worker's add-on list carries no remove control", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoWorkerHome(page);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_workerTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);

  // Services are removed in the dialog, never from the card — for anyone.
  const addonHeaders = page.getByText(/^Added Services:/);
  const n = await addonHeaders.count();
  console.log(`worker cards showing Added Services: ${n}`);
  // A loop over zero elements is not a passing test. Either the worker has a
  // job with add-ons in view, or this spec has nothing to say and must say so.
  test.skip(n === 0, "no worker-visible job carries add-ons in this dataset");
  for (let i = 0; i < n; i++) {
    const block = addonHeaders.nth(i).locator("xpath=..");
    expect(await block.getByRole("button").count(),
      "an add-on block on the card offers a control — removal belongs in the dialog").toBe(0);
  }
});
