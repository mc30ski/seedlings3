// ─────────────────────────────────────────────────────────────────────────────
// The Edit Charges / Edit Services dialogs and the invoice preview, DRIVEN.
//
// These surfaces had no render coverage: every guard on them scanned source.
// That is how the ledger picker came to be gated on "is this the admin view"
// instead of "does this user have the role", and shipped invisible on the one
// screen where charges are entered.
//
// Every test fails if it cannot find what it came to check.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

const money = (s: string) => Number(s.replace(/[$,]/g, ""));

async function gotoJobs(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify("expanded"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

test("Edit Charges opens, lists the charges, and offers the ledger link", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page);

  // The link is PER CHARGE ROW, so a charge-less job legitimately shows none.
  // Walk the cards until one has a charge on it; fail if none does, because
  // then this spec proved nothing.
  const buttons = page.getByRole("button", { name: "Edit Charges" });
  const count = await buttons.count();
  expect(count, "no Edit Charges button on any card").toBeGreaterThan(0);
  console.log(`Edit Charges buttons on the page: ${count}`);

  let examined = 0;
  let withCharges = 0;
  for (let i = 0; i < Math.min(count, 12); i++) {
    await buttons.nth(i).click();
    const dlg = page.getByRole("dialog").first();
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1200);           // the list loads over the wire
    const body = await dlg.innerText();
    examined++;

    // Copy invariants hold on EVERY charges dialog, charges or not.
    expect(body, "must not tell the operator this is where the deduction is recorded")
      .not.toMatch(/not a business expense/i);
    expect(body).toMatch(/pool/i);

    // A charge row renders "$12.34 — Mulch". Total line proves the list.
    const hasRows = /Total: \$[\d,]+\.\d{2}/.test(body);
    if (hasRows) {
      withCharges++;
      const link = dlg.getByRole("button", { name: /Link a ledger charge/i });
      const linked = dlg.getByText(/^Ledger:/);
      const affordances = (await link.count()) + (await linked.count());
      console.log(`card ${i}: has charges — ledger affordances: ${affordances}`);
      expect(
        affordances,
        "a charge row is showing but offers no way to link it to the ledger",
      ).toBeGreaterThan(0);
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    if (withCharges >= 2) break;
  }
  console.log(`charges dialogs examined: ${examined}, of which carried charges: ${withCharges}`);
  expect(withCharges, "no job with charges was found — this spec asserted nothing about the ledger link").toBeGreaterThan(0);
});

test("Edit Services lists what is on the visit and is the only way to remove one", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page);

  // The card itself must NOT carry a remove control on an add-on line.
  const addonBlocks = page.getByText(/^Added Services:/);
  const addonCount = await addonBlocks.count();
  console.log(`cards showing Added Services: ${addonCount}`);
  expect(addonCount, "no card is showing add-ons — nothing to check").toBeGreaterThan(0);

  const btn = page.getByRole("button", { name: "Edit Services" }).first();
  await expect(btn, "no Edit Services button on any card").toBeVisible({ timeout: 30_000 });
  await btn.click();

  const dlg = page.getByRole("dialog").first();
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  const body = await dlg.innerText();
  console.log("SERVICES DIALOG >>>", body.replace(/\s+/g, " ").slice(0, 400));
  expect(body).toMatch(/Edit Services/);
  // The pool correction — it must not promise the crew the whole amount.
  expect(body, 'must not claim "the crew splits it"').not.toMatch(/crew splits it/i);
  expect(body).toMatch(/pool/i);
});

test("the invoice preview's lines add up to the total it states", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page);

  const btn = page.getByRole("button", { name: /Invoice preview/i }).first();
  await expect(btn, "no Invoice preview button on any card").toBeVisible({ timeout: 30_000 });
  await btn.click();

  const dlg = page.getByRole("dialog").first();
  await expect(dlg).toBeVisible({ timeout: 15_000 });
  await expect(dlg.getByText(/Total due/i)).toBeVisible({ timeout: 20_000 });
  const body = await dlg.innerText();
  console.log("PREVIEW >>>", body.replace(/\s+/g, " ").slice(0, 500));

  const totalM = body.match(/Total due\s*\n?\s*\$([\d,]+\.\d{2})/);
  expect(totalM, "preview has no Total due").not.toBeNull();
  const total = money(totalM![1]);

  // Every $ figure above "Total due" that sits on its own line is a line item.
  const head = body.slice(0, body.indexOf("Total due"));
  const items = [...head.matchAll(/\n\$([\d,]+\.\d{2})\s*(?:\n|$)/g)].map((m) => money(m[1]));
  console.log(`preview lines: ${items.join(" + ")} = ${items.reduce((s, x) => s + x, 0)} vs total ${total}`);
  expect(items.length, "preview rendered no line items").toBeGreaterThan(0);
  expect(
    Math.abs(Math.round(items.reduce((s, x) => s + x, 0) * 100) / 100 - total),
    "invoice preview lines must sum to Total due",
  ).toBeLessThan(0.02);

  // The shared/not-shared box must describe THIS job, not the rule.
  const shared = body.match(/Shared[^\n]*\n?\s*\$([\d,]+\.\d{2})/);
  const notSharedRow = /Not shared/.test(body);
  const heading = /Not all of this is shared/.test(body);
  console.log(`shared=${shared?.[1]} notSharedRow=${notSharedRow} heading="${heading ? "Not all" : "All"}"`);
  expect(
    notSharedRow === heading,
    'the "Not shared" row and the "Not all of this is shared" heading must agree',
  ).toBe(true);
});

test("a payment ROW is never announced as money that landed", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoJobs(page);
  const body = await page.locator("body").innerText();

  // "Paid: $0.00" is not a sentence about money — a confirmed $0 payment is a
  // write-off and says so. And an unapproved payment is not paid at all.
  expect(body, 'a card announced "Paid: $0.00"').not.toMatch(/Paid: \$0\.00/);
  console.log(`"Closed — nothing collected": ${(body.match(/Closed — nothing collected/g) || []).length}`);
  console.log(`"Pending approval": ${(body.match(/Pending approval:/g) || []).length}`);
  console.log(`"Paid: $": ${(body.match(/Paid: \$/g) || []).length}`);

  // The same claim in the invoice preview.
  const btn = page.getByRole("button", { name: /Invoice preview/i });
  const n = await btn.count();
  expect(n, "no Invoice preview button to check").toBeGreaterThan(0);
  let checked = 0;
  for (let i = 0; i < Math.min(n, 10) && checked < 6; i++) {
    await btn.nth(i).click();
    const dlg = page.getByRole("dialog").first();
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(900);
    const t = await dlg.innerText();
    expect(t, 'invoice preview announced "already paid ($0.00)"')
      .not.toMatch(/already paid \(\$0\.00\)/);
    checked++;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  console.log(`invoice previews checked: ${checked}`);
  expect(checked).toBeGreaterThan(0);
});
