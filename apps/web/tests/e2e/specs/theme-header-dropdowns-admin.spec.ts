import { test, expect } from "@playwright/test";

// Dropdowns that open FROM THE TITLE BAR inherit its `color`, which is
// `chrome.headerFg` — white in High contrast, pale green in Spring, cream in
// Fall. A panel painting its own `bg.panel` and inheriting that ink rendered
// near-white labels on a white panel: the rows were present, only their icons
// visible. Every header panel must state its own colour.
const THEMES = ["original", "dark", "contrast", "spring", "summer", "fall", "winter",
                "funkadelic", "retro", "coffeehouse", "espresso",
                "urban", "jelly", "juice"];

for (const theme of THEMES) {
  test(`header dropdown text is legible in ${theme}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await page.evaluate((t) => {
      localStorage.setItem("seedlings_theme", t);
      localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
      localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
      localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    }, theme);
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500);

    const check = async (label: string) => {
      const rows = await page.evaluate(() => {
        const lum = (c: string) => {
          const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/); if (!m) return -1;
          const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
        };
        const out: any[] = [];
        for (const el of Array.from(document.querySelectorAll('[role="menu"], [aria-label*="switch role"] + div, div')) as HTMLElement[]) {
          if (getComputedStyle(el).position !== "absolute") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 80 || r.top > 260) continue;
          let bg = "";
          for (let n: HTMLElement | null = el; n; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (/^rgb\(/.test(c)) { bg = c; break; }
          }
          if (!bg) continue;
          for (const t of Array.from(el.querySelectorAll("*")) as HTMLElement[]) {
            const own = Array.from(t.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim());
            if (!own) continue;
            const fg = getComputedStyle(t).color;
            const lf = lum(fg), lb = lum(bg);
            if (lf < 0 || lb < 0) continue;
            const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
            out.push({ text: (t.textContent || "").trim().slice(0, 18), fg, bg, ratio: Math.round(ratio * 100) / 100 });
          }
        }
        return out;
      });
      const bad = rows.filter((r) => r.ratio < 3);
      console.log(`HDR[${theme}] ${label}: ${rows.length} text nodes, ${bad.length} below 3:1`
        + (bad.length ? " -> " + bad.slice(0, 3).map((b: any) => `"${b.text}" ${b.ratio}:1`).join(", ") : ""));
      expect(bad, `${label} has unreadable rows in ${theme}`).toEqual([]);
    };

    const role = page.locator('[aria-label*="switch role"]');
    if (await role.count()) { await role.first().click(); await page.waitForTimeout(400); await check("role"); await page.keyboard.press("Escape"); }
    await page.getByTestId("theme-chip").click();
    await page.waitForTimeout(400);
    await check("theme");
  });
}
