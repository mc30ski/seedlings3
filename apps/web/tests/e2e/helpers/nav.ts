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

/**
 * Navigate a Super user to Super → Directory → Compliance. Same
 * pattern as gotoWorkerHome — stamp the localStorage keys so the tab
 * router lands exactly where we want. Requires the storage state to
 * belong to a user with the SUPER role (or ADMIN, since AdminCompliance
 * is also mounted under the admin tab list).
 */
export async function gotoSuperCompliance(page: Page, opts: { path?: string } = {}) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("compliance"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Directory"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate a Super user to Super → Directory → Clients. This is where
 * the Super-only "View as this client" button lives; regular admins
 * cannot reach this tab (topTab="super" requires the SUPER role).
 */
export async function gotoSuperClients(page: Page, opts: { path?: string } = {}) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("clients"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Directory"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}

/**
 * Navigate to the admin-side Clients tab (Admin → Directory → Clients).
 * Used by tests that verify the "View as" button does NOT appear on the
 * admin variant even when the caller is Super — the purpose="ADMIN"
 * gate on ClientsTab is what enforces this.
 */
export async function gotoAdminClients(page: Page, opts: { path?: string } = {}) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("admin"));
    localStorage.setItem("seedlings_adminTab", JSON.stringify("clients"));
    localStorage.setItem("seedlings_adminCategory", JSON.stringify("Directory"));
  });
  await page.goto(path);
  await page.waitForLoadState("networkidle");
}
