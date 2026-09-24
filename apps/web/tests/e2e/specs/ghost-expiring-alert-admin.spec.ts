import { test, expect } from "@playwright/test";
import { makePrisma } from "../helpers/db";
import type { PrismaClient } from "@prisma/client";

/**
 * AN ALERT MUST BE ABLE TO SHOW YOU WHAT IT COUNTED.
 *
 * "Next visits expiring 1" opened the Jobs list on "No job occurrences match
 * current filters." The badge counted a ghost the filter behind it then
 * refused to show, because the two used different windows:
 *
 *   the count   ghosts due within GHOST_EXPIRING_SOON_DAYS  (today..today+3)
 *   the filter  the "now" preset                            (today..today+2)
 *
 * A visit due in exactly three days fell in the gap. That is a one-day
 * difference between a threshold and a hand-picked preset, and no amount of
 * reading either file on its own reveals it — the only thing that shows it is
 * clicking the alert and finding nothing there.
 *
 * This is the THIRD shipping of this bug shape. The expired bucket had it
 * twice ("lastWeek" against a 7-day server, then against a 30-day one) and
 * carries a build gate; the expiring bucket had it too, four lines away, and
 * did not. So the fixture is built at the BOUNDARY on purpose: a ghost due in
 * exactly GHOST_EXPIRING_SOON_DAYS days. Anywhere else in the window and this
 * spec passes against the bug.
 */

/** Must equal GHOST_EXPIRING_SOON_DAYS in apps/api/src/services/jobs.ts and
 *  the constant of the same name in JobsTab. A build gate pins those two to
 *  each other; this spec is the one that proves the number is USABLE. */
const EXPIRING_SOON_DAYS = 3;

/** Any repeat interval longer than the window works. The last visit is placed
 *  `FREQ - EXPIRING_SOON_DAYS` days back, so the next one falls due exactly on
 *  the far edge of what the alert counts. */
const FREQ_DAYS = 7;

let prisma: PrismaClient;
let jobId: string | null = null;
let propertyId: string | null = null;

/** A property of its own, named distinctively.
 *
 *  The first version of this spec hung the fixture on an existing property and
 *  asserted "the list is not empty". The seed already carries ghosts at one and
 *  two days out, so that assertion passed with the bug still in place — the
 *  boundary ghost was simply drowned out by ghosts the broken window DID cover.
 *  A spec that cannot fail is worse than no spec, so the assertion now names
 *  this exact property and nothing else can satisfy it. */
const FIXTURE_NAME = `E2E Ghost Boundary ${Date.now()}`;

test.beforeAll(async () => {
  prisma = makePrisma();

  const client = await prisma.client.findFirst({ select: { id: true } });
  if (!client) throw new Error("seed has no client to hang a scratch property on");

  const property = await prisma.property.create({
    data: {
      clientId: client.id,
      kind: "SINGLE",
      displayName: FIXTURE_NAME,
      street1: "1 E2E Boundary Way",
      city: "Hillsborough",
      state: "NC",
      postalCode: "27278",
      country: "USA",
    },
  });
  propertyId = property.id;

  const job = await prisma.job.create({
    data: {
      propertyId: property.id,
      kind: "SINGLE_ADDRESS",
      // ACCEPTED or it is not a live repeating service and ghosts nothing.
      status: "ACCEPTED",
      frequencyDays: FREQ_DAYS,
      description: FIXTURE_NAME,
    },
  });
  jobId = job.id;

  // Offsetting from `now` rather than from an ET midnight keeps the ET day
  // arithmetic honest: whatever time of day it is, +FREQ days later is the
  // same number of ET days later.
  const lastVisit = new Date(Date.now() - (FREQ_DAYS - EXPIRING_SOON_DAYS) * 86_400_000);
  await prisma.jobOccurrence.create({
    data: {
      jobId: job.id,
      kind: "SINGLE_ADDRESS",
      // STANDARD, and not one-off: every other workflow is excluded from
      // ghosting on purpose — none of them is a repeating service visit.
      workflow: "STANDARD",
      // Finished but not CLOSED, which is the ordinary reason the next
      // occurrence was never generated and a ghost exists at all.
      status: "COMPLETED",
      startAt: lastVisit,
      completedAt: lastVisit,
      hoursApprovedAt: lastVisit,
      frequencyDays: FREQ_DAYS,
      source: "GENERATED",
    },
  });
});

test.afterAll(async () => {
  if (jobId) {
    await prisma.jobOccurrence.deleteMany({ where: { jobId } }).catch(() => {});
    await prisma.job.delete({ where: { id: jobId } }).catch(() => {});
  }
  if (propertyId) {
    await prisma.property.delete({ where: { id: propertyId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

/** The alert's own click handler, reproduced exactly: it stamps this key,
 *  clears "View as", lands on the operator Jobs surface, and JobsTab reads the
 *  key on mount. Driving the key rather than hunting the header dropdown keeps
 *  the spec about the window mismatch rather than about menu markup. */
async function openExpiringAlert(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_adminjobs_workers", JSON.stringify([]));
    localStorage.setItem("seedlings_adminJobs_showExpiringGhosts", "1");
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
}

test.describe("Next visits expiring — the alert and the list agree", () => {
  test("a ghost at the far edge of the window is counted AND shown", async ({ page }) => {
    // ── The number the badge promises ────────────────────────────────────────
    // Read off the app's OWN request rather than issuing one: this endpoint is
    // behind Clerk, and a bare fetch from the page carries no token. Watching
    // the real call also means we are asserting the number the badge is
    // actually drawn from, not a second opinion about it.
    const countsResponse = page.waitForResponse(
      (r) => r.url().includes("ghost-expiry-counts") && r.status() === 200,
      { timeout: 45_000 },
    );
    await page.goto("/");
    const counts = await (await countsResponse).json();
    expect(
      counts.expiringSoon,
      "the fixture must be counted as expiring — if it is not, the fixture is wrong, not the app",
    ).toBeGreaterThan(0);

    // ── What the badge actually opens ────────────────────────────────────────
    await openExpiringAlert(page);

    // THE BOUNDARY GHOST ITSELF, by name. Not "the list is not empty" — the
    // seed carries ghosts one and two days out that the broken window still
    // covered, and asserting on the list as a whole passes against the bug.
    await expect(
      page.getByText(FIXTURE_NAME).first(),
      "the alert counted a visit due in exactly " +
        `${EXPIRING_SOON_DAYS} days, so the list it opens must contain it`,
    ).toBeVisible({ timeout: 20_000 });
  });
});
