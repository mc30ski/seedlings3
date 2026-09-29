import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression: the paused-count affordance on Admin → Directory → Clients.
 * Verifies:
 *
 *   1. When a client has ≥1 repeating visit on hold, the "Job services"
 *      button on the client card carries the count.
 *   2. Clicking it hands off to Admin → Work → Services with q = client
 *      name and NO pre-applied job-status filter.
 *   3. The "Paused repeating only" toggle narrows the Clients list to
 *      only clients with ≥1 held repeating visit.
 *
 * WHAT THIS USED TO ASSERT, and why it changed: the count came from Jobs
 * in status PAUSED. Job-level pause is gone — it deleted every scheduled
 * visit and rebuilt the chain on resume, which is what Archive already
 * did — and `PAUSED` is no longer a JobStatus value, so the fixture this
 * spec used to create would now fail at the database. The state the
 * Clients tab is reporting has moved to the occurrence:
 * JobOccurrence.status = STREAM_PAUSED.
 *
 * Runs under `super` project — the affordance lives under the Admin
 * category, but the Super storage state has the ADMIN role too.
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

test.describe("Clients tab — paused repeating affordance", () => {
  test("Client holding a repeating visit shows the count, and clicking through lands on that client's services at every status", async ({ page }) => {
    // Two scratch clients — one WITH a held repeating visit, one WITHOUT —
    // so the filter toggle has something to hide.
    const CLIENT_WITH = `E2E Paused Client ${Date.now()}`;
    const CLIENT_WITHOUT = `E2E Unpaused Client ${Date.now()}`;

    const withScratch = await createScratchClientWithContacts(prisma, {
      clientName: CLIENT_WITH,
      contacts: [{ firstName: "Paused", lastName: "Contact", isPrimary: true }],
    });
    const withoutScratch = await createScratchClientWithContacts(prisma, {
      clientName: CLIENT_WITHOUT,
      contacts: [{ firstName: "Active", lastName: "Contact", isPrimary: true }],
    });

    // Attach a Property + a Job + a STREAM_PAUSED occurrence to the "with"
    // client. The OCCURRENCE status is what the /admin/clients count
    // aggregates on — the Job just has to be non-ARCHIVED to be counted.
    const property = await prisma.property.create({
      data: {
        clientId: withScratch.clientId,
        kind: "SINGLE",
        displayName: "E2E Test Property",
        street1: "1 Test St",
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
        // Repeating: a one-off has no stream to hold.
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
        streamPauseReasonCode: "non_payment",
        streamPauseReason: "E2E fixture — held for non-payment",
      },
    });

    try {
      await gotoAdminClients(page);

      // Search-narrow to the specific client so the paused pill's
      // parent card is the only one on screen (Admin has many other
      // clients from the seed). Filtering shrinks the list to just
      // ours plus any that share the E2E prefix.
      const search = page.locator("input[placeholder='Search…']").first();
      await expect(search).toBeVisible({ timeout: 15_000 });
      await search.fill(CLIENT_WITH);

      // 1. The client card's "Job services" button carries the paused count.
      //
      // This used to be a separate "N paused" pill that only appeared when
      // something was paused. It merged into the always-present Job services
      // button when the client-level bulk Pause/Resume pair was removed —
      // two buttons to the same destination was exactly the clutter that
      // change was about. The COUNT is still the signal; it is now a suffix
      // rather than a button of its own.
      const jobServicesBtn = page.getByRole("button", { name: /Job services/i });
      await expect(jobServicesBtn).toBeVisible({ timeout: 15_000 });
      await expect(
        jobServicesBtn,
        "the paused count must still be on the button for a client with a held repeating visit",
      ).toHaveText(/Job services.*1/);

      // The unpaused client gets the same button with NO count — the button
      // is the way into Services for every client, the number is the alarm.
      await search.fill(CLIENT_WITHOUT);
      const plainBtn = page.getByRole("button", { name: /Job services/i });
      await expect(plainBtn).toBeVisible({ timeout: 15_000 });
      await expect(
        plainBtn,
        "a client with nothing paused must show no count",
      ).not.toHaveText(/\d/);

      // 2. Click it → lands in Services narrowed to this client.
      await search.fill(CLIENT_WITH);
      await expect(jobServicesBtn).toBeVisible();
      await jobServicesBtn.click();
      const servicesSearch = page.locator('input#services-search');
      await expect(servicesSearch).toBeVisible({ timeout: 15_000 });
      await expect(servicesSearch).toHaveValue(CLIENT_WITH);

      // ...at ALL statuses, deliberately. The handoff used to force the job
      // status filter to PAUSED, because its only caller was a paused-count
      // pill. This button now exists so an operator can PAUSE a service —
      // which means the RUNNING ones are what they came to act on, and a
      // paused-only list would hide every one of them. ServicesTab shows a
      // chip naming the active job-status filter only when it is not ALL.
      // Asserted on the FILTER STATE, not on page text: this client has a
      // paused service, so its card carries a "Paused" status badge and a
      // text match finds that instead of the filter chip.
      const jobStatusFilter = await page.evaluate(() =>
        localStorage.getItem("seedlings_services_jobStatus"),
      );
      expect(
        jobStatusFilter,
        "landing on Services must not pre-filter to paused only",
      ).toBe(JSON.stringify(["ALL"]));

      // 3. Back to Clients — toggle "Paused only" and the unpaused
      // client should disappear from the list.
      await gotoAdminClients(page);
      const pausedToggle = page.getByRole("button", { name: /(Show|Showing) only clients with a paused repeating service/i });
      await expect(pausedToggle).toBeVisible({ timeout: 15_000 });
      await pausedToggle.click();
      // The paused-services client remains visible; the un-paused one is hidden.
      await expect(page.getByText(CLIENT_WITH).first()).toBeVisible();
      await expect(page.getByText(CLIENT_WITHOUT)).toHaveCount(0);
    } finally {
      // Cleanup, innermost first: occurrence blocks Job, Job blocks
      // Property, Property blocks Client.
      await prisma.jobOccurrence.deleteMany({ where: { id: occurrence.id } });
      await prisma.job.deleteMany({ where: { id: job.id } });
      await prisma.property.deleteMany({ where: { id: property.id } });
      await deleteScratchClient(prisma, withScratch.clientId);
      await deleteScratchClient(prisma, withoutScratch.clientId);
    }
  });
});
