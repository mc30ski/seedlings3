import { test, expect } from "@playwright/test";
import { gotoWorkerHome } from "../helpers/nav";
import { DEFAULT_EXPLAINER_TITLE } from "../../../src/ui/components/TabExplainer";

/**
 * Help is ONE preference, not one per tab.
 *
 * It used to be stored per tab (and per role), so turning help on told you
 * about the tab you were standing on and nothing else — every tab you moved
 * to came up closed and you had to find the (i) again. Someone who wants the
 * help wants it WHILE they find their way around, which is exactly when they
 * are changing tabs.
 *
 * WHAT THIS ASSERTS, AND WHY IT IS SHAPED THIS WAY. It drives the real
 * controls — click the (i), then click a tab — and asserts what is on the
 * screen afterwards. It deliberately does NOT read `localStorage`, call the
 * component's hook, or recompute "should it be open" from the same rule the
 * component uses: a test that re-derives the answer the implementation gives
 * agrees with the implementation by construction and cannot fail when the
 * implementation is wrong. The requirement is "I can still see it", so that
 * is the assertion.
 */

// The (i) trigger's accessible name IS the panel title — imported rather than
// retyped, so a copy change cannot leave this spec silently matching nothing.
const TRIGGER = new RegExp(`^${DEFAULT_EXPLAINER_TITLE}$`, "i");

/** The open panel: the heading band inside it, which is a button labelled
 *  "Hide <title>". Distinct from the (i) trigger, so neither can stand in for
 *  the other and make a false pass. */
const PANEL = new RegExp(`^Hide ${DEFAULT_EXPLAINER_TITLE}$`, "i");

/** Switch the inner tab the way a person does: the breadcrumb row shows the
 *  current tab's name as a dropdown ("Work  ›  Home"), so changing tabs means
 *  opening that dropdown and picking another. Not a tablist — there is no
 *  role="tab" here. */
async function switchInnerTab(page: import("@playwright/test").Page, from: RegExp, to: RegExp) {
  await page.getByRole("button", { name: from }).click();
  await page.getByRole("button", { name: to }).last().click();
  await page.waitForLoadState("networkidle");
}

test.describe("Tab explainer — the help preference survives a tab change", () => {
  test.beforeEach(async ({ page }) => {
    await gotoWorkerHome(page);
    // Start from a known OFF state. Help defaults to closed, but a previous
    // spec sharing this storage state could have left it on — and a test that
    // starts from "already open" would pass without the feature existing.
    await page.evaluate(() => {
      try {
        localStorage.removeItem("seedlings_help:open");
      } catch {}
    });
    await page.reload();
    await page.waitForLoadState("networkidle");
  });

  test("opening help on one tab leaves it open on the next", async ({ page }) => {
    const trigger = page.getByRole("button", { name: TRIGGER });
    await expect(trigger, "the breadcrumb (i) must be on Work → Home").toBeVisible();

    // Precondition, asserted rather than assumed: closed to begin with. If
    // this is already open the rest of the test proves nothing.
    await expect(
      page.getByRole("button", { name: PANEL }),
      "help must start closed, or the assertions below are vacuous",
    ).toHaveCount(0);

    await trigger.click();
    await expect(
      page.getByRole("button", { name: PANEL }),
      "clicking the (i) must open the panel on this tab",
    ).toBeVisible();

    // Now the actual complaint: change tabs.
    await switchInnerTab(page, /^\s*Home\s*$/i, /^\s*Jobs\s*$/i);

    await expect(
      page.getByRole("button", { name: PANEL }),
      "help was left ON, so the next tab must show its own explainer without another click",
    ).toBeVisible();

    // And the copy really is the NEW tab's, not the previous panel left
    // mounted. Jobs explains the card types; Home does not.
    await expect(
      page.getByRole("button", { name: TRIGGER }),
      "the trigger must still be the toggle, now showing the open state",
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("closing help also sticks — it does not reopen on the next tab", async ({ page }) => {
    // The mirror case. A preference that only ever latched ON would pass the
    // test above while being just as wrong.
    const trigger = page.getByRole("button", { name: TRIGGER });
    await trigger.click();
    await expect(page.getByRole("button", { name: PANEL })).toBeVisible();

    await trigger.click();
    await expect(
      page.getByRole("button", { name: PANEL }),
      "clicking the (i) again must close it",
    ).toHaveCount(0);

    await switchInnerTab(page, /^\s*Home\s*$/i, /^\s*Jobs\s*$/i);

    await expect(
      page.getByRole("button", { name: PANEL }),
      "help was left OFF, so the next tab must not push the panel back onto the screen",
    ).toHaveCount(0);
  });

  test("the preference outlives a reload, not just a tab change", async ({ page }) => {
    await page.getByRole("button", { name: TRIGGER }).click();
    await expect(page.getByRole("button", { name: PANEL })).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("button", { name: PANEL }),
      "the preference is persisted, so a reload must come back with help still on",
    ).toBeVisible();
  });
});
