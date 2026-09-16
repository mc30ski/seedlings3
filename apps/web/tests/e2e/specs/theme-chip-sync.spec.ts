import { test, expect } from "@playwright/test";

// The header chip and the Profile picker are two views of ONE setting.
// Changing either must move the other and must persist across a reload —
// there is no shared state between them, only the `seedlings:theme-changed`
// event and localStorage, so this is the test that proves the wiring.
const PAGE_BG: Record<string, string> = {
  original: "rgb(255, 255, 255)",
  dark: "rgb(18, 21, 26)",
  spring: "rgb(230, 244, 224)",
  fall: "rgb(251, 240, 216)",
};

test("header chip and Profile picker stay in step, and the choice persists", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_theme", "original");
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("profile"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByTestId("theme-option-original").waitFor({ state: "visible", timeout: 45_000 });

  const state = () => page.evaluate(() => ({
    attr: document.documentElement.getAttribute("data-theme"),
    stored: localStorage.getItem("seedlings_theme"),
    body: getComputedStyle(document.body).backgroundColor,
    // Which row the PROFILE picker marks active, read from its own DOM.
    profileActive: document.querySelector('[data-testid^="theme-option-"][data-active="true"]')
      ?.getAttribute("data-testid") ?? null,
  }));

  // 1. Change from the HEADER chip -> the Profile picker must follow.
  await page.getByTestId("theme-chip").click();
  await page.getByTestId("theme-chip-option-dark").click();
  await page.waitForTimeout(500);
  let s = await state();
  console.log("AFTER chip->dark  " + JSON.stringify(s));
  expect(s.attr, "chip did not apply the theme").toBe("dark");
  expect(s.stored, "chip did not persist the theme").toBe("dark");
  expect(s.body).toBe(PAGE_BG.dark);
  // The Profile row for dark must now render as the active one.
  await expect(page.getByTestId("theme-option-dark")).toHaveAttribute("data-active", "true");

  // 2. Change from the PROFILE picker -> the header chip must follow.
  await page.getByTestId("theme-option-spring").click();
  await page.waitForTimeout(500);
  s = await state();
  console.log("AFTER profile->spring  " + JSON.stringify(s));
  expect(s.attr).toBe("spring");
  expect(s.stored).toBe("spring");
  expect(s.body).toBe(PAGE_BG.spring);
  // The chip's own label reflects the new theme.
  await expect(page.getByTestId("theme-chip")).toHaveAttribute("title", /Spring/);

  // 3. It survives a reload.
  await page.goto("/");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(2000);
  s = await state();
  console.log("AFTER reload  " + JSON.stringify(s));
  expect(s.attr, "the theme did not survive a reload").toBe("spring");
  expect(s.body).toBe(PAGE_BG.spring);
});
