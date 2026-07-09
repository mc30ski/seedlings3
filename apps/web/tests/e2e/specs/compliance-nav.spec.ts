import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  resetWorkerCompliance,
  createScratchPolicy,
  cleanupScratchPolicies,
  signPolicyDirect,
  USERS,
} from "../helpers/db";
import { gotoWorkerHome } from "../helpers/nav";

/**
 * Navigation tests for the compliance banner's "View profile" button.
 * Covers the pushNavHistory fix — clicking View profile pushes the
 * previous tab state onto the browser history stack, so the back button
 * (in-app AND browser/OS gesture) returns the worker to where they were.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await resetWorkerCompliance(prisma, USERS.employee);
  await cleanupScratchPolicies(prisma);
  await prisma.$disconnect();
});

async function seedPendingPolicyForEmployee() {
  await resetWorkerCompliance(prisma, USERS.employee);
  const realPolicies = await prisma.policyDocument.findMany({
    where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
    select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
  });
  for (const p of realPolicies) {
    if (!p.currentVersion) continue;
    await signPolicyDirect(prisma, {
      userId: USERS.employee,
      policyDocumentVersionId: p.currentVersion.id,
      contentDigestAtSign: p.currentVersion.contentDigest,
    });
  }
  await cleanupScratchPolicies(prisma);
  await createScratchPolicy(prisma, {
    keyPrefix: "E2E_NAV",
    title: "E2E Nav Test Policy",
    enforcement: "BLOCK",
    createdByUserId: USERS.super,
  });
}

test.describe("View profile navigation", () => {
  test("View profile from compliance banner switches to Profile tab", async ({ page }) => {
    await seedPendingPolicyForEmployee();
    await gotoWorkerHome(page);

    const banner = page.locator('[data-testid="compliance-banner"]');
    await expect(banner).toBeVisible();

    // Confirm we're on Home before clicking.
    // The Home tab renders the workday strip / hero, which the Profile
    // tab does not — checking for the banner alone isn't enough because
    // the banner is Home-only. Use tab-outer state via localStorage.
    const beforeTop = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("seedlings_topTab") ?? '""'),
    );
    const beforeInner = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("seedlings_workerTab") ?? '""'),
    );
    expect(beforeTop).toBe("worker");
    expect(beforeInner).toBe("home");

    await banner.getByRole("button", { name: /View profile/i }).click();

    // After the click, the app should be on worker/profile.
    // usePersistedState writes to localStorage on state change; give the
    // effect a beat then read it back.
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("seedlings_workerTab") ?? '""') === "profile",
      { timeout: 5_000 },
    );
    const afterTop = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("seedlings_topTab") ?? '""'),
    );
    const afterInner = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("seedlings_workerTab") ?? '""'),
    );
    expect(afterTop).toBe("worker");
    expect(afterInner).toBe("profile");
  });

  test("browser back after View profile returns to Home tab", async ({ page }) => {
    await seedPendingPolicyForEmployee();
    await gotoWorkerHome(page);

    const banner = page.locator('[data-testid="compliance-banner"]');
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: /View profile/i }).click();

    // Wait for the profile switch to actually land.
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("seedlings_workerTab") ?? '""') === "profile",
      { timeout: 5_000 },
    );

    // Trigger the browser back gesture — pushNavHistory added a history
    // entry, so this pops it and fires popstate → restoreFromHistory().
    await page.goBack();

    // Should be back on Home tab.
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("seedlings_workerTab") ?? '""') === "home",
      { timeout: 5_000 },
    );
    const afterInner = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("seedlings_workerTab") ?? '""'),
    );
    expect(afterInner).toBe("home");

    // Banner should be visible again since we're back on Home and the
    // policy is still pending.
    await expect(page.locator('[data-testid="compliance-banner"]')).toBeVisible({
      timeout: 8_000,
    });
  });
});
