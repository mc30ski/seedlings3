// The other half of parcel-worker.spec.ts: a privileged caller must still get
// the full record, or the redaction has quietly broken the feature for admins.
import { test, expect, type Page } from "@playwright/test";

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

test("a Super's parcel payload keeps value and owner", async ({ page }) => {
  test.setTimeout(180_000);
  let payload: any = null;
  page.on("response", async (r) => {
    if (/parcel/.test(r.url()) && r.status() === 200 && !/image/.test(r.url())) {
      try { payload = await r.json(); } catch {}
    }
  });
  await gotoSuper(page, "payments", "Money");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify("semi"));
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_status", JSON.stringify(["CLOSED"]));
  });
  await gotoSuper(page, "jobs", "Work");
  await page.waitForTimeout(2500);
  await page.locator('button[title*="Property record"]').first().click();
  await page.waitForTimeout(13000);

  expect(payload, "no parcel response captured").not.toBeNull();
  expect(payload.redacted).toBe(false);
  expect(payload.data?.totalValue, "a Super must still see the assessed value").toBeGreaterThan(0);
  expect(payload.data?.owner, "a Super must still see the owner of record").toBeTruthy();

  const body = await page.locator("body").innerText();
  expect(body).toMatch(/County tax assessment/);
  expect(body).toMatch(/Owner of record/);
});
