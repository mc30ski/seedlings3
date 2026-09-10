import { test, expect } from "@playwright/test";
import { makePrisma, USERS } from "../helpers/db";

/**
 * A saved forecast must bring its COST BEHAVIOUR TAGS back, not just its
 * window and sliders.
 *
 * Why this needs a browser and not just a unit test: the arithmetic side is
 * already covered (the model replays a tagged scenario correctly, and the
 * service round-trips the tags through the database). What is only testable
 * here is the RESTORE path — the tab rebuilding its state from a stored blob.
 * That exact path has already shipped a bug on this tab: the saved window
 * restored fine while the preset badge, a separate piece of state that
 * `loadScenario` never updated, kept reading whichever preset was last used.
 * A value that is stored but not restored at one of the sites that rebuild
 * state is the shape of bug this guards against.
 *
 * Seeds the scenario directly rather than driving the save flow, so the
 * assertion is about restoring and nothing else.
 */

const SCRATCH_NAME = "E2E_SCRATCH tagged forecast";
// Present in the dev ledger over this window, and the largest line — so the
// row is near the top of the Costs table rather than scrolled out of view.
const TAGGED_CATEGORY = "Supplies";

test.describe("Forecast — a saved scenario restores its cost tags", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let forecastId: string | null = null;

  test.beforeAll(async () => {
    prisma = makePrisma();
    const row = await prisma.forecast.create({
      data: {
        name: SCRATCH_NAME,
        windowFrom: "2026-03-01",
        windowTo: "2026-09-10",
        // Deliberately sparse: only the tag. Everything else has to come from
        // defaultAssumptions, which is exactly how an older saved scenario
        // looks once new levers have shipped.
        assumptions: { behaviorOverrides: { [TAGGED_CATEGORY]: "FIXED" } },
        createdById: USERS.super,
      },
      select: { id: true },
    });
    forecastId = row.id;
  });

  test.afterAll(async () => {
    if (forecastId) await prisma.forecast.delete({ where: { id: forecastId } }).catch(() => {});
    await prisma.$disconnect();
  });

  test("the tag comes back, and it reaches the arithmetic", async ({ page }) => {
    await page.goto("/");
    // Wait for React to mount before stamping: `goto` resolves on load, and
    // the tab router writes its own topTab once the app comes up, which
    // silently lands the run on the worker view.
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => {
      localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
      localStorage.setItem("seedlings_superTab", JSON.stringify("forecast"));
      localStorage.setItem("seedlings_superCategory", JSON.stringify("Money"));
      // Open the Costs section up front — that is where the pickers live.
      // SectionExpander stores an UNPREFIXED key whose value is "1"/"0", not
      // the JSON the tab-router keys use.
      localStorage.setItem("forecast_sec_costs", "1");
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /Acting as Super/ })).toBeVisible({
      timeout: 30_000,
    });

    // Open OUR scenario by name, not the first one in the list.
    const row = page
      .locator("div")
      .filter({ has: page.getByText(SCRATCH_NAME, { exact: true }) })
      .filter({ has: page.getByRole("button", { name: /^Open$/ }) })
      .last();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.getByRole("button", { name: /^Open$/ }).click();
    await page.waitForLoadState("networkidle");

    // The tagged category must render under the Fixed group with its picker
    // showing Fixed — not reset to the default.
    const costRow = page
      .locator("div")
      .filter({ has: page.getByText(TAGGED_CATEGORY, { exact: true }) })
      .filter({ has: page.locator('[data-part="value-text"]') })
      .last();
    await expect(costRow).toBeVisible({ timeout: 20_000 });
    await expect(
      costRow.locator('[data-part="value-text"]'),
      "the saved tag must survive the reopen",
    ).toHaveText("Fixed");

    // And it must have reached the model, not just the control: a FIXED row is
    // grouped under the Fixed heading, which only the behaviour can produce.
    await expect(page.getByText(/Fixed — doesn't grow when the business grows/)).toBeVisible();

    await page.screenshot({ path: "test-results/forecast-saved-tags.png", fullPage: false });
  });
});
