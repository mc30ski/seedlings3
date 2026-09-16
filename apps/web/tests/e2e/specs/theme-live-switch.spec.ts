import { test, expect } from "@playwright/test";

// SWITCHING, not loading.
//
// Every other theme check in this repo reloads the page, which hides a whole
// class of bug: anything the boot script sets once and nothing updates
// afterwards. `--seedlings-boot-bg` was exactly that — an inline style on
// <html> that paints the page background. Changing theme from the picker
// re-skinned every card and left the page on the previous theme's colour.
const PAGE_BG: Record<string, string> = {
  original: "rgb(255, 255, 255)",
  dark: "rgb(18, 21, 26)",
  spring: "rgb(230, 244, 224)",
  fall: "rgb(251, 240, 216)",
  contrast: "rgb(255, 255, 255)",
  funkadelic: "rgb(21, 0, 41)",
  summer: "rgb(255, 248, 234)",
  winter: "rgb(168, 196, 236)",
  retro: "rgb(43, 45, 66)",
  urban: "rgb(20, 20, 20)",
  jelly: "rgb(240, 221, 255)",
  juice: "rgb(253, 238, 194)",
};

test("switching theme live repaints the page, not just the cards", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_theme", "dark");
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("profile"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle").catch(() => {});
  // Deliberately a WORKER account. The Appearance card is gated on `isSelf`,
  // and for an admin/super that resolves through the profile's user picker
  // (`targetUserId = isAdmin ? selectedUserId : me.id`, default ""), so the
  // card is absent until they select themselves. A worker always sees it,
  // and the bug under test is theme-wide, not role-specific.
  //
  // The card renders after the tab's async data lands, so wait for the
  // control itself rather than guessing at a delay.
  await page.getByTestId("theme-option-original").waitFor({ state: "visible", timeout: 45_000 });

  const read = () => page.evaluate(() => ({
    bootVar: document.documentElement.style.getPropertyValue("--seedlings-boot-bg").trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    theme: document.documentElement.getAttribute("data-theme"),
  }));

  // Click through every theme in the picker WITHOUT reloading.
  for (const id of ["original", "spring", "summer", "fall", "winter", "contrast", "funkadelic", "retro", "urban", "jelly", "juice", "dark"]) {
    const row = page.getByTestId(`theme-option-${id}`);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.waitForTimeout(600);
    const got = await read();
    console.log(`SWITCH -> ${id.padEnd(9)} data-theme=${String(got.theme).padEnd(9)} bootVar=${got.bootVar.padEnd(9)} body=${got.bodyBg}`);
    expect(got.theme, `${id}: data-theme`).toBe(id === "original" ? null : id);
    expect(got.bodyBg, `${id}: the PAGE background must follow the theme, not stay on the previous one`)
      .toBe(PAGE_BG[id]);
  }
});
