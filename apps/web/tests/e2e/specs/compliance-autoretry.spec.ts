import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  resetWorkerCompliance,
  resetWorkdayState,
  createScratchPolicy,
  cleanupScratchPolicies,
  signPolicyDirect,
  USERS,
} from "../helpers/db";
import { gotoWorkerHome } from "../helpers/nav";

/**
 * End-to-end auto-retry integration test.
 *
 * The load-bearing behavior added to `lib/api.ts` on 2026-07-09: when a
 * request comes back with POLICIES_REQUIRED, api.ts awaits the sign
 * wizard's outcome and, if the worker signed everything, transparently
 * retries the original request. Every gated action in the app benefits
 * from this — workday start, job claim, equipment reserve.
 *
 * The other test files (compliance-wizard.spec.ts) verify the
 * `policies:wizard-closed` event dispatch — that's the mechanism api.ts
 * relies on. This spec confirms the whole chain end-to-end using the
 * real gated action: try to start the workday, get gated, sign the
 * pending policy, and observe that the workday actually starts (no
 * manual retry needed).
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  // Reset both compliance and workday state so we don't leave the
  // Employee seed user in a weird half-signed / half-started state.
  await resetWorkerCompliance(prisma, USERS.employee);
  await cleanupScratchPolicies(prisma);
  await resetWorkdayState(prisma, USERS.employee);
  await prisma.$disconnect();
});

async function clearAllRealPoliciesFor(userId: string) {
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

test.describe("Auto-retry: workday start → sign → workday actually starts", () => {
  test("api.ts transparently retries startWorkday after the sign wizard completes", async ({ page }) => {
    // Setup:
    //   - Employee has no active workday and no dangling priors.
    //   - Employee has signed every real EMPLOYEE-targeting policy, so
    //     only our scratch policy is pending.
    //   - Scratch policy is BLOCK-level, targets Employee, and gates
    //     WORKDAY_START — meaning the server will actually reject the
    //     workday-start API call until the worker signs.
    await resetWorkdayState(prisma, USERS.employee);
    await clearAllRealPoliciesFor(USERS.employee);
    await cleanupScratchPolicies(prisma);
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_AUTORETRY",
      title: "E2E AutoRetry Gate",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });
    // The scratch policy fixture doesn't set gatesServices by default;
    // patch the row directly to gate WORKDAY_START.
    await prisma.policyDocument.update({
      where: { id: scratch.policyId },
      data: { gatesServices: ["WORKDAY_START"] },
    });

    await gotoWorkerHome(page);

    // Sanity: banner is showing (worker has a pending policy).
    await expect(page.locator('[data-testid="compliance-banner"]')).toBeVisible({
      timeout: 8_000,
    });

    // The workday strip renders a "Start" button on the Start-your-workday
    // card when today.state === NOT_STARTED. Match it by accessible name
    // — the button contains a Play icon plus the text "Start".
    const startBtn = page.getByRole("button", { name: /^Start$/i }).first();
    await expect(startBtn).toBeVisible({ timeout: 15_000 });
    await startBtn.click();

    // The workday-start flow has one OR two dialogs before it fires the
    // actual startWorkday call:
    //   1. confirmNoJobs (only if the Employee has no jobs today)
    //   2. StartWorkdayDialog (always)
    // Both have a "Start workday" confirm button. Click through whichever
    // opens until the sign wizard appears — that means the API call fired
    // and hit the compliance gate.
    const wizardDialog = page.getByRole("dialog").filter({ hasText: /E2E AutoRetry Gate/i });
    for (let i = 0; i < 5; i++) {
      if (await wizardDialog.isVisible().catch(() => false)) break;
      const nextBtn = page.getByRole("button", { name: /^Start workday$/i }).first();
      const btnVisible = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (btnVisible) {
        await nextBtn.click();
      } else {
        await page.waitForTimeout(500);
      }
    }

    // Sign wizard opens on top of the workday dialog.
    await expect(wizardDialog).toBeVisible({ timeout: 10_000 });

    // Walk the wizard: read → sign.
    const continueBtn = wizardDialog.getByRole("button", { name: /Continue/i });
    await expect(continueBtn).toBeEnabled({ timeout: 10_000 });
    await continueBtn.click();

    await expect(page.getByText(/Type your legal name/i)).toBeVisible({ timeout: 5_000 });
    const nameInput = page.getByPlaceholder("Employee Worker");
    await nameInput.fill("Employee Worker");
    await page.getByText(/I have read the document/i).click();

    const signBtn = wizardDialog.getByRole("button", { name: /^Sign$/i });
    await expect(signBtn).toBeEnabled({ timeout: 5_000 });
    await signBtn.click();

    // After signing: wizard closes → policies:wizard-closed { completed: true }
    // fires → api.ts's retry runs → startWorkday succeeds → workday is IN_PROGRESS.
    // The WorkdayStrip re-renders and its card turns green with "On the clock".
    await expect(wizardDialog).toBeHidden({ timeout: 15_000 });

    // Assertion 1: server-side, the workday row is now IN_PROGRESS
    // (startedAt set, endedAt null, pausedAt null).
    // Poll for it because the retry + response cycle is async.
    let workday: { startedAt: Date; endedAt: Date | null; pausedAt: Date | null } | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      workday = await prisma.workerWorkday.findFirst({
        where: { userId: USERS.employee, endedAt: null },
        select: { startedAt: true, endedAt: true, pausedAt: true },
        orderBy: { startedAt: "desc" },
      });
      if (workday) break;
      await page.waitForTimeout(500);
    }
    expect(workday).not.toBeNull();
    expect(workday?.endedAt).toBeNull();
    expect(workday?.pausedAt).toBeNull();

    // Assertion 2: the compliance banner is gone (no more pending policies).
    await expect(page.locator('[data-testid="compliance-banner"]')).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});
