import { test, expect, request as pwRequest } from "@playwright/test";
import { makePrisma } from "../helpers/db";
import type { PrismaClient } from "@prisma/client";

/**
 * WALL DISPLAYS — the pairing loop, end to end.
 *
 * The display page is the one surface in the app with no user session: it
 * authenticates as a DEVICE, using a token a Super approves once. That makes
 * the pairing flow the whole security boundary, so this drives it for real —
 * open the screen, read the six digits off it, approve them in the app, and
 * check the board actually arrives.
 *
 * The two assertions that matter most are the negative ones:
 *   • the six digits alone must NOT buy a token (they are on a wall, in a room,
 *     where anyone can read them)
 *   • a revoked display must go back to a pairing code, NOT freeze on the last
 *     good frame — a frozen board looks exactly like a working one
 */

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";


/** Land on Super -> System -> Displays, re-stamping every time.
 *
 *  A bare `reload()` does NOT hold the tab: the app rewrites the role keys
 *  during boot, so the second load came back on Worker -> Home and every
 *  locator after it looked for controls that were not on screen. Stamp, then
 *  navigate — never the other way round. */
async function gotoDisplays(p: import("@playwright/test").Page) {
  await p.goto("/");
  await p.waitForLoadState("domcontentloaded");
  await p.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("displays"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("System"));
  });
  await p.goto("/");
  await p.waitForLoadState("networkidle");
  await expect(p.getByPlaceholder("000000")).toBeVisible({ timeout: 30_000 });
}

let prisma: PrismaClient;
test.beforeAll(() => { prisma = makePrisma(); });

// CLEAN UP AFTER YOURSELF. These tests pair real screens, and the re-pair test
// deliberately leaves a REPLACEMENT behind — so every run used to add a row to
// the operator's Displays tab that nobody would recognise and that errors when
// clicked once someone else tidies the table.
test.afterAll(async () => {
  await prisma.display.deleteMany({ where: { name: { startsWith: "E2E " } } });
  await prisma.displayPairing.deleteMany({ where: { approvedAt: null } });
  await prisma.$disconnect();
});

test.describe("Displays — pairing, board, revoke", () => {
  test("a screen pairs, shows the board, and drops back to a code when revoked", async ({ page, context }) => {
    test.setTimeout(180_000);
    // Unique per run. A fixed name collides with screens left behind by an
    // earlier run and makes "is it gone?" unanswerable.
    const screenName = `E2E Screen ${Date.now()}`;

    // ── The screen boots and asks to be paired ───────────────────────────────
    await page.goto("/display");
    const codeEl = page.locator("text=/^\\d{3} \\d{3}$/");
    await expect(codeEl, "the display must show a six-digit pairing code").toBeVisible({ timeout: 30_000 });
    const shown = ((await codeEl.textContent()) ?? "").replace(/\D/g, "");
    expect(shown, "the code must be six digits").toHaveLength(6);

    // ── The code alone must not be enough ────────────────────────────────────
    // This is the subtle one. If polling with the public digits returned the
    // token, anyone who glanced at the wall could pair themselves the instant
    // the real screen was approved.
    const api = await pwRequest.newContext();
    const withCodeOnly = await api.post(`${API_BASE}/api/public/display/pair/poll`, {
      data: { deviceSecret: shown },
    });
    const codeOnlyBody = await withCodeOnly.json();
    expect(
      codeOnlyBody.token,
      "the six digits on the wall must never buy a token — only the device's own secret does",
    ).toBeUndefined();

    // ── A Super approves it ──────────────────────────────────────────────────
    const app = await context.newPage();
    await gotoDisplays(app);
    await app.getByPlaceholder("000000").fill(shown);
    await app.getByPlaceholder("Shop TV").fill(screenName);

    await app.getByRole("button", { name: /^Pair screen$/ }).click();
    // Pairing is a mutation, so it confirms first — house rule, and this one
    // grants a device access to live data. Confirm INSIDE the dialog: the
    // trigger and the confirm share a label, so an unscoped click can land on
    // the wrong one.
    await app.getByRole("alertdialog").getByRole("button", { name: /^Pair screen$/ }).click();

    await expect(
      app.getByText(screenName).first(),
      "the paired screen must appear in the connected list",
    ).toBeVisible({ timeout: 30_000 });

    // ── The screen picks up its board without anyone touching it ─────────────
    await expect(
      codeEl,
      "once approved, the pairing code must give way to the board on its own",
    ).toBeHidden({ timeout: 30_000 });
    await expect(
      page.getByText(screenName).first(),
      "the display names itself once it is live",
    ).toBeVisible({ timeout: 30_000 });

    // ── Revoke, and check it does not freeze ─────────────────────────────────
    // The row is the div holding BOTH the name and the button — filtering on
    // the name alone lands on an inner text wrapper that contains neither.
    const myRow = app
      .locator("div")
      .filter({ hasText: screenName })
      .filter({ has: app.getByRole("button", { name: /Disconnect/ }) })
      .last();
    // Wait on the CALL, not on the list. The tab refreshes itself every 15s
    // while you stand in front of it, so inferring "it worked" from the row
    // disappearing races that refresh — and when it lost, the test reported a
    // revoke that had never happened.
    const revoked = app.waitForResponse(
      (r) => r.url().includes("/revoke") && r.request().method() === "POST",
    );
    await myRow.getByRole("button", { name: /Disconnect/ }).click();
    await app.getByRole("alertdialog").getByRole("button", { name: /^Disconnect$/ }).click();
    expect((await revoked).status(), "the revoke must actually reach the server").toBe(200);
    // Assert after a RELOAD. The success toast repeats the screen's name, so
    // an immediate check is satisfied by the toast confirming the very thing
    // it is meant to verify — and a page-level `div` filter also catches rows
    // belonging to other screens entirely.
    await gotoDisplays(app);
    // Wait for the LIST to exist before asserting something is absent from it.
    // `toHaveCount(0)` is satisfied by a page that has not rendered yet, so
    // without this the assertion passes whether or not the revoke worked —
    // which is exactly how it passed while the screen stayed live.
    await expect(
      app.getByText("Connected screens"),
      "the connected list must have rendered before we assert an absence",
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      app.getByText(screenName),
      "a revoked screen leaves the connected list",
    ).toHaveCount(0, { timeout: 30_000 });

    // Bring the screen forward first. Browsers throttle timers in background
    // tabs, so a backgrounded display would look like it had stopped polling —
    // an artefact of the test harness, not of the display, which is always the
    // foreground tab on a wall.
    await page.bringToFront();
    // The display polls on its own schedule, so give it a poll to notice.
    await expect(
      codeEl,
      "a revoked screen must return to a pairing code, never sit on stale data",
    ).toBeVisible({ timeout: 120_000 });

    await api.dispose();
    await app.close();
  });

  test("re-pairing a wiped screen replaces its entry instead of leaving a ghost", async ({ page, context }) => {
    test.setTimeout(180_000);
    const screenName = `E2E Wiped ${Date.now()}`;

    // Pair a screen normally.
    await page.goto("/display");
    const codeEl = page.locator("text=/^\\d{3} \\d{3}$/");
    await expect(codeEl).toBeVisible({ timeout: 30_000 });
    const firstCode = ((await codeEl.textContent()) ?? "").replace(/\D/g, "");

    const app = await context.newPage();
    await gotoDisplays(app);
    await app.getByPlaceholder("000000").fill(firstCode);
    await app.getByPlaceholder("Shop TV").fill(screenName);
    await app.getByRole("button", { name: /^Pair screen$/ }).click();
    await app.getByRole("alertdialog").getByRole("button", { name: /^Pair screen$/ }).click();
    await expect(app.getByText(screenName).first()).toBeVisible({ timeout: 30_000 });

    // Wipe the screen's storage — a factory reset, a replaced stick, a cleared
    // profile. It must come back asking to pair, not sit there broken.
    // Remove the display's OWN keys, not the whole origin. On a wall the TV
    // and the phone are different machines; in this test they share one
    // browser profile, so `localStorage.clear()` also wiped the app tab's
    // navigation state and dumped it back on Worker → Home.
    await page.evaluate(() => {
      localStorage.removeItem("seedlings_display_token");
      localStorage.removeItem("seedlings_display_device_secret");
    });
    await page.reload();
    await expect(
      codeEl,
      "a screen that lost its storage must ask to pair again",
    ).toBeVisible({ timeout: 30_000 });
    const secondCode = ((await codeEl.textContent()) ?? "").replace(/\D/g, "");
    expect(secondCode, "it must be a NEW request, not the old one").not.toBe(firstCode);

    // Approve it as a REPLACEMENT for the original row.
    await gotoDisplays(app);
    // Tell the app this code belongs to the screen already in the list. That
    // is what turns a second pairing into a takeover.
    const oldRow = app
      .locator("div")
      .filter({ hasText: screenName })
      .filter({ has: app.getByRole("button", { name: /Re-pair this screen/ }) })
      .last();
    await oldRow.getByRole("button", { name: /Re-pair this screen/ }).click();
    await expect(
      app.getByText(/Replacing/),
      "the form must say which screen it is taking over",
    ).toBeVisible({ timeout: 15_000 });
    await app.getByPlaceholder("000000").fill(secondCode);
    const approved = app.waitForResponse(
      (r) => r.url().includes("/displays/approve") && r.request().method() === "POST",
    );
    await app.getByRole("button", { name: /^Pair screen$/ }).click();
    await app.getByRole("alertdialog").getByRole("button", { name: /^Replace screen$/ }).click();
    expect((await approved).status()).toBe(200);

    // The whole point: ONE entry, not two. Without the replacement path the
    // old row stays behind as a credential nobody holds, indistinguishable
    // from a TV that is merely switched off.
    await gotoDisplays(app);
    await expect(app.getByText("Connected screens")).toBeVisible({ timeout: 30_000 });
    await expect(
      app.getByText(screenName),
      "re-pairing must not leave the wiped screen's old entry behind",
    ).toHaveCount(1, { timeout: 30_000 });

    await app.close();
  });
});
