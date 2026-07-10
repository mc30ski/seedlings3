import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchPolicy,
  cleanupScratchPolicies,
  USERS,
} from "../helpers/db";

/**
 * Regression: the policy version list had a Preview button but no way
 * to actually edit a DRAFT's content. Operator would spot a typo in the
 * preview, then have to delete the whole draft and recreate from
 * scratch to fix it. This spec exercises the new Edit affordance:
 *
 *   1. Seed a scratch policy with a DRAFT version.
 *   2. Open the Admin Compliance detail drawer for that policy.
 *   3. Click the new "Edit" button on the draft row.
 *   4. Change contentMarkdown + changeNote in the dialog.
 *   5. Save; assert the DB reflects the new content.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await cleanupScratchPolicies(prisma);
  await prisma.$disconnect();
});

test.describe("Compliance draft version — edit", () => {
  test("Operator can edit a DRAFT version's content and change note; DB reflects the update", async ({ page }) => {
    // createScratchPolicy publishes the version by default. To exercise
    // the DRAFT edit flow we roll v1's status back to DRAFT after seed.
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_DRAFT_EDIT",
      title: "E2E Draft Edit Policy",
      targetWorkerTypes: ["EMPLOYEE"],
      enforcement: "INFO",
      workerAction: "ACKNOWLEDGE",
      createdByUserId: USERS.super,
    });
    // Un-publish so the version is a real DRAFT for this test.
    await prisma.policyDocument.update({
      where: { id: scratch.policyId },
      data: { currentVersionId: null },
    });
    await prisma.policyDocumentVersion.update({
      where: { id: scratch.versionId },
      data: {
        status: "DRAFT",
        publishedAt: null,
        approvedAt: null,
        submittedAt: null,
        changeNote: "Original change note",
      },
    });

    try {
      // Load Super → Directory → Compliance.
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
        localStorage.setItem("seedlings_superTab", JSON.stringify("compliance"));
        localStorage.setItem("seedlings_superCategory", JSON.stringify("Directory"));
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Open our scratch policy's detail drawer.
      await page.getByText("E2E Draft Edit Policy").first().click();

      // The Edit button lives on the DRAFT version row. Its icon is a
      // FileText — click by role + accessible name "Edit".
      const editBtn = page.getByRole("button", { name: /^Edit$/ }).first();
      await expect(editBtn).toBeVisible({ timeout: 15_000 });
      await editBtn.click();

      // The Edit dialog appears with the change note pre-filled.
      await expect(page.getByRole("dialog").getByText(/Edit draft/i)).toBeVisible();
      const changeNoteInput = page.locator("input").filter({ hasNot: page.locator("[type='date']") }).first();
      await changeNoteInput.fill("Fixed a typo caught in preview");

      const contentTextarea = page.locator("textarea").first();
      await contentTextarea.fill(
        "# E2E Draft Edit Policy\n\nBody edited by the regression spec.",
      );

      await page.getByRole("button", { name: /^Save$/ }).click();

      // DB reflects the new content + change note after save.
      await expect(async () => {
        const row = await prisma.policyDocumentVersion.findUnique({
          where: { id: scratch.versionId },
          select: { contentMarkdown: true, changeNote: true, status: true },
        });
        expect(row?.status).toBe("DRAFT");
        expect(row?.changeNote).toBe("Fixed a typo caught in preview");
        expect(row?.contentMarkdown).toContain("Body edited by the regression spec.");
      }).toPass({ timeout: 10_000 });
    } finally {
      // cleanupScratchPolicies in afterAll deletes the scratch policy.
    }
  });
});
