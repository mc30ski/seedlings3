import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Regression: the "N services paused" affordance on Admin →
 * Directory → Clients. Verifies:
 *
 *   1. When a client has ≥1 PAUSED Job, a "N paused" pill renders on the
 *      client card.
 *   2. The pill is clickable and hands off to Admin → Work → Services
 *      with q = client name AND jobStatusFilter = PAUSED.
 *   3. The "Paused services only" filter toggle narrows the Clients list
 *      to only clients with ≥1 paused Job.
 *
 * Runs under `super` project — the ClientsTab pause/resume affordances
 * live under the Admin category, but the Super storage state has the
 * ADMIN role too so the same UI is reachable.
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

test.describe("Clients tab — paused services affordance", () => {
  test("Client with paused Jobs shows count pill, click jumps to Services filtered to that client + PAUSED", async ({ page }) => {
    // Two scratch clients — one WITH a paused job, one WITHOUT — so the
    // filter toggle has something to hide.
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

    // Attach a Property + a PAUSED Job to the "with" client. The Job
    // status is what the /admin/clients count aggregates on.
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
        status: "PAUSED",
        description: "E2E paused job",
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

      // 1. The "N paused" pill renders. Since we've narrowed to a single
      // client card, the button locator on the page is unambiguous.
      // Match specifically "1 paused" (digit prefix) so the filter
      // toggle button up in the header doesn't false-positive.
      const pausedPill = page.getByRole("button", { name: /^\s*1 paused\s*$/i });
      await expect(pausedPill).toBeVisible({ timeout: 15_000 });

      // Confirm the unpaused client's card would NOT have this pill:
      // swap the search to the other client and assert no "N paused"
      // pill exists in the visible list. Match "<digit> paused" so the
      // "Show only clients with paused services" filter toggle (which
      // has no digit prefix) doesn't false-positive.
      await search.fill(CLIENT_WITHOUT);
      await expect(page.getByRole("button", { name: /\d+ paused/i })).toHaveCount(0, { timeout: 15_000 });

      // 2. Click the pill → lands in Services with q + PAUSED filter set.
      await search.fill(CLIENT_WITH);
      await expect(pausedPill).toBeVisible();
      await pausedPill.click();
      const servicesSearch = page.locator('input#services-search');
      await expect(servicesSearch).toBeVisible({ timeout: 15_000 });
      await expect(servicesSearch).toHaveValue(CLIENT_WITH);
      // ServicesTab renders a chip strip that shows the active job-status
      // filter label ("Paused") when non-ALL. Assert that chip exists.
      await expect(page.getByText(/Paused/).first()).toBeVisible();

      // 3. Back to Clients — toggle "Paused only" and the unpaused
      // client should disappear from the list.
      await gotoAdminClients(page);
      const pausedToggle = page.getByRole("button", { name: /Show only clients with paused services|Showing only clients with paused services/i });
      await expect(pausedToggle).toBeVisible({ timeout: 15_000 });
      await pausedToggle.click();
      // The paused-services client remains visible; the un-paused one is hidden.
      await expect(page.getByText(CLIENT_WITH).first()).toBeVisible();
      await expect(page.getByText(CLIENT_WITHOUT)).toHaveCount(0);
    } finally {
      // Cleanup: delete Job first (Job blocks Property), Property blocks Client.
      await prisma.job.deleteMany({ where: { id: job.id } });
      await prisma.property.deleteMany({ where: { id: property.id } });
      await deleteScratchClient(prisma, withScratch.clientId);
      await deleteScratchClient(prisma, withoutScratch.clientId);
    }
  });
});
