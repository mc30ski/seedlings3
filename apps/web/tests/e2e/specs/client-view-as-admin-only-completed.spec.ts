import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression against a wrong-turn from the earlier client-visibility
 * audit: `isAdminOnly` was mis-treated as a "hide from client" flag.
 * It isn't. Its actual UI label is "Administered (workers cannot claim,
 * must be assigned)" — a worker-assignment rule, nothing to do with
 * what the client sees.
 *
 * A completed STANDARD-workflow occurrence marked `isAdminOnly: true`
 * MUST show in the client's "My Properties" history. This test seeds
 * one and verifies the Super-view-as portal renders it.
 *
 * Runs under the `super` project so we can use the client "View as"
 * button. The seeded ClientContact carries an explicit clerkUserId so
 * the impersonation plugin can resolve it.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Client view-as — admin-only completed jobs surface in the client history", () => {
  test("A completed STANDARD occurrence marked isAdminOnly=true is visible to the client under view-as", async ({ page }) => {
    const CLIENT_NAME = `E2E AdminOnly Visibility ${Date.now()}`;
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: CLIENT_NAME,
      contacts: [
        {
          firstName: "Admin",
          lastName: "OnlyTest",
          isPrimary: true,
          clerkUserId: `user_test_adminonly_${Date.now()}`,
        },
      ],
    });

    // Attach a Property + a Job + a completed, admin-only occurrence.
    // Everything gets marked STANDARD so the workflow filter doesn't
    // hide it — the ONLY reason it'd hide today is the (now-removed)
    // isAdminOnly filter this test is guarding against.
    const property = await prisma.property.create({
      data: {
        clientId: scratch.clientId,
        kind: "SINGLE",
        displayName: "AdminOnly Test Property",
        street1: "999 AdminOnly Ln",
        city: "Chapel Hill",
        state: "NC",
        postalCode: "27516",
        country: "US",
      },
    });
    const job = await prisma.job.create({
      data: {
        propertyId: property.id,
        kind: "SINGLE_ADDRESS",
        status: "ACCEPTED",
        description: "AdminOnly regression job",
      },
    });
    const now = new Date();
    const startedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago  // date-handling-allow: e2e-seed
    const completedAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000); // +30 min  // date-handling-allow: e2e-seed
    const occurrence = await prisma.jobOccurrence.create({
      data: {
        jobId: job.id,
        startAt: startedAt,
        startedAt,
        completedAt,
        status: "COMPLETED",
        workflow: "STANDARD",
        // THE flag under test: admin marked this occurrence "Administered"
        // so workers can't self-claim; must be assigned. Nothing to do
        // with client visibility.
        isAdminOnly: true,
        isEstimate: false,
        source: "MANUAL",
      },
    });

    try {
      // Load Super → Directory → Clients, find scratch, click View as.
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
        localStorage.setItem("seedlings_superTab", JSON.stringify("clients"));
        localStorage.setItem("seedlings_superCategory", JSON.stringify("Directory"));
        localStorage.removeItem("seedlings_impersonateClientContact");
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const viewAsBtn = page.locator(
        `[data-testid="view-as-client-button"][data-client-id="${scratch.clientId}"]`,
      );
      await expect(viewAsBtn).toBeVisible({ timeout: 15_000 });
      await viewAsBtn.click();

      // Wait for the impersonation banner as the "we've landed in the
      // impersonated session" signal.
      await expect(page.getByText(/Read-only preview: viewing as/i)).toBeVisible({ timeout: 20_000 });

      // Navigate into My Properties tab.
      const myPropertiesTab = page
        .getByRole("tab", { name: /My Properties/i })
        .or(page.getByText(/My Properties/i));
      await myPropertiesTab.first().click();

      // THE assertion: the completed job's property + kind should be
      // visible to the client under view-as, despite isAdminOnly=true.
      // The client history renders each service with the property name
      // near the top of the card.
      await expect(page.getByText(/AdminOnly Test Property/).first()).toBeVisible({ timeout: 15_000 });

      // The empty-state placeholder must NOT be present — its presence
      // would mean the filter is still hiding admin-only rows.
      await expect(page.getByText(/No services scheduled yet/i)).toHaveCount(0);
    } finally {
      // Exit view-as so the next test isn't polluted.
      await page.evaluate(() => {
        localStorage.removeItem("seedlings_impersonateClientContact");
      });
      // Cleanup fixtures in FK-safe order.
      await prisma.jobOccurrence.deleteMany({ where: { id: occurrence.id } });
      await prisma.job.deleteMany({ where: { id: job.id } });
      await prisma.property.deleteMany({ where: { id: property.id } });
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});
