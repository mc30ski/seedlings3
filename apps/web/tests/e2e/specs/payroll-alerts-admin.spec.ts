// ─────────────────────────────────────────────────────────────────────────────
// Payroll identity queue — header alerts dropdown + Tasks page.
//
// Canonical spec: docs/features/payroll.md.
//
// WHY THIS EXISTS. Until a Gusto name is matched to a User, THAT WORKER
// CANNOT SEE THEIR OWN PAY — and the worker is deliberately never told
// whose row it is, so their only signal is a passive "ask your admin".
// Before 2026-08-26 the queue was visible in exactly one place: a banner
// inside the Payroll tab. The one person who could fix it had to happen to
// go looking, while the person affected was told to go ask them.
//
// Both surfaces are SUPER-only, matching the banner and the endpoint guard.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";

async function gotoSuperHome(page: any) {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("seedlings_topTab", JSON.stringify("super")));
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3500);
}

/** Same auth the app uses — a bare fetch() gets 401. */
async function apiAs(page: any, path: string): Promise<any> {
  return page.evaluate(async (p: string) => {
    const token = await (window as any).Clerk?.session?.getToken?.();
    const r = await fetch(p, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    try {
      return await r.json();
    } catch {
      return null;
    }
  }, path);
}

async function openAlerts(page: any) {
  await page.locator("[data-alert-badge]").first().click();
  await page.waitForTimeout(1200);
}

test.describe("Payroll identity queue — operator surfaces", () => {
  test("the alerts dropdown lists the queue, with the real count", async ({ page }) => {
    await gotoSuperHome(page);

    // seed.ts leaves one row deliberately unmatched, so this is non-zero.
    const unmatched = await apiAs(page, "/api/payroll/identities/unmatched");
    expect(Array.isArray(unmatched)).toBe(true);
    expect(unmatched.length, "seed should leave a name unmatched").toBeGreaterThan(0);

    await openAlerts(page);
    const row = page.getByText(/Payroll names to match/).first();
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The badge must agree with the endpoint — a hardcoded or stale count
    // is worse than none, because it sends the operator looking for work
    // that isn't there (or hides work that is).
    const card = page
      .locator("div")
      .filter({ hasText: /Payroll names to match/ })
      .last();
    await expect(card).toContainText(String(unmatched.length));
  });

  test("Tasks shows the queue as an INLINE section, not a link away", async ({ page }) => {
    // Inline on purpose: the whole action is one picker plus a confirm, so
    // bouncing to the Payroll tab would be more steps than doing it here.
    await gotoSuperHome(page);
    await openAlerts(page);
    await page.getByRole("button", { name: /Tasks$/ }).first().click();
    await page.waitForTimeout(3000);

    await expect(page.getByText(/Payroll names to match/).first()).toBeVisible({
      timeout: 10_000,
    });

    const card = page
      .locator("div")
      .filter({ hasText: /Payroll names to match/ })
      .filter({ has: page.getByRole("button", { name: /Expand/i }) })
      .last();
    await card.getByRole("button", { name: /Expand/i }).first().click();
    await page.waitForTimeout(2500);

    // The REAL component, not a stub or a summary — the operator can
    // resolve the queue without leaving Tasks.
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body, "the embedded review is missing its worker picker").toMatch(/Choose worker/);
    expect(body).toMatch(/payroll name.? needs? matching/i);
  });
});
