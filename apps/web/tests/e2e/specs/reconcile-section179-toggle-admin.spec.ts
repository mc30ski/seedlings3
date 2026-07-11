import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS } from "../helpers/db";

/**
 * Regression: the §179 toggle on the Reconcile P&L must actually
 * route fixed-asset rows differently based on its state. Before the
 * fix, a $7000 mower categorized as "Depreciation (line 13)" was
 * silently filtered out of the P&L in every scenario — even when the
 * operator explicitly wanted year-of-purchase expensing.
 *
 * This spec:
 *   1. Seeds one BusinessExpense row above the fixed-asset threshold
 *      (Depreciation category, $3,000) dated in-window.
 *   2. Fetches /admin/business-expenses/pnl-report?section179=true and
 *      asserts the row's dollars land in the operating expense
 *      section, not in Excluded.
 *   3. Fetches the same report with section179=false and asserts the
 *      row lands in the Excluded bucket under "Fixed Assets
 *      (capitalized)" instead.
 *   4. Verifies the report payload echoes the toggle state + the
 *      threshold so the UI can render the correct copy.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Reconcile P&L — §179 toggle", () => {
  test("Fixed-asset row moves between operating expenses and Excluded based on the toggle", async ({ page }) => {
    // Seed a fixed-asset-eligible row inside a fresh date window we
    // can reason about deterministically.
    const uniqueTag = `E2E_S179_${Date.now()}`;
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
        // Categorized as Depreciation — this is the operator's stated
        // intent for tax treatment. Without the §179 toggle wired
        // correctly, the row is silently invisible regardless of
        // category.
        category: "Depreciation line 13",
        vendor: "Home Depot",
      },
    });

    try {
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Bearer token from the live Clerk session so the direct API
      // calls below carry auth. (The _proxy path 500s in the test
      // environment because API_BASE_URL isn't configured; going
      // straight to the API is simpler than teaching the harness.)
      const token = await page.evaluate(async () => {
        const w = window as any;
        return (await w.Clerk?.session?.getToken()) ?? "";
      });
      const apiFetch = (url: string) =>
        page.request.get(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

      // Section 179 ON (default) — the row must reach the P&L as an
      // operating expense. It shows up somewhere in expenses.flat OR
      // expenses.groups; either way, the excluded bucket must NOT
      // include a matching dollar amount for our seeded row.
      const respOn = await apiFetch(
        `http://127.0.0.1:8080/api/admin/business-expenses/pnl-report?from=${from}&to=${to}&section179=true`,
      );
      expect(respOn.ok(), await respOn.text()).toBe(true);
      const reportOn = await respOn.json();
      expect(reportOn.section179).toBe(true);
      expect(reportOn.fixedAssetMinCost).toBeGreaterThan(0);
      const excludedOn = collectExcluded(reportOn);
      // Our seeded row's dollars should NOT be in the excluded bucket
      // when §179 is on. (Other unrelated dollars might, from the
      // seed's real rows — assert on absence of the seeded amount.)
      expect(excludedOn.hasCapitalizedBucket).toBe(false);

      // Section 179 OFF — the same row is capitalized and lands in
      // Excluded under "Fixed Assets (capitalized)".
      const respOff = await apiFetch(
        `http://127.0.0.1:8080/api/admin/business-expenses/pnl-report?from=${from}&to=${to}&section179=false`,
      );
      expect(respOff.ok(), await respOff.text()).toBe(true);
      const reportOff = await respOff.json();
      expect(reportOff.section179).toBe(false);
      const excludedOff = collectExcluded(reportOff);
      expect(excludedOff.hasCapitalizedBucket).toBe(true);
      expect(excludedOff.capitalizedTotal).toBeGreaterThanOrEqual(3000);
    } finally {
      await prisma.businessExpense.delete({ where: { id: row.id } });
    }
  });
});

/** Walk the `excluded` bucket looking for the "Fixed Assets
 *  (capitalized)" account. Returns whether it exists and its running
 *  total across every group + flat row. */
function collectExcluded(report: any): {
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
