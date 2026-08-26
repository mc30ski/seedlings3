// ─────────────────────────────────────────────────────────────────────────────
// Payroll — the ADMIN projection, in a real browser.
//
// Canonical spec: docs/features/payroll.md.
//
// Runs under the `admin-role` project (ADMIN, NOT SUPER). That distinction
// is the whole point: SUPER outranks ADMIN and receives the full payload,
// so an admin-only restriction is invisible from a super session. Testing
// this from `super` would pass while proving nothing.
//
// THE PROMISE UNDER TEST: an admin looking at another worker gets hours /
// gross / net and nothing else. The tax breakdown is Super-only. The
// restriction lives in the RESPONSE — a payload that carries tax figures
// and hides them in the UI would be a leak, so these assertions read the
// payload, not the DOM.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  USERS,
  createScratchPayrollPeriod,
  cleanupScratchPayroll,
} from "../helpers/db";

let prisma: PrismaClient;

// seed.ts creates real payroll history, so this spec must locate ITS OWN
// period rather than assuming index 0 in the list.
const SCRATCH_PAY_DAY = "2026-07-17";

const TAX_FIELDS = [
  "federalIncomeTax",
  "stateTaxEmployee",
  "socialSecurityEmployee",
  "medicareEmployee",
  "employeeTaxes",
  "employerCost",
] as const;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.beforeEach(async () => {
  await cleanupScratchPayroll(prisma);
  await createScratchPayrollPeriod(prisma, {
    periodStart: "2026-07-06",
    periodEnd: "2026-07-12",
    payDay: "2026-07-17",
    uploadedById: USERS.super,
    workers: [
      { userId: USERS.employee, firstName: "Mine", netPay: 1234.56, grossEarnings: 1500.01 },
      { userId: USERS.contractor, firstName: "Theirs", netPay: 4321.99, grossEarnings: 5000.02 },
    ],
  });
});

test.afterAll(async () => {
  await cleanupScratchPayroll(prisma);
  await prisma.$disconnect();
});

/** Call the API with the app's own Clerk bearer token. See payroll-worker. */
async function apiAs(page: any, path: string): Promise<{ status: number; json: any }> {
  return page.evaluate(async (p: string) => {
    const token = await (window as any).Clerk?.session?.getToken?.();
    const r = await fetch(p, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      /* non-JSON */
    }
    return { status: r.status, json };
  }, path);
}

async function gotoAdminPayroll(page: any) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("admin"));
    localStorage.setItem("seedlings_adminTab", JSON.stringify("payroll"));
    localStorage.setItem("seedlings_adminCategory", JSON.stringify("Money"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
}

test.describe("Payroll — admin projection", () => {
  test("an admin payload carries NO tax or employer-cost field", async ({ page }) => {
    await gotoAdminPayroll(page);

    const periods = await apiAs(page, "/api/payroll/periods");
    expect(periods.status).toBe(200);
    const scratch = periods.json.find((p: any) => p.payDay === SCRATCH_PAY_DAY);
    expect(scratch, "scratch period missing from the admin list").toBeTruthy();

    const detail = await apiAs(page, `/api/payroll/periods/${scratch.id}/entries`);
    expect(detail.status).toBe(200);
    expect(detail.json.entries.length).toBeGreaterThan(0);

    for (const entry of detail.json.entries) {
      for (const f of TAX_FIELDS) {
        expect(
          entry.values,
          `admin received ${f} for ${entry.rawFirstName} — this is a leak`,
        ).not.toHaveProperty(f);
      }
    }
  });

  test("the period AGGREGATE carries no employer cost either", async ({ page }) => {
    // The per-entry projection is built by fieldsFor(); the period-level
    // `teamTotals` is built separately from the stored totals JSON, so it
    // is a second, independent path to the same figure. Shipping it here
    // would return through the back door exactly what the test above
    // proves is withheld — and on a three-person payroll an aggregate is
    // close enough to per-person to matter.
    await gotoAdminPayroll(page);

    const periods = await apiAs(page, "/api/payroll/periods");
    expect(periods.status).toBe(200);
    expect(periods.json.length).toBeGreaterThan(0);

    for (const p of periods.json) {
      expect(p.teamTotals, "admin should still get the team net/gross").toBeTruthy();
      expect(
        p.teamTotals,
        `admin received teamTotals.employerCost for ${p.payDay} — this is a leak`,
      ).not.toHaveProperty("employerCost");
    }
  });

  test("an admin payload carries exactly hours / gross / net / check", async ({ page }) => {
    await gotoAdminPayroll(page);
    const periods = await apiAs(page, "/api/payroll/periods");
    const scratch = periods.json.find((p: any) => p.payDay === SCRATCH_PAY_DAY);
    const detail = await apiAs(page, `/api/payroll/periods/${scratch.id}/entries`);

    expect(Object.keys(detail.json.entries[0].values).sort()).toEqual(
      ["checkAmount", "grossEarnings", "netPay", "regularHours"].sort(),
    );
  });

  test("an admin does not receive unmatched rows", async ({ page }) => {
    // A row with no confirmed owner is an unattributed number; showing it
    // in a per-worker admin view would imply an attribution that isn't there.
    await gotoAdminPayroll(page);
    const periods = await apiAs(page, "/api/payroll/periods");
    const scratch = periods.json.find((p: any) => p.payDay === SCRATCH_PAY_DAY);
    const detail = await apiAs(page, `/api/payroll/periods/${scratch.id}/entries`);

    const names = detail.json.entries.map((e: any) => e.rawFirstName);
    expect(names).not.toContain("Nobody");
    for (const e of detail.json.entries) expect(e.userId).not.toBeNull();
  });

  test("no tax figure reaches the rendered page either", async ({ page }) => {
    await gotoAdminPayroll(page);
    await page.getByText(/Paid 7\/17\/2026/).first().click();
    await page.waitForTimeout(2000);

    const body = (await page.locator("body").textContent()) ?? "";
    // Values seeded into every tax column by createScratchPayrollPeriod.
    for (const seeded of ["11.11", "22.22", "33.33", "44.44", "111.10"]) {
      expect(body, `tax figure ${seeded} rendered on an admin screen`).not.toContain(seeded);
    }
    // But the permitted figures ARE shown.
    expect(body).toContain("1234.56");
  });

  test("an admin cannot mutate payroll", async ({ page }) => {
    // Import, identity matching and archive are Super-only: each rewrites
    // what workers see about their own pay.
    await gotoAdminPayroll(page);

    const res = await page.evaluate(async () => {
      const token = await (window as any).Clerk?.session?.getToken?.();
      const r = await fetch("/api/payroll/import", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ csvText: "irrelevant", filename: "x.csv" }),
      });
      return r.status;
    });

    expect(res, "an ADMIN was allowed to import payroll").toBe(403);
  });
});
