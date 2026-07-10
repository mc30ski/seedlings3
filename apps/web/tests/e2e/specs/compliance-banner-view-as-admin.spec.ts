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
 * View-as regression: when a Super navigates to Admin → Work → Home and
 * selects a worker via "View as", the ComplianceBanner must reflect the
 * TARGET worker's pending items — not the caller's own. The banner was
 * previously disabled in view-as mode, which meant a Super had no way to
 * see that a worker was gated on compliance without hopping to the
 * Compliance matrix.
 *
 * This test:
 *   1. Resets the employee's compliance state
 *   2. Seeds a fresh BLOCK-level policy that targets the employee
 *   3. Loads Admin → Home as Super with selectedWorkers = [employee]
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
  test("Super view-as a worker sees the target worker's pending compliance in the banner", async ({ page }) => {
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
      createdByUserId: USERS.super,
    });
    scratchPolicyId = scratch.policyId;

    // 3. Load Admin → Work → Home with the employee pre-selected
    await page.goto("/");
    await page.evaluate((employeeId) => {
      localStorage.setItem("seedlings_topTab", JSON.stringify("admin"));
      localStorage.setItem("seedlings_adminTab", JSON.stringify("home"));
      localStorage.setItem("seedlings_adminCategory", JSON.stringify("Work"));
      localStorage.setItem("seedlings_adminhome_workers", JSON.stringify([employeeId]));
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
