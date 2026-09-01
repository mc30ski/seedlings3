// ─────────────────────────────────────────────────────────────────────────────
// Money cards must add up — a DATA-INDEPENDENT arithmetic guard.
//
// WHY THIS FILE EXISTS
//
// The tips specs asserted that a tip was DESIGNATED correctly and that a
// worker only saw their own share. Both passed while the cards rendering
// that money were showing arithmetic that didn't close:
//
//   • Payment card: a split carries two bases. `grossAmount`/`feeAmount` are
//     the ACTUAL breakdown on everything the client handed over (tip
//     included); `amount` is what the worker is PAID, which for an employee
//     is their share of the INVOICE. On an overpaid job those diverge, and
//     the card rendered the actual basis:
//         "$63.00 share − $22.05 margin (35%) + $10.50 tip = $51.45"
//     against a real payout of $34.12 + $10.50 = $44.62. The per-worker
//     lines then contradicted the card's own headline.
//
//   • Job card: the payout block rendered only `sp.amount` + margin — the
//     JOB portion — under a header reading "Paid: $126.00". A $105 job paid
//     $126 showed $34.12 + $34.12 + $36.76 and simply omitted the $21 tip.
//
// Neither was a data bug. Both were rendering bugs, and no spec could see
// them because every existing assertion checked a value against the DATABASE
// rather than checking the card against ITSELF.
//
// So these tests assert no specific dollar figures. They read whatever the
// cards render and verify the equations close. That makes them immune to
// seed churn and able to catch this class of bug on any fixture — tipped,
// overpaid, underpaid, written off, or ordinary.
//
// Runs under the `super` project (filename carries the `-admin` token).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";

const money = (s: string) => Number(s.replace(/[$,]/g, ""));
const close = (a: number, b: number) => Math.abs(a - b) < 0.02;

async function gotoSuper(page: Page, tab: string, category: string) {
  await page.goto("/");
  await page.evaluate(([t, c]) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify(t));
    localStorage.setItem("seedlings_superCategory", JSON.stringify(c));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  }, [tab, category]);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3500);
}

test("every per-worker equation on a payment card resolves to its own stated total", async ({ page }) => {
  await gotoSuper(page, "payments", "Money");
  const body = (await page.locator("body").innerText()).replace(/−/g, "-");

  // "$52.50 share - $18.38 margin (35%) + $10.50 tip = $44.62"
  // The tip clause is optional; the top-up clause deliberately is NOT part
  // of the equation any more (it's a business-side note), so it must not
  // appear between the deduction and the "=".
  const re =
    /\$([\d,]+\.\d{2}) share - \$([\d,]+\.\d{2}) (?:margin|commission) \(\d+(?:\.\d+)?%\)(?: \+ \$([\d,]+\.\d{2}) tip)? = \$([\d,]+\.\d{2})/g;

  const rows = [...body.matchAll(re)];
  expect(
    rows.length,
    "no per-worker equations rendered — the Payments tab has no approved cards, so this spec proves nothing. Reseed dev.",
  ).toBeGreaterThan(0);

  for (const m of rows) {
    const [line, share, deduction, tip, total] = m;
    const lhs = money(share) - money(deduction) + (tip ? money(tip) : 0);
    expect(
      close(lhs, money(total)),
      `equation does not close: "${line}" — left side is $${lhs.toFixed(2)}`,
    ).toBe(true);
  }
});

test("a payment card's headline equals the sum of its own per-worker totals", async ({ page }) => {
  // The bug that prompted this: the headline was right ($89.24) and the
  // per-worker lines were wrong ($51.45 x 2), so each half looked defensible
  // in isolation. Only comparing them to each other exposes it.
  //
  // Scoped per CARD rather than by slicing page text: cards that render no
  // headline (pending approval) don't reset a text slice, so a text-based
  // split compares one card's headline against several cards' rows.
  await gotoSuper(page, "payments", "Money");
  const cards = page.getByTestId("payment-card");
  const n = await cards.count();
  expect(n, "no payment cards on screen — reseed dev").toBeGreaterThan(0);

  const eq =
    /\$([\d,]+\.\d{2}) share - \$([\d,]+\.\d{2}) (?:margin|commission) \(\d+(?:\.\d+)?%\)(?: \+ \$([\d,]+\.\d{2}) tip)? = \$([\d,]+\.\d{2})/g;

  let checked = 0;
  for (let i = 0; i < n; i++) {
    const text = (await cards.nth(i).innerText()).replace(/−/g, "-");
    const marker = text.indexOf("TOTAL TO WORKERS");
    if (marker < 0) continue;
    // "promised (pending approval)" rows are contingent and deliberately
    // excluded from the headline, so only assert on settled cards.
    if (/promised \(pending approval\)/.test(text)) continue;
    const headline = text.slice(marker).match(/\$([\d,]+\.\d{2})/);
    const rows = [...text.slice(0, marker).matchAll(eq)];
    if (!headline || rows.length === 0) continue;
    const summed = rows.reduce((s, m) => s + money(m[4]), 0);
    expect(
      close(summed, money(headline[1])),
      `card headline $${headline[1]} != sum of its rows $${summed.toFixed(2)}\n---\n${text}`,
    ).toBe(true);
    checked++;
  }
  expect(checked, "found no settled card to reconcile — reseed dev").toBeGreaterThan(0);
});

test("a job card's payout block accounts for every dollar the client paid", async ({ page }) => {
  // This view is deliberately heavy — every closed job, every card expanded —
  // so it needs well past the default budget to finish painting.
  test.setTimeout(180_000);
  // Guards the second bug: the block summed to the INVOICE while its own
  // header said what was PAID. The card now renders its own reconciliation
  // line, and flags any remainder in red rather than hiding it.
  // Warm the shell on another Super tab first. On a cold context the first
  // navigation is the app's "first open of the ET day", which auto-jumps to
  // worker Home; landing on Work → Jobs from there does not reliably apply
  // the pinned view below, and the spec then finds nothing to assert on.
  await gotoSuper(page, "payments", "Money");

  // Why each key is needed: the default window is forward-looking and shows
  // no paid work; CLOSED (which both money fixtures are, and which the
  // status filter honours ONE of — passing several renders only the first)
  // is not in the default set; and the payout block only exists on the EXPANDED
  // card, so the default "semi" density hides it entirely. Miss any one and
  // this spec asserts on nothing — which the guard below turns into a
  // failure rather than a false green.
  await page.evaluate(() => {
    localStorage.setItem("seedlings_ajobs_status", JSON.stringify(["CLOSED"]));
    // MUST be a real preset, not null + an explicit from/to. `usePersistedState`
    // coalesces a stored null back to its default ("now"), and JobsTab then
    // recomputes dateFrom/dateTo from that preset on mount — silently
    // discarding any explicit range written here. "all" is admin-only and
    // covers every fixture regardless of when the seed dates them.
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify("expanded"));
  });
  await gotoSuper(page, "jobs", "Work");
  await page.waitForSelector("text=/job pay/", { timeout: 60_000 });

  const body = (await page.locator("body").innerText());

  expect(
    /Unaccounted: /.test(body),
    "a job card could not account for the full amount paid — see the red 'Unaccounted' line on the card",
  ).toBe(false);

  // "$68.24 job pay + $21.00 tips + $36.76 business = $126.00 paid"
  const re =
    /\$([\d,]+\.\d{2}) job pay(?: \+ \$([\d,]+\.\d{2}) tips)? \+ \$([\d,]+\.\d{2}) business = \$([\d,]+\.\d{2}) paid/g;
  const rows = [...body.matchAll(re)];
  expect(
    rows.length,
    "no paid job cards rendered a reconciliation line — this spec proves nothing. Reseed dev.",
  ).toBeGreaterThan(0);

  for (const m of rows) {
    const [line, job, tips, business, paid] = m;
    const lhs = money(job) + (tips ? money(tips) : 0) + money(business);
    expect(
      close(lhs, money(paid)),
      `job card does not reconcile: "${line}" — left side is $${lhs.toFixed(2)}`,
    ).toBe(true);
  }
});
