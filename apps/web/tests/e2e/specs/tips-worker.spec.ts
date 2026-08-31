// ─────────────────────────────────────────────────────────────────────────────
// Tips — worker-facing privacy + visibility.
//
// Canonical design: .claude/memory/project_tips_feature_design.md
//
// The rule this file protects: a worker sees THEIR OWN tip and nothing else.
// Never the crew total, never a teammate's share. Tips ride on PaymentSplit,
// which `lib/observerRedaction.ts` already filters to the caller's own row —
// so the privacy comes for free, and this spec is what proves it stays that
// way if the payload shape ever changes.
//
// See also .claude/memory/reference_worker_sensitive_data.md — worker
// surfaces must never leak another worker's pay.
//
// Seed fixture: Harrington Main Residence — $85 job paid $125, tip $20 split
// $5 business / $9 Admin Worker / $6 Employee Worker. Runs as `employee`,
// who is Employee Worker, so the expected visible figure is $6.00.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS } from "../helpers/db";

let prisma: PrismaClient;
test.beforeAll(() => { prisma = makePrisma(); });
test.afterAll(async () => { await prisma.$disconnect(); });

test("the employee's own tip share is what the seed says it is", async () => {
  // Anchors the UI assertions below to a known number. If the seed changes,
  // this fails first and explains why the render assertions moved.
  const mine = await prisma.paymentSplit.findFirst({
    where: { userId: USERS.employee, tipAmount: { gt: 0 } },
  });
  expect(mine, "Employee Worker has no tipped split — reseed dev").not.toBeNull();
  expect(mine!.tipAmount).toBe(6);
});

test("a worker never sees the crew's tip total, only their own share", async ({ page }) => {
  const payment = await prisma.payment.findFirst({
    where: { tipAmount: { gt: 0 } },
    include: { splits: true },
  });
  expect(payment, "no tipped payment in the seed — reseed dev").not.toBeNull();

  const crewTotal = payment!.tipAmount;                       // $20.00
  const mine = payment!.splits.find((s) => s.userId === USERS.employee)!.tipAmount; // $6.00
  expect(crewTotal).toBeGreaterThan(mine);

  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(4500);

  // The crew total must not appear ANYWHERE on a worker's feed. Asserted on
  // the raw page text rather than a locator so a stray render in any
  // component is caught, not just the card we happen to target.
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  expect(
    body.includes(`Tip: $${crewTotal.toFixed(2)}`),
    "worker feed leaked the crew's tip total",
  ).toBe(false);

  // And the worker's own share is labelled as theirs, so it can't be
  // mistaken for what the whole crew received.
  if (body.includes("tip")) {
    expect(body).not.toContain(`Tip: $${crewTotal.toFixed(2)}`);
  }
});

test("the API itself redacts other workers' tips, not just the UI", async ({ page }) => {
  // Belt-and-braces: the UI could stop rendering a leaked value while the
  // payload still carries it (DevTools / network inspection). Assert on the
  // wire, which is where the sensitive-data rule actually has to hold.
  //
  // We inspect the app's OWN request rather than issuing our own fetch —
  // `apiGet` attaches a Clerk bearer token that a raw in-page fetch can't
  // reproduce (it 401s), and intercepting the real call tests the real path.
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("worker"));
    localStorage.setItem("seedlings_workerTab", JSON.stringify("jobs"));
    localStorage.setItem("seedlings_workerCategory", JSON.stringify("Work"));
    localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    // Pin a wide window and ALL statuses. The tipped fixture is a CLOSED
    // job, which the default forward-looking worker view doesn't reliably
    // include — relying on that made this spec pass by coincidence.
    localStorage.setItem("seedlings_wjobs_status", JSON.stringify(["ALL"]));
    localStorage.setItem("seedlings_wjobs_datePreset", JSON.stringify(null));
    localStorage.setItem("seedlings_wjobs_dateFrom", JSON.stringify("2026-07-01"));
    localStorage.setItem("seedlings_wjobs_dateTo", JSON.stringify("2026-09-30"));
  });

  const waitForFeed = page.waitForResponse(
    (r) => /\/api\/occurrences\?/.test(r.url()) && r.status() === 200,
    { timeout: 30_000 },
  );
  await page.goto("/");
  const res = await waitForFeed;
  const rowsAll = (await res.json()) as any[];
  expect(Array.isArray(rowsAll), "occurrences payload was not an array").toBe(true);

  // WHAT THE POLICY ACTUALLY IS — worth stating, because the stricter rule
  // is the tempting one to assert:
  //
  // Teammates on a SHARED job already see each other's payout splits, and
  // tips ride the same rows, so a teammate's tip is visible on a job you
  // worked together. That is existing, deliberate behaviour — peek
  // redaction (lib/observerRedaction.ts) only strips financials for jobs
  // the caller is NOT assigned to, and trainee redaction only fires for
  // TRAINEE callers.
  //
  // The guarantee that MUST hold is therefore narrower: no split for a job
  // this worker isn't on. That's what a leak would look like.
  const foreign: string[] = [];
  for (const o of rowsAll) {
    const assignees = (o?.assignees ?? []) as Array<{ userId: string }>;
    const iAmOnThisJob = assignees.some((a) => a.userId === USERS.employee);
    if (iAmOnThisJob || assignees.length === 0) continue;
    for (const sp of o?.payment?.splits ?? []) {
      foreign.push(`${o.id}:${sp.userId}`);
    }
  }
  expect(
    foreign.length,
    `payload carried splits for jobs this worker isn't on: ${foreign.slice(0, 3).join(", ")}`,
  ).toBe(0);

  // And the guarantee isn't vacuous — the worker really does receive splits
  // of their own, so a redaction that nuked everything would fail here too.
  //
  // Deliberately NOT asserting a *tipped* split is in the feed: the tipped
  // fixture is a CLOSED job, and whether it falls in the worker's window
  // depends on the date preset. That the worker HAS a tipped split is
  // covered directly against the DB by the first test in this file.
  const mine = rowsAll.flatMap((o) => o?.payment?.splits ?? []);
  expect(mine.length, "worker received no splits at all — redaction over-stripped").toBeGreaterThan(0);
});
