import { test, expect } from "@playwright/test";

// THE FIRST PAINT, not the settled page.
//
// The splash renders before React and before any Chakra token exists, and it
// paints the body through an INLINE style — which outranks every stylesheet,
// including the themed shield. Hardcoded white there meant a dark-theme
// refresh flashed white before the app faded in. Everything this asserts
// happens in the first few hundred ms, so it is sampled by an observer
// installed ahead of the page's own scripts.
const EXPECT: Record<string, string> = {
  dark: "rgb(18, 21, 26)",
  spring: "rgb(230, 244, 224)",
  fall: "rgb(251, 240, 216)",
  funkadelic: "rgb(21, 0, 41)",
  retro: "rgb(43, 45, 66)",
  winter: "rgb(168, 196, 236)",
};

for (const [theme, want] of Object.entries(EXPECT)) {
  test(`splash paints the ${theme} page colour, never white`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await page.evaluate((t) => {
      localStorage.setItem("seedlings_theme", t);
      localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
      localStorage.setItem("seedlings_workerTab", JSON.stringify("home"));
      localStorage.removeItem("seedlings_lastAppOpenedAt"); // force the splash
    }, theme);

    await page.addInitScript(() => {
      (window as any).__splash = [];
      const snap = () => {
        const ov = document.querySelector('[data-app-splash-overlay="1"]') as HTMLElement | null;
        const shield = document.getElementById("pre-splash-shield");
        if (!document.body) return;
        (window as any).__splash.push({
          overlay: ov ? getComputedStyle(ov).backgroundColor : null,
          shield: shield ? getComputedStyle(shield).backgroundColor : null,
          body: getComputedStyle(document.body).backgroundColor,
        });
      };
      const iv = setInterval(snap, 30);
      setTimeout(() => clearInterval(iv), 4000);
    });

    await page.goto("/");
    await page.waitForTimeout(3000);
    const frames: any[] = await page.evaluate(() => (window as any).__splash ?? []);
    const overlays = frames.map((f) => f.overlay).filter(Boolean);
    const shields = frames.map((f) => f.shield).filter(Boolean);
    const bodies = frames.map((f) => f.body).filter(Boolean);
    const white = "rgb(255, 255, 255)";
    console.log(`SPLASH[${theme}] frames=${frames.length} overlay=${[...new Set(overlays)].join("|") || "none"} `
      + `shield=${[...new Set(shields)].join("|") || "none"} bodyWhiteFrames=${bodies.filter((b) => b === white).length}`);

    if (overlays.length) expect([...new Set(overlays)], "splash overlay was white").not.toContain(white);
    if (shields.length) expect([...new Set(shields)], "pre-splash shield was white").not.toContain(white);
    expect(bodies.filter((b) => b === white).length, `the body flashed white in ${theme}`).toBe(0);
    expect(bodies, "body never reached the theme colour").toContain(want);
  });
}
