import { test, expect, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchClientWithContacts,
  deleteScratchClient,
} from "../helpers/db";

/**
 * Work → Repeating — the table, and acting on a row from it.
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
 *   3. Pausing from a row writes an ordinary per-occurrence pause: the
 *      database ends up in STREAM_PAUSED with the reason code recorded and a
 *      history row written. The database assertion is the point — this tab
 *      is a LENS, and the claim is that pausing from it is indistinguishable
 *      from pausing the same visit from its card in Services. Only a read of
 *      those rows proves it.
 *
 *      (Multi-select and bulk pause/resume were removed 2026-11-10 — the
 *      book is one screenful, so the per-row path is the only one.)
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

/**
 * Open the pause-reason menu on the "N paused" summary chip.
 *
 * THE CARET, NOT THE CHIP. Clicking the chip body filters to every paused
 * row — the same one-click behaviour the five chips beside it have — and
 * only the caret opens the menu. A spec that clicks the chip gets a filter
 * and then times out waiting for an option that never appeared, which is
 * exactly how this read before the helper existed.
 */
async function openPauseReasonMenu(page: Page) {
  await page
    .locator('[data-lens="paused"] span[title="Narrow to one pause reason"]')
    .click();
}

/** A client + property + repeating job + one occurrence in `status`.
 *
 *  `opts` exists for the two-clocks test, which needs a visit DATED IN THE
 *  PAST: both "how long has the money been waiting" and "has the stream
 *  expired" are measured from dates, so a fixture pinned to `new Date()`
 *  can only ever produce zero and null. */
async function makeRepeatingFixture(
  clientName: string,
  status: "SCHEDULED" | "PENDING_PAYMENT" | "STREAM_PAUSED",
  opts: { daysAgo?: number; completed?: boolean; requestedDaysAgo?: number } = {},
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
  const startAt = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000);
  const occurrence = await prisma.jobOccurrence.create({
    data: {
      jobId: job.id,
      kind: "SINGLE_ADDRESS",
      workflow: "STANDARD",
      status,
      jobType: "E2E Mowing",
      startAt,
      // The money clock's anchor. Stamped here rather than left to the
      // status, because this fixture writes the row directly and so skips
      // `updateOccurrence`, which is what stamps it in the real app.
      ...(opts.completed ? { completedAt: startAt } : {}),
      // The INVOICE clock, separate from the completion clock on purpose —
      // a visit finished 30 days ago and invoiced yesterday is the case the
      // two badges exist to tell apart.
      ...(opts.requestedDaysAgo !== undefined
        ? {
            paymentRequestSentAt: new Date(Date.now() - opts.requestedDaysAgo * 86_400_000),
            paymentRequestFirstSentAt: new Date(Date.now() - opts.requestedDaysAgo * 86_400_000),
          }
        : {}),
      ...(status === "STREAM_PAUSED"
        ? { streamPausedAt: new Date(), streamPauseReasonCode: "season_over" }
        : {}),
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
  test("a scheduled repeating job occurrence can be paused from its row; an unpaid one offers no pause", async ({ page }) => {
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
      // A BLOCKED ROW OFFERS NO PAUSE AT ALL. It used to carry a disabled
      // tick beside the stated reason; with the multi-select gone, the rule
      // is simply that the control is absent and the sentence explains why.
      await expect(
        unpaidRow.getByRole("button", { name: /Pause repeating/i }),
        "an unpaid visit must not offer a pause it would refuse",
      ).toHaveCount(0);

      // ── 3. Pause the live one from its own row ───────────────────────
      await liveRow.getByRole("button", { name: /Pause repeating/i }).click();

      // A reason is MANDATORY — confirm is dead until one is picked, which is
      // what keeps a paused service findable next spring.
      const confirm = page.locator('[data-testid="stream-pause-confirm-pause"]');
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
          { timeout: 20_000, message: "the row must write a normal stream pause" },
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

      // The unpaid fixture must be untouched — a pause touches the row it
      // rows and nothing else.
      const untouched = await prisma.jobOccurrence.findUnique({
        where: { id: unpaid.occurrence.id },
        select: { status: true },
      });
      expect(
        untouched?.status,
        "nothing outside the paused row may move",
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

      await openPauseReasonMenu(page);
      await page.getByRole("option", { name: /Paused — any reason/i }).click();
      await expect.poll(visibleRows, { message: "the held fixture must survive 'any reason'" })
        .toBe(1);

      await openPauseReasonMenu(page);
      await page.getByRole("option", { name: /Paused — Season over/i }).click();
      await expect
        .poll(visibleRows, {
          message: "a NAMED reason must narrow the list, not empty it",
        })
        .toBe(1);

      // A reason the fixture is not held under must exclude it — otherwise
      // the assertion above would pass on a filter that ignores the reason.
      // THE CHIP IS THE MENU NOW. Addressed by `data-lens` rather than
      // "the first listbox on the page", which was only ever true by
      // accident of DOM order and quietly re-aimed when the control moved
      // from the toolbar up into the summary strip.
      await openPauseReasonMenu(page);
      await page.getByRole("option", { name: /Paused — Non-payment/i }).click();
      await expect.poll(visibleRows, { message: "a different reason must exclude it" })
        .toBe(0);

      // Back to everything for the resume below. The "off" item is named
      // for this screen's unit — Jobs and Services still say "All visits".
      await openPauseReasonMenu(page);
      await page.getByRole("option", { name: "All repeating job occurrences" }).click();
      await expect(liveRow).toBeVisible({ timeout: 10_000 });

      // ── 6. Resuming from the row puts it back on the schedule ───────
      //
      // The dialog opens on a suggested date — this stream's own cadence
      // stepped forward from its last visit — so the commonest next action
      // is "confirm", not "now change it".
      const originalStartAt = (await prisma.jobOccurrence.findUnique({
        where: { id: live.occurrence.id },
        select: { startAt: true },
      }))!.startAt!;

      await liveRow.getByRole("button", { name: /Resume repeating/i }).click();
      const resumeConfirm = page.locator('[data-testid="stream-pause-confirm-resume"]');
      await expect(
        resumeConfirm,
        "the resume date must be pre-filled, or confirm would be dead on open",
      ).toBeEnabled();
      await resumeConfirm.click();

      await expect
        .poll(
          async () => {
            const row = await prisma.jobOccurrence.findUnique({
              where: { id: live.occurrence.id },
              select: { status: true },
            });
            return row?.status;
          },
          { timeout: 20_000, message: "the row must resume the stream" },
        )
        .toBe("SCHEDULED");

      const resumed = await prisma.jobOccurrence.findUnique({
        where: { id: live.occurrence.id },
        select: { startAt: true, streamPauseReasonCode: true, streamPausedAt: true },
      });
      // CALENDAR DAYS IN ET, NOT A MILLISECOND DIVISION. The resume writes a
      // DATE, so the restarted visit sits at ET midnight while the original
      // sat at whatever time the fixture was created — and `(b - a) / 86.4e6`
      // on that pair is 13.46, which rounds to 13 and fails an assertion
      // about a 14-day cadence that is in fact correct. Same UTC-noon anchor
      // the API's own `etDaysBetween` uses, so DST cannot move it either.
      const etKey = (d: Date) =>
        new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
      const etDaysApart = (a: Date, b: Date) => {
        const [ay, am, ad] = etKey(a).split("-").map(Number);
        const [by, bm, bd] = etKey(b).split("-").map(Number);
        return Math.round(
          (Date.UTC(by, bm - 1, bd, 12) - Date.UTC(ay, am - 1, ad, 12)) / 86_400_000,
        );
      };
      expect(
        etDaysApart(originalStartAt, resumed!.startAt!),
        "a 14-day service must restart one cadence on from its last visit",
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
      // reminder had already arrived. Everything else (scheduled, awaiting
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

  test("an unpaid visit states how long it has waited, and a stopped stream is marked expired", async ({ page }) => {
    const stamp = Date.now();
    // 30 days back on a 14-day cadence: the next visit came due 16 days ago
    // and was never created, so this stream has stopped.
    const STALLED = `E2E Clocks Stalled ${stamp}`;
    // Same age, same cadence — but PAUSED, which is a deliberate stop with a
    // reason attached. It must NOT be called expired. This is the assertion
    // that matters most on this screen: the whole feature exists to pause
    // repeating job occurrences, and marking the operator's own decision as
    // a failure would discredit it.
    const PAUSED = `E2E Clocks Paused ${stamp}`;
    // Today, unpaid: the money clock must read "Finished today" rather than
    // "Waiting 0 days", and nothing about it is expired yet.
    const FRESH = `E2E Clocks Fresh ${stamp}`;

    const stalled = await makeRepeatingFixture(STALLED, "PENDING_PAYMENT", {
      daysAgo: 30,
      completed: true,
      // Finished 30 days ago, invoiced 2 days ago. THE WHOLE REASON BOTH
      // NUMBERS EXIST: the invoice clock alone calls this nearly fresh.
      requestedDaysAgo: 2,
    });
    const paused = await makeRepeatingFixture(PAUSED, "STREAM_PAUSED", { daysAgo: 30 });
    const fresh = await makeRepeatingFixture(FRESH, "PENDING_PAYMENT", { completed: true });

    try {
      await gotoRepeatingTab(page);
      const search = page.locator("input#repeating-search");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("E2E Clocks");

      const stalledRow = page.locator(`[data-testid="repeating-row-${stalled.occurrence.id}"]`);
      const pausedRow = page.locator(`[data-testid="repeating-row-${paused.occurrence.id}"]`);
      const freshRow = page.locator(`[data-testid="repeating-row-${fresh.occurrence.id}"]`);
      await expect(stalledRow).toBeVisible({ timeout: 20_000 });

      // ── 1. How long the money has been waiting ───────────────────────
      await expect(
        stalledRow.locator('[data-testid="repeating-awaiting-age"]'),
        'an unpaid visit must say how long it has waited — "Awaiting payment" reads the same at 2 days and at 45',
      ).toHaveText(/Waiting 30 days/);

      // Zero is a sentence, not a number. "Waiting 0 days" is the shape this
      // would have shipped as.
      await expect(
        freshRow.locator('[data-testid="repeating-awaiting-age"]'),
      ).toHaveText(/Finished today/);

      // A paused row is not waiting on money and must carry no clock at all.
      await expect(
        pausedRow.locator('[data-testid="repeating-awaiting-age"]'),
      ).toHaveCount(0);

      // ── 1b. And when we last ASKED, which is a different number ──────
      //
      // Finished 30 days ago, invoiced 2 days ago. Money → Awaiting payment
      // used to show only the second and called it "Requested 2 days ago",
      // which is true and reads as a fresh invoice on a month-old debt.
      await expect(
        stalledRow.locator('[data-testid="payment-wait-requested"]'),
      ).toHaveText(/Requested 2 days ago/);

      // Never asked is its OWN state, not a blank. It is the operator's
      // move rather than the client's, and Money → Awaiting payment cannot
      // show these at all — it lists invoices that went out.
      await expect(
        freshRow.locator('[data-testid="payment-wait-never-requested"]'),
        "a visit nobody has invoiced must say so, not show an empty slot",
      ).toBeVisible();
      await expect(
        freshRow.locator('[data-testid="payment-wait-requested"]'),
      ).toHaveCount(0);

      // ── 2. The stopped stream is marked expired ──────────────────────
      //
      // Read off the attribute as well as the text: the attribute is what
      // the stripe's colour is driven from, and a green text assertion with
      // a transparent stripe would be a feature nobody can see while
      // scanning.
      await expect(
        stalledRow,
        "a stream whose next visit came due 16 days ago and was never created has expired",
      ).toHaveAttribute("data-expired", "16");
      await expect(
        stalledRow.locator('[data-testid="repeating-expired"]'),
      ).toHaveText(/Expired 16d/);

      // ── 3. A PAUSED stream is never expired ──────────────────────────
      await expect(
        pausedRow,
        "a paused stream stopped on purpose — calling that expired paints the operator's own decision as a failure",
      ).toHaveAttribute("data-expired", "0");
      await expect(
        pausedRow.locator('[data-testid="repeating-expired"]'),
      ).toHaveCount(0);

      // ── 4. Nor is a stream that is merely between visits ─────────────
      await expect(freshRow).toHaveAttribute("data-expired", "0");

      // ── 5. The count reaches the summary strip ───────────────────────
      // Unfiltered, so it counts the seed's stalled streams too — assert it
      // is present and at least our one rather than pinning a number the
      // seed can move.
      const badge = page.locator('[data-testid="repeating-expired-count"]');
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(/\d+ expired/);
      const n = Number((await badge.innerText()).match(/\d+/)?.[0] ?? 0);
      expect(n, "the stalled fixture must be in the count").toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup(stalled);
      await cleanup(paused);
      await cleanup(fresh);
    }
  });

  test("a row can message its customer, with a draft keyed to what it is about to do", async ({ page }) => {
    const stamp = Date.now();
    const NAME = `E2E Contact ${stamp}`;
    const f = await makeRepeatingFixture(NAME, "SCHEDULED");
    try {
      // The shared fixture gives its contact a phone and an email. Strip
      // both first, so the no-icon case below is actually being exercised
      // rather than assumed.
      await prisma.clientContact.updateMany({
        where: { clientId: f.scratch.clientId },
        data: { phone: null, email: null },
      });
      await gotoRepeatingTab(page);
      const search = page.locator("input#repeating-search");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("E2E Contact");

      const row = page.locator(`[data-testid="repeating-row-${f.occurrence.id}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });

      // The fixture's contact has no phone or email, so the icon must not
      // render at all — a dead control teaches the operator to ignore it.
      await expect(
        row.locator('[data-testid="contact-menu-trigger"]'),
        "an unreachable customer must offer no messaging icon",
      ).toHaveCount(0);

      // Give them a phone, and the icon appears with the pause draft.
      await prisma.clientContact.updateMany({
        where: { clientId: f.scratch.clientId },
        data: { phone: "(555) 123-9999" },
      });
      await page.reload();
      await expect(search).toBeVisible({ timeout: 30_000 });
      await search.fill("E2E Contact");
      await expect(row).toBeVisible({ timeout: 20_000 });

      const trigger = row.locator('[data-testid="contact-menu-trigger"]');
      await expect(trigger, "a reachable customer must be messageable").toHaveCount(1);
      await trigger.click();

      const menu = page.locator('[data-testid="contact-menu"]');
      await expect(menu).toBeVisible();
      // SCHEDULED, so the draft is the one about pausing — the point of
      // putting this beside the decision rather than a tab away.
      await expect(
        menu.locator('[data-testid="contact-menu-draft"]'),
        "a pausable row must draft the message about pausing",
      ).toHaveText(/pausing/i);
      await expect(menu.locator('[data-testid="contact-menu-text"]')).toContainText("555");
      // No email on this contact, so no email item.
      await expect(menu.locator('[data-testid="contact-menu-email"]')).toHaveCount(0);

      // It closes without sending anything.
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    } finally {
      await cleanup(f);
    }
  });

  test("a stream with no live visit is still listed, and says how long", async ({ page }) => {
    // THE BUG THAT COST A CUSTOMER. This table listed live occurrences, so a
    // stream vanished the moment its last visit closed or was cancelled. A
    // real customer sat cancelled for 73 days and five missed visits with
    // her job still marked an ACCEPTED fortnightly, and the business found
    // out from a bad review.
    const stamp = Date.now();
    const STOPPED = `E2E Unserved Stopped ${stamp}`;
    const CANCELLED = `E2E Unserved Cancelled ${stamp}`;

    // The stopped fixture is a 14-day service last served SEVENTY-FIVE days
    // ago. That is 5.35 cycles, and the screen must say 5: nobody is a third
    // of a visit behind, and the count is floored so it can never overstate
    // the neglect. An exact multiple would have passed whether the figure
    // floored or rounded, which is why this one deliberately is not.
    const stopped = await makeRepeatingFixture(STOPPED, "SCHEDULED", { daysAgo: 75 });
    const cancelled = await makeRepeatingFixture(CANCELLED, "SCHEDULED", { daysAgo: 70 });
    try {
      // Take the live visit away: one finishes cleanly, one is cancelled.
      // Neither leaves anything for the old occurrence-rooted query to find.
      await prisma.jobOccurrence.update({
        where: { id: stopped.occurrence.id },
        data: { status: "CLOSED", completedAt: new Date(Date.now() - 75 * 86_400_000) },
      });
      await prisma.jobOccurrence.update({
        where: { id: cancelled.occurrence.id },
        data: { status: "CANCELED" },
      });

      await gotoRepeatingTab(page);
      const search = page.locator("input#repeating-search");
      await expect(search).toBeVisible({ timeout: 20_000 });
      await search.fill("E2E Unserved");

      // KEYED ON THE JOB, because there is no occurrence to key on.
      const stoppedRow = page.locator(`[data-testid="repeating-row-job:${stopped.job.id}"]`);
      const cancelledRow = page.locator(`[data-testid="repeating-row-job:${cancelled.job.id}"]`);

      await expect(
        stoppedRow,
        "a stream whose last visit closed must still be listed — it used to vanish",
      ).toBeVisible({ timeout: 20_000 });
      // BOTH carry the same status — there is no visit, and that is all
      // `status` means here. Which KIND of absence shows on the badge, from
      // `dormancy`; `status` deliberately does not ape a JobOccurrenceStatus
      // spelling (an invented "CANCELLED" with two Ls once sat in this field
      // beside the enum's one-L CANCELED).
      await expect(stoppedRow).toHaveAttribute("data-status", "NO_VISIT");
      await expect(stoppedRow).toContainText("Not being served");
      await expect(cancelledRow).toBeVisible();
      await expect(cancelledRow).toHaveAttribute("data-status", "NO_VISIT");
      await expect(
        cancelledRow,
        "a cancelled stream must read differently from one that merely stopped",
      ).toContainText("Cancelled, nothing since");

      // MISSED VISITS, NOT DAYS, AND WHOLE ONES: 75 days on a 14-day
      // service is 5.35 cycles, which is 5 missed visits.
      await expect(
        stoppedRow,
        "neglect must be stated in missed visits, which reads the same for a weekly and a monthly customer",
      ).toContainText("5 missed");

      // Nothing to pause — and offering a control whose every click refuses
      // teaches the operator to ignore controls.
      await expect(stoppedRow.getByRole("button", { name: /Pause repeating/i })).toHaveCount(0);
      await expect(stoppedRow.getByRole("button", { name: /Resume repeating/i })).toHaveCount(0);

      // The draft is the one this row exists for: ask whether they still
      // want the service, rather than silently rebook or silently drop.
      await prisma.clientContact.updateMany({
        where: { clientId: stopped.scratch.clientId },
        data: { phone: "(555) 404-0001" },
      });
      await page.reload();
      await expect(search).toBeVisible({ timeout: 30_000 });
      await search.fill("E2E Unserved");
      await expect(stoppedRow).toBeVisible({ timeout: 20_000 });
      await stoppedRow.locator('[data-testid="contact-menu-trigger"]').click();
      await expect(
        page.locator('[data-testid="contact-menu-draft"]'),
      ).toHaveText(/still on/i);
      await page.keyboard.press("Escape");

      // And the chip counts them and filters to exactly them.
      const chip = page.locator('[data-lens="unserved"]');
      await expect(chip).toBeVisible();
      const said = Number((await chip.innerText()).match(/\d+/)?.[0] ?? -1);
      await search.fill("");
      await chip.click();
      await expect(page.locator('[data-testid^="repeating-row-"]')).toHaveCount(said);
    } finally {
      await cleanup(stopped);
      await cleanup(cancelled);
    }
  });

  test("every summary chip filters to exactly the rows it counted", async ({ page }) => {
    // THE CLAIM THAT MATTERS: a chip says "6 expired" and then shows six.
    // The gate asserts the count and the filter are the same expression,
    // which is a claim about the source; this is the claim about the screen.
    // Driven over the SEED book rather than fixtures, because the bug this
    // guards against is a predicate that disagrees with itself on real data.
    await gotoRepeatingTab(page);
    const rows = page.locator('[data-testid^="repeating-row-"]');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });

    const all = page.locator('[data-lens="all"]');
    const total = Number((await all.innerText()).match(/\d+/)?.[0] ?? 0);
    expect(total, "the book must have rows to filter").toBeGreaterThan(0);
    await expect(rows).toHaveCount(total);

    // "paused" is deliberately absent from this loop: it opens the reason
    // MENU rather than toggling, so a click does not and must not filter.
    // Its count-matches-rows claim is driven in its own test below, through
    // the menu — not skipped, asserted somewhere this loop cannot reach.
    for (const lens of ["scheduled", "blocked", "due", "expired"]) {
      const chip = page.locator(`[data-lens="${lens}"]`);
      // The three conditional chips are absent when their count is zero —
      // a chip reading "0 expired" is a filter to an empty table.
      if ((await chip.count()) === 0) continue;

      const said = Number((await chip.innerText()).match(/\d+/)?.[0] ?? -1);
      await chip.click();
      await expect(chip).toHaveAttribute("data-active", "1");
      await expect(
        rows,
        `the "${lens}" chip counted ${said}; the table must show exactly that many`,
      ).toHaveCount(said);

      // Clicking the lit chip returns to everything — the same toggle the
      // Due button has.
      await chip.click();
      await expect(chip).toHaveAttribute("data-active", "0");
      await expect(rows).toHaveCount(total);
    }

    // ── ONE CONTROL PER FILTER ───────────────────────────────────────
    //
    // The strip is now every filter this screen has. A "To review" button
    // and a pause-reason icon button used to sit under it, each repeating
    // what a chip already said; both are folded into their chips. Two
    // controls for one question is the shape of the bug that got the
    // previous bulk-pause feature deleted.
    await expect(
      page.locator('[data-testid="repeating-due-filter"]'),
      "the separate To review button must be gone — the chip is the control",
    ).toHaveCount(0);
  });

  test("the paused chip is the reason filter, and its count follows the reason", async ({ page }) => {
    // THE CHIP MUST NOT LIE. It states a count and then filters to it, and
    // that has to keep holding once a reason narrows the set — which is the
    // whole risk of hanging the reason menu off a counting chip.
    await gotoRepeatingTab(page);
    const rows = page.locator('[data-testid^="repeating-row-"]');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });

    const chip = page.locator('[data-lens="paused"]');
    const body = chip.locator('[data-testid="lens-chip-body"]');
    const caret = chip.locator('span[title="Narrow to one pause reason"]');
    const countOn = async () => Number((await chip.innerText()).match(/\d+/)?.[0] ?? -1);
    const total = Number(
      (await page.locator('[data-lens="all"]').innerText()).match(/\d+/)?.[0] ?? 0,
    );

    // Unfiltered, the chip counts every paused row.
    const allPaused = await countOn();
    expect(allPaused, "the seed book must have paused rows to narrow").toBeGreaterThan(0);

    // ── ONE CLICK FILTERS, like every other chip ─────────────────────
    //
    // THE BUG THIS GUARDS. The whole chip was the menu trigger, so a click
    // opened a menu and filtered nothing — you had to then pick "Paused —
    // any reason", a second step with nothing on screen to suggest it,
    // while the five chips beside it all filtered on the first click. The
    // operator's words: "that isn't obvious".
    await body.click();
    await expect(chip, "one click on the body must filter").toHaveAttribute("data-active", "1");
    await expect(rows).toHaveCount(allPaused);
    await expect(
      chip,
      "and must NOT pop the menu open — Ark opens on pointerdown, so the body has to stop it there",
    ).toHaveAttribute("aria-expanded", "false");

    // Clicking again clears, the same toggle the other chips have.
    await body.click();
    await expect(chip).toHaveAttribute("data-active", "0");
    await expect(rows).toHaveCount(total);

    // ── THE CARET OPENS THE MENU, and filters nothing by itself ──────
    await caret.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(chip, "opening the menu must not apply a filter")
      .toHaveAttribute("data-active", "0");
    await expect(rows).toHaveCount(total);

    // "Paused — any reason" is the whole paused set.
    await page.getByRole("option", { name: "Paused — any reason" }).click();
    await expect(chip).toHaveAttribute("data-active", "1");
    await expect(rows).toHaveCount(allPaused);

    // Now narrow to ONE reason. The chip has to restate its count and name
    // the reason, and the table has to match the new number — not the old.
    await caret.click();
    const reasonOption = page.getByRole("option", { name: /^Paused — (?!any reason)/ }).first();
    const reasonName = (await reasonOption.innerText()).replace(/^Paused — /, "").trim();
    await reasonOption.click();

    await expect(chip, "the chip must name the reason it is narrowed to")
      .toHaveText(new RegExp(reasonName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const narrowed = await countOn();
    await expect(
      rows,
      `the chip says ${narrowed} under "${reasonName}"; the table must show exactly that`,
    ).toHaveCount(narrowed);
    expect(narrowed, "a single reason cannot exceed every paused row").toBeLessThanOrEqual(allPaused);

    // Clearing from the menu drops the reason too — a reason left armed
    // would silently empty the list the next time paused is switched on.
    await caret.click();
    await page.getByRole("option", { name: "All repeating job occurrences" }).click();
    await expect(chip).toHaveAttribute("data-active", "0");
    await expect(chip, "clearing must drop the reason from the chip")
      .not.toHaveText(new RegExp(reasonName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(chip).toHaveText(new RegExp(`${allPaused} paused`));
  });
});
