import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression: the "Paused repeating only" filter on Admin → Directory →
 * Clients used to include ARCHIVED clients (and clients on archived
 * properties) that happened to be holding work from before archival.
 * Operator screenshot on 2026-07-11 caught Claire (Archived) appearing in
 * the filter. The fix scopes the count SQL to (client.status=ACTIVE AND
 * property.status=ACTIVE) so archived-anything drops to zero and the
 * filter naturally excludes it.
 *
 * The held state moved while this predicate did not: the count used to be
 * Jobs in status=PAUSED, and job-level pause is gone (it was Archive under
 * a second name), so the fixture is now a STREAM_PAUSED occurrence. The
 * exclusion this spec guards is unchanged — which is the point of keeping
 * it pointed at the new shape rather than deleting it.
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
  test("an archived client holding a repeating visit stays out of 'Paused repeating only'; its active peer does not", async ({ page }) => {
    // Two scratch clients, both holding a repeating visit:
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

    async function attachPausedRepeating(clientId: string) {
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
          status: "ACCEPTED",
          frequencyDays: 14,
          description: "E2E paused repeating job",
        },
      });
      const occurrence = await prisma.jobOccurrence.create({
        data: {
          jobId: job.id,
          kind: "SINGLE_ADDRESS",
          workflow: "STANDARD",
          status: "STREAM_PAUSED",
          startAt: new Date(),
          streamPausedAt: new Date(),
          streamPauseReasonCode: "customer_hold",
        },
      });
      return { propertyId: property.id, jobId: job.id, occurrenceId: occurrence.id };
    }
    const activeFixtures = await attachPausedRepeating(activeScratch.clientId);
    const archivedFixtures = await attachPausedRepeating(archivedScratch.clientId);

    // Archive the second client so it hits the exclusion predicate.
    await prisma.client.update({
      where: { id: archivedScratch.clientId },
      data: { status: "ARCHIVED" },
    });

    try {
      await gotoAdminClients(page);

      // Toggle the "Paused repeating only" filter on.
      const pausedToggle = page.getByRole("button", {
        name: /(Show|Showing) only clients with a paused repeating service/i,
      });
      await expect(pausedToggle).toBeVisible({ timeout: 15_000 });
      await pausedToggle.click();

      // Active peer is visible; archived one is NOT.
      await expect(page.getByText(ACTIVE_NAME).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(ARCHIVED_NAME)).toHaveCount(0);
    } finally {
      // Clean up in FK-safe order — occurrences first.
      await prisma.jobOccurrence.deleteMany({
        where: { id: { in: [activeFixtures.occurrenceId, archivedFixtures.occurrenceId] } },
      });
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
