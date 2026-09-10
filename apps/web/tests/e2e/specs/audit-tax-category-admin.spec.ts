import { test, expect } from "@playwright/test";
import { makePrisma, USERS } from "../helpers/db";

/**
 * The "Expenses Without a Tax Category" audit check, end to end.
 *
 * Why this needs a browser: the check's id lives in two places — AUDIT_CHECKS
 * on the client and an `if (checks.includes(...))` branch in the route — and a
 * card only renders for a result the server actually returned. So if the two
 * ever drift, the operator ticks the check, runs the audit, and sees NOTHING,
 * which in an audit tool reads as a clean bill of health rather than as a bug.
 * A build gate asserts the two registries agree; this asserts the wiring
 * really carries a finding from the database to the screen.
 *
 * Plants one uncategorised expense so the check has something to find, and
 * runs ONLY this check so the spec stays fast and can't be affected by an
 * unrelated finding elsewhere in the system.
 */

const PROBE_DESC = "E2E_SCRATCH uncategorised expense";

test.describe("Audit — expenses with no tax category", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let expenseId: string | null = null;

  test.beforeAll(async () => {
    prisma = makePrisma();
    const row = await prisma.businessExpense.create({
      data: {
        // The whole point: no category, so it resolves to no Schedule C line.
        category: null,
        description: PROBE_DESC,
        cost: 13.57,
        date: new Date("2026-08-15T12:00:00Z"),
        type: "EXPENSE",
        createdById: USERS.super,
        ledgerId: `E2E-AUDITPROBE-${Date.now().toString(36)}`,
      },
      select: { id: true },
    });
    expenseId = row.id;
  });

  test.afterAll(async () => {
    if (expenseId) {
      await prisma.businessExpense.delete({ where: { id: expenseId } }).catch(() => {});
    }
    await prisma.$disconnect();
  });

  test("the check finds it, and reports it as a Warning", async ({ page }) => {
    await page.goto("/");
    // Wait for React to mount before stamping — `goto` resolves on load, and
    // the tab router writes its own topTab once the app comes up.
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
      localStorage.setItem("seedlings_superTab", JSON.stringify("audit"));
      localStorage.setItem("seedlings_superCategory", JSON.stringify("Records"));
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Acting as Super/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("System Audit", { exact: true })).toBeVisible({ timeout: 30_000 });

    // Run ONLY this check: clear the default all-selected state, then tick ours.
    await page.getByRole("button", { name: "None", exact: true }).click();
    await page.getByText("Expenses Without a Tax Category", { exact: true }).first().click();
    await page.getByRole("button", { name: /Run Audit/i }).click();

    // The result card must appear — its absence is the failure this guards.
    const card = page
      .locator("div")
      .filter({ has: page.getByText("Expenses Without a Tax Category", { exact: true }) })
      .filter({ hasText: PROBE_DESC })
      .last();
    await expect(card, "the check must return a card carrying the finding").toBeVisible({
      timeout: 60_000,
    });

    // The finding names the row well enough to find it in the Ledger by hand —
    // there is no deep-link target for a ledger row, so date and amount are the
    // only handle the operator gets.
    await expect(page.getByText(new RegExp(`2026-08-15.*13\\.57.*${PROBE_DESC}`))).toBeVisible();
    await expect(page.getByText(/no category set, so it has no Schedule C line/)).toBeVisible();

    // And it is a WARNING, not an Issue — the band it lands in is what tells
    // the operator how hard to care.
    await expect(page.getByText("Warnings", { exact: true })).toBeVisible();
    await expect(card.getByText("Warning", { exact: true })).toBeVisible();

    await page.screenshot({ path: "test-results/audit-tax-category.png", fullPage: false });
  });
});
