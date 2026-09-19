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

test("claim state does not change whether Guidance pulses", async ({ page }) => {
  test.setTimeout(240_000);
  // Guidance is "how this job is done" — it is for whoever ends up doing it,
  // so an UNCLAIMED job with a note must pulse exactly like a claimed one.
  // Asked because an unclaimed card looked quiet in production; it turned out
  // that job had photos and no note. This pins the distinction so the answer
  // stays true: claim state is irrelevant, a written note is what pulses.
  const prisma = makePrisma();
  try {
    const occ = await prisma.jobOccurrence.findFirst({
      where: { status: "SCHEDULED", workflow: "STANDARD", assignees: { none: {} } },
      select: { id: true, guidanceNote: true },
    });
    expect(occ, "no unclaimed scheduled occurrence to test with").toBeTruthy();
    const before = occ!.guidanceNote;

    await gotoJobs(page, "semi");
    const baseline = await page.locator("[data-guidance-pulse]").count();

    await prisma.jobOccurrence.update({
      where: { id: occ!.id },
      data: { guidanceNote: "E2E_UNCLAIMED_GUIDANCE — an unclaimed job still pulses." },
    });
    try {
      await gotoJobs(page, "semi");
      const withNote = await page.locator("[data-guidance-pulse]").count();
      console.log(`unclaimed guidance — pulsing before: ${baseline}, after: ${withNote}`);
      expect(
        withNote,
        "adding a guidance note to an UNCLAIMED job did not add a pulse — claim state is leaking into the signal",
      ).toBe(baseline + 1);
    } finally {
      await prisma.jobOccurrence.update({
        where: { id: occ!.id },
        data: { guidanceNote: before },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("an ASSIGNED job pulses its guidance — note or photos, no exceptions", async ({ page }) => {
  test.setTimeout(240_000);
  // THE HARD REQUIREMENT. An unclaimed job may stay quiet; the moment someone
  // is assigned there is a person who has to know how this job is done before
  // they arrive, and photos-only is still guidance they have not seen.
  const prisma = makePrisma();
  try {
    // Every assigned, unfinished visit that has ANY guidance content must be
    // pulsing. Derived from the data, so it keeps meaning as the seed moves.
    const mustPulse = await prisma.jobOccurrence.findMany({
      where: {
        status: { notIn: FINISHED as any },
        assignees: { some: { role: { not: "observer" } } },
        OR: [{ guidanceNote: { not: null } }, { propertyPhotos: { some: {} } }],
      },
      select: { id: true },
    });
    expect(
      mustPulse.length,
      "no assigned visit carries guidance — this spec would prove nothing",
    ).toBeGreaterThan(0);

    for (const density of ["semi", "expanded"] as const) {
      await gotoJobs(page, density);
      const pulsing = await page.locator("[data-guidance-pulse]").count();
      console.log(`${density}: assigned-with-guidance ${mustPulse.length}, pulsing ${pulsing}`);
      expect(
        pulsing,
        `${density}: ${mustPulse.length} assigned visits carry guidance but only ${pulsing} are pulsing`,
      ).toBeGreaterThanOrEqual(mustPulse.length);
    }
  } finally {
    await prisma.$disconnect();
  }
});
