import { test } from "@playwright/test";
test.use({ storageState: "./playwright/.auth/owner.json", viewport: { width: 390, height: 844 } });

test("banner footprint on a phone", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("payments"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Money"));
    localStorage.setItem("seedlings_areaLensId", "cmvtt4ppj01nrfr9kyekske8n");
    localStorage.setItem("seedlings_areaLensName", "Mike's Book");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const m = await page.evaluate(() => {
    const txt = Array.from(document.querySelectorAll("p")).find((e) =>
      /^(Portfolio filter:|Your portfolio:)/.test((e.textContent || "").trim())) as HTMLElement | undefined;
    if (!txt) return { error: "no banner" };
    const outer = txt.closest("[class]")?.parentElement as HTMLElement;
    const lh = parseFloat(getComputedStyle(txt).lineHeight);
    const r = txt.getBoundingClientRect();
    return {
      bannerHeight: Math.round((outer?.getBoundingClientRect().height ?? 0)),
      textWidth: Math.round(r.width),
      viewport: 390,
      lines: Math.round(r.height / lh),
    };
  });
  console.log("PHONE", JSON.stringify(m));
  await page.screenshot({ path: "/tmp/mob-worst.png", clip: { x: 0, y: 60, width: 390, height: 140 } });
});
