import { test, expect } from "@playwright/test";
import { waitForSplashGone } from "../helpers/nav";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression against a wrong-turn from the earlier client-visibility
 * audit: `mustBeAssigned` was mis-treated as a "hide from client" flag.
 * It isn't. Its actual UI label is "Administered (workers cannot claim,
 * must be assigned)" — a worker-assignment rule, nothing to do with
 * what the client sees.
 *
 * A completed STANDARD-workflow occurrence marked `mustBeAssigned: true`
 * MUST show in the client's "My Properties" history. This test seeds one
 * and verifies the portal renders it under view-as.
 *
 * Runs under the `owner` project, which holds `clients.view-as` and so can
 * use the client "View as" button. The seeded ClientContact carries an explicit clerkUserId so
 * the impersonation plugin can resolve it.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Client view-as — must-be-assigned completed jobs surface in the client history", () => {
  test("A completed STANDARD occurrence marked mustBeAssigned=true is visible to the client under view-as", async ({ page }) => {
    const CLIENT_NAME = `E2E MustBeAssigned Visibility ${Date.now()}`;
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

    // Attach a Property + a Job + a completed, must-be-assignedly occurrence.
    // Everything gets marked STANDARD so the workflow filter doesn't
    // hide it — the ONLY reason it'd hide today is the (now-removed)
    // mustBeAssigned filter this test is guarding against.
    const property = await prisma.property.create({
      data: {
        clientId: scratch.clientId,
        kind: "SINGLE",
        displayName: "MustBeAssigned Test Property",
        street1: "999 MustBeAssigned Ln",
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
        description: "mustBeAssigned regression job",
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
        mustBeAssigned: true,
        isEstimate: false,
        source: "MANUAL",
      },
    });

    try {
      // Load Directory → Clients, find scratch, click View as.
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
        // Also stamp the first-open marker: without it the "auto-show Home
        // on the first open of the ET day" effect in pages/index.tsx fires
        // on the reload below and discards the tab stamped here. It is
        // suppressed after 22:00 ET, so a spec missing this passes at
        // night and fails in the afternoon.
        localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
        localStorage.setItem("seedlings_staffTab", JSON.stringify("clients"));
        localStorage.setItem("seedlings_staffCategory", JSON.stringify("Directory"));
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
      await waitForSplashGone(page);

      // Navigate into My Properties tab.
      const myPropertiesTab = page
        .getByRole("tab", { name: /My Properties/i })
        .or(page.getByText(/My Properties/i));
      await myPropertiesTab.first().click();

      // THE assertion: the completed job's property + kind should be
      // visible to the client under view-as, despite mustBeAssigned=true.
      // The client history renders each service with the property name
      // near the top of the card.
      await expect(page.getByText(/MustBeAssigned Test Property/).first()).toBeVisible({ timeout: 15_000 });

      // The empty-state placeholder must NOT be present — its presence
      // would mean the filter is still hiding must-be-assignedly rows.
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
