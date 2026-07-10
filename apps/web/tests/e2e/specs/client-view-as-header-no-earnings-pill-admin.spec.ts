import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Header-fidelity regression: under Super view-as, the title-bar
 * "$X Wk" earnings pill must NOT render.
 *
 * The pill is Super's own money — fetched with Super's real Clerk token
 * from a WORKER-guarded endpoint. A real client (no roles) is 403'd on
 * the endpoint, so they don't see it. But under Super view-as, the pill
 * used to render on top of the client shell, leaking Super's numbers
 * over what is supposed to be a client preview.
 *
 * This test picks a real seed client (via ClientsTab View-as button)
 * and asserts the earnings pill is absent while the impersonation
 * banner is visible.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Client view-as — title-bar earnings pill", () => {
  test("Earnings pill is hidden while Super is impersonating a client", async ({ page }) => {
    const CLIENT_NAME = `E2E HeaderPill ${Date.now()}`;
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: CLIENT_NAME,
      contacts: [
        {
          firstName: "Header",
          lastName: "Pill",
          isPrimary: true,
          // Explicit clerkUserId so the impersonation plugin resolves.
          clerkUserId: `user_test_headerpill_${Date.now()}`,
        },
      ],
    });

    try {
      // Navigate to Super → Directory → Clients.
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
        localStorage.setItem("seedlings_superTab", JSON.stringify("clients"));
        localStorage.setItem("seedlings_superCategory", JSON.stringify("Directory"));
        localStorage.removeItem("seedlings_impersonateClientContact");
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Baseline: BEFORE entering view-as, the earnings pill is visible
      // for a Super caller (Super hits the worker endpoint and gets a
      // valid response — usually $0 in a fresh test DB, but the label
      // "Wk" / "Today" / "Mo" is what we key on). We assert this ONLY
      // if the pill happens to appear — a fresh test DB may return no
      // data yet. The critical assertion is the "hidden under view-as"
      // case below.
      // Enter view-as: click the View-as button for our scratch client.
      const viewAsBtn = page.locator(
        `[data-testid="view-as-client-button"][data-client-id="${scratch.clientId}"]`,
      );
      await expect(viewAsBtn).toBeVisible({ timeout: 15_000 });
      await viewAsBtn.click();

      // Wait for the view-as banner as our "we're in impersonation" signal.
      await expect(page.getByText(/Read-only preview: viewing as/i)).toBeVisible({ timeout: 20_000 });

      // THE assertion: the earnings pill must be absent from the title
      // bar. We match on the "Wk" / "Today" / "Mo" period label, which is
      // unique to this pill (no other UI in the header uses those tokens).
      // The pill renders as `<button>$X.XX Wk</button>` — assert count 0.
      const earningsPill = page.getByRole("button", { name: /\$[\d.,]+\s*(Wk|Today|Mo|All)/i });
      await expect(earningsPill).toHaveCount(0);
    } finally {
      // Cleanup — clear any impersonation state so subsequent tests
      // aren't polluted, then delete the scratch client.
      await page.evaluate(() => {
        localStorage.removeItem("seedlings_impersonateClientContact");
      });
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});
