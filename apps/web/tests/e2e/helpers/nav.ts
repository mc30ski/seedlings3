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

/**
 * Navigate to the Education guides tab. Present for every role by
 * design — training material is read by the people doing the work — so
 * the role is a parameter rather than three near-identical helpers.
 * Canonical spec: docs/features/education.md.
 *
 * NOTE: stamping both keys reaches the tab even when the role's `catMap`
 * has no entry for it — which is exactly how a shipped bug hid here (a
 * worker had no clickable route to Guides while this helper worked
 * fine). `gotoGuidesByClicking` is the one that proves the nav exists;
 * this one is for tests about the tab's contents.
 */
export async function gotoGuides(
  page: Page,
  role: "worker" | "admin" | "super",
  opts: { path?: string } = {},
) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate((r: string) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify(r));
    localStorage.setItem(`seedlings_${r}Tab`, JSON.stringify("guides"));
    localStorage.setItem(`seedlings_${r}Category`, JSON.stringify("Records"));
  }, role);
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
 * A tab can be registered in a role's tab list and still be unreachable
 * if the role's `catMap` has no entry for it — it lands in no category
 * and never renders in the nav. Stamped-localStorage navigation cannot
 * see that class of bug; this can.
 */
export async function gotoGuidesByClicking(
  page: Page,
  role: "worker" | "admin" | "super",
  opts: { path?: string } = {},
) {
  const path = opts.path ?? "/";
  await page.goto(path);
  await page.evaluate((r: string) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify(r));
    // Deliberately NOT setting the inner tab or category — the point is
    // to walk there through the UI.
    localStorage.removeItem(`seedlings_${r}Tab`);
    localStorage.removeItem(`seedlings_${r}Category`);
  }, role);
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
