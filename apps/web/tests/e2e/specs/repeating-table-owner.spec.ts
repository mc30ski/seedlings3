import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Work → Repeating — the table, and acting on a selection from it.
 *
 * Spec: docs/features/repeating.md
 *
 * WHAT THIS COVERS, and why each one is here rather than in the build gate:
 *
 *   1. A repeating job occurrence in SCHEDULED appears and can be ticked.
 *   2. One in PENDING_PAYMENT appears, states its blocker, and CANNOT be
 *      ticked. This is the rule the operator asked for — settle the money
 *      first, then hold the visit that replaces it — and it is the one
 *      behaviour on this screen that a reader would assume was a bug if it
 *      were missing, because a disabled control with no explanation looks
 *      broken.
 *   3. Selecting and pausing writes an ordinary per-occurrence pause: the
 *      confirm NAMES the row first, and the database ends up in
 *      STREAM_PAUSED with the reason code recorded. The database assertion is
 *      the point — the whole safety argument of this feature is that a
 *      selection produces the same rows as pausing one at a time, and only a
 *      read of those rows proves it.
 *
 * WHAT IS COVERED ELSEWHERE, deliberately not duplicated here:
 *   · which personas see the tab at all — `persona-sweep` parses
 *     TAB_REQUIREMENTS and asserts every persona sees exactly the tabs their
 *     capabilities earn, so the new row is swept across all nine for free.
 *   · the endpoints' authz both ways — the `api` project derives from
 *     docs/features/permissions-ROUTE-MAP.md.
 *   · the read-only rendering (oversight read without the write) — there is
 *     no dev persona holding `schedule.view-all` without `schedule.manage`,
 *     though the live book's Auditor role does. `repeating-build-gate`
 *     asserts each affordance sits behind `canManage` instead.
 *
 * Runs under the `owner` project: the table needs both halves of the
 * capability split.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function gotoRepeatingTab(page: any) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    // Stamp the first-open marker too, or the "auto-show Home on the first
    // open of the ET day" effect discards the tab stamped here. A spec
    // missing this passes at night and fails in the afternoon.
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("repeating"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Work"));
  });
  await page.goto("/");
  // The FIRST assertion gets a long timeout on purpose: this tab is compiled
  // by `next dev` on its first visit, and a cold compile loses to any fixed
  // wait. Waiting on the summary strip — which only renders once the list
  // request has resolved — is the honest signal that the tab is up.
  await expect(page.locator('[data-testid="repeating-summary"]')).toBeVisible({
    timeout: 60_000,
  });
}

/** A client + property + repeating job + one occurrence in `status`. */
async function makeRepeatingFixture(
  clientName: string,
  status: "SCHEDULED" | "PENDING_PAYMENT",
) {
  const scratch = await createScratchClientWithContacts(prisma, {
    clientName,
    contacts: [{ firstName: "Repeating", lastName: "Contact", isPrimary: true }],
  });
  const property = await prisma.property.create({
    data: {
      clientId: scratch.clientId,
      kind: "SINGLE",
      displayName: `${clientName} Property`,
      street1: "1 Repeating St",
      city: "Chapel Hill",
      state: "NC",
      postalCode: "27516",
      country: "US",
    },
  });
  const job = await prisma.job.create({
    data: {
      propertyId: property.id,
      kind: "SINGLE_ADDRESS",
      status: "ACCEPTED",
      // Repeating: the cadence IS the membership test for this table.
      frequencyDays: 14,
      description: `${clientName} repeating job`,
    },
  });
  const occurrence = await prisma.jobOccurrence.create({
    data: {
      jobId: job.id,
      kind: "SINGLE_ADDRESS",
      workflow: "STANDARD",
      status,
      jobType: "E2E Mowing",
      startAt: new Date(),
    },
  });
  return { scratch, property, job, occurrence };
}

async function cleanup(f: Awaited<ReturnType<typeof makeRepeatingFixture>>) {
  // Innermost first: occurrence blocks Job, Job blocks Property, Property
  // blocks Client.
  await prisma.jobOccurrencePauseEvent.deleteMany({
    where: { occurrenceId: f.occurrence.id },
  });
  await prisma.jobOccurrence.deleteMany({ where: { id: f.occurrence.id } });
  await prisma.job.deleteMany({ where: { id: f.job.id } });
  await prisma.property.deleteMany({ where: { id: f.property.id } });
  await deleteScratchClient(prisma, f.scratch.clientId);
}

test.describe("Work → Repeating", () => {
  test("a scheduled repeating job occurrence can be held from a selection; an unpaid one cannot be ticked", async ({ page }) => {
    const stamp = Date.now();
    const LIVE = `E2E Repeating Live ${stamp}`;
    const UNPAID = `E2E Repeating Unpaid ${stamp}`;

    const live = await makeRepeatingFixture(LIVE, "SCHEDULED");
    const unpaid = await makeRepeatingFixture(UNPAID, "PENDING_PAYMENT");

    try {
      await gotoRepeatingTab(page);

      const liveRow = page.locator(`[data-testid="repeating-row-${live.occurrence.id}"]`);
      const unpaidRow = page.locator(`[data-testid="repeating-row-${unpaid.occurrence.id}"]`);

      // Narrow to the fixtures so the seed's own repeating job occurrences are not
      // in the way of a click.
      const search = page.locator("input#repeating-search");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill(`E2E Repeating`);

      // ── 1. Both appear, in their own states ──────────────────────────
      await expect(liveRow).toBeVisible({ timeout: 20_000 });
      await expect(liveRow).toHaveAttribute("data-status", "SCHEDULED");
      await expect(unpaidRow).toBeVisible();
      await expect(unpaidRow).toHaveAttribute("data-status", "PENDING_PAYMENT");

      // ── 1b. The column titles sort the rows ──────────────────────────
      //
      // Driven rather than inspected: the gate already asserts the headers
      // and the phone picker read one list, which is a claim about the
      // source. This is the claim about the screen — that clicking a title
      // reorders what is drawn, and clicking it again reverses it.
      //
      // The two fixtures are named "…Live <stamp>" and "…Unpaid <stamp>",
      // so ascending by customer puts Live first and descending flips it.
      const rowOrder = async () =>
        page.locator('[data-testid="repeating-rows"] > div')
          .evaluateAll((els) =>
            els.map((e) => (e.getAttribute("data-testid") ?? "").replace("repeating-row-", "")),
          );

      const customerHeader = page.locator('[data-testid="repeating-sort-customer"]');
      await customerHeader.click();
      await expect(customerHeader).toHaveAttribute("data-active", "1");
      await expect(customerHeader).toHaveAttribute("data-dir", "asc");
      await expect
        .poll(async () => (await rowOrder()).indexOf(live.occurrence.id) <
                          (await rowOrder()).indexOf(unpaid.occurrence.id),
          { message: "ascending by customer must put Live before Unpaid" })
        .toBe(true);

      await customerHeader.click();
      await expect(customerHeader).toHaveAttribute("data-dir", "desc");
      await expect
        .poll(async () => (await rowOrder()).indexOf(unpaid.occurrence.id) <
                          (await rowOrder()).indexOf(live.occurrence.id),
          { message: "a second click must reverse the order" })
        .toBe(true);

      // Only the active column carries the indicator — an arrow on every
      // header says nothing about which one the rows are actually in.
      await expect(page.locator('[data-testid="repeating-sort-next"]'))
        .toHaveAttribute("data-active", "0");

      // ── 2. The unpaid one states its blocker and cannot be ticked ────
      await expect(
        unpaidRow.getByText(/settle or write off the visit first/i),
        "a blocked row must say WHY — a disabled box with nothing beside it reads as a bug",
      ).toBeVisible();
      const unpaidBox = unpaidRow.locator('input[type="checkbox"]');
      await expect(unpaidBox).toBeDisabled();

      // ── 3. Tick the live one and pause the selection ─────────────────
      await liveRow.locator('input[type="checkbox"]').click({ force: true });
      await expect(liveRow).toHaveAttribute("data-selected", "1");

      const bar = page.locator('[data-testid="repeating-selection-bar"]');
      await expect(bar).toBeVisible();
      // The button carries its own count, not the selection's.
      const pauseBtn = page.locator('[data-testid="repeating-pause-selected"]');
      await expect(pauseBtn).toHaveText(/Pause 1/);
      await pauseBtn.click();

      // THE CONFIRM NAMES THE ROW. This is the difference between this and
      // the client-level cascade that was removed: the operator sees what
      // they are about to touch, by name, before anything is written.
      const summary = page.locator('[data-testid="stream-selection-summary"]');
      await expect(summary).toBeVisible({ timeout: 10_000 });
      await expect(summary).toContainText(LIVE);
      await expect(summary).toContainText("E2E Mowing");

      // A reason is MANDATORY — confirm is dead until one is picked, which is
      // what keeps a held service findable next spring.
      const confirm = page.locator('[data-testid="stream-pause-confirm-pause-many"]');
      await expect(
        confirm,
        "a pause with no reason must not be confirmable",
      ).toBeDisabled();

      await page.locator('[data-testid="stream-pause-reason"]').click();
      await page.getByRole("option", { name: /Season over/i }).click();
      await expect(confirm).toBeEnabled();
      await confirm.click();

      // ── 4. The database holds an ORDINARY per-occurrence pause ───────
      //
      // The whole safety claim is that a selection writes exactly what
      // pausing one card at a time writes. Only reading the rows proves it:
      // the status, the reason code, and a history row with the label
      // snapshotted.
      await expect
        .poll(
          async () => {
            const row = await prisma.jobOccurrence.findUnique({
              where: { id: live.occurrence.id },
              select: { status: true, streamPauseReasonCode: true },
            });
            return `${row?.status}:${row?.streamPauseReasonCode}`;
          },
          { timeout: 20_000, message: "the selection must write a normal stream pause" },
        )
        .toBe("STREAM_PAUSED:season_over");

      const events = await prisma.jobOccurrencePauseEvent.findMany({
        where: { occurrenceId: live.occurrence.id },
        select: { reasonCode: true, reasonLabel: true, resumedAt: true },
      });
      expect(events, "one open history row, label snapshotted").toHaveLength(1);
      expect(events[0].reasonCode).toBe("season_over");
      expect(events[0].reasonLabel).toBeTruthy();
      expect(events[0].resumedAt).toBeNull();

      // The unpaid fixture must be untouched — a selection touches ticked
      // rows and nothing else.
      const untouched = await prisma.jobOccurrence.findUnique({
        where: { id: unpaid.occurrence.id },
        select: { status: true },
      });
      expect(
        untouched?.status,
        "nothing outside the selection may move",
      ).toBe("PENDING_PAYMENT");

      // ── 5. The row re-renders as held, and offers the way back ───────
      await expect(liveRow).toHaveAttribute("data-status", "STREAM_PAUSED", {
        timeout: 20_000,
      });
      await expect(liveRow.getByText(/Season over/i)).toBeVisible();
      await expect(
        liveRow.getByRole("button", { name: /Resume repeating/i }),
        "a held row must offer the way back from the same place it was held",
      ).toBeVisible();

      // ── 5b. Filtering by a SPECIFIC pause reason returns rows ───────
      //
      // THE BUG THIS COVERS REACHED THE OPERATOR. "Paused — any reason"
      // worked while every named reason returned nothing: the shared
      // predicate reads `streamPauseReasonCode` and the row carried
      // `pauseReasonCode`. The mismatch type-checked, because the predicate
      // marks its fields optional — and "any reason" kept working only
      // because that branch returns before it reads the field, which made
      // the failure look like missing data rather than a bug.
      //
      // Run HERE, after the fixture is held under "Season over", so the
      // expected count comes from this test's own data rather than the
      // seed's. The search box is still narrowed to the two fixtures.
      const visibleRows = () => page.locator('[data-testid="repeating-rows"] > div').count();

      await page.locator('button[aria-haspopup="listbox"]').first().click();
      await page.getByRole("option", { name: /Paused — any reason/i }).click();
      await expect.poll(visibleRows, { message: "the held fixture must survive 'any reason'" })
        .toBe(1);

      await page.locator('button[aria-haspopup="listbox"]').first().click();
      await page.getByRole("option", { name: /Paused — Season over/i }).click();
      await expect
        .poll(visibleRows, {
          message: "a NAMED reason must narrow the list, not empty it",
        })
        .toBe(1);

      // A reason the fixture is not held under must exclude it — otherwise
      // the assertion above would pass on a filter that ignores the reason.
      await page.locator('button[aria-haspopup="listbox"]').first().click();
      await page.getByRole("option", { name: /Paused — Non-payment/i }).click();
      await expect.poll(visibleRows, { message: "a different reason must exclude it" })
        .toBe(0);

      // Back to everything for the resume below.
      await page.locator('button[aria-haspopup="listbox"]').first().click();
      await page.getByRole("option", { name: /All visits/i }).click();
      await expect(liveRow).toBeVisible({ timeout: 10_000 });

      // ── 6. Resuming the selection restarts it on its OWN cadence ─────
      //
      // THE HALF THAT CAN PILE UP THE BOOK. A shared date would put every
      // resumed service on one day; the default steps each one forward by
      // its own interval from its own last date. The fixture is a 14-day
      // service whose visit sits today, so "its own cadence" is a verifiable
      // number — today + 14 — and not just "some future date".
      const originalStartAt = (await prisma.jobOccurrence.findUnique({
        where: { id: live.occurrence.id },
        select: { startAt: true },
      }))!.startAt!;

      await liveRow.locator('input[type="checkbox"]').click({ force: true });
      const resumeBtn = page.locator('[data-testid="repeating-resume-selected"]');
      await expect(resumeBtn).toHaveText(/Resume 1/);
      await resumeBtn.click();

      // Cadence is pre-selected; the shared-date option is the opt-in.
      await expect(page.locator('[data-testid="resume-many-cadence"]')).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await page.locator('[data-testid="stream-pause-confirm-resume-many"]').click();

      await expect
        .poll(
          async () => {
            const row = await prisma.jobOccurrence.findUnique({
              where: { id: live.occurrence.id },
              select: { status: true },
            });
            return row?.status;
          },
          { timeout: 20_000, message: "the selection must resume the stream" },
        )
        .toBe("SCHEDULED");

      const resumed = await prisma.jobOccurrence.findUnique({
        where: { id: live.occurrence.id },
        select: { startAt: true, streamPauseReasonCode: true, streamPausedAt: true },
      });
      const daysMoved = Math.round(
        (resumed!.startAt!.getTime() - originalStartAt.getTime()) / 86_400_000,
      );
      expect(
        daysMoved,
        "a 14-day service must restart one cadence on, not on a shared date",
      ).toBe(14);
      // The live pause fields are cleared — "is this held" must answer no.
      expect(resumed!.streamPauseReasonCode).toBeNull();
      expect(resumed!.streamPausedAt).toBeNull();

      // …while the history row survives, closed rather than deleted, so
      // "what did we hold for the season, and did it come back?" stays
      // answerable next year.
      const closed = await prisma.jobOccurrencePauseEvent.findMany({
        where: { occurrenceId: live.occurrence.id },
        select: { reasonCode: true, resumedAt: true, resumedOntoAt: true },
      });
      expect(closed, "the pause history must not be deleted by a resume").toHaveLength(1);
      expect(closed[0].reasonCode).toBe("season_over");
      expect(closed[0].resumedAt).not.toBeNull();
      expect(closed[0].resumedOntoAt).not.toBeNull();

      // ── 7. Open lands on the job, for a row that is NOT held ─────────
      //
      // THE CASE THAT SHIPPED BROKEN. Open reused the stream-pause-reminders
      // link, which resolves the job by looking the occurrence up in the
      // DUE-reminders list — so it worked only for a held row whose
      // check-back had already arrived. Everything else (scheduled, awaiting
      // payment, held until spring) narrowed Services to no jobs and showed
      // "No jobs match current filters", which reads as a broken tab.
      //
      // The fixture is back in SCHEDULED after the resume above, so this is
      // exactly that case.
      await liveRow.locator('[data-testid="repeating-open-service"]').click();
      await expect(
        page.getByText(/No jobs match current filters/i),
        "Open must land on the job, not an empty filtered list",
      ).toHaveCount(0, { timeout: 15_000 });
      // And it must not switch on the held-only filter, which would hide
      // every row that is merely scheduled.
      await expect(
        page.getByText(/Has a paused repeating job occurrence/i),
        "a plain Open must not narrow Services to the held set",
      ).toHaveCount(0);
    } finally {
      await cleanup(live);
      await cleanup(unpaid);
    }
  });
});
