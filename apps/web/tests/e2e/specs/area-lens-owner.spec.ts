/**
 * THE AREA LENS — "show me only Durham", for somebody entitled to see more.
 *
 * Two properties are worth a browser to prove, because neither is visible
 * in a unit test and both fail silently:
 *
 *   1. ONE CONTROL NARROWS EVERY VIEW. The lens rides on the principal, so
 *      the ~100 query sites already calling areaWhere() honour it without
 *      an edit. If that threading breaks, a panel keeps showing company
 *      numbers under a header that says Durham — and nothing errors.
 *
 *   2. IT CANNOT WIDEN. The chosen area is intersected with the areas the
 *      caller is GRANTED, so a lens pointing somewhere they hold nothing
 *      resolves to empty — 200 with no rows, never a 403 and never that
 *      territory's data. A lens may hide a row; it may not refuse an action.
 */
import { test, expect } from "@playwright/test";
import { waitForSplashGone } from "../helpers/nav";

/** Dev-seed areas. The tree is All areas → Durham, Chapel Hill. */
const DURHAM = "cmv5of1vy0006gndrqohl0nvj";
const CHAPEL_HILL = "cmv5oqzj801lcgnw72h6yxnt6";

async function land(page: any, tab: string, category: string, lens: string | null) {
  await page.goto("/");
  await page.evaluate(
    ({ tab, category, lens }: { tab: string; category: string; lens: string | null }) => {
      localStorage.setItem("seedlings_topTab", JSON.stringify("staff"));
      // Stamp the open time too, or the first-open-of-the-day takeover drags
      // the run to Work → Home and the assertions measure the wrong tab.
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
      localStorage.setItem("seedlings_staffTab", JSON.stringify(tab));
      localStorage.setItem("seedlings_staffCategory", JSON.stringify(category));
      localStorage.setItem("seedlings:jobs:insightsOpen", JSON.stringify(true));
      // The weather strip is what calls /api/weather/location; hidden, the
      // forecast assertions below would measure nothing and pass empty.
      localStorage.setItem("titleWeatherMode", JSON.stringify("compact"));
      if (lens) localStorage.setItem("seedlings_areaLensId", lens);
      else localStorage.removeItem("seedlings_areaLensId");
    },
    { tab, category, lens },
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await waitForSplashGone(page);
  await page.waitForTimeout(4500);
}

/** Row counts from the app's OWN requests — a hand-rolled page fetch has no
 *  Clerk bearer token, and its 401 reads exactly like a permissions result. */
function watchClients(page: any, sink: Array<{ status: number; lens: string; rows: number }>) {
  page.on("response", async (r: any) => {
    if (!/\/api\/clients$/.test(new URL(r.url()).pathname)) return;
    const lens = r.request().headers()["x-area-lens"] ?? "none";
    try {
      const j = await r.json();
      const rows = Array.isArray(j) ? j : (j?.clients ?? j?.items ?? []);
      sink.push({ status: r.status(), lens, rows: Array.isArray(rows) ? rows.length : -1 });
    } catch {
      sink.push({ status: r.status(), lens, rows: -1 });
    }
  });
}

test.describe("a reader who can see everything", () => {
  test.use({ storageState: "./playwright/.auth/owner.json" });

  test("one header control narrows the whole app", async ({ page }) => {
    const clients: Array<{ status: number; lens: string; rows: number }> = [];
    watchClients(page, clients);

    await land(page, "clients", "Records", null);
    const unlensed = clients.at(-1);
    expect(unlensed?.rows, "the owner should see every client unlensed").toBeGreaterThan(0);

    await land(page, "clients", "Records", DURHAM);
    const lensed = clients.at(-1);
    expect(lensed?.lens, "the lens must reach the server as a header").toBe(DURHAM);
    expect(lensed?.status).toBe(200);
    // THE LIST, not just the INSIGHTS card — this is the half that proves
    // the lens is threaded rather than wired into one panel.
    expect(
      lensed!.rows,
      "a district lens must return fewer clients than no lens at all",
    ).toBeLessThan(unlensed!.rows);
  });

  test("the chip names the area, and the INSIGHTS note stops saying 'the whole company'", async ({ page }) => {
    await land(page, "jobs", "Work", null);
    const chip = page.getByTestId("area-lens-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("title", "Viewing all areas");

    await chip.click();
    await page.getByTestId(`area-lens-option-${DURHAM}`).click();
    await page.waitForTimeout(4500);

    // LOUD WHEN SET is the whole mitigation for persisting the choice:
    // "Chapel Hill earned nothing" and "you have been looking at Durham
    // since Tuesday" are the same empty screen without it.
    await expect(chip).toHaveAttribute("title", "Viewing Durham only");
    await expect(page.getByText("Durham only — over the selected period.")).toBeVisible();

    // And it survives a reload, which is the point of persisting it.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await waitForSplashGone(page);
    await expect(page.getByTestId("area-lens-chip")).toHaveAttribute("title", "Viewing Durham only");
  });
});

test.describe("the forecast follows the lens", () => {
  test.use({ storageState: "./playwright/.auth/owner.json" });

  test("an area with coordinates outranks the business address", async ({ page }) => {
    // Every other number on a lensed screen is that district's. A forecast
    // for head office would be the one panel still answering about
    // somewhere else — which is the same silent-wrong-answer shape the
    // whole area feature exists to avoid, just wearing a weather icon.
    const locs: string[] = [];
    page.on("response", async (r) => {
      if (!new URL(r.url()).pathname.endsWith("/api/weather/location") || r.status() !== 200) return;
      try {
        const j = await r.json();
        locs.push(`${j.source}:${j.lat?.toFixed(2)},${j.lng?.toFixed(2)}`);
      } catch {}
    });

    const seen: Record<string, string | undefined> = {};
    for (const [label, id] of [["none", null], ["durham", DURHAM], ["chapelHill", CHAPEL_HILL]] as const) {
      locs.length = 0;
      await land(page, "jobs", "Work", id);
      seen[label] = locs.at(-1);
    }
    console.log(`forecast anchors: ${JSON.stringify(seen)}`);

    // Unlensed falls back to BUSINESS_ADDRESS, exactly as before areas.
    expect(seen.none, "no lens must still use the business address").toMatch(/^business:/);
    // Lensed uses the area's own point — and the two districts differ, so
    // this cannot pass by accidentally returning the same coordinates.
    expect(seen.durham, "a lensed area must anchor the forecast").toMatch(/^area:/);
    expect(seen.chapelHill).toMatch(/^area:/);
    expect(seen.durham).not.toBe(seen.chapelHill);
  });
});

test.describe("a reader already limited to one district", () => {
  test.use({ storageState: "./playwright/.auth/districtLead.json" });

  test("is offered no lens, and a forged one shows nothing rather than more", async ({ page }) => {
    const clients: Array<{ status: number; lens: string; rows: number }> = [];
    watchClients(page, clients);

    await land(page, "clients", "Records", null);
    // No choice to make: they already see Durham and nothing else, so a
    // control that cannot change anything would only teach distrust of the
    // ones that can.
    await expect(page.getByTestId("area-lens-chip")).toHaveCount(0);
    expect(clients.at(-1)?.rows, "they should see their own district").toBeGreaterThan(0);

    // THE SECURITY PROPERTY. Chapel Hill is a district they hold nothing in.
    clients.length = 0;
    await land(page, "clients", "Records", CHAPEL_HILL);
    const forged = clients.filter((c) => c.lens === CHAPEL_HILL);
    expect(forged.length, "the app must actually have sent the forged lens").toBeGreaterThan(0);
    for (const c of forged) {
      expect(c.status, "a lens must never produce a refusal").toBe(200);
      expect(c.rows, "a lens outside your grants must resolve to nothing").toBe(0);
    }
  });
});
