// ─────────────────────────────────────────────────────────────────────────────
// Payroll — Super surfaces: upload, replace, identity matching, archive.
//
// Canonical spec: docs/features/payroll.md.
//
// Drives the REAL Gusto fixture through the REAL upload dialog, so the
// whole chain is exercised: file read → POST → parse → conservation check
// → persist → render. The parser has unit tests; this proves the wiring.
//
// Runs under the `owner` project (filename carries the `-owner` token).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { join } from "path";
import { readFileSync } from "fs";
import { makePrisma, USERS, cleanupScratchPayroll } from "../helpers/db";

let prisma: PrismaClient;

const FIXTURE = join(
  process.cwd(),
  "../api/src/services/__fixtures__/gusto-payroll-journal.csv",
);

// The fixture's own natural key. Cleaned explicitly because this spec
// imports the real file rather than seeding scratch rows, and leaving it
// behind would make a later run's "replaced" assertion pass for the wrong
// reason.
const FIXTURE_START = "2026-08-10";
const FIXTURE_END = "2026-08-16";
const FIXTURE_NAMES = ["Serrano", "Torres", "Wanderski"];
// Exact pairs, because the seed also has a "Wanderski" (Michael). Deleting
// identities by SURNAME wiped that mapping and left seeded workers
// unattributed for every later spec.
const FIXTURE_PAIRS = [
  { lastName: "Serrano", firstName: "Caleb" },
  { lastName: "Torres", firstName: "Justin" },
  { lastName: "Wanderski", firstName: "Jacob" },
];

async function cleanupFixtureImport(p: PrismaClient) {
  const period = await p.payrollPeriod.findUnique({
    where: { periodStart_periodEnd: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END } },
  });
  if (period) {
    await p.payrollEntry.deleteMany({ where: { payrollPeriodId: period.id } });
    await p.payrollPeriod.delete({ where: { id: period.id } });
  }
  for (const pair of FIXTURE_PAIRS) {
    await p.payrollIdentity.deleteMany({ where: pair });
  }
}

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.beforeEach(async () => {
  await cleanupScratchPayroll(prisma);
  await cleanupFixtureImport(prisma);
});

test.afterAll(async () => {
  await cleanupScratchPayroll(prisma);
  await cleanupFixtureImport(prisma);
  await prisma.$disconnect();
});

async function gotoSuperPayroll(page: any) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
    // Also stamp the first-open marker: without it the "auto-show Home
    // on the first open of the ET day" effect in pages/index.tsx fires
    // on the reload below and discards the tab stamped here. It is
    // suppressed after 22:00 ET, so a spec missing this passes at
    // night and fails in the afternoon.
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    localStorage.setItem("seedlings_staffTab", JSON.stringify("payroll"));
    localStorage.setItem("seedlings_staffCategory", JSON.stringify("Money"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
}

async function uploadFixture(page: any) {
  await page.getByRole("button", { name: /Upload payroll/i }).first().click();
  await page.waitForTimeout(600);
  await page.setInputFiles('input[type="file"]', FIXTURE);
  await page.getByRole("button", { name: /^Import$/i }).click();
  await page.waitForTimeout(3000);
}

/** Same flow, but with CSV text built in the test rather than read from disk. */
async function uploadCsv(page: any, csv: string) {
  await page.getByRole("button", { name: /Upload payroll/i }).first().click();
  await page.waitForTimeout(600);
  await page.setInputFiles('input[type="file"]', {
    name: "gusto-payroll-journal.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.getByRole("button", { name: /^Import$/i }).click();
  await page.waitForTimeout(3000);
}

/** Caleb's corrected net pay, and the totals that must move with it. */
const CORRECTED_NET = 25;

/**
 * The fixture with ONE figure corrected — a real "Gusto re-ran it" export.
 *
 * Built by string surgery on the real file rather than kept as a second
 * fixture, so it cannot drift away from the original: any change to the
 * source file flows through, and if these anchors ever stop matching the
 * assertion fires rather than silently testing the unmodified file.
 */
function correctedFixture(): string {
  const original = readFileSync(FIXTURE, "utf8");
  // Caleb: a zero-hours row, so his net/check/gross are all "0.00" —
  // anchored on the tail of his line to hit net + check only.
  const calebTail = '"0.00","0.00","0.00","0.00","0.00"\n';
  const calebFixed = '"25.00","0.00","0.00","25.00","0.00"\n';
  // And the "Payroll Totals" row, which must stay consistent or the
  // import's conservation check rejects the file outright.
  const totalsTail = '"1087.44","0.00","0.00","1087.44"';
  const totalsFixed = '"1112.44","0.00","0.00","1112.44"';

  const out = original
    .replace(calebTail, calebFixed)
    .replace(totalsTail, totalsFixed);
  if (out === original) {
    throw new Error("correctedFixture() anchors no longer match the fixture");
  }
  return out;
}

test.describe("Payroll — Super", () => {
  test("imports the real Gusto export and reads its dates from the file", async ({ page }) => {
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(1500);

    // Pay day and period both come from the CSV, not from "now".
    await expect(page.getByText(/Paid 8\/21\/2026/).first()).toBeVisible();
    await expect(page.getByText(/8\/10\/2026 – 8\/16\/2026/).first()).toBeVisible();

    const period = await prisma.payrollPeriod.findUnique({
      where: { periodStart_periodEnd: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END } },
      include: { entries: true },
    });
    expect(period).not.toBeNull();
    expect(period!.payDay).toBe("2026-08-21");
    expect(period!.label).toBe("Weekly Payroll");
    // Three employees; the "Payroll Totals" row is NOT one of them.
    expect(period!.entries).toHaveLength(3);
  });

  test("re-uploading the same period REPLACES it rather than duplicating", async ({ page }) => {
    // The natural key is (periodStart, periodEnd). Re-upload is the only
    // edit path, so this is the behaviour the whole model rests on.
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(1500);

    // A CORRECTED export — the case a replace exists for. Caleb's net moves
    // and the "Payroll Totals" row moves with it, because the import runs a
    // conservation check and rejects a file whose rows don't sum.
    await uploadCsv(page, correctedFixture());
    await expect(page.getByText(/replaced/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(1500);

    const count = await prisma.payrollPeriod.count({
      where: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END },
    });
    expect(count, "re-upload created a duplicate period").toBe(1);

    // Replaced means the FIGURES actually moved — not merely that a row
    // with the same key still exists.
    const caleb = await prisma.payrollEntry.findFirst({
      where: {
        rawLastName: "Serrano",
        payrollPeriod: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END },
      },
    });
    expect(caleb?.netPay, "replace reported success but the data did not change").toBe(
      CORRECTED_NET,
    );

    // And it snapshotted what it displaced.
    const audits = await prisma.auditEvent.findMany({
      where: { scope: "PAYROLL" as any, verb: "PAYROLL_REPLACED" as any },
    });
    expect(audits.length).toBeGreaterThan(0);
  });

  test('re-uploading an IDENTICAL export reports "no change", not "replaced"', async ({
    page,
  }) => {
    // Reported 2026-08-26: an operator re-imported an export they had
    // already loaded, was told it was "replaced", and saw no number move —
    // indistinguishable from a broken import. The replace was correct; the
    // MESSAGE was not. A no-op has to announce itself as one.
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(1500);

    await uploadFixture(page);
    await expect(page.getByText(/no change/i).first()).toBeVisible();
    await expect(
      page.getByText(/^replaced$/i),
      'an unchanged re-import must not claim "replaced"',
    ).toHaveCount(0);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(1500);

    // Still exactly one period, and still the original figures.
    const count = await prisma.payrollPeriod.count({
      where: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END },
    });
    expect(count).toBe(1);
    const caleb = await prisma.payrollEntry.findFirst({
      where: {
        rawLastName: "Serrano",
        payrollPeriod: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END },
      },
    });
    expect(caleb?.netPay).toBe(0);
  });

  test("the employer side is on the tab for `payroll.manage`", async ({ page }) => {
    // THIS ASSERTION WAS INVERTED, and it had to be.
    //
    // It was written when the same feature was three tabs: a Super on the
    // "Admin" payroll tab held `payroll.manage` and still had to be shown
    // the `payroll.view` payload, because the TAB was the narrower thing.
    // There is one Payroll tab now and the tab narrows nothing — what you
    // see comes from what you hold. docs/features/payroll.md is explicit:
    // employer cost is `payroll.manage` only, "on every surface". Keeping
    // the old assertion would have made the build demand that a manager be
    // hidden from their own books.
    //
    // The rule it was really guarding — that the employer side never
    // reaches somebody who does not hold `payroll.manage` — is asserted
    // where it can be: payroll-worker.spec.ts reads the worker's actual
    // response payload, and the `api` project drives the endpoint as each
    // persona. Both run without this file.
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(1500);

    // Confirm we are actually on a rendered payroll surface — otherwise a
    // blank page would pass every assertion below.
    await expect(page.getByText(/TEAM NET/i).first()).toBeVisible({ timeout: 10_000 });

    let body = (await page.locator("body").textContent()) ?? "";
    expect(body, "`payroll.manage` must see the employer side on the tab").toMatch(
      /EMPLOYER COST/i,
    );

    // And in the expanded period, where the per-worker and whole-run
    // breakdowns live.
    await page.getByText(/Paid |Pays /).first().click();
    await page.waitForTimeout(2000);
    body = (await page.locator("body").textContent()) ?? "";
    expect(body, "the expanded period must carry the employer breakdown").toMatch(
      /EMPLOYER COST/i,
    );
    expect(body).toMatch(/FUTA/);
  });

  test("unmatched names surface for review and block worker visibility", async ({ page }) => {
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(2000);

    // The CSV has no employee identifier, so nothing auto-matches.
    // The fixture's three names are all new, so the review queue must gain
    // exactly three. Asserted as a count of THOSE names rather than the
    // section's total, which also includes seed.ts's deliberate unmatched row.
    //
    // The heading moved from a hand-rolled banner ("N names need matching")
    // into the section title when this became a Dashboard section
    // (2026-08-27) — same information, one frame.
    await expect(page.getByText(/payroll names? to match/i)).toBeVisible({ timeout: 10_000 });

    const unmatched = await prisma.payrollEntry.count({
      where: { userId: null, rawLastName: { in: FIXTURE_NAMES } },
    });
    expect(unmatched).toBe(3);
  });

  test("confirming a match back-fills that worker's history", async ({ page }) => {
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(2000);

    const before = await prisma.payrollEntry.count({
      where: { userId: null, rawLastName: { in: FIXTURE_NAMES } },
    });

    // Match the first FIXTURE name specifically. The queue also contains
    // seed.ts's deliberate unmatched row, and rows are sorted by surname,
    // so "first in the list" is not necessarily one of ours.
    const row = page.locator('[data-testid="payroll-unmatched-row"][data-name="Caleb Serrano"]');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.locator('button:has-text("Choose worker")').click();
    await page.waitForTimeout(700);
    await page.getByRole("option").first().click();
    await page.waitForTimeout(400);
    // Match button INSIDE our row. `.first()` would hit the queue's first
    // row (seed.ts's unmatched name), whose button is disabled because no
    // worker is selected for it.
    await row.locator('button:has-text("Match")').click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: /Confirm match/i }).click();
    await page.waitForTimeout(2500);

    // One fewer of OUR names to match, and a persisted mapping so future
    // uploads link automatically.
    // Count the fixture's exact name PAIRS. Counting by surname would also
    // pick up the seed's Wanderski/Michael and never equal 1.
    const identities = await prisma.payrollIdentity.count({
      where: { OR: FIXTURE_PAIRS },
    });
    expect(identities).toBe(1);

    const stillUnmatched = await prisma.payrollEntry.count({
      where: { userId: null, rawLastName: { in: FIXTURE_NAMES } },
    });
    expect(stillUnmatched).toBe(before - 1);
  });

  test("archiving is a soft delete that snapshots what it hides", async ({ page }) => {
    await gotoSuperPayroll(page);
    await uploadFixture(page);
    await page.getByRole("button", { name: /^Done$/i }).click();
    await page.waitForTimeout(2000);

    await page.getByText(/Paid 8\/21\/2026/).first().click();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: /Archive period/i }).click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /^Archive$/i }).click();
    await page.waitForTimeout(2500);

    const period = await prisma.payrollPeriod.findUnique({
      where: { periodStart_periodEnd: { periodStart: FIXTURE_START, periodEnd: FIXTURE_END } },
      include: { entries: true },
    });
    // Soft delete — the row and its entries survive.
    expect(period).not.toBeNull();
    expect(period!.archivedAt).not.toBeNull();
    expect(period!.entries.length).toBe(3);

    const audits = await prisma.auditEvent.findMany({
      where: { scope: "PAYROLL" as any, verb: "PAYROLL_ARCHIVED" as any },
    });
    expect(audits.length).toBeGreaterThan(0);
  });
});
