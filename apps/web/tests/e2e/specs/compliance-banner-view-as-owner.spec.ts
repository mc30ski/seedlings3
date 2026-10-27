import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  resetWorkerCompliance,
  createScratchPolicy,
  cleanupScratchPolicies,
  USERS,
} from "../helpers/db";

/**
 * View-as regression: when someone with `compliance.manage` navigates to Work → Home and
 * selects a worker via "View as", the ComplianceBanner must reflect the
 * TARGET worker's pending items — not the caller's own. The banner was
 * previously disabled in view-as mode, which meant someone with `compliance.manage` had no way to
 * see that a worker was gated on compliance without hopping to the
 * Compliance matrix.
 *
 * This test:
 *   1. Resets the employee's compliance state
 *   2. Seeds a fresh BLOCK-level policy that targets the employee
 *   3. Loads Home as Super with selectedWorkers = [employee]
 *   4. Asserts the compliance banner renders with the employee's context
 *      (third-person phrasing, "Manage in Compliance" CTA, no Sign now)
 */

let prisma: PrismaClient;
let scratchPolicyId: string | null = null;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await resetWorkerCompliance(prisma, USERS.employee);
  await cleanupScratchPolicies(prisma);
  await prisma.$disconnect();
});

test.describe("Compliance banner in Admin view-as", () => {
  test("View-as sees the target worker's pending compliance in the banner", async ({ page }) => {
    // 1. Reset employee state
    await resetWorkerCompliance(prisma, USERS.employee);

    // 2. Seed a scratch BLOCK policy targeting the employee so we know
    //    something must render — the exact copy in the banner depends
    //    on this being present.
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_VIEWAS",
      title: "E2E View-As Scratch Policy",
      targetWorkerTypes: ["EMPLOYEE"],
      enforcement: "BLOCK",
      workerAction: "ACKNOWLEDGE",
      createdByUserId: USERS.owner,
    });
    scratchPolicyId = scratch.policyId;

    // 3. Load Work → Home with the employee pre-selected
    await page.goto("/");
    await page.evaluate((employeeId) => {
      localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
      // Also stamp the first-open marker: without it the "auto-show Home
      // on the first open of the ET day" effect in pages/index.tsx fires
      // on the reload below and discards the tab stamped here. It is
      // suppressed after 22:00 ET, so a spec missing this passes at
      // night and fails in the afternoon.
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
      localStorage.setItem("seedlings_staffTab", JSON.stringify("home"));
      localStorage.setItem("seedlings_staffCategory", JSON.stringify("Work"));
      // HomeTab's view-as picker persists via
      // usePersistedState("homeTab_viewAsIds"), which prefixes
      // "seedlings_". Exactly ONE id = view-as on one person (0 = All
      // Workers aggregate, N = subset) — the mode this spec exercises.
      // The old "seedlings_home_workers" key was read by nothing,
      // so this test silently ran in SELF mode and never covered view-as.
      localStorage.setItem("seedlings_homeTab_viewAsIds", JSON.stringify([employeeId]));
    }, USERS.employee);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 4. Assert the compliance banner rendered — this is what was broken.
    //    In view-as mode the banner must:
    //      - be present at all
    //      - use third-person copy naming the target (not "You have...")
    //      - show a "Manage in Compliance" button, not Sign now / View profile
    const banner = page.getByTestId("compliance-banner");
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toHaveAttribute("data-severity", "block");
    // Third-person copy (target's name or "This worker")
    const bannerText = await banner.textContent();
    expect(bannerText).not.toMatch(/^You have/i);
    // View-as-mode CTA
    await expect(banner.getByRole("button", { name: /Manage in Compliance/i })).toBeVisible();
    // Self-service CTAs should NOT appear
    await expect(banner.getByRole("button", { name: /Sign now/i })).toHaveCount(0);
    await expect(banner.getByRole("button", { name: /^View profile$/i })).toHaveCount(0);
  });
});
