import { test, expect, Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";
import { gotoSuperClients } from "../helpers/nav";

/**
 * THE test I should have written the first time.
 *
 * Verifies the whole point of client "View as": a Super clicks the
 * button on a client card, gets shifted into the client's portal UI,
 * and actually sees the SAME tabs a real client would see when they
 * log in (specifically the "My Properties" tab, which is only visible
 * to non-worker/non-admin/approved users).
 *
 * If this test regresses, the feature is silently broken — the shell
 * loads, no error is thrown, but the operator can't actually see what
 * the client sees. This is the failure mode we shipped last time.
 *
 * Runs under the `super` project since only Super can trigger it.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function ensureExitImpersonation(page: Page) {
  // Defensive cleanup — if a prior test crashed mid-session, clear the
  // localStorage key before the next test starts so the storage state
  // is deterministic.
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.removeItem("seedlings_impersonateClientContact");
    // Reset topTab so we don't accidentally start on the client shell.
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
  });
}

test.describe("Client View-As: full click-through flow", () => {
  test("Super clicks View as, enters session, sees My Properties tab with client's data, then exits cleanly", async ({ page }) => {
    // Setup: scratch client with a Clerk-linked contact so the "View as"
    // button is renderable AND clickable AND the impersonation resolves
    // server-side.
    const CLIENT_NAME = "E2E Full Flow Client";
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: CLIENT_NAME,
      contacts: [
        {
          firstName: "Impersonate",
          lastName: "Target",
          isPrimary: true,
          // Explicit clerkUserId so the plugin's target-lookup succeeds.
          clerkUserId: `user_test_flow_${Date.now()}`,
        },
      ],
    });
    try {
      await ensureExitImpersonation(page);

      // Step 1: navigate to Super → Directory → Clients.
      await gotoSuperClients(page);

      // Step 2: find and click the View as button on our scratch client.
      const viewAsBtn = page.locator(
        `[data-testid="view-as-client-button"][data-client-id="${scratch.clientId}"]`,
      );
      await expect(viewAsBtn).toBeVisible({ timeout: 15_000 });
      await viewAsBtn.click();

      // Step 3: setClientImpersonation triggers a hard page reload. Wait
      // for the banner to appear as the signal that we've landed in the
      // impersonated session.
      const banner = page.getByText(/Read-only preview: viewing as/i);
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText(CLIENT_NAME);

      // Step 4: THE CRITICAL ASSERTION. The "My Properties" inner tab
      // must be visible in the client shell. This is the tab that was
      // hidden by `!isAdmin` in visibility guard before the /api/me
      // overlay fix.
      const myPropertiesTab = page.getByRole("tab", { name: /My Properties/i })
        .or(page.getByText(/My Properties/i));
      await expect(myPropertiesTab.first()).toBeVisible({ timeout: 15_000 });

      // Step 5: click "My Properties" and verify the tab actually loads
      // the impersonated client's data. /api/client/me returns the
      // client's display name in its `client` field.
      await myPropertiesTab.first().click();

      // Look for the client name somewhere on the rendered tab — the
      // ClientMyJobsTab renders the client's displayName in its header.
      await expect(page.getByText(CLIENT_NAME).first()).toBeVisible({
        timeout: 15_000,
      });

      // Step 6: exit the session via the banner button. Should reload and
      // land back in Super mode.
      const exitBtn = page.getByRole("button", { name: /Exit view-as/i });
      await expect(exitBtn).toBeVisible();
      await exitBtn.click();

      // After reload, the purple banner should be gone.
      await expect(page.getByText(/Read-only preview: viewing as/i)).toHaveCount(0, {
        timeout: 15_000,
      });
    } finally {
      // Cleanup the scratch client and defensively wipe impersonation
      // state so subsequent tests aren't polluted.
      await ensureExitImpersonation(page).catch(() => {});
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});
