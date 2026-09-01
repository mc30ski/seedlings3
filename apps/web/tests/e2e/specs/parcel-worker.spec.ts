// ─────────────────────────────────────────────────────────────────────────────
// Parcel record — worker redaction.
//
// Workers get the SIZE and the IMAGERY. The county's appraised value and the
// owner of record are stripped SERVER-SIDE (routes/me.ts), so this asserts on
// the network payload rather than the rendered dialog: a redaction that only
// hides fields in the UI is still readable in devtools.
//
// See .claude/memory/reference_worker_sensitive_data.md — same rule the
// team/groups worker endpoints follow.
// ─────────────────────────────────────────────────────────────────────────────
import { test, expect } from "@playwright/test";

test("a worker's parcel payload carries no value or owner", async ({ page }) => {
  test.setTimeout(180_000);
  let payload: any = null;
  page.on("response", async (r) => {
    if (/parcel/.test(r.url())) {
      console.log("  PARCEL REQ:", r.status(), r.url().replace(/^https?:\/\/[^/]+/, ""));
      if (r.status() === 200 && !/image/.test(r.url())) { try { payload = await r.json(); } catch {} }
    }
  });

  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_wjobs_status", JSON.stringify(["CLOSED"]));
    localStorage.setItem("seedlings_wjobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_wjobs_density", JSON.stringify("semi"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);

  const icon = page.locator('button[title*="Property record"]').first();
  expect(await icon.count(), "a worker should see the parcel icon").toBeGreaterThan(0);
  await icon.click();
  await page.waitForTimeout(13000);

  expect(payload, "no parcel response captured").not.toBeNull();
  expect(payload.redacted, "worker payload must be flagged redacted").toBe(true);
  for (const f of ["landValue", "improvementValue", "totalValue", "valueType", "owner"]) {
    expect(payload.data?.[f], `${f} must be stripped for a worker`).toBeNull();
  }
  // And the operational half must still be there, or the redaction is useless.
  expect(payload.data?.acres, "acres must survive redaction").toBeGreaterThan(0);

  const body = await page.locator("body").innerText();
  expect(body).toMatch(/acres · whole parcel/);
  expect(body, "worker UI must not show the assessment").not.toMatch(/County tax assessment/);
  expect(body, "worker UI must not show the owner").not.toMatch(/Owner of record/);
  console.log("WORKER acres:", payload.data?.acres, "| redacted:", payload.redacted);
});
