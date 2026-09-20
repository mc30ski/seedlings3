import { test, expect } from "@playwright/test";

/**
 * Two layout regressions, both reported from a phone-width screenshot of
 * Super → Equipment → Collections — the worst case in the app, because it is
 * the longest category + tab name pair.
 *
 * 1. THE (i) WAS OFF THE SCREEN. The whole breadcrumb row was the horizontal
 *    scroll container, so the right-hand actions lived inside it. With long
 *    tab names the row overflowed and the trigger was dragged past the edge —
 *    reachable only by a sideways swipe nobody knows is there. It was also
 *    the only flex item that could shrink, so it was squeezed BELOW its own
 *    content width (48px of box for 76px of buttons) and clipped its child.
 *
 * 2. THE HEADING BAND STOPPED SHORT. It was `w="full"` with `mx={-3}` against
 *    a frame with `px={3}`, but `width:100%` resolves against the CONTENT
 *    box — so the negative margins SHIFTED it 12px left instead of widening
 *    it, leaving it 24px short on the right and looking half-drawn.
 *
 * Both are invisible to a typecheck and to every static gate: the markup is
 * valid and the tokens are right. Only geometry shows them, so this spec
 * measures geometry.
 */

const NARROW = { width: 320, height: 900 };

/** The reported case. Long category + long tab name is what makes the row
 *  overflow in the first place; a short pair would pass without the fix. */
async function gotoSuperCollections(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("collections"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Equipment"));
    localStorage.setItem("seedlings_help:open", JSON.stringify(true));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

test.describe("Tab explainer — narrow screens", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(NARROW);
  });

  test("the help trigger stays on screen when the tab path is long", async ({ page }) => {
    await gotoSuperCollections(page);

    const info = page.getByRole("button", { name: /^What this tab shows$/i });
    await expect(info, "the trigger must be mounted on this tab").toBeVisible();

    const box = await info.boundingBox();
    expect(box, "the trigger must have a box").not.toBeNull();

    // `toBeVisible()` is NOT enough here: an element scrolled outside a
    // clipping ancestor still reports visible. The bug was entirely about
    // WHERE it was, so assert the coordinates.
    expect(
      Math.round(box!.x + box!.width),
      `the trigger's right edge (${Math.round(box!.x + box!.width)}) must be inside the ${NARROW.width}px viewport`,
    ).toBeLessThanOrEqual(NARROW.width);
    expect(Math.round(box!.x), "and its left edge must not be off the other side").toBeGreaterThanOrEqual(0);

    // It must also keep its full size. The old failure squeezed the actions
    // box below its content width, so the button was clipped while still
    // being nominally "on screen".
    expect(Math.round(box!.width), "the trigger must not be compressed").toBeGreaterThanOrEqual(24);

    // And it must still work from here — an on-screen control that cannot be
    // clicked is the same bug wearing a different coat.
    await info.click();
    await expect(page.getByRole("button", { name: /^Hide What this tab shows$/i })).toHaveCount(0);
    await info.click();
    await expect(page.getByRole("button", { name: /^Hide What this tab shows$/i })).toBeVisible();
  });

  test("the heading band spans the full width of the panel", async ({ page }) => {
    await gotoSuperCollections(page);

    const measured = await page.evaluate(() => {
      const band = document.querySelector('button[aria-label^="Hide What this tab shows"]');
      const panel = band?.parentElement ?? null;
      if (!band || !panel) return null;
      return {
        // clientWidth excludes the panel's borders (2px frame + 6px accent
        // rail), which is exactly the width a full-bleed child should fill.
        panelInner: Math.round(panel.clientWidth),
        bandWidth: Math.round(band.getBoundingClientRect().width),
      };
    });

    expect(measured, "the open panel and its heading band must both exist").not.toBeNull();
    expect(measured!.panelInner, "sanity: the panel must have real width").toBeGreaterThan(100);
    expect(
      measured!.bandWidth,
      `the band (${measured!.bandWidth}px) must fill the panel's inner width (${measured!.panelInner}px)`,
    ).toBe(measured!.panelInner);
  });

  test("the panel's copy shares one left and right edge, role sections included", async ({ page }) => {
    // The frame stopped carrying inline padding so the band could be
    // full-bleed, which moved that padding onto the copy. A RoleSection that
    // picks up its own copy of it indents the Admin and Super paragraphs
    // relative to the base text — which is what happened on the first pass.
    await gotoSuperCollections(page);

    const edges = await page.evaluate(() => {
      const band = document.querySelector('button[aria-label^="Hide What this tab shows"]');
      const panel = band?.parentElement;
      if (!panel) return null;
      return [...panel.querySelectorAll("p")]
        // Drop the heading itself and the small "in addition to everything
        // above" captions — those are deliberately inset next to their badge.
        .filter((p) => (p.textContent || "").length > 40)
        .map((p) => {
          const b = p.getBoundingClientRect();
          return { l: Math.round(b.left), r: Math.round(b.right) };
        });
    });

    expect(edges, "paragraphs must be measurable").not.toBeNull();
    expect(edges!.length, "this tab has base copy plus Admin and Super sections").toBeGreaterThanOrEqual(3);
    const lefts = new Set(edges!.map((e) => e.l));
    const rights = new Set(edges!.map((e) => e.r));
    expect([...lefts], "every paragraph shares one left edge").toHaveLength(1);
    expect([...rights], "every paragraph shares one right edge").toHaveLength(1);
  });
});
