import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS } from "../helpers/db";

/**
 * Regression: the Reconcile P&L must always surface fixed-asset
 * purchases in the "Operating Cash After CapEx" subtotal even though
 * the row is capitalized to the balance sheet. The bug this catches:
 * a $7000 mower categorized as Depreciation used to silently vanish
 * from the P&L, giving the operator no signal that the money left the
 * business.
 *
 * The report must expose:
 *   • the raw fixedAssetPurchases total
 *   • operatingCashAfterCapEx = netOperatingIncome − fixedAssetPurchases
 *   • the "Fixed Assets (capitalized)" bucket under Excluded, so
 *     the operator can drill into what was capitalized.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Reconcile P&L — CapEx subtotal", () => {
  test("Fixed-asset row shows up in fixedAssetPurchases, deducts from NOI in operatingCashAfterCapEx, and lands in Excluded", async ({ page }) => {
    const uniqueTag = `E2E_CAPEX_${Date.now()}`;
    // date-handling-allow: e2e-seed
    const now = new Date();
    // date-handling-allow: e2e-seed
    const rowDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    // date-handling-allow: e2e-seed
    const fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = fromDate.toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    const row = await prisma.businessExpense.create({
      data: {
        ledgerId: uniqueTag,
        createdById: USERS.super,
        type: "EXPENSE",
        description: `${uniqueTag} Rider mower`,
        cost: 3000,
        date: rowDate,
        category: "Depreciation line 13",
        vendor: "Home Depot",
      },
    });

    try {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const token = await page.evaluate(async () => {
        const w = window as any;
        return (await w.Clerk?.session?.getToken()) ?? "";
      });
      const resp = await page.request.get(
        `http://127.0.0.1:8080/api/admin/business-expenses/pnl-report?from=${from}&to=${to}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      expect(resp.ok(), await resp.text()).toBe(true);
      const report = await resp.json();

      // fixedAssetPurchases MUST include our seeded $3000 row.
      expect(report.fixedAssetPurchases).toBeGreaterThanOrEqual(3000);

      // operatingCashAfterCapEx MUST equal NOI minus fixedAssetPurchases.
      // The invariant is what makes the second subtotal on the UI a
      // meaningful signal — verify it algebraically here.
      const expected = report.netOperatingIncome - report.fixedAssetPurchases;
      expect(Math.abs(report.operatingCashAfterCapEx - expected)).toBeLessThan(0.01);

      // Excluded bucket surfaces "Fixed Assets (capitalized)" so the
      // operator can drill into it. Presence + non-zero total both
      // matter — silent-disappearance was the original failure mode.
      const excluded = collectCapitalized(report);
      expect(excluded.hasCapitalizedBucket).toBe(true);
      expect(excluded.capitalizedTotal).toBeGreaterThanOrEqual(3000);
    } finally {
      await prisma.businessExpense.delete({ where: { id: row.id } });
    }
  });
});

function collectCapitalized(report: any): {
  hasCapitalizedBucket: boolean;
  capitalizedTotal: number;
} {
  let hasCapitalizedBucket = false;
  let capitalizedTotal = 0;
  const excluded = report.excluded;
  if (!excluded) return { hasCapitalizedBucket, capitalizedTotal };
  const walk = (rows: Array<{ qbAccount: string; total: number }>) => {
    for (const r of rows) {
      if (r.qbAccount === "Fixed Assets (capitalized)") {
        hasCapitalizedBucket = true;
        capitalizedTotal += r.total;
      }
    }
  };
  walk(excluded.flat ?? []);
  for (const group of excluded.groups ?? []) {
    walk(group.children ?? []);
    if (group.parent === "Fixed Assets (capitalized)") {
      hasCapitalizedBucket = true;
      capitalizedTotal += group.directTotal ?? 0;
    }
  }
  return { hasCapitalizedBucket, capitalizedTotal };
}
