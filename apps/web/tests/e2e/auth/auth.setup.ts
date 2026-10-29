import { test as setup, expect } from "@playwright/test";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { createClerkClient } from "@clerk/clerk-sdk-node";
import path from "path";
import { writeFileSync } from "fs";
import { makePrisma } from "../helpers/prisma";

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
  { name: "scheduler",  clerkUserId: "user_3C8WUUJaKLHuhOo51pupfRSjs9V" }, // runs the schedule
  { name: "owner",      clerkUserId: "user_31z4k12rqlwSC7bdOcvtZLVWphQ" }, // Michael — holds everything

  // Added 2026-10-12 for the revised model. These four exist to be CLICKED
  // THROUGH as, which is the only way to verify a non-field persona.
  //   coordinator — office staff, paid, no field work
  //   bookkeeper  — books without payroll, 1099
  //   payroll     — payroll without books (the other half of that split)
  //   unpaid      — entitlements but NO payroll: the case that proves an
  //                 unpaid person never reaches a split, a wage or an export
  { name: "coordinator", clerkUserId: "user_3Kb1s1G1xxbzfxXL0WAiGvtd3DA" },
  { name: "bookkeeper",  clerkUserId: "user_3Kb1sDh90di1Ya57pOtEGBw4hJz" },
  { name: "payroll",     clerkUserId: "user_3Kb1sECtQcpabtj34NIODcFCQv0" },
  { name: "unpaid",      clerkUserId: "user_3Kb1s9wrOJx2CoLRW3EooVxunN7" },
  // Added 2026-10-22. The first persona whose access is narrowed by PORTFOLIO
  // rather than by capability: it holds Admin's whole set, but only inside
  // Durham. Portfolio scoping had models, routes, a tab, 25 unit tests and a
  // seeded fixture, and still no run had ever issued a request as a
  // territorially limited user — the fixture carried a synthetic
  // `seed_…` clerkUserId that could not sign in.
  { name: "districtLead", clerkUserId: "user_3L4dcamBCzjUi4HM66iShU6jRFx" },
  // Added 2026-10-26. APPROVED STAFF THAT NOBODY HAS GRANTED ANYTHING TO —
  // the state between "admitted" and "given a job to do". It had no persona,
  // and `unpaid` was standing in for it by accident of holding no role; that
  // made `unpaid` unable to test the pay class it is named for, and left
  // three bugs reachable only by hand (a Client badge on a staff header, a
  // customer-shell bar with no way out, and a tab strip under the notice
  // saying nothing had been shared yet).
  //
  // `workerType` is EMPLOYEE, deliberately. Leaving it unset is a DIFFERENT
  // state: `can()` fails at the payroll gate before it reads a single role,
  // so the account would pass for the wrong reason.
  { name: "newhire",      clerkUserId: "user_3LEXIdBPWHEhac9hu5VlnTRhTkY" },
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

/**
 * Resolve each seed user's DATABASE id and write it where helpers/db.ts can
 * read it synchronously.
 *
 * WHY THIS EXISTS
 * `helpers/db.ts` used to hardcode the five cuids. On 2026-10-11 all five were
 * dead — the User rows had been recreated by Clerk sign-ins at some point and
 * every id had changed, so every DB-touching spec failed on a foreign-key
 * violation (`PolicySignature_userId_fkey`, `Guide_createdById_fkey`). 52
 * failures in the first 64 tests, all one root cause.
 *
 * `prisma/seed.ts` had already learned this lesson and resolves by email,
 * noting "the email is the stable identity here; the cuid never was." The e2e
 * helpers never followed. This closes that gap using something even more
 * stable than the email: the Clerk user id, which is the account itself and is
 * already listed above.
 *
 * Every project declares `dependencies: ["auth-setup"]`, so this always runs
 * before any spec and the file is never stale.
 */
setup("resolve seed user ids", async () => {
  const prisma = makePrisma();
  try {
    const ids: Record<string, string> = {};
    const missing: string[] = [];
    for (const user of CLERK_USERS) {
      const row = await prisma.user.findUnique({
        where: { clerkUserId: user.clerkUserId },
        select: { id: true },
      });
      if (!row) missing.push(`${user.name} <${user.clerkUserId}>`);
      else ids[user.name] = row.id;
    }
    if (missing.length) {
      throw new Error(
        `Seed users not found in the dev database by Clerk id:\n  ${missing.join("\n  ")}\n\n` +
          `These come from signing in through Clerk, not from the seed. Sign in ` +
          `as each one, then re-run.`,
      );
    }
    const out = path.resolve(__dirname, "../../../playwright/.auth/user-ids.json");
    writeFileSync(out, JSON.stringify(ids, null, 2) + "\n");
    console.log(`resolved ${Object.keys(ids).length} seed user ids -> ${out}`);
  } finally {
    await prisma.$disconnect();
  }
});
