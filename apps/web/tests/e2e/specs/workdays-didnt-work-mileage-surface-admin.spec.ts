import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS } from "../helpers/db";

/**
 * Regression: on Super → Records → Workdays, a driver who has pending
 * mileage BUT no `WorkerWorkday` on the same date must have their
 * mileage chip + Review button surfaced under the "Didn't work"
 * section. Otherwise the "Workdays / mileage to review" alert count
 * has no visible target and reads like a ghost.
 *
 * Scenario (real prod incident, 2026-07-14): Michael acted as an
 * Observer on a job — didn't clock in himself but drove the truck, so
 * his MileageEntry is pending approval while his workday row doesn't
 * exist for that date. Before the fix, that entry was invisible on
 * the Workdays tab.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test.describe("Workdays — 'Didn't work' surfaces pending mileage", () => {
  test("A pending mileage entry for a driver with no workday shows a Review button under Didn't work", async ({ page }) => {
    const uniqueTag = `E2E_MILEAGE_${Date.now()}`;
    // Use YESTERDAY — WorkdaysTab defaults its selectedDate to
    // `bizAddDays(bizToday(), -1)` when no initialDate is passed, so
    // yesterday lets us land on the right date without extra
    // navigation. Also matches the real prod incident (pending mileage
    // for a past day the operator hadn't visited yet).
    // date-handling-allow: e2e-seed
    const now = new Date();
    // date-handling-allow: e2e-seed
    const rowDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const entryDate = rowDate.toISOString().slice(0, 10);

    // Reuse the seed's truck (created in seed.ts). If it's missing
    // (fresh reseed race?), create one on the fly so the test is
    // self-contained.
    let vehicle = await prisma.vehicle.findFirst({
      where: { plate: "NC-LWN-42" },
    });
    if (!vehicle) {
      vehicle = await prisma.vehicle.create({
        data: {
          displayName: `${uniqueTag} Truck`,
          make: "Ford",
          vehicleModel: "F-150",
          year: 2024,
          plate: uniqueTag.slice(0, 8),
          inServiceDate: "2024-01-01",
          currentOdometer: 10000,
        },
      });
    }

    // Ensure Employee has a vehicle assignment so the mileage
    // startEntry gate would pass in production. Assignment presence
    // isn't checked by the pending-summary endpoint but is required
    // for driving in the real app.
    await prisma.vehicleAssignment.upsert({
      where: {
        vehicleId_userId: { vehicleId: vehicle.id, userId: USERS.employee },
      },
      create: { vehicleId: vehicle.id, userId: USERS.employee },
      update: {},
    });

    // Delete any existing workday for Employee on this date so
    // Employee lands in the "Didn't work" section — the whole point.
    await prisma.workerWorkday.deleteMany({
      where: { userId: USERS.employee, workdayDate: entryDate },
    });

    // The pending mileage row itself: closed, un-approved, before today.
    // date-handling-allow: e2e-seed
    const startedAt = new Date(rowDate.getTime() + 8 * 60 * 60 * 1000); // 8am
    // date-handling-allow: e2e-seed
    const endedAt = new Date(rowDate.getTime() + 10 * 60 * 60 * 1000); // 10am
    const entry = await prisma.mileageEntry.create({
      data: {
        vehicleId: vehicle.id,
        driverUserId: USERS.employee,
        entryDate,
        startedAt,
        endedAt,
        startOdometer: 20000,
        endOdometer: 20025,
        miles: 25,
      },
    });

    try {
      // Load Super → Records → Workdays. WorkdaysTab defaults to
      // yesterday which matches our seeded entryDate — no date jump
      // needed.
      await page.goto("/");
      await page.evaluate(() => {
        localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
        localStorage.setItem("seedlings_superTab", JSON.stringify("workdays"));
        localStorage.setItem("seedlings_superCategory", JSON.stringify("Records"));
      });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Locate the "Didn't work" section and verify it contains a row
      // for Employee with the mileage chip.
      const didntWorkHeader = page.getByText(/Didn['’]t work/i).first();
      await expect(didntWorkHeader).toBeVisible({ timeout: 15_000 });

      // "1 pending" appears when the mileage chip renders with a
      // pending count — the whole regression signal.
      await expect(page.getByText(/1 pending/i).first()).toBeVisible({
        timeout: 15_000,
      });

      // The Review button must be present so the operator can
      // actually approve/reject the ghost mileage.
      await expect(
        page.getByRole("button", { name: /^Review$/ }).first(),
      ).toBeVisible();
    } finally {
      await prisma.mileageEntry.deleteMany({ where: { id: entry.id } });
    }
  });
});
