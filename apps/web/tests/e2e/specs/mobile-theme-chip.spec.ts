import { test, expect } from "@playwright/test";

// The header chip's dropdown is anchored to the RIGHT edge of a control that
// sits near the right edge of the screen, so any width it gains pushes it off
// the LEFT edge. It first shipped with only a `minW` and the descriptions
// grew it past 600px — unreadable on a phone. This pins the panel inside the
// viewport at the narrowest width the app supports.
for (const width of [320, 390, 430]) {
  test(`theme dropdown fits a ${width}px viewport`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 780 });
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("seedlings_theme", "original");
      localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
      localStorage.setItem("seedlings_workerTab", JSON.stringify("home"));
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.getByTestId("theme-chip").waitFor({ state: "visible", timeout: 45_000 });
    await page.getByTestId("theme-chip").click();
    const panel = page.getByTestId("theme-chip-option-original");
    await panel.waitFor({ state: "visible" });

    const box = await page.evaluate(() => {
      const el = document.querySelector('[role="menu"]') as HTMLElement;
      const r = el.getBoundingClientRect();
      // Does any option's text get clipped?
      const clipped = Array.from(document.querySelectorAll('[data-testid^="theme-chip-option-"]'))
        .some((o) => o.scrollWidth > o.clientWidth + 1);
      return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), clipped };
    });
    console.log(`FIT ${width}px -> panel left=${box.left} right=${box.right} w=${box.w} clipped=${box.clipped}`);
    expect(box.left, "panel runs off the left edge").toBeGreaterThanOrEqual(0);
    expect(box.right, "panel runs off the right edge").toBeLessThanOrEqual(width);
    expect(box.clipped, "an option's content is clipped").toBe(false);
  });
}
