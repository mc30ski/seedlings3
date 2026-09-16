import { test, expect } from "@playwright/test";

// A pulse is a box-shadow ring drawn at ~0.45 alpha over the page, so its
// visibility is purely its contrast with that theme's OWN background. The
// tints were hand-written for two themes; every theme added afterwards
// inherited the light values and pulsed almost invisibly — loudest on the
// dark-grounded ones, where the ring matched the page it sat on.
const THEMES = ["original", "dark", "contrast", "spring", "summer", "fall", "winter",
                "funkadelic", "retro", "coffeehouse", "espresso",
                "urban", "jelly", "juice"];

test("every pulse tint reads against its own theme's page", async ({ page }) => {
  test.setTimeout(300_000);
  let worstOverall = { theme: "", tint: "", ratio: 99 };
  for (const theme of THEMES) {
    await page.goto("/");
    await page.evaluate((t) => {
      localStorage.setItem("seedlings_theme", t);
      localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
      localStorage.setItem("seedlings_workerTab", JSON.stringify("home"));
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    }, theme);
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);
    const res = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const lum = (c: number[]) => {
        const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const pageM = getComputedStyle(document.body).backgroundColor.match(/(\d+),\s*(\d+),\s*(\d+)/)!;
      const pl = lum([+pageM[1], +pageM[2], +pageM[3]]);
      const names = ["pink","orange","blue","cyan","purple","red","ghost","gray","yellow","green","instruction"];
      return names.map((n) => {
        const raw = cs.getPropertyValue("--pulse-" + n).trim();
        const p = raw.split(",").map((x) => parseFloat(x));
        if (p.length !== 3 || p.some(isNaN)) return { n, ratio: -1 };
        const tl = lum(p);
        return { n, ratio: Math.round(((Math.max(tl, pl) + 0.05) / (Math.min(tl, pl) + 0.05)) * 100) / 100 };
      });
    });
    const missing = res.filter((r) => r.ratio < 0);
    const worst = res.filter((r) => r.ratio >= 0).sort((a, b) => a.ratio - b.ratio)[0];
    console.log(`PULSE ${theme.padEnd(12)} worst=${worst.n} ${worst.ratio}:1  (${res.length} tints, ${missing.length} undefined)`);
    expect(missing, `${theme}: undefined pulse tints`).toEqual([]);
    expect(worst.ratio, `${theme}: "${worst.n}" pulse barely separates from the page`).toBeGreaterThanOrEqual(3);
    if (worst.ratio < worstOverall.ratio) worstOverall = { theme, tint: worst.n, ratio: worst.ratio };
  }
  console.log(`PULSE worst across all themes: ${worstOverall.tint} in ${worstOverall.theme} at ${worstOverall.ratio}:1`);
});
