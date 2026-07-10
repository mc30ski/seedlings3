import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { makePrisma, USERS } from "../helpers/db";

/**
 * Regression: the recurrenceSeriesId model must actually collapse
 * rows with the same series id in the "Due to record" panel EVEN IF
 * the label text differs. That's the whole point — the model exists
 * to survive typos, autocorrect, and hidden characters that used to
 * fork implicit-key streams (see Vercel 2026-07-13 incident).
 *
 * This spec seeds two BusinessExpense rows that share a
 * `recurrenceSeriesId` but differ in description by one character.
 * Under the legacy (type, description, vendor) key they'd fork; under
 * the new key they must collapse. The /due-soon response is our
 * assertion target.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Ledger — recurrenceSeriesId collapses forked descriptions", () => {
  test("two rows with the same series id but different descriptions surface as ONE due-soon entry", async ({ page }) => {
    const seriesId = randomUUID();
    const uniqueTag = `E2E_SERIES_${Date.now()}`;
    // Two rows, one visible-character apart in description. Both dated
    // in the past so their MONTHLY cadence lands their next-expected
    // date within the /due-soon lookahead window. Old row: 60 days
    // ago; newer row: 30 days ago — enough spread to prove the
    // most-recent-wins logic still applies within the collapsed set.
    // date-handling-allow: e2e-seed
    const now = new Date();
    // date-handling-allow: e2e-seed
    const older = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    // date-handling-allow: e2e-seed
    const newer = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rowA = await prisma.businessExpense.create({
      data: {
        ledgerId: `${uniqueTag}_A`,
        createdById: USERS.super,
        type: "EXPENSE",
        description: `${uniqueTag} Vercel - App hosting`,
        cost: 137.08,
        date: older,
        vendor: "Vercel",
        recurrence: "MONTHLY",
        recurrenceSeriesId: seriesId,
      },
    });
    const rowB = await prisma.businessExpense.create({
      data: {
        ledgerId: `${uniqueTag}_B`,
        createdById: USERS.super,
        type: "EXPENSE",
        // Same series, but a stray extra space — legacy key would fork.
        description: `${uniqueTag}  Vercel - App hosting`,
        cost: 184.91,
        date: newer,
        vendor: "Vercel",
        recurrence: "MONTHLY",
        recurrenceSeriesId: seriesId,
      },
    });

    try {
      // page.request inherits browser cookies after we hit an
      // authenticated URL first. Landing on / is enough to prime the
      // session so the direct API call carries auth.
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      const resp = await page.request.get(
        "/api/_proxy/admin/business-expenses/due-soon",
      );
      // If the proxy isn't configured for direct requests (as we've
      // seen before with API_BASE_URL not present in the test env),
      // hit the API directly instead.
      let suggestions: Array<{ latestId: string; prefill: { description: string } }>;
      if (resp.ok()) {
        suggestions = await resp.json();
      } else {
        const direct = await page.request.get(
          "http://localhost:8080/api/admin/business-expenses/due-soon",
          {
            headers: {
              Authorization: `Bearer ${await page.evaluate(async () => {
                const w = window as any;
                return (await w.Clerk?.session?.getToken()) ?? "";
              })}`,
            },
          },
        );
        expect(direct.ok(), await direct.text()).toBe(true);
        suggestions = await direct.json();
      }

      // Filter to just OUR seeded rows. The seed DB has other recurring
      // series (facebook ads, quickbooks, etc.) that must be excluded
      // from the assertion.
      const ours = suggestions.filter((s) =>
        s.prefill.description.includes(uniqueTag),
      );

      // The core assertion: two rows, same seriesId, DIFFERENT
      // descriptions — must collapse to exactly ONE due-soon entry.
      expect(ours).toHaveLength(1);
      // The winner is the most recent row (rowB — 30 days ago vs 60).
      expect(ours[0].latestId).toBe(rowB.id);
    } finally {
      await prisma.businessExpense.deleteMany({
        where: { id: { in: [rowA.id, rowB.id] } },
      });
    }
  });
});
