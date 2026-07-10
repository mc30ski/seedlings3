import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression: "Paused services only" filter on Admin → Directory →
 * Clients used to include ARCHIVED clients (and clients on archived
 * properties) that happened to have a Job in status=PAUSED from before
 * archival. Operator screenshot on 2026-07-11 caught Claire (Archived)
 * appearing in the filter. The fix scopes the pausedJobsCount SQL
 * aggregate to (client.status=ACTIVE AND property.status=ACTIVE) so
 * archived-anything drops to zero and the filter naturally excludes it.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function gotoAdminClients(page: any) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("admin"));
    localStorage.setItem("seedlings_adminTab", JSON.stringify("clients"));
    localStorage.setItem("seedlings_adminCategory", JSON.stringify("Directory"));
    // Reset the Clients tab's own persisted filters so this test doesn't
    // inherit state from a prior run.
    localStorage.removeItem("seedlings_admin_clients_status");
    localStorage.removeItem("seedlings_admin_clients_kind");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
}

test.describe("Clients tab — paused filter excludes archived", () => {
  test("Archived client with a paused Job does NOT appear when 'Paused services only' is on; active peer still does", async ({ page }) => {
    // Two scratch clients, both with a PAUSED job:
    //   activeClient  — status ACTIVE   → should appear in filter
    //   archivedClient — status ARCHIVED → should NOT appear in filter
    const ACTIVE_NAME = `E2E ActiveWithPause ${Date.now()}`;
    const ARCHIVED_NAME = `E2E ArchivedWithPause ${Date.now()}`;

    const activeScratch = await createScratchClientWithContacts(prisma, {
      clientName: ACTIVE_NAME,
      contacts: [{ firstName: "Active", lastName: "Pause", isPrimary: true }],
    });
    const archivedScratch = await createScratchClientWithContacts(prisma, {
      clientName: ARCHIVED_NAME,
      contacts: [{ firstName: "Archived", lastName: "Pause", isPrimary: true }],
    });

    async function attachPausedJob(clientId: string) {
      const property = await prisma.property.create({
        data: {
          clientId,
          kind: "SINGLE",
          displayName: "E2E Prop",
          street1: "1 E2E Ln",
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
          status: "PAUSED",
          description: "E2E paused job",
        },
      });
      return { propertyId: property.id, jobId: job.id };
    }
    const activeFixtures = await attachPausedJob(activeScratch.clientId);
    const archivedFixtures = await attachPausedJob(archivedScratch.clientId);

    // Archive the second client so it hits the exclusion predicate.
    await prisma.client.update({
      where: { id: archivedScratch.clientId },
      data: { status: "ARCHIVED" },
    });

    try {
      await gotoAdminClients(page);

      // Toggle the "Paused services only" filter on.
      const pausedToggle = page.getByRole("button", {
        name: /Show only clients with paused services|Showing only clients with paused services/i,
      });
      await expect(pausedToggle).toBeVisible({ timeout: 15_000 });
      await pausedToggle.click();

      // Active peer is visible; archived one is NOT.
      await expect(page.getByText(ACTIVE_NAME).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(ARCHIVED_NAME)).toHaveCount(0);
    } finally {
      // Clean up in FK-safe order.
      await prisma.job.deleteMany({
        where: { id: { in: [activeFixtures.jobId, archivedFixtures.jobId] } },
      });
      await prisma.property.deleteMany({
        where: { id: { in: [activeFixtures.propertyId, archivedFixtures.propertyId] } },
      });
      await deleteScratchClient(prisma, activeScratch.clientId);
      await deleteScratchClient(prisma, archivedScratch.clientId);
    }
  });
});
