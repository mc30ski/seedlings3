import { expect, type Page } from "@playwright/test";

/**
 * Force the self-scoped view + Home inner tab BEFORE navigating. The app
 * persists `topTab` and `workerInnerTab` in localStorage, and defaults
 * `topTab` to "client" for a first-time storage state. Rather than
 * relying on the "auto-jump to Home tab on first open of the day" logic
 * (which only fires on a fresh ET day), tests explicitly stamp these
 * values so a worker load always starts on the worker Home dashboard —
 * exactly where the ComplianceBanner renders.
 */
export async function gotoWorkerHome(page: Page, opts: { path?: string } = {}) {
  // First navigate to a light page so we have a same-origin document to
  // write localStorage on. Then stamp the keys and reload into Home.
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    // usePersistedState wraps keys with the `seedlings_` prefix.
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    // Without this, the "first open of the day" takeover (pages/index.tsx)
    // fires on the reload below and drags a worker to Work → Home, discarding
    // the tab we just stamped. It only fires for somebody with a workerType,
    // which is why this only ever bit the worker projects.
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("home"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Work"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate to Compliance. Stamps the keys the app actually persists so
 * the tab router lands exactly where we want. Requires storage state for
 * an account holding `compliance.view`.
 *
 * THE KEYS WERE WRONG. This wrote `seedlings_topTab: "super"` plus
 * `seedlings_staffTab` / `seedlings_staffCategory`. The app persists
 * `topTab` as `"client" | "staff"` and reads `seedlings_staffTab` /
 * `seedlings_staffCategory` (see pages/index.tsx). "super" was coerced
 * to "staff" by the migration and the other two keys were read by
 * nothing — so this helper did not land on Compliance at all; it left
 * whatever tab was already persisted.
 */
export async function gotoCompliance(page: Page, opts: { path?: string } = {}) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("compliance"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Records"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate to Clients. The "View as this client" button lives here and
 * is gated on `clients.view-as`, so whether it renders depends on the
 * account, not on how you got to the tab.
 *
 * Same wrong-keys fix as gotoCompliance above.
 */
export async function gotoClients(page: Page, opts: { path?: string } = {}) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("clients"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Directory"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate to the Education guides tab. Open to everyone by design —
 * training material is read by the people doing the work — and its
 * TAB_REQUIREMENTS row is ALWAYS. Canonical spec: docs/features/education.md.
 *
 * It took a role parameter and stamped per-role keys; there is one staff
 * tab list and one set of keys now.
 *
 * NOTE: stamping the keys reaches the tab even when no category maps to
 * it — which is exactly how a shipped bug hid here (there was no
 * clickable route to Guides while this helper worked fine).
 * `gotoGuidesByClicking` is the one that proves the nav exists; this one
 * is for tests about the tab's contents.
 */
export async function gotoGuides(
  page: Page,
  opts: { path?: string } = {},
) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("guides"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Records"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await waitForGuidesRendered(page);
}

/**
 * Wait until the Guides tab has actually painted its catalog.
 *
 * `networkidle` says the network went quiet, not that React rendered —
 * and a fixed `waitForTimeout` after it is a guess that gets shorter as
 * the machine gets busier. Under a three-project run with the dev server
 * compiling, 2s stopped being enough and DOM assertions failed
 * intermittently on content that arrived a moment later.
 *
 * The search box is the anchor: it renders with the tab regardless of
 * how many guides come back, so this also works for an empty catalog.
 */
export async function waitForGuidesRendered(page: Page) {
  await page.getByPlaceholder(/Search guides/i).waitFor({ state: "visible", timeout: 30_000 });
}

/**
 * Reach Guides the way a person does: pick the category, then the tab.
 *
 * A tab can be in the tab list and still be unreachable if no category
 * maps to it — it lands nowhere and never renders in the nav.
 * Stamped-localStorage navigation cannot see that class of bug; this can.
 */
export async function gotoGuidesByClicking(
  page: Page,
  opts: { path?: string } = {},
) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    // Deliberately NOT setting the inner tab or category — the point is
    // to walk there through the UI.
    localStorage.removeItem("seedlings_staffTab");
    localStorage.removeItem("seedlings_staffCategory");
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);

  // The category nav is a dropdown showing the CURRENT category, so the
  // first click opens the list rather than selecting anything.
  await page.locator("[data-category-trigger], button").filter({ hasText: /^(Work|Records|Equipment|Directory|Money|System)$/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByText("Records", { exact: true }).first().click();
  await page.waitForTimeout(1200);

  // Same again for the inner tab.
  await page.locator("button").filter({ hasText: /^(Home|Guides|Documents|Timeline|History|Activity)$/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByText("Guides", { exact: true }).first().click();
  await waitForGuidesRendered(page);
}

/**
 * Wait until the Jobs tab has finished loading its occurrences.
 *
 * The list renders "No job occurrences match current filters." while the
 * fetch is still in flight, so a fixed `waitForTimeout` after
 * `networkidle` reads an empty list as a real one — two specs asserted
 * against a half-loaded page and failed depending on how busy the machine
 * was. The toolbar's refresh button carries `loading={loading}`, which is
 * the same flag the list reads, so it is enabled exactly when the list is
 * settled.
 */
export async function waitForJobsListSettled(page: Page) {
  const refresh = page.getByRole("button", { name: /Refresh jobs/i });
  await refresh.waitFor({ state: "visible", timeout: 60_000 });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  // A second load follows the first on this tab (pins, ghost counts). Give
  // it a beat to start, then wait it out too.
  await page.waitForTimeout(500);
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
}

/**
 * Wait until the splash overlay is off the page.
 *
 * `toBeVisible()` does not hit-test, so an element under the splash
 * reports visible while a click on it times out — which is what entering a
 * client "View as" session looked like: the banner asserted fine and the
 * very next click waited out its timeout. AppSplash holds for up to
 * HARD_MAX_MS (15s) plus its fade, so this waits past that.
 */
export async function waitForSplashGone(page: Page) {
  const overlay = page.locator('[data-app-splash-overlay="1"]');
  // Absent is not the same as finished: straight after a reload the
  // overlay has not mounted yet, so a bare `detached` wait returns on the
  // gap before it appears — and switching shells re-fetches `me`, which
  // brings it back. Require it to stay away.
  await expect
    .poll(
      async () => {
        for (let i = 0; i < 4; i++) {
          if ((await overlay.count()) > 0) return false;
          await page.waitForTimeout(400);
        }
        return true;
      },
      { timeout: 45_000, message: "the splash overlay never stayed away" },
    )
    .toBe(true);
}
