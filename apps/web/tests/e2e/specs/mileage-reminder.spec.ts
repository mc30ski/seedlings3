import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS, resetWorkdayState, signPolicyDirect } from "../helpers/db";
import { gotoWorkerHome } from "../helpers/nav";
// Canonical ET date key — MileageEntry.entryDate is a YYYY-MM-DD business
// day, and deriving it in UTC would seed the session on the wrong day
// after ~8pm ET (see CLAUDE.md date-handling rules).
import { bizToday } from "../../../src/lib/dates";
import type { Page } from "@playwright/test";

/**
 * The driving-log reminder — a nudge after clocking in and after clocking
 * out, never a gate.
 *
 *   • Clock IN with a vehicle assigned and no session open → "Start your
 *     driving log?" with a one-tap way out.
 *   • Clock OUT with a session still running → "You're still logging
 *     miles" with a one-tap way out.
 *
 * Both are dismissible, and dismissing must leave the workday transition
 * exactly as it landed — the clock has already moved by the time the
 * dialog renders. That is the whole point: an open mileage session used to
 * REFUSE the end on the MY ACTIVITIES banner, which left a worker on Home
 * with no way to clock out.
 *
 * The employee fixture has one assigned vehicle (Mike's Ram 2500), which is
 * what makes both directions reachable.
 *
 * NOTE on targeting: MY ACTIVITIES renders the workday banner AND the
 * mileage banner, and both put a button labelled "Start" on screen. Every
 * click below goes through the `workday-banner` testid so the spec can
 * never accidentally drive the driving-log banner instead of the clock.
 */

/** The workday banner's own action button — never the mileage banner's. */
function workdayAction(page: Page, name: RegExp) {
  return page.getByTestId("workday-banner").getByRole("button", { name });
}

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** Leave no open session behind — every test in this file starts from
 *  "clocked out, not driving". */
async function resetDriving(userId: string) {
  await prisma.mileageEntry.deleteMany({ where: { driverUserId: userId, endedAt: null } });
}

/**
 * Release any equipment the fixture worker is still holding.
 *
 * Equipment DOES still block ending a workday — that is deliberate, and
 * the distinction this file exists to pin down: company property in
 * someone's hands has to be released by a person, while an open driving
 * session only earns a reminder. The employee fixture ships holding a
 * mower, so without this the End button is disabled for a reason that
 * has nothing to do with mileage.
 */
async function releaseHeldEquipment(userId: string) {
  await prisma.checkout.updateMany({
    where: { userId, releasedAt: null },
    data: { releasedAt: new Date(), rentalCost: 0 },
  });
}

/**
 * Clear the compliance gate for the fixture worker.
 *
 * Not incidental setup — without it the clock-in never happens at all.
 * Every active BLOCK policy that gates WORKDAY_START makes the server
 * throw POLICIES_REQUIRED, and PolicyGateInterceptor opens the signing
 * wizard on top of the page instead. The workday stays NOT_STARTED, so
 * a spec that skips this reads as "the reminder is broken" when what
 * actually happened is that the worker was never let on the clock.
 *
 * Signs whatever is currently required rather than a hardcoded list, so
 * seeding a new policy doesn't silently break this file.
 */
async function clearComplianceGate(userId: string) {
  const versions = await prisma.policyDocumentVersion.findMany({
    where: { policyDocument: { archivedAt: null } },
    select: { id: true, contentDigest: true, policyDocumentId: true },
  });
  for (const v of versions) {
    const already = await prisma.policySignature.findFirst({
      where: { userId, policyDocumentVersionId: v.id },
    });
    if (already) continue;
    await signPolicyDirect(prisma, {
      userId,
      policyDocumentVersionId: v.id,
      contentDigestAtSign: v.contentDigest,
    }).catch(() => {
      // A unique-constraint race or a shape this seed doesn't carry is
      // not worth failing setup over — the assertion below on the
      // workday actually starting is what proves the gate is clear.
    });
  }
}

test.describe("Driving-log reminder", () => {
  test.beforeEach(async () => {
    await clearComplianceGate(USERS.employee);
    await releaseHeldEquipment(USERS.employee);
    await resetWorkdayState(prisma, USERS.employee);
    await resetDriving(USERS.employee);
  });

  test.afterAll(async () => {
    await resetWorkdayState(prisma, USERS.employee);
    await resetDriving(USERS.employee);
  });

  test("clocking in suggests starting the drive, and Not now dismisses it", async ({ page }) => {
    await gotoWorkerHome(page);

    // Clock in from whichever workday affordance Home is showing.
    await workdayAction(page, /^Start$/).click();

    const reminder = page.getByText("Start your driving log?", { exact: true });
    await expect(reminder).toBeVisible({ timeout: 20_000 });

    // It names the assigned vehicle rather than asking in the abstract.
    await expect(page.getByText(/assigned to you/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Not now" }).click();
    await expect(reminder).toBeHidden();

    // Dismissing writes nothing — no session was opened.
    const open = await prisma.mileageEntry.count({
      where: { driverUserId: USERS.employee, endedAt: null },
    });
    expect(open, "Not now must not start a session").toBe(0);

    // …and the workday itself really did start. The reminder is a nudge
    // layered on top of a transition that already committed.
    const workday = await prisma.workerWorkday.findFirst({
      where: { userId: USERS.employee, endedAt: null },
    });
    expect(workday, "the workday must have started regardless").not.toBeNull();
  });

  test("clocking out with a session running suggests stopping it, and does not block the clock-out", async ({ page }) => {
    // Clock in and open a driving session directly, so the test exercises
    // the END path rather than re-testing the start prompt.
    const vehicle = await prisma.vehicleAssignment
      .findFirst({ where: { userId: USERS.employee }, include: { vehicle: true } });
    expect(vehicle, "the employee fixture must have an assigned vehicle").not.toBeNull();

    await gotoWorkerHome(page);
    await workdayAction(page, /^Start$/).click();
    // The start reminder fires here; dismiss it so it isn't in the way.
    const startPrompt = page.getByText("Start your driving log?", { exact: true });
    await expect(startPrompt).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Not now" }).click();
    await expect(startPrompt).toBeHidden();

    await prisma.mileageEntry.create({
      data: {
        driverUserId: USERS.employee,
        vehicleId: vehicle!.vehicleId,
        entryDate: bizToday(),
        startedAt: new Date(),
        startOdometer: vehicle!.vehicle?.currentOdometer ?? 1000,
      },
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    // End must be ENABLED with a driving session open — this is the exact
    // assertion the old hard block would have failed.
    const endButton = workdayAction(page, /^End$/);
    await expect(endButton).toBeEnabled({ timeout: 15_000 });
    // The banner's End posts directly — no confirm step — which is the
    // path that used to be refused outright while a session was open.
    await endButton.click();

    const reminder = page.getByText("You're still logging miles", { exact: true });
    await expect(reminder).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Leave it running" }).click();
    await expect(reminder).toBeHidden();

    // The clock-out committed even though the session is still open —
    // this is the behaviour the banner's old hard block prevented.
    const workday = await prisma.workerWorkday.findFirst({
      where: { userId: USERS.employee },
      orderBy: { startedAt: "desc" },
    });
    expect(workday?.endedAt, "ending must not be blocked by an open session").not.toBeNull();

    // …and "Leave it running" really left it running.
    const stillOpen = await prisma.mileageEntry.count({
      where: { driverUserId: USERS.employee, endedAt: null },
    });
    expect(stillOpen, "Leave it running must not close the session").toBe(1);
  });
});
