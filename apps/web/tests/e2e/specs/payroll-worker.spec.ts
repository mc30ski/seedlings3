// ─────────────────────────────────────────────────────────────────────────────
// Payroll — worker isolation, in a real browser.
//
// Canonical spec: docs/features/payroll.md.
//
// THIS IS THE TEST THAT MATTERS. `payroll-build-gate.test.ts` asserts the
// worker-scoping `where` clause exists in the source; it cannot prove the
// query actually isolates, because that needs a database and a signed-in
// session. This does.
//
// A period is seeded with THREE rows — the signed-in employee, another
// worker, and an unmatched name — with deliberately different figures. If
// scoping ever regresses, the other worker's numbers show up here.
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

// Figures chosen so no two are equal and none is a substring of another —
// a leak can't hide behind a coincidental match.
const SCRATCH_PAY_DAY = "2026-07-17";
const ME = { netPay: 1234.56, grossEarnings: 1500.01 };
const OTHER = { netPay: 4321.99, grossEarnings: 5000.02 };

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
      { userId: USERS.employee, firstName: "Mine", ...ME },
      { userId: USERS.contractor, firstName: "Theirs", ...OTHER },
    ],
  });
});

test.afterAll(async () => {
  await cleanupScratchPayroll(prisma);
  await prisma.$disconnect();
});

/**
 * Call the API from inside the page with the SAME auth the app uses.
 *
 * A bare fetch() gets 401: apps/web/src/lib/api.ts attaches a Clerk bearer
 * token, it does not rely on cookies. Pulling the token off `window.Clerk`
 * is how we assert on the ACTUAL response payload — which matters here,
 * because a DOM-only assertion would still pass if the server sent a fuller
 * payload and the client filtered it. The access control has to be in the
 * response, so the response is what we read.
 */
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
      /* non-JSON error body */
    }
    return { status: r.status, json };
  }, path);
}

async function gotoWorkerPayroll(page: any) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("payroll"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Money"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2500);
}

test.describe("Payroll — worker view", () => {
  test("a worker sees ONLY their own row, never a colleague's", async ({ page }) => {
    await gotoWorkerPayroll(page);

    // Open OUR scratch period (seed.ts creates other, real periods for this
    // same worker — those are legitimately visible and are not what this
    // test is about).
    await page.getByText(/Paid 7\/17\/2026/).first().click();
    await page.waitForTimeout(2000);

    const body = (await page.locator("body").textContent()) ?? "";

    // Own figures present.
    expect(body).toContain("1234.56");
    expect(body).toContain("1500.01");

    // The other worker's figures must NOT appear anywhere on the page.
    expect(body, "another worker's net pay leaked into the worker view").not.toContain("4321.99");
    expect(body, "another worker's gross leaked into the worker view").not.toContain("5000.02");

    // Nor the unmatched row, which belongs to nobody.
    expect(body, "an unmatched row leaked into the worker view").not.toContain("888.88");
    expect(body).not.toContain("Nobody");
  });

  test("the API response itself contains only the worker's row", async ({ page }) => {
    // Asserting on the DOM alone would pass if the client filtered a
    // fuller payload. The access control has to be in the RESPONSE.
    await gotoWorkerPayroll(page);

    const list = await apiAs(page, "/api/me/payroll");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json)).toBe(true);

    // Find OUR scratch period by its pay day. seed.ts now creates real
    // payroll history for this worker, so list[0] is the seed's newest
    // period, not the one this spec created.
    const mine = list.json.find((p: any) => p.payDay === SCRATCH_PAY_DAY);
    expect(mine, "scratch period not found in the worker's list").toBeTruthy();

    const detail = await apiAs(page, `/api/me/payroll/${mine.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.entries).toHaveLength(1);
    expect(detail.json.entries[0].values.netPay).toBe(ME.netPay);
  });

  test("a worker sees their OWN full tax breakdown", async ({ page }) => {
    // Their own pay-stub data. The hours/gross/net restriction applies to
    // an ADMIN looking at someone else, not to a worker's own row.
    await gotoWorkerPayroll(page);

    const list = await apiAs(page, "/api/me/payroll");
    const mine = list.json.find((p: any) => p.payDay === SCRATCH_PAY_DAY);
    const detail = await apiAs(page, `/api/me/payroll/${mine.id}`);
    const values = detail.json.entries[0].values;

    for (const f of [
      "federalIncomeTax",
      "stateTaxEmployee",
      "socialSecurityEmployee",
      "medicareEmployee",
      "employeeTaxes",
    ]) {
      expect(values, `worker must receive their own ${f}`).toHaveProperty(f);
    }
  });

  test("a worker cannot read another worker's payroll via viewAsUserId", async ({ page }) => {
    // The parameter exists for ADMIN/SUPER. A plain worker passing it must
    // be refused, not quietly served.
    await gotoWorkerPayroll(page);

    const res = await apiAs(page, `/api/me/payroll?viewAsUserId=${USERS.contractor}`);
    expect(res.status, "worker escalated to another worker's payroll").toBe(403);
  });

  test("a silent gap surfaces as a pending-match notice", async ({ page }) => {
    // The case option A cannot reach: the worker HAS history, so the empty
    // state never shows — the newest period just isn't there. Payroll
    // attaches by NAME, so a name change leaves the row unattributed and
    // the worker sees nothing at all. This is their only signal.
    const latest = await prisma.payrollPeriod.findFirst({
      where: { archivedAt: null },
      orderBy: { payDay: "desc" },
      include: { entries: true },
    });
    expect(latest, "seed should provide payroll history").toBeTruthy();
    const mine = latest!.entries.find((e) => e.userId === USERS.employee);
    expect(mine, "seed should give this worker a row in the newest period").toBeTruthy();

    // Detach ONLY the newest period — older history stays, which is what
    // makes the gap silent rather than an empty state.
    await prisma.payrollEntry.update({ where: { id: mine!.id }, data: { userId: null } });
    try {
      await gotoWorkerPayroll(page);
      await expect(page.getByText(/hasn't been matched to an account yet/i)).toBeVisible({
        timeout: 10_000,
      });
      // Tells them WHICH period, so they can name it to their admin.
      await expect(page.getByText(/8\/22\/2026/)).toBeVisible();
    } finally {
      await prisma.payrollEntry.update({
        where: { id: mine!.id },
        data: { userId: USERS.employee },
      });
    }
  });

  test("a fully-matched worker sees NO pending-match notice", async ({ page }) => {
    // The notice is targeted, not a broadcast. seed.ts leaves one row
    // deliberately unmatched, and a worker who is present in the newest
    // period must not be told about it — it isn't theirs and can't be.
    await gotoWorkerPayroll(page);
    await expect(page.getByText(/hasn't been matched to an account yet/i)).toHaveCount(0);
  });

  test("a worker with no payroll gets an empty state, not an error", async ({ page }) => {
    // Every contractor is in this position today — the Gusto payroll
    // journal doesn't include them.
    // seed.ts gives this worker real payroll history, so reaching the
    // "never been paid" state means temporarily detaching them from it.
    // Capture the exact ids and put them back in a finally — a broad
    // "reattach every null-user row" restore would also re-link the
    // deliberately-unmatched seed row and destroy the review fixture.
    await cleanupScratchPayroll(prisma);
    const detached = await prisma.payrollEntry.findMany({
      where: { userId: USERS.employee },
      select: { id: true },
    });
    await prisma.payrollEntry.updateMany({
      where: { id: { in: detached.map((d) => d.id) } },
      data: { userId: null },
    });

    try {
      await gotoWorkerPayroll(page);
      await expect(page.getByText(/No payroll records for you yet/i)).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      for (const d of detached) {
        await prisma.payrollEntry.update({
          where: { id: d.id },
          data: { userId: USERS.employee },
        });
      }
    }
  });
});
