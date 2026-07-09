import { test, expect, Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";
import { gotoAdminClients, gotoSuperClients } from "../helpers/nav";

/**
 * UI-level regression guards for the two visibility gates on the
 * "View as this client" button. Runs under the `super` project since
 * only Super users have permission to see the button anywhere.
 *
 * Complements the API-level specs (client-view-as-admin.spec.ts) which
 * exercise the backend contract. These two tests specifically catch
 * accidental removal of the frontend gates that keep the button off
 * the admin-side Clients tab and off cards with no Clerk-linked
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
  test("button appears on Super → Clients but NOT on Admin → Clients (same Super user)", async ({ page }) => {
    const scratch = await createScratchClientWithContacts(prisma, {
      clientName: "E2E ViewAs UI Purpose Client",
      contacts: [
        { firstName: "Impersonatable", lastName: "Contact", isPrimary: true },
      ],
    });
    try {
      // Super shell: purpose="SUPER" is passed to ClientsTab, so the
      // button gate is satisfied.
      await gotoSuperClients(page);
      const buttonSuper = await findButtonForClient(page, scratch.clientId);
      await expect(buttonSuper).toBeVisible({ timeout: 10_000 });

      // Admin shell: purpose="ADMIN" is passed to the same ClientsTab
      // component, so the `purpose === "SUPER"` gate fails and the
      // button must NOT render — even though the caller (Super) has
      // both roles.
      await gotoAdminClients(page);
      const buttonAdmin = await findButtonForClient(page, scratch.clientId);
      await expect(buttonAdmin).toHaveCount(0, { timeout: 10_000 });
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
      await gotoSuperClients(page);
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
