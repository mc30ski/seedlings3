import { test, expect, Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";
import { gotoClients } from "../helpers/nav";

/**
 * UI-level regression guards for the two visibility gates on the
 * "View as this client" button. Runs under the `owner` project since
 * the button needs `clients.view-as` to appear anywhere.
 *
 * Complements the API-level specs (client-view-as-admin.spec.ts) which
 * exercise the backend contract. These two tests specifically catch
 * accidental removal of the frontend gates that keep the button off
 * a caller with `clients.manage`-side Clients tab and off cards with no Clerk-linked
 * contact.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function findButtonForClient(page: Page, clientId: string) {
  return page.locator(`[data-testid="view-as-client-button"][data-client-id="${clientId}"]`);
}

test.describe("View As button: purpose gate", () => {
  test("button appears on Clients but NOT on Clients (same Super user)", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs UI Purpose Client",
      contacts: [
        { firstName: "Impersonatable", lastName: "Contact", isPrimary: true },
      ],
    });
    try {
      // The button renders for an account holding `clients.view-as`.
      await gotoClients(page);
      const button = await findButtonForClient(page, scratch.clientId);
      await expect(button).toBeVisible({ timeout: 10_000 });

      // A SECOND ASSERTION WAS HERE and has been removed, not weakened.
      // It navigated to "the shell" and required the button to be ABSENT,
      // because the tab was handed a prop that decided privilege by where
      // you came from. That gate is deleted: the
      // button asks for `clients.view-as` and nothing else, so the same
      // account sees the same thing however it reached the tab — which
      // is the point of the change. Asserting absence here would now be
      // asserting the bug. "No capability, no button" is covered by the
      // persona sweep, which signs in as an account that lacks it.
    } finally {
      await deleteScratchClient(prisma, scratch.clientId);
    }
  });
});

test.describe("View As button: clerkUserId gate", () => {
  test("button appears only for clients with at least one Clerk-linked contact", async ({ page }) => {
    // Two scratch clients side by side:
    //   - `linked`   has one contact with a clerkUserId → button visible
    //   - `unlinked` has two contacts, neither with a clerkUserId → button hidden
    const linked = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs UI ClerkGate Linked",
      contacts: [
        { firstName: "HasLogin", lastName: "Contact", isPrimary: true },
      ],
    });
    const unlinked = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs UI ClerkGate NoLogin",
      contacts: [
        { firstName: "NoLogin1", lastName: "Contact", isPrimary: true, clerkUserId: null },
        { firstName: "NoLogin2", lastName: "Contact", clerkUserId: null },
      ],
    });
    try {
      await gotoClients(page);
      const buttonLinked = await findButtonForClient(page, linked.clientId);
      const buttonUnlinked = await findButtonForClient(page, unlinked.clientId);

      await expect(buttonLinked).toBeVisible({ timeout: 10_000 });
      await expect(buttonUnlinked).toHaveCount(0);
    } finally {
      await deleteScratchClient(prisma, linked.clientId);
      await deleteScratchClient(prisma, unlinked.clientId);
    }
  });
});
