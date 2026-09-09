import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS } from "../helpers/db";
import { gotoWorkerHome } from "../helpers/nav";

/**
 * Home → MY VEHICLES.
 *
 * A per-driver section: one row per vehicle assigned to the scoped worker,
 * summarising THAT worker's driving over the section's own timeframe. The
 * dev fixture shares "Mike's Ram 2500" between two drivers with different
 * mileage, which is what makes the scoping testable — a fleet-scoped
 * implementation would show both drivers the same number.
 *
 * The section must disappear entirely for a worker with no assigned
 * vehicle. Not an empty frame — nothing, the same rule the MileageStrip
 * follows.
 */

let prisma: PrismaClient;

test.beforeAll(async () => { prisma = makePrisma(); });
test.afterAll(async () => { await prisma.$disconnect(); });

const SECTION = "My vehicles";

test.describe("MY VEHICLES — a driver with vehicles", () => {
  test.use({ storageState: "./playwright/.auth/employee.json" });

  test("shows the section, its vehicle, and a working timeframe", async ({ page }) => {
    const assigned = await prisma.vehicleAssignment.findFirst({
      where: { userId: USERS.employee },
      include: { vehicle: true },
    });
    expect(assigned, "the employee fixture must have an assigned vehicle").not.toBeNull();

    await gotoWorkerHome(page);

    const header = page.getByText(SECTION, { exact: true });
    await expect(header).toBeVisible({ timeout: 25_000 });

    // The section opens EXPANDED, like the other Home sections, so the
    // detail is what a reader sees first. Targeted by testid: the title
    // lives in the Dashboard HEADER, above this subtree, so a
    // "div containing the title" selector lands on the header instead.
    const section = page.getByTestId("my-vehicles");
    await expect(section).toBeVisible({ timeout: 20_000 });

    // The vehicle itself, by name, scoped INSIDE the section — the
    // MileageStrip keeps a hidden copy of the same name mounted in a
    // display:none box on the collapsed workday row, so a page-wide
    // lookup resolves to that one and reports "hidden".
    await expect(
      section.getByText(assigned!.vehicle.displayName, { exact: false }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // The roll-up tiles above the per-vehicle rows.
    for (const label of ["Miles", "Trips", "Vehicles"]) {
      await expect(section.getByText(label, { exact: true }).first()).toBeVisible();
    }

    // Collapsing swaps the detail for a one-line summary, and that summary
    // LEADS with the timeframe — a mileage figure with no window attached
    // is unreadable. This is also the only assertion that proves the
    // timeframe is wired at all.
    await header.click();
    await expect(
      page.getByText(/last month · .*\d+ mi · \d+ trip/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("MY VEHICLES — a worker with no vehicles", () => {
  test.use({ storageState: "./playwright/.auth/contractor.json" });

  test("renders nothing at all", async ({ page }) => {
    const count = await prisma.vehicleAssignment.count({ where: { userId: USERS.contractor } });
    expect(count, "the contractor fixture is expected to have no vehicles").toBe(0);

    await gotoWorkerHome(page);
    // Wait for the page to actually settle before asserting an absence —
    // an assertion that passes because nothing has rendered yet is not an
    // assertion.
    await expect(page.getByTestId("workday-banner").first()).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(SECTION, { exact: true })).toHaveCount(0);
  });
});
