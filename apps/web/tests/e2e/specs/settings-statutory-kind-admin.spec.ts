import { test, expect } from "@playwright/test";

/** The `statutoryKind` tag on an expense category.
 *
 *  Why this has a spec of its own: the editor round-trips the WHOLE category
 *  array through JSON on every keystroke, so a field the parser doesn't know
 *  about is silently dropped the first time anyone edits an unrelated row.
 *  That has already happened once here — an earlier version of this editor
 *  dropped `qbAccount` on parse and re-saving wiped every QB mapping.
 *
 *  So the check is not "does the column render" but "does the SEEDED VALUE
 *  survive the parse and come back selected". If the parse dropped it, the
 *  picker would read "—" and the assertion below would fail. */
test("Settings — a category tagged workers comp keeps its tag through the editor", async ({ page }) => {
  await page.goto("/");
  // Wait for the app to MOUNT before stamping. `page.goto` resolves on load,
  // and the tab router's "jump to Home on the first open of the day" writes
  // its own topTab once React comes up — after the stamp, if we don't wait,
  // which silently lands the run on the worker view instead of Super.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    localStorage.setItem("seedlings_topTab", JSON.stringify("super"));
    localStorage.setItem("seedlings_superTab", JSON.stringify("settings"));
    localStorage.setItem("seedlings_superCategory", JSON.stringify("System"));
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /Acting as Super/ })).toBeVisible({
    timeout: 30_000,
  });

  // Settings are grouped into collapsible sections; EXPENSE_CATEGORIES lives
  // under Catalogs & Taxonomies and is not in the DOM until it is opened.
  await page.getByText("Catalogs & Taxonomies", { exact: true }).click();

  // The collapsed view badges every category. The seeded categories carry
  // their tag suffix, which proves the field survived the API read.
  const compBadge = page.getByText(/Insurance — workers comp · line 15 · comp/);
  await expect(compBadge).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Insurance — general liability · line 15 · GL/)).toBeVisible();

  // Open the dedicated EXPENSE_CATEGORIES editor. Scoped by intersection
  // rather than by the card's own title: `.last()` on a title-only filter
  // resolves to the tightest wrapper around the TEXT, which contains neither
  // the badges nor the button. Filtering on both the badge and an Edit button
  // makes the tightest match the card body, which is what we want.
  const card = page
    .locator("div")
    .filter({ has: compBadge })
    .filter({ has: page.getByRole("button", { name: "Edit", exact: true }) })
    .last();
  await card.getByRole("button", { name: "Edit", exact: true }).click();

  // The seventh column exists. Matched as the header PARAGRAPH, not as bare
  // text — the word also appears in the editor's explanatory blurb above.
  await expect(page.getByRole("paragraph").filter({ hasText: /^Statutory$/ })).toBeVisible();
  // ...and the seeded rows come back with their tags SELECTED, not reset to
  // "—". This is the assertion that catches a dropped field: the editor
  // re-serializes the whole array on every keystroke, so a value the parse
  // step loses is gone from the setting the moment anything else is touched.
  // Read the TRIGGER's value text, not bare text: each picker also renders its
  // full option list in a closed popover, so a plain text match lands on a
  // hidden <option> and proves nothing about what is selected.
  const selected = page.locator('[data-part="value-text"]');
  await expect(selected.filter({ hasText: /^Workers comp$/ })).toHaveCount(1);
  await expect(selected.filter({ hasText: /^General liability$/ })).toHaveCount(1);

  await page.screenshot({ path: "test-results/settings-statutory-kind.png", fullPage: false });
});
