import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchPolicy,
  cleanupScratchPolicies,
  createScratchUnclassifiedWorker,
  deleteScratchUser,
  USERS,
} from "../helpers/db";
import { gotoSuperCompliance } from "../helpers/nav";

/**
 * Admin-facing UI actions on the Compliance tab. Runs under the `super`
 * Playwright project (Michael's storage state).
 *
 * Covers three fixes that shipped alongside the Safety Guide rollout:
 *
 * 1. Archive dialog closes the detail drawer after successful archive.
 *    Before the fix, the drawer stayed open showing the archived state,
 *    which visually read as "the dialog came back."
 *
 * 2. Unclassified-worker warning row appears when any approved
 *    WORKER-role user has no workerType set. Positive test — creates
 *    such a user, verifies the row renders, deletes them.
 *
 * 3. Upload file type picker replaces the raw MIME text field with
 *    three toggle buttons (PDF / Photos / Word documents). Verifies
 *    that clicking "PDF" stores the correct MIME string on the policy.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await cleanupScratchPolicies(prisma);
  await prisma.$disconnect();
});

test.describe("Admin: Archive dialog closes detail drawer after success", () => {
  test("archiving a policy closes the drawer and removes it from the list", async ({ page }) => {
    await cleanupScratchPolicies(prisma);
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_ADMIN_ARCHIVE",
      title: "E2E Archive Me",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoSuperCompliance(page);

    // The Compliance tab defaults to the Policies view. Find our scratch
    // policy row and click it to open the detail drawer.
    const policyRow = page
      .locator("text=E2E Archive Me")
      .first();
    await expect(policyRow).toBeVisible({ timeout: 10_000 });
    await policyRow.click();

    // Detail drawer opens — headline shows the policy title.
    const drawerTitle = page.locator("h2, [role='heading']").filter({ hasText: "E2E Archive Me" });
    await expect(drawerTitle.first()).toBeVisible({ timeout: 10_000 });

    // Click the Archive button in the drawer.
    const archiveBtn = page.getByRole("button", { name: /^Archive$/i }).first();
    await expect(archiveBtn).toBeVisible({ timeout: 5_000 });
    await archiveBtn.click();

    // Confirm dialog opens — type a reason and click the red Archive.
    const confirmDialog = page.getByRole("alertdialog", {
      name: /Archive this policy\?/i,
    });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog
      .getByPlaceholder(/Superseded/i)
      .fill("e2e test archive");
    await confirmDialog.getByRole("button", { name: /^Archive$/i }).click();

    // The fix: the detail drawer should CLOSE (not stay open showing
    // the archived state). Wait for the drawer headline to vanish.
    await expect(drawerTitle.first()).toBeHidden({ timeout: 10_000 });

    // And the archived policy should no longer appear in the default
    // list (Show archived is off).
    await expect(page.locator("text=E2E Archive Me")).toHaveCount(0, {
      timeout: 8_000,
    });

    // Server-side confirmation: archivedAt is set.
    const row = await prisma.policyDocument.findUnique({
      where: { id: scratch.policyId },
      select: { archivedAt: true },
    });
    expect(row?.archivedAt).not.toBeNull();
  });
});

test.describe("Admin: Sign matrix unclassified-worker warning", () => {
  test("warning row renders when an approved WORKER-role user has no workerType", async ({ page }) => {
    // Create a scratch unclassified worker.
    const displayName = "E2E Unclassified TestUser";
    const scratchUserId = await createScratchUnclassifiedWorker(prisma, {
      displayName,
    });

    try {
      await gotoSuperCompliance(page);
      const matrixToggle = page.getByRole("button", { name: /^Sign matrix$/i });
      await expect(matrixToggle).toBeVisible({ timeout: 10_000 });
      await matrixToggle.click();

      // The warning uses phrasing "1 worker has no worker type set" for
      // one, or "N workers have no worker type set" for multiple.
      const warning = page.getByText(/worker(s)? (has|have) no worker type set/i);
      await expect(warning.first()).toBeVisible({ timeout: 10_000 });

      // The scratch user's displayName should appear in the warning
      // row's names list.
      const nameCell = page.getByText(displayName);
      await expect(nameCell.first()).toBeVisible({ timeout: 5_000 });
    } finally {
      // Always cleanup so a failed test doesn't leave a phantom user
      // hanging around in dev.
      await deleteScratchUser(prisma, scratchUserId);
    }
  });
});

test.describe("Admin: Upload file type picker", () => {
  test("clicking PDF sets workerUploadAcceptedTypes to application/pdf", async ({ page }) => {
    await cleanupScratchPolicies(prisma);
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_ADMIN_UPLOAD_PICKER",
      title: "E2E Upload Picker Policy",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoSuperCompliance(page);
    await page.locator("text=E2E Upload Picker Policy").first().click();

    // Wait for detail drawer.
    await expect(
      page.locator("h2, [role='heading']").filter({ hasText: "E2E Upload Picker Policy" }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Open Edit metadata.
    await page.getByRole("button", { name: /Edit metadata/i }).click();
    await expect(
      page.getByRole("dialog", { name: /Edit policy/i }).first(),
    ).toBeVisible({ timeout: 5_000 });

    // Toggle "Worker must upload a file (e.g. insurance certificate)".
    await page.getByText(/Worker must upload a file/i).click();

    // Click the "PDF" preset button (renders as a Chakra button).
    const pdfBtn = page.getByRole("button", { name: /^PDF$/i });
    await expect(pdfBtn).toBeVisible({ timeout: 5_000 });
    await pdfBtn.click();

    // Save the metadata edit.
    await page.getByRole("button", { name: /^Save$/i }).click();

    // Dialog closes.
    await expect(
      page.getByRole("dialog", { name: /Edit policy/i }),
    ).toBeHidden({ timeout: 10_000 });

    // Poll the DB — the picker rebuilds the MIME string on save; expect
    // "application/pdf" to be the stored value.
    let acceptedTypes: string | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      const row = await prisma.policyDocument.findUnique({
        where: { id: scratch.policyId },
        select: { workerUploadAcceptedTypes: true, requiresWorkerUpload: true },
      });
      if (row?.requiresWorkerUpload && row?.workerUploadAcceptedTypes) {
        acceptedTypes = row.workerUploadAcceptedTypes;
        break;
      }
      await page.waitForTimeout(300);
    }
    expect(acceptedTypes).toBe("application/pdf");
  });
});
