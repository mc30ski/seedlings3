import { test, expect } from "@playwright/test";

// The season override has two possible authors, and only one of them may be
// cleared automatically. A theme that names a season (Spring/Fall/High
// contrast) pins the logo; an admin picking a season by hand on the Profile
// tab must survive a later switch to Original or Dark.
test("an admin's hand-picked season outlives a theme change", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    // Admin picks "spring" by hand, in September, on the Original theme.
    localStorage.setItem("seedlings_theme", "original");
    localStorage.setItem("seedlings_seasonOverride", "spring");
    localStorage.setItem("seedlings_seasonOverrideSource", "manual");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1800);
  const kept = await page.evaluate(() => ({
    override: localStorage.getItem("seedlings_seasonOverride"),
    img: document.querySelector('img[alt="Seedlings"]')?.getAttribute("src"),
  }));
  console.log("MANUAL after Original load: " + JSON.stringify(kept));
  expect(kept.override, "a manual season must survive an auto theme").toBe("spring");
  expect(kept.img).toBe("/seedlings-icon.png");

  // Now a theme that names a season takes over, then back to Original.
  await page.evaluate(() => localStorage.setItem("seedlings_theme", "fall"));
  await page.goto("/");
  await page.waitForTimeout(1200);
  const themed = await page.evaluate(() => localStorage.getItem("seedlings_seasonOverride"));
  console.log("THEMED (fall theme): " + themed);
  expect(themed, "a named-season theme pins the logo").toBe("fall");

  await page.evaluate(() => localStorage.setItem("seedlings_theme", "original"));
  await page.goto("/");
  await page.waitForTimeout(1200);
  const cleared = await page.evaluate(() => localStorage.getItem("seedlings_seasonOverride"));
  console.log("BACK to Original: " + cleared);
  expect(cleared, "what a THEME set, a theme may clear").toBeNull();
});
