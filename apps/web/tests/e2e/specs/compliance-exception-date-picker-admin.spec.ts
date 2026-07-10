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
  test("Picking 2026-08-15 stores expiresAt at end-of-day ET on 8/15 (not 8/14 midnight UTC)", async ({ page }) => {
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

      // Set the date input to 2026-08-15.
      const dateInput = page.locator("input[type='date']").first();
      await dateInput.fill("2026-08-15");

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

      // The ET calendar day of expiresAt must be 8/15 — not 8/14.
      const dayInET = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(exc!.expiresAt);
      expect(dayInET).toBe("08/15/2026");

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
