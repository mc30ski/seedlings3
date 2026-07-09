import type { Page } from "@playwright/test";

/**
 * Force the worker view + Home inner tab BEFORE navigating. The app
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
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("home"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}
