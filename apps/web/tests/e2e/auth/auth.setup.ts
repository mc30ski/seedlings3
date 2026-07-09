import { test as setup, expect } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/clerk-sdk-node";
import path from "path";

/**
 * One-time auth bootstrap for all Playwright projects.
 *
 * Uses Clerk's sign-in ticket flow: for each test user we mint a short-lived
 * ticket via the backend SDK, then complete sign-in through Clerk's normal
 * front-end flow using that ticket. This means:
 *   - No passwords stored anywhere
 *   - No dependency on Clerk test-mode magic OTPs
 *   - Works against a `pk_test_` Clerk instance without any org-side setup
 *
 * The resulting cookies + localStorage are saved to
 * `playwright/.auth/<user>.json` and loaded by every test project via
 * `storageState`, so tests start pre-authenticated.
 */

const CLERK_USERS = [
  { name: "employee",   clerkUserId: "user_3C8Z5OelA3n3uKkyPu7m3iNCvy8" },
  { name: "contractor", clerkUserId: "user_3C8XlDK9K5l5ysvQcHExViJr0F5" },
  { name: "trainee",    clerkUserId: "user_3C8a6PjGfg1eBe0YlHxp7Z5mGjL" },
  { name: "admin",      clerkUserId: "user_3C8WUUJaKLHuhOo51pupfRSjs9V" }, // ADMIN + WORKER
  { name: "super",      clerkUserId: "user_31z4k12rqlwSC7bdOcvtZLVWphQ" }, // Michael (SUPER)
];

const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });

setup("global clerk setup", async () => {
  await clerkSetup({
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!,
    secretKey: process.env.CLERK_SECRET_KEY!,
  });
});

for (const user of CLERK_USERS) {
  setup(`authenticate ${user.name}`, async ({ page }) => {
    // Mint a fresh sign-in ticket from the backend. Each ticket is
    // single-use and expires quickly; that's fine — we redeem it once
    // immediately below to establish the session.
    const token = await clerkClient.signInTokens.createSignInToken({
      userId: user.clerkUserId,
      expiresInSeconds: 60 * 5,
    });

    await page.goto("/sign-in");
    await clerk.signIn({
      page,
      signInParams: {
        strategy: "ticket",
        ticket: token.token,
      },
    });

    // Wait for the app to load post-sign-in. We land on the Home tab.
    await page.goto("/");
    await expect(page).toHaveURL(/\//);
    // Wait for a marker that guarantees Clerk hydration completed.
    await page.waitForLoadState("networkidle");

    await page.context().storageState({
      path: path.resolve(__dirname, `../../../playwright/.auth/${user.name}.json`),
    });
  });
}
