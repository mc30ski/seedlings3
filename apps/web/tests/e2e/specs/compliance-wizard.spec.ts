import { test, expect, Page } from "@playwright/test";
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
 * Wizard-level tests. Covers the Cancel button and the
 * `policies:wizard-closed` event dispatch — the mechanism api.ts relies
 * on for its auto-retry-after-signing behavior.
 *
 * Not attempting a full end-to-end auto-retry test here (would need a
 * gated action like startWorkday plus workday state fixtures). The event
 * dispatch is the load-bearing part — if this fires with the correct
 * completed value, api.ts's simple await + retry can be trusted.
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

async function clearAllRealPolicies(userId: string) {
  await resetWorkerCompliance(prisma, userId);
  const realPolicies = await prisma.policyDocument.findMany({
    where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
    select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
  });
  for (const p of realPolicies) {
    if (!p.currentVersion) continue;
    await signPolicyDirect(prisma, {
      userId,
      policyDocumentVersionId: p.currentVersion.id,
      contentDigestAtSign: p.currentVersion.contentDigest,
    });
  }
}

/** Attach a listener that captures every `policies:wizard-closed` event
 *  detail into a window-scoped array we can pull down via evaluate. */
async function instrumentWizardClosed(page: Page) {
  await page.evaluate(() => {
    (window as any).__wizardClosedEvents = [];
    (window as any).__policiesSignedEvents = 0;
    window.addEventListener("policies:wizard-closed", (e: Event) => {
      const detail = (e as CustomEvent).detail;
      (window as any).__wizardClosedEvents.push(detail);
    });
    window.addEventListener("policies:signed", () => {
      (window as any).__policiesSignedEvents++;
    });
  });
}

async function readWizardEvents(page: Page): Promise<{
  closed: Array<{ completed: boolean }>;
  signed: number;
}> {
  return page.evaluate(() => ({
    closed: (window as any).__wizardClosedEvents ?? [],
    signed: (window as any).__policiesSignedEvents ?? 0,
  }));
}

test.describe("Wizard: Cancel button", () => {
  test("Cancel button is present and visible on the sign step", async ({ page }) => {
    await clearAllRealPolicies(USERS.employee);
    await cleanupScratchPolicies(prisma);
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_WIZARD_CANCEL",
      title: "E2E Wizard Cancel",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoWorkerHome(page);
    const banner = page.locator('[data-testid="compliance-banner"]');
    await expect(banner).toBeVisible();
    await banner.getByRole("button", { name: /Sign now/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.first()).toBeVisible({ timeout: 8_000 });

    const cancelBtn = dialog.getByRole("button", { name: /^Cancel$/i });
    await expect(cancelBtn).toBeVisible();
    await expect(cancelBtn).toBeEnabled();
  });

  test("clicking Cancel closes the wizard AND fires policies:wizard-closed { completed: false }", async ({ page }) => {
    await clearAllRealPolicies(USERS.employee);
    await cleanupScratchPolicies(prisma);
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_WIZARD_CANCEL_EVT",
      title: "E2E Wizard Cancel Event",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoWorkerHome(page);
    await instrumentWizardClosed(page);

    const banner = page.locator('[data-testid="compliance-banner"]');
    await banner.getByRole("button", { name: /Sign now/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.first()).toBeVisible({ timeout: 8_000 });
    await dialog.getByRole("button", { name: /^Cancel$/i }).click();
    await expect(dialog.first()).toBeHidden({ timeout: 8_000 });

    const events = await readWizardEvents(page);
    // At least one wizard-closed event fired, all with completed=false.
    expect(events.closed.length).toBeGreaterThanOrEqual(1);
    for (const evt of events.closed) {
      expect(evt.completed).toBe(false);
    }
    // No policies:signed should have fired (worker never completed).
    expect(events.signed).toBe(0);
  });
});

test.describe("Wizard: successful sign flow", () => {
  test("completing sign fires policies:signed then policies:wizard-closed { completed: true }", async ({ page }) => {
    await clearAllRealPolicies(USERS.employee);
    await cleanupScratchPolicies(prisma);
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_WIZARD_SIGN",
      title: "E2E Wizard Sign Complete",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoWorkerHome(page);
    await instrumentWizardClosed(page);

    const banner = page.locator('[data-testid="compliance-banner"]');
    await banner.getByRole("button", { name: /Sign now/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.first()).toBeVisible({ timeout: 8_000 });

    // Read step — Continue button becomes enabled once the read is
    // complete. Short scratch content auto-completes on mount because
    // the container fits without scrolling; wait for enable.
    const continueBtn = dialog.getByRole("button", { name: /Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
    await continueBtn.click();

    // Sign step — wait for the sign-step label ("Type your legal name")
    // to confirm the transition landed, then fill the name input.
    await expect(page.getByText(/Type your legal name/i)).toBeVisible({
      timeout: 5_000,
    });
    const nameInput = page.getByPlaceholder("Employee Worker");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill("Employee Worker");

    // Also check the "I have read the document and agree to its terms"
    // acknowledgment — Sign stays disabled until both are satisfied.
    await page.getByText(/I have read the document/i).click();

    const signBtn = dialog.getByRole("button", { name: /^Sign$/i });
    await expect(signBtn).toBeEnabled({ timeout: 5_000 });
    await signBtn.click();

    // Wizard closes.
    await expect(dialog.first()).toBeHidden({ timeout: 10_000 });

    const events = await readWizardEvents(page);
    // One or more signed events (fires per-sign), one wizard-closed with
    // completed=true.
    expect(events.signed).toBeGreaterThanOrEqual(1);
    const completedTrueEvents = events.closed.filter((e) => e.completed);
    expect(completedTrueEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("after successful sign, the compliance banner disappears", async ({ page }) => {
    await clearAllRealPolicies(USERS.employee);
    await cleanupScratchPolicies(prisma);
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_WIZARD_BANNER_CLEAR",
      title: "E2E Banner Clears After Sign",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoWorkerHome(page);
    const banner = page.locator('[data-testid="compliance-banner"]');
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: /Sign now/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.first()).toBeVisible({ timeout: 8_000 });

    const continueBtn = dialog.getByRole("button", { name: /Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
    await continueBtn.click();
    await expect(page.getByText(/Type your legal name/i)).toBeVisible({
      timeout: 5_000,
    });
    const nameInput = page.getByPlaceholder("Employee Worker");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    await nameInput.fill("Employee Worker");
    await page.getByText(/I have read the document/i).click();
    const signBtn = dialog.getByRole("button", { name: /^Sign$/i });
    await expect(signBtn).toBeEnabled({ timeout: 5_000 });
    await signBtn.click();
    await expect(dialog.first()).toBeHidden({ timeout: 10_000 });

    // Banner should refetch via the policies:signed event and disappear.
    await expect(page.locator('[data-testid="compliance-banner"]')).toHaveCount(0, {
      timeout: 8_000,
    });
  });
});
