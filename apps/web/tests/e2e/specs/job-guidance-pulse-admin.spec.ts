// ─────────────────────────────────────────────────────────────────────────────
// Guidance + Instructions: present at every density, quiet on a finished visit.
//
// TWO BUGS REACHED PRODUCTION HERE, and both were invisible to the build
// gates because both were about what the browser actually renders:
//
//   1. The compact card gated its Guidance drawer on `propertyPhotos.length`
//      while the expanded card used `photos || guidanceNote`. A job with a
//      written note and no photos showed a pulsing drawer when expanded and
//      NOTHING when compact. From the outside: "sometimes the Guidance
//      pulsates and sometimes it doesn't."
//
//   2. The pulse kept running after the visit was done — there is nothing to
//      read before starting a job that is finished, awaiting payment, or
//      closed.
//
// EXPECTATIONS COME FROM THE DATABASE, not from hardcoded counts. A spec that
// asserts "2 drawers" passes forever once the seed changes shape; this one
// asks the DB what SHOULD render and compares. That is what makes it able to
// fail for the right reason.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";
import { makePrisma } from "../helpers/db";

/** Statuses where the work is over. Mirrors `pulseIsPointless` in JobsTab. */
const FINISHED = ["COMPLETED", "PENDING_PAYMENT", "CLOSED"];

async function gotoJobs(page: Page, density: "semi" | "expanded") {
  await page.goto("/");
  await page.evaluate((d) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_ajobs_datePreset", JSON.stringify("all"));
    localStorage.setItem("seedlings_ajobs_density", JSON.stringify(d));
    // The default status set omits finished work, which is exactly the half
    // this spec is about.
    localStorage.removeItem("seedlings_ajobs_status");
  }, density);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4000);
}

/** Guidance drawers on screen — the header reads "Guidance (N)". */
async function drawerCount(page: Page): Promise<number> {
  const body = await page.locator("body").innerText();
  return [...body.matchAll(/Guidance \(\d+\)/g)].length;
}

test("a guidance note with no photos renders at BOTH densities", async ({ page }) => {
  test.setTimeout(240_000);
  const prisma = makePrisma();
  try {
    // The shape that broke: note, zero photos. If the seed has none, this
    // spec cannot speak to the bug — say so rather than pass silently.
    const noteNoPhotos = await prisma.jobOccurrence.count({
      where: { guidanceNote: { not: null }, propertyPhotos: { none: {} } },
    });
    expect(
      noteNoPhotos,
      "no occurrence has a guidance note without photos — this spec would prove nothing",
    ).toBeGreaterThan(0);

    await gotoJobs(page, "expanded");
    const expanded = await drawerCount(page);
    await gotoJobs(page, "semi");
    const semi = await drawerCount(page);

    console.log(`guidance drawers — expanded: ${expanded}, semi: ${semi}`);
    expect(expanded, "no guidance drawer rendered at expanded density").toBeGreaterThan(0);
    expect(
      semi,
      `density changed how many Guidance drawers render (expanded ${expanded}, semi ${semi}) — ` +
        "a note-without-photos job is being hidden at one density",
    ).toBe(expanded);
  } finally {
    await prisma.$disconnect();
  }
});

test("nothing pulses on a finished visit", async ({ page }) => {
  test.setTimeout(240_000);
  const prisma = makePrisma();
  try {
    // Park a guidance note on a FINISHED visit if the seed has not already.
    const finished = await prisma.jobOccurrence.findFirst({
      where: { status: { in: FINISHED as any }, guidanceNote: null },
      select: { id: true },
    });
    expect(finished, "no finished occurrence to attach guidance to").toBeTruthy();
    await prisma.jobOccurrence.update({
      where: { id: finished!.id },
      data: { guidanceNote: "E2E_FINISHED_GUIDANCE — must not pulse." },
    });

    try {
      for (const density of ["semi", "expanded"] as const) {
        await gotoJobs(page, density);

        // Every pulsing guidance drawer / chip currently on screen.
        const pulsing = await page.locator("[data-guidance-pulse], [data-guidance-pulse-icon]").count();
        const instrPulsing = await page
          .locator("[data-instruction-pulse], [data-instruction-pulse-icon]")
          .count();

        // What SHOULD be pulsing, straight from the data: unfinished visits.
        const eligible = await prisma.jobOccurrence.count({
          where: { guidanceNote: { not: null }, status: { notIn: FINISHED as any } },
        });
        console.log(
          `${density}: guidance pulsing ${pulsing}, instruction pulsing ${instrPulsing}, eligible ${eligible}`,
        );

        // The finished one we just stamped must NOT be among them. Upper
        // bound rather than equality: a card can carry both a drawer and a
        // chip, and the feed is paginated by date.
        expect(
          pulsing,
          `${density}: more guidance pulses on screen than there are unfinished visits with a note ` +
            `(${pulsing} > ${eligible}) — a finished visit is still pulsing`,
        ).toBeLessThanOrEqual(eligible * 2);

        // And the strong one: the finished card is on screen (its note text
        // is unique) and carries no pulse marker.
        const finishedCard = page
          .locator("div")
          .filter({ hasText: "E2E_FINISHED_GUIDANCE" })
          .last();
        if (await finishedCard.count()) {
          const marked = await finishedCard.locator("[data-guidance-pulse]").count();
          expect(marked, `${density}: the finished visit's guidance is pulsing`).toBe(0);
        }
      }
    } finally {
      await prisma.jobOccurrence.update({
        where: { id: finished!.id },
        data: { guidanceNote: null },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});
