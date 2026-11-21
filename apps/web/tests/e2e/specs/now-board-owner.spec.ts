import { test, expect, type Page } from "@playwright/test";
import { waitForSplashGone } from "../helpers/nav";

/**
 * Work → Now — the operation as it stands this minute.
 *
 * WHAT THIS COVERS, and why each one is here rather than in a build gate:
 *
 *   1. The board loads and its four counts RECONCILE — done + working +
 *      left must equal the total. They come from one server-side partition
 *      of one list, so a drift here means the partition has a hole in it,
 *      and nothing static can see that.
 *   2. Refresh actually re-reads. A control that looks like it refreshes
 *      and does not is worse than no control, because the "as of" line
 *      beside it then vouches for a figure that never moved.
 *   3. IT DOES NOT POLL, observed rather than read. The build gate scans
 *      for `setInterval` + a network call, which is a source pattern; this
 *      watches the wire with the tab open and idle. The tab DOES re-read
 *      when the document becomes visible again, which is an event rather
 *      than a timer — asserted in the same test so the two cannot be
 *      confused for one another.
 *   4. Start working goes to Home. This is the one action on the tab, and
 *      its failure mode is silence: the whole card is armed — cursor,
 *      hover, arrow — so a dead handler looks exactly like a live one until
 *      somebody presses it. Home's own begin-workday hero shipped wired to
 *      `onLaunchWorkflow={() => {}}` for exactly that reason.
 *
 *      WHO the card is offered to is a build-gate rule, not this one:
 *      `tab-requirements-build-gate` asserts it is gated on `work.claim`
 *      and reads no pay class. It cannot be driven from here — there is no
 *      dev persona holding `schedule.view-all` (which opens the tab)
 *      WITHOUT `work.claim`, though the live book's UNPAID Auditor is
 *      exactly that person, and was being offered a working day.
 *
 * WHAT IS COVERED ELSEWHERE, deliberately not duplicated:
 *   · which personas see the tab — `persona-sweep` reads TAB_REQUIREMENTS
 *     and sweeps all nine, so the `now` row comes for free.
 *   · the endpoint's authz both ways — the `api` project derives from
 *     docs/features/permissions-ROUTE-MAP.md.
 *   · the portfolio narrowing — `permissions-build-gate` G50 asserts it
 *     against both the route and the builder.
 *   · the WITHHOLDING of the clock panels from a reader without
 *     `time.view` — `scheduler-now-board-withheld.spec.ts`, which reads the
 *     response body rather than the page, because the claim is that the
 *     data does not travel. The owner holds `time.view`, so that case
 *     cannot be driven from this file. (An earlier draft of this note said
 *     no dev persona could drive it at all. Three can: scheduler,
 *     coordinator and districtLead.)
 *
 * Runs under `owner`.
 */

const BOARD = "**/api/board/now*";

async function gotoNowTab(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    // Stamp the first-open marker, or the "auto-show the morning tab on the
    // first open of the ET day" effect discards the tab stamped here. It is
    // doubly relevant on this spec: that effect now LANDS on `now` for
    // anybody who can see it, so without the stamp this would pass for the
    // wrong reason and keep passing if the stamping below broke.
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("now"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Work"));
  });
  await page.goto("/");
  // A long first timeout on purpose: `next dev` compiles this tab on its
  // first visit, and a cold compile loses to any fixed wait. The age line
  // only renders once the board request has resolved, so it is the honest
  // signal that the tab is up.
  await expect(page.locator('[data-testid="now-as-of"]')).toBeVisible({
    timeout: 90_000,
  });
  await waitForSplashGone(page);
}

/** The number out of a count tile, which reads "3\nWorking now". */
async function count(page: Page, key: string): Promise<number> {
  const text = await page.locator(`[data-testid="now-count-${key}"]`).innerText();
  return Number(text.split("\n")[0].trim());
}

test("the board loads and its counts reconcile", async ({ page }) => {
  await gotoNowTab(page);

  await expect(page.locator('[data-testid="now-visits"]')).toBeVisible();

  const [working, done, left, total] = await Promise.all([
    count(page, "working-now"),
    count(page, "done"),
    count(page, "left"),
    count(page, "visits-today"),
  ]);
  expect(
    working + done + left,
    `the four tiles are one partition of one list — ${working} working + ` +
      `${done} done + ${left} left should be the ${total} visits today. A ` +
      "gap means a status the server counts in none of the three, which " +
      "reads on screen as work that simply is not there.",
  ).toBe(total);

  // AND THE TOTAL IS VISITS, NOT ROWS.
  //
  // The identity above cannot see this on its own, which is the whole
  // reason for the next two assertions. The board carries the office's own
  // day — tasks, reminders, follow-ups — alongside field work. If those
  // leaked back into the counts they would land in `left`, the partition
  // would still add up perfectly, and "Visits today" would quietly be
  // counting a reminder as a property somebody drove to. That is exactly
  // how it shipped: one list, one count, a heading reading "Today's
  // visits", and a titleless reminder rendering as the word "Visit".
  const visitRows = await page.locator('[data-testid="now-visit"]').count();
  expect(
    visitRows,
    `"Visits today" says ${total} but the panel lists ${visitRows} visits. ` +
      "The tile and the list must be the same set — if they differ, " +
      "something that is not field work is being counted as a visit.",
  ).toBe(total);

  // The office rows must still be ON the board — shown, just not counted.
  // Dropping them would make this pass for the wrong reason, and would
  // hide today's reminders from the one screen meant to show the whole day.
  const officeRows = await page.locator('[data-testid="now-office-row"]').count();
  if (officeRows > 0) {
    await expect(
      page.locator('[data-testid="now-office-rows"]'),
      "non-visit rows must be listed under their own heading, not hidden",
    ).toBeVisible();
  }

  // The age line is load-bearing: once a board updates quietly, one that
  // stopped looks exactly like one that is working.
  await expect(page.locator('[data-testid="now-as-of"]')).toContainText(/As of \d/);
  await expect(page.locator('[data-testid="now-refresh"]')).toBeVisible();
});

test("Refresh re-reads, and nothing else does", async ({ page }) => {
  await gotoNowTab(page);

  // ── Refresh asks the server again ───────────────────────────────────
  const refreshed = page.waitForResponse(
    (r) => r.url().includes("/api/board/now") && r.status() === 200,
    { timeout: 20_000 },
  );
  await page.locator('[data-testid="now-refresh"]').click();
  expect((await refreshed).status()).toBe(200);

  // ── and the tab does not ask on its own ─────────────────────────────
  let unbidden = 0;
  const watch = (r: { url(): string }) => {
    if (r.url().includes("/api/board/now")) unbidden++;
  };
  page.on("request", watch);
  await page.waitForTimeout(12_000);
  expect(
    unbidden,
    "the app does not poll. A timer re-hitting this endpoint costs a " +
      "database connection per tick on every open tab, forever, whether or " +
      "not anybody is looking at it. The wall display at /display is the " +
      "one granted exception, precisely because nobody is standing at it.",
  ).toBe(0);

  // ── but coming back to the tab DOES, which is an event, not a timer ──
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    // BUBBLES, because the listener is on `window`. A real browser fires
    // visibilitychange at the Document and it bubbles up; a synthetic
    // `new Event("visibilitychange")` defaults to bubbles:false, never
    // reaches window, and reads here as "the tab does not re-read when you
    // come back to it" — a failure of the test, not of the tab.
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
  await expect
    .poll(() => unbidden, {
      timeout: 15_000,
      message:
        "returning to the tab must re-read the board — otherwise somebody " +
        "who left it open over lunch comes back to this morning's figures " +
        "with nothing saying so",
    })
    .toBeGreaterThan(0);
  page.off("request", watch);
});

test("Start working goes to Home rather than nothing", async ({ page }) => {
  await gotoNowTab(page);

  const card = page.locator('[data-testid="now-start-working"]');
  if ((await card.count()) === 0) {
    // The persona is already on the clock, so the card is correctly absent
    // and the quieter "My day" one stands in its place. Assert THAT rather
    // than skipping silently — an absent card and a broken one look
    // identical from here otherwise.
    await expect(page.locator('[data-testid="now-my-day"]')).toBeVisible();
    return;
  }

  await card.click();

  // The staff tab is `usePersistedState`, so the navigation writes itself
  // down. Reading the stamp rather than hunting for something on Home keeps
  // this test about THIS card: a Home that changes its layout tomorrow must
  // not turn into a failure here.
  //
  // The failure mode being guarded is silence. The whole card is armed —
  // cursor, hover, arrow — so a dead handler looks exactly like a live one
  // until you press it, which is precisely how Home's own begin-workday
  // hero shipped wired to `() => {}`.
  await expect
    .poll(
      () => page.evaluate(() => localStorage.getItem("seedlings_staffTab")),
      {
        timeout: 15_000,
        message:
          "clicking Start working must land on Home, where the day actually " +
          "starts",
      },
    )
    .toBe(JSON.stringify("home"));
});

test("a photo opens on the WHOLE visit, not just the thumbnails shown", async ({ page }) => {
  // The row shows three tiles and a "+N" chip. The viewer behind them must
  // open on every photo of that visit, and the counter is the only thing
  // that says so out loud — "1 / 5" against three tiles is the assertion
  // that the preview is a preview and not the whole set.
  //
  // WHY THIS IS NOT A BUILD GATE: the number comes from the payload the
  // server chose to send, through a cap, through a `slice(0, 3)`, into a
  // component that counts what it was handed. Every one of those is fine in
  // isolation. Only driving it says whether the count a reader sees matches
  // the photos the visit actually has.
  await gotoNowTab(page);

  const more = page.locator('[data-testid="now-visit-photo-more"]').first();
  const hasOverflow = await more.count();
  test.skip(
    hasOverflow === 0,
    "no seeded visit today has more than 3 photos — reseed; this test is " +
      "about the overflow case specifically",
  );

  // The row this chip belongs to, and how many it claims are hidden.
  const chipText = (await more.innerText()).trim(); // "+2"
  const hidden = Number(chipText.replace("+", ""));
  expect(hidden, `the overflow chip should read "+<number>", got "${chipText}"`).toBeGreaterThan(0);

  await more.click();

  // PhotoLightbox renders "n / total".
  const counter = page.getByText(/^\d+\s*\/\s*\d+$/).first();
  await expect(counter).toBeVisible({ timeout: 10_000 });
  const [startStr, totalStr] = (await counter.innerText()).split("/");
  const total = Number(totalStr.trim());
  const start = Number(startStr.trim());
  expect(
    total,
    "the viewer must hold the three shown plus the number the chip promised",
  ).toBe(3 + hidden);
  // The chip opens on the FIRST HIDDEN photo, not on the first photo — that
  // is the whole point of pressing it rather than a thumbnail.
  expect(start, "the overflow chip must open past the three on the row").toBe(4);

  // It is a carousel, not a single frame. Asserted RELATIVE to where it
  // opened: hard-coding "2 / n" here assumed a click on the first thumbnail
  // and failed against the chip, which is a bug in the test and not in the
  // viewer — the sort of thing that gets "fixed" by weakening the assertion.
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByText(new RegExp(`^${start + 1}\\s*/\\s*${total}$`)).first(),
    "ArrowRight must advance the viewer by one",
  ).toBeVisible({ timeout: 5_000 });

  // And Escape returns to the board rather than leaving it stranded.
  await page.keyboard.press("Escape");
  await expect(counter).toBeHidden({ timeout: 5_000 });
  await expect(page.locator('[data-testid="now-visits"]')).toBeVisible();
});

test("a visit row opens that visit, not just the Jobs tab", async ({ page }) => {
  // "Open in Jobs" at the top of the panel already goes to the tab. A row
  // that did the same would be the worse version of itself: it would drop
  // the reader into their own default filters to hunt for the visit they
  // had just pointed at.
  //
  // Asserted on JobsTab's own "Filtered to 1 occurrence" badge, which only
  // appears when `highlightOccId` is set AND the occurrence came back from
  // the server — so this covers the whole handoff (localStorage key, the
  // remount, the date anchor, the includeOccId fetch) rather than just the
  // navigation. A click that merely landed on Jobs leaves no badge.
  await gotoNowTab(page);

  const row = page.locator('[data-testid="now-visit"]').first();
  await expect(row).toBeVisible();
  await row.click();

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("seedlings_staffTab")), {
      timeout: 20_000,
      message: "clicking a visit must navigate to Jobs",
    })
    .toBe(JSON.stringify("jobs"));

  await expect(
    page.getByText("Filtered to 1 occurrence").first(),
    "Jobs must open narrowed to the visit that was clicked, not to the whole day",
  ).toBeVisible({ timeout: 30_000 });

  // The handoff key is single-use; leaving it behind would re-highlight the
  // same visit on the reader's next unrelated visit to Jobs.
  expect(
    await page.evaluate(() => localStorage.getItem("seedlings_jobs_pendingHighlight")),
    "the pending-highlight key must be consumed by JobsTab",
  ).toBeNull();
});
