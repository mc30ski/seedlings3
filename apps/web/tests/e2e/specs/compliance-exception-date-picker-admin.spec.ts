import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  createScratchPolicy,
  cleanupScratchPolicies,
  USERS,
} from "../helpers/db";

/**
 * Regression: the Grant Exception dialog's `<input type="date">` sends
 * a bare "YYYY-MM-DD" string. Before the fix, the API did
 * `new Date("2026-08-15")` which is UTC midnight — 8pm ET the previous
 * day during EDT. The sign matrix then formatted the stored expiresAt
 * via `fmtDate` in ET, displaying "until 8/14" for a picker value of
 * "8/15" — a full day off. The fix routes the picker string through
 * `etEndOfDay` so the ET calendar date the operator picked matches
 * what displays AND when the exception actually expires.
 *
 * This spec does the full UI grant flow and asserts the resulting
 * database row's expiresAt is end-of-day-ET on the picked date.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await cleanupScratchPolicies(prisma);
  await prisma.$disconnect();
});

test.describe("Compliance exception date picker", () => {
  // The picked date must be in the FUTURE and within 90 days —
  // grantException rejects anything else with INVALID_EXPIRY, so a
  // hardcoded literal silently rots into a 400 and the DB row never
  // appears. (It did: the original "2026-08-15" went stale and this
  // spec failed on `expect(exc).not.toBeNull()` with no hint why.)
  // Derive it from today in ET instead, anchored at UTC noon so the
  // +30d hop can't be flipped by a DST boundary.
  const etTodayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    // date-handling-allow: e2e-seed, must not import app helpers
  }).format(new Date());
  const [etY, etM, etD] = etTodayKey.split("-").map(Number);
  // date-handling-allow: e2e-seed
  const targetUtcNoon = new Date(Date.UTC(etY, etM - 1, etD + 30, 12, 0, 0));
  const pickDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    // date-handling-allow: e2e-seed
  }).format(targetUtcNoon); // YYYY-MM-DD
  const [pickY, pickM, pickD] = pickDate.split("-");
  const expectedEtDay = `${pickM}/${pickD}/${pickY}`; // MM/DD/YYYY

  test(`Picking ${pickDate} stores expiresAt at end-of-day ET (not midnight UTC the day before)`, async ({ page }) => {
    // Seed a scratch BLOCK policy so the Grant Exception drawer has
    // somewhere to attach — must target Employee since USERS.employee
    // is the target we pick in the dialog.
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_EXC_DATE",
      title: "E2E Exception Date Picker Policy",
      targetWorkerTypes: ["EMPLOYEE"],
      enforcement: "BLOCK",
      workerAction: "SIGN",
      createdByUserId: USERS.super,
    });

    try {
      // Navigate to Super → Directory → Compliance.
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
        localStorage.setItem("seedlings_superTab", JSON.stringify("compliance"));
        localStorage.setItem("seedlings_superCategory", JSON.stringify("Directory"));
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Open the scratch policy's detail drawer.
      await page.getByText("E2E Exception Date Picker Policy").first().click();

      // Click Grant exception.
      await page.getByRole("button", { name: /Grant exception/i }).click();

      // Select the employee target. Seed employee's displayName is
      // "Employee Worker" (from db.helpers USERS.employee).
      await page.getByText(/Employee Worker/i).first().click();

      // Set the date input to the derived future date.
      const dateInput = page.locator("input[type='date']").first();
      await dateInput.fill(pickDate);

      // Reason. Only one textarea in the Grant Exception dialog — the
      // Textarea has no placeholder or label so target by role.
      await page.locator("textarea").first().fill(
        "E2E regression: picker date matches ET display",
      );

      // Submit. Button label is "Grant" (or "Grant (N)" when multi-selected).
      await page.getByRole("button", { name: /^Grant(\s+\(\d+\))?$/i }).click();

      // Wait a moment for the POST to complete + DB write.
      await expect(async () => {
        const exc = await prisma.policyException.findFirst({
          where: {
            userId: USERS.employee,
            policyDocumentId: scratch.policyId,
            revokedAt: null,
          },
          orderBy: { grantedAt: "desc" },
        });
        expect(exc).not.toBeNull();
      }).toPass({ timeout: 10_000 });

      const exc = await prisma.policyException.findFirst({
        where: {
          userId: USERS.employee,
          policyDocumentId: scratch.policyId,
          revokedAt: null,
        },
        orderBy: { grantedAt: "desc" },
      });
      expect(exc).not.toBeNull();

      // The ET calendar day of expiresAt must be the picked day — not
      // the day before (which is what UTC-midnight parsing produced).
      const dayInET = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(exc!.expiresAt);
      expect(dayInET).toBe(expectedEtDay);

      // The ET wall-clock time must be 23:59 — end-of-day, not midnight.
      // A common wrong-fix is `etMidnight` which would show "8/15" but
      // silently expire the exception at the START of 8/15.
      const timeInET = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(exc!.expiresAt);
      expect(timeInET).toBe("23:59");

      // Explicit cleanup of the exception the test wrote.
      await prisma.policyException.delete({ where: { id: exc!.id } });
    } finally {
      // cleanupScratchPolicies in afterAll handles the policy fixture.
    }
  });
});
