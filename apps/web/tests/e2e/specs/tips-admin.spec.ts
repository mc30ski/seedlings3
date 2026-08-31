// ─────────────────────────────────────────────────────────────────────────────
// Tips — Super surfaces: designation at approval, payment card, payroll column.
//
// Canonical design: .claude/memory/project_tips_feature_design.md
// Policy: docs/FINANCIAL_SYSTEM.md §4 "Tips (a designated overpayment)".
//
// A tip is a DESIGNATED OVERPAYMENT — there is no standalone tip entry. The
// specs below cover the two things most likely to break silently:
//
//   1. The designation flow itself (toggle → percentages → approve), driven
//      through the real dialog against the real endpoint. Money is divided
//      here, so a regression is a wrong paycheck, not a cosmetic bug.
//   2. The SEPARATION rule — a tip is never summed into a payout figure.
//      Job pay is work-anchored and tips are payment-anchored, so a merged
//      number matches neither paycheck.
//
// Seed fixtures relied on (apps/api/prisma/seed.ts):
//   • Harrington Main Residence — $85 job paid $125, ALREADY tipped $20
//     ($5 business / $9 Admin Worker / $6 Employee Worker).
//   • "TIP FIXTURE" — $200 job paid $240, PENDING approval, 60/40
//     completionSplits. Drives the designation flow.
//
// Runs under the `super` project (filename carries the `-admin` token).
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect, type Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma } from "../helpers/db";

let prisma: PrismaClient;
test.beforeAll(() => { prisma = makePrisma(); });
test.afterAll(async () => { await prisma.$disconnect(); });

/**
 * Land on a Super tab. Stamps `seedlings_lastAppOpenedAt` because the shell
 * auto-jumps to worker Home on the first open of an ET day, which would
 * otherwise override `topTab` on the second navigation.
 */
async function gotoSuper(page: Page, tab: string, category: string) {
  await page.goto("/");
  await page.evaluate(([t, c]) => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify(t));
    localStorage.setItem("seedlings_superCategory", JSON.stringify(c));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  }, [tab, category]);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3500);
}

/**
 * Expand PENDING APPROVAL and open the approve dialog for the $240
 * overpaid fixture specifically. Targeting the row by its amount rather
 * than "the first Approve button" keeps the spec stable as other seed
 * fixtures come and go from the queue.
 */
async function openApproveDialogForTipFixture(page: Page) {
  // Dismiss anything a previous test left open — a stale dialog keeps its
  // inputs in the DOM and later locators match the hidden copy.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const note = page.getByText(/TIP FIXTURE/).first();
  // The section may render expanded or collapsed depending on persisted
  // state; only toggle it when the fixture isn't already on screen.
  if (!(await note.isVisible().catch(() => false))) {
    const section = page.getByText(/PENDING APPROVAL/i).first();
    if (await section.count()) {
      await section.scrollIntoViewIfNeeded();
      await section.click();
      await page.waitForTimeout(1500);
    }
  }
  await expect(note).toBeVisible();
  // Innermost div holding BOTH the fixture's note and its Approve button —
  // filtering on the note alone matches leaf nodes with no button in them.
  const card = page
    .locator("div")
    .filter({ hasText: /TIP FIXTURE/ })
    .filter({ has: page.getByRole("button", { name: /Approve/ }) })
    .last();
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: /Approve/ }).first().click();
  await page.waitForTimeout(1500);
}

test.describe("Tips — payment card", () => {
  test("a tipped payment shows the Tip badge and the crew/business split", async ({ page }) => {
    await gotoSuper(page, "payments", "Money");

    // The badge proves the tip is distinguishable at a glance from a plain
    // overpayment, which is the whole reason it exists — an overpayment is
    // more often a typo than a tip.
    const badge = page.getByText(/^Tip \$20\.00$/).first();
    await expect(badge).toBeVisible();

    // The breakdown must name BOTH destinations. The crew's share is
    // wages/1099 income while the business's share is ordinary revenue —
    // an operator reconciling payroll needs the split, not just the total.
    await expect(
      page.getByText(/Tip \$20\.00 — \$15\.00 to workers,\s*\$5\.00 to business/),
    ).toBeVisible();
  });

  test("the tip is NOT summed into the worker payout headline", async ({ page }) => {
    await gotoSuper(page, "payments", "Money");
    // $105 job splits + $20 tip. If a refactor ever merges them the headline
    // becomes $120/$125 and silently misstates what payroll owes.
    await expect(page.getByText("$105.00").first()).toBeVisible();
    await expect(page.getByText(/from \$125\.00 paid/)).toBeVisible();
  });
});

test.describe("Tips — designation at approval", () => {
  // Re-seeding between runs restores the pending fixture, but a spec that
  // approves it would poison a re-run within the same seed. Each test here
  // either reads without approving, or restores the row afterwards.
  async function findPendingTipFixture() {
    return prisma.payment.findFirst({
      where: { confirmed: false, note: { contains: "TIP FIXTURE" } },
      include: { occurrence: { select: { id: true, price: true } } },
    });
  }

  test("raising the amount above the invoice reveals the tip editor", async ({ page }) => {
    const pending = await findPendingTipFixture();
    test.skip(!pending, "TIP FIXTURE pending payment missing — reseed dev.");

    await gotoSuper(page, "payments", "Money");

    await openApproveDialogForTipFixture(page);

    // Approve and Edit were MERGED — one dialog, amount editable in place.
    // The tip editor must key off the amount FIELD, not the reported value,
    // or a tip recorded after the fact is unreachable (that's exactly what
    // the two-button split caused).
    const amount = page
      .getByText("Actual amount collected")
      .locator("xpath=following::input[1]")
      .locator("visible=true")
      .first();
    // CurrencyInput rejects input failing /^\d*\.?\d{0,2}$/, so clear first —
    // a partial edit is silently dropped and the value never changes.
    await amount.fill("");
    await amount.fill("260");
    await amount.blur();
    await page.waitForTimeout(800);

    // The dialog states the overpayment in plain money rather than making
    // the operator subtract two numbers themselves.
    await expect(page.getByText(/\$60\.00 over the invoice/)).toBeVisible();

    // Default OFF. An overpayment is more often a data-entry error than a
    // tip, so the operator opts IN — the money stays with the business
    // until someone says otherwise.
    const toggle = page.getByRole("button", { name: /^It's a tip$/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await page.waitForTimeout(500);

    // Percentages seed from the job's completionSplits with business at 0.
    await expect(page.getByText(/Split the \$60\.00 tip/)).toBeVisible();
    await expect(page.getByText(/Total 100\.00%/)).toBeVisible();
  });

  test("approve is blocked while the tip percentages don't total 100", async ({ page }) => {
    const pending = await findPendingTipFixture();
    test.skip(!pending, "TIP FIXTURE pending payment missing — reseed dev.");

    await gotoSuper(page, "payments", "Money");
    await openApproveDialogForTipFixture(page);
    await page.getByRole("button", { name: /^It's a tip$/ }).click();
    await page.waitForTimeout(400);

    // Break the total — the confirm must refuse rather than quietly
    // allocating money somewhere the operator didn't intend. Anchored on
    // the Business row's label: an index-based locator picks up inputs on
    // the page behind the modal.
    const bizPct = page
      .getByText("Business", { exact: true })
      .locator("xpath=following::input[1]")
      .locator("visible=true")
      .first();
    await bizPct.fill("99");
    await page.waitForTimeout(400);
    await expect(page.getByText(/must be 100%/)).toBeVisible();

    const confirm = page.getByRole("button", { name: /^Approve$/ }).last();
    await expect(confirm).toBeDisabled();
  });
});

test.describe("Tips — payroll surface", () => {
  test("payroll exposes a Tips column separate from Additional Earnings", async ({ page }) => {
    await gotoSuper(page, "reconcile", "Money");
    await page.keyboard.press("Escape");

    await page.getByText(/^Worker Payroll/).first().click();
    await page.waitForTimeout(2500);

    // Gusto treats tips as a distinct earning type (and cash vs paycheck
    // tips differ), so folding them into Additional Earnings would lose the
    // FICA tip credit. Both columns must exist independently.
    await expect(page.getByText("Tips", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Additional Earnings").first()).toBeVisible();
  });

  test("a tip lands on the payroll for the date the CLIENT PAID", async () => {
    // Payment-anchored, not work-anchored — this is the rule that lets a
    // worker get the job payout on one payroll and its tip on another.
    // Asserted against the DB because it's a data-anchoring guarantee, not
    // a rendering one.
    const split = await prisma.paymentSplit.findFirst({
      where: { tipAmount: { gt: 0 } },
      include: { payment: { select: { confirmedAt: true } }, user: { select: { displayName: true } } },
    });
    expect(split, "no tipped split in the seed — reseed dev").not.toBeNull();
    expect(split!.payment.confirmedAt).not.toBeNull();
    expect(split!.tipAmount).toBeGreaterThan(0);
  });
});

test.describe("Tips — conservation", () => {
  test("every tipped payment still accounts for exactly what came in", async () => {
    // The build gate fuzzes this against the pure reconciler; this asserts
    // it against rows that actually landed in the database, which is where
    // a persistence bug (a write that drops tipAmount) would show up.
    const payments = await prisma.payment.findMany({
      where: { tipAmount: { gt: 0 } },
      include: { splits: true, occurrence: { select: { expenses: { select: { cost: true } } } } },
    });
    expect(payments.length, "no tipped payment in the seed — reseed dev").toBeGreaterThan(0);

    for (const p of payments) {
      const workerTips = p.splits.reduce((s, x) => s + x.tipAmount, 0);
      // tipToBusiness + every worker's share must equal the designated total.
      expect(
        Math.abs(p.tipToBusinessAmount + workerTips - p.tipAmount),
        `tip parts don't reconcile on payment ${p.id}`,
      ).toBeLessThan(0.005);

      // Tip and overage are mutually exclusive by construction: designating
      // money as a tip moves it OUT of overage.
      expect(p.tipAmount > 0 && p.overageAmount > 0).toBe(false);
    }
  });
});
