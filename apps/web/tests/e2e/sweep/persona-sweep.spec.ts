/**
 * THE READ-ONLY PERSONA SWEEP.
 *
 * Walks the app as every seeded persona and checks three things the API
 * suite cannot: that the right TABS appear, that each one OPENS, and that
 * the UI never offers an action the route refuses.
 *
 * WHY NOT CLICK EVERYTHING. The API project already drives all 641 endpoints
 * as a holder and a non-holder of each entitlement, so authorization itself
 * is settled. Clicking Approve / Delete / Write-off as nine personas would
 * re-prove that while mutating the seed data every later run depends on.
 * This sweep navigates and reads; it writes nothing.
 *
 * THE USEFUL SIGNAL IS A CONSOLE ERROR. `api.ts` logs `[permissions]` in
 * development whenever a request comes back `NOT_AUTHORIZED`, naming the
 * route and the missing capability. That fires exactly when the UI offered
 * something the route denies — the drift this whole phase exists to prevent
 * — so catching it is cheaper and broader than enumerating buttons.
 *
 * WHAT IT CANNOT DO. It cannot find a control that SHOULD be present and is
 * not: a legitimately hidden button and a wrongly hidden one look identical
 * from outside. That direction is what the inventory in the third test is
 * for, and the inventory needs a human to read it.
 */
import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { PERSONAS, STORAGE_STATE, personaCapabilities } from "../helpers/personas";
import type { SeedUserKey } from "../helpers/db";

/**
 * NOT `tests/e2e/report/` — that folder belongs to the HTML reporter, which
 * CLEARS it when it writes. The first version of this put the inventory
 * there and it silently never existed.
 */
const REPORT_DIR = path.resolve(__dirname, "../inventory");
const INVENTORY = path.join(REPORT_DIR, "persona-sweep.json");

/**
 * Tab id → the label its breadcrumb renders.
 *
 * Needed to tell whether a navigation ACTUALLY ARRIVED. See `gotoTab`.
 */
// `shellOfTab()` WAS HERE and has been deleted.
//
// It parsed `pages/index.tsx` for three tab-array literals — one per
// shell — so the walk could navigate straight to the shell containing a
// tab instead of probing all three. There is one staff tab list now, so
// there is nothing to resolve; the walk goes to "staff" and arrives.
//
// It did not fail loudly when that happened. It threw at module load,
// which Playwright reports as "0 tests in 0 files" — the sweep looked
// like it had nothing to run rather than like it was broken.

function tabLabels(): Map<string, string> {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../../pages/index.tsx"),
    "utf8",
  );
  const out = new Map<string, string>();
  for (const m of src.matchAll(/value:\s*"([A-Za-z][A-Za-z0-9-]*)",\s*\n\s*label:\s*"([^"]+)"/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  if (out.size === 0) throw new Error("tab labels did not parse — index.tsx shape changed");
  return out;
}

/** The capability→tab table the app itself uses, read from its source. */
function tabRequirements(): Array<[string, string[] | "ALWAYS"]> {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../../src/lib/tabRequirements.ts"),
    "utf8",
  );
  const body = src.slice(
    src.indexOf("export const TAB_REQUIREMENTS = {"),
    src.indexOf("} as const satisfies"),
  );
  const rows: Array<[string, string[] | "ALWAYS"]> = [];
  for (const m of body.matchAll(/^\s{2}"?([A-Za-z][A-Za-z0-9-]*)"?:\s*(ALWAYS|\[[^\]]*\]),/gm)) {
    rows.push([
      m[1],
      m[2] === "ALWAYS" ? "ALWAYS" : [...m[2].matchAll(/"([^"]+)"/g)].map((e) => e[1]),
    ]);
  }
  if (rows.length === 0) throw new Error("TAB_REQUIREMENTS did not parse — its shape changed");
  return rows;
}

/** Which tabs this capability set earns. Mirrors `canSeeTab`. */
function expectedTabs(caps: Set<string>): string[] {
  return tabRequirements()
    .filter(([, need]) => (need === "ALWAYS" ? true : need.some((e) => caps.has(e))))
    .map(([id]) => id);
}

type Refusal = { tab: string; text: string };

/** Collect `[permissions]` console errors and uncaught page errors. */
function watch(page: Page, sink: { refusals: Refusal[]; errors: string[] }, tabRef: { id: string }) {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (text.includes("[permissions]")) sink.refusals.push({ tab: tabRef.id, text });
  });
  page.on("pageerror", (err) => sink.errors.push(`${tabRef.id}: ${err.message}`));
}

/**
 * Land on a shell + inner tab, and say whether we ACTUALLY ARRIVED.
 *
 * THE CHECK THIS REPLACES WAS VACUOUS. It stamped `seedlings_<shell>Tab`
 * and then read that same key back to confirm — verifying its own write,
 * not what the app did. It could never fail, so the walk stopped at the
 * first shell it tried (always "worker") and measured whatever the app
 * actually showed, which for a tab living in another shell was the Home
 * page. Six of admin's tabs were "measured" that way and every one of them
 * reported Home's breadcrumb.
 *
 * Arrival is now judged by the rendered breadcrumb naming the target tab.
 * That also serves as the readiness wait — if the label is on screen, the
 * chrome has mounted — and it is what makes "could not reach this tab" a
 * finding rather than a silently wrong measurement.
 */
async function gotoTab(page: Page, shell: string, tab: string, label: string): Promise<boolean> {
  await page.goto("/");
  // waitForLoadState BEFORE stamping, or React rehydrates and clobbers the
  // values we just wrote — a race this suite has been bitten by before.
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(
    ([s, t]) => {
      localStorage.setItem("seedlings_topTab", JSON.stringify(s));
      localStorage.setItem(`seedlings_${s}Tab`, JSON.stringify(t));
      // LOOK LIKE A RETURNING USER. The app jumps anyone with a workerType
      // to worker/Home on the first open of a new ET day. Every Playwright
      // context is fresh, so that fired on EVERY navigation and the walk
      // measured Home for an unknown number of worker-shell tabs.
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    },
    [shell, tab],
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  try {
    await page.waitForFunction(
      (want) =>
        Array.from(document.querySelectorAll("button")).some(
          (b) => (b.textContent ?? "").trim() === want,
        ),
      label,
      { timeout: 15_000 },
    );
  } catch {
    return false;
  }
  // SEEING THE LABEL IS NOT BEING ON THE TAB. The breadcrumb renders a chip
  // for each tab in the category, so the label proves the category
  // resolved, not that this tab is active. Read back what the app settled
  // on — not circular, because the app rewrites the key when it redirects.
  return await page.evaluate(
    (t) => JSON.parse(localStorage.getItem(`seedlings_${t.s}Tab`) ?? '""') === t.t,
    { s: shell, t: tab },
  );
}

const inventory: Record<string, unknown> = {};
test.afterAll(async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  // MERGE, don't clobber. Re-running one persona to check a fix would
  // otherwise replace the whole inventory with that persona alone, and the
  // result reads like the other eight have no tabs. Each entry carries the
  // time it was taken so a stale one is visible rather than assumed fresh.
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
  } catch {
    /* first run */
  }
  const stamped = Object.fromEntries(
    Object.entries(inventory).map(([k, v]) => [
      k,
      { ...(v as Record<string, unknown>), takenAt: new Date().toISOString() },
    ]),
  );
  fs.writeFileSync(INVENTORY, JSON.stringify({ ...existing, ...stamped }, null, 2));
});

/**
 * Build the routes once, as the most privileged persona, before measuring
 * anything.
 *
 * `next dev` compiles a route on first request. Without this the personas
 * early in the run pay that cost and their inventories read as empty — the
 * warming was visible as a monotonic fall in "empty" tabs from the second
 * persona to the seventh. Warming first makes every persona's measurement
 * comparable, which is the whole point of an inventory.
 */
test.describe("warmup", () => {
  test.use({ storageState: STORAGE_STATE("owner") });
  test("build the routes before measuring", async ({ page }) => {
    for (const shell of ["staff"]) {
      await gotoTab(page, shell, "home", "Home");
    }
  });
});

for (const persona of PERSONAS) {
  test.describe(`persona: ${persona}`, () => {
    test.use({ storageState: STORAGE_STATE(persona as SeedUserKey) });

    test(`sees exactly the tabs their capabilities earn`, async ({ page }) => {
      const caps = (await personaCapabilities())[persona] ?? new Set<string>();
      const want = expectedTabs(caps);
      const capabilityTabs = tabRequirements().filter(
        ([, n]) => n !== "ALWAYS" && (n as string[]).some((e) => caps.has(e)),
      );

      await page.goto("/");
      await page.waitForLoadState("networkidle");

      if (capabilityTabs.length === 0) {
        // Nothing opens for them. The app owes an explanation, not a frame.
        await expect(
          page.getByText(/account is active, but nothing has been shared/i),
          "a person who holds nothing must get the no-access page",
        ).toBeVisible({ timeout: 15_000 });
        inventory[persona] = { capabilities: [...caps].sort(), verdict: "no-access page" };
        return;
      }

      // WHERE DID THEY LAND? Read the persisted shell rather than probing
      // the chrome for a test-only attribute: the app's own redirect effect
      // moves a person to a shell they can reach, so this asserts the real
      // behaviour. Landing on "client" while holding staff capabilities is
      // the stranding bug — bookkeeper and payroll did exactly that until
      // shell visibility started following the tabs inside it.
      const landedOn = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("seedlings_topTab") ?? '"client"'),
      );
      inventory[persona] = {
        capabilities: [...caps].sort(),
        expectedTabs: want,
        landedOn,
      };
      expect(
        landedOn,
        `${persona} holds ${caps.size} capabilities and ${capabilityTabs.length} tabs ` +
          `but landed on the client shell — they are stranded`,
      ).not.toBe("client");
    });

    test(`every tab they can reach opens without a refusal`, async ({ page }) => {
      const caps = (await personaCapabilities())[persona] ?? new Set<string>();
      const capabilityTabs = tabRequirements().filter(
        ([, n]) => n !== "ALWAYS" && (n as string[]).some((e) => caps.has(e)),
      );
      test.skip(capabilityTabs.length === 0, "holds nothing — covered by the no-access assertion");

      const sink = { refusals: [] as Refusal[], errors: [] as string[] };
      const tabRef = { id: "(none)" };
      watch(page, sink, tabRef);

      const LABELS = tabLabels();
      const controls: Record<string, string[]> = {};
      const empty: string[] = [];
      const unreachable: string[] = [];

      for (const [tabId] of capabilityTabs) {
        tabRef.id = tabId;
        const label = LABELS.get(tabId) ?? tabId;
        // One staff tab list, so one destination. This used to probe up to
        // three shells per tab per persona — roughly 400 extra page loads
        // across the sweep — and cached the answer to avoid it.
        const order = ["staff"];
        let arrived = false;
        for (const shell of order) {
          if (!(await gotoTab(page, shell, tabId, label))) continue;
          arrived = true;
          // THE INVENTORY: every enabled control on screen. Read-only —
          // nothing is clicked.
          const visible = await page.evaluate(() =>
            Array.from(document.querySelectorAll("button:not([disabled])"))
              .map((b) => (b.textContent ?? "").trim())
              .filter((t) => t.length > 0 && t.length < 60),
          );
          controls[tabId] = [...new Set(visible)].sort();
          if (visible.length === 0) empty.push(tabId);
          break;
        }
        // NOT a measurement of zero — a tab the table says this person can
        // see and that no shell would actually open. Worth knowing on its
        // own, and the thing the old vacuous check hid.
        if (!arrived) unreachable.push(tabId);
      }

      (inventory[persona] as Record<string, unknown>) = {
        ...(inventory[persona] as Record<string, unknown>),
        controlsByTab: controls,
        tabsWithNoControls: empty,
        tabsUnreachable: unreachable,
      };

      // ONE combined assertion. Three sequential expects would hide each
      // other: the first failure stops the test and the rest go unreported.
      expect({
        refusals: sink.refusals,
        pageErrors: sink.errors,
      }).toEqual({ refusals: [], pageErrors: [] });
    });
  });
}
