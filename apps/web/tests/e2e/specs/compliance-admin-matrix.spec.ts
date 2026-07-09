import { test, expect } from "@playwright/test";
import { gotoSuperCompliance } from "../helpers/nav";

/**
 * Admin-facing Sign Matrix tests. Runs under the `super` Playwright
 * project (Michael's storage state) — needs SUPER role to load the
 * admin Compliance tab.
 *
 * Covers today's UI polish:
 *  - Worker type renders as a colored Chakra chip (Blue/Orange/Cyan),
 *    NOT as raw uppercase enum text.
 *  - The unclassified-worker warning row renders IF any exist. If none
 *    do (typical dev + prod state), the warning is absent — that's a
 *    negative test worth having too.
 */

test.describe("Sign Matrix: worker-type chips", () => {
  test("worker type renders as a colored chip, not raw enum text", async ({ page }) => {
    await gotoSuperCompliance(page);

    // Switch the compliance tab to the Sign Matrix view. The toggle is
    // labeled "Sign matrix" next to "Policies".
    const matrixToggle = page.getByRole("button", { name: /^Sign matrix$/i });
    await expect(matrixToggle).toBeVisible({ timeout: 10_000 });
    await matrixToggle.click();

    // Wait for at least one worker row to render. Sign matrix pulls from
    // the users list; on dev DB there are always several seed workers.
    const badge = page.locator('[data-testid="sign-matrix-worker-type"]').first();
    await expect(badge).toBeVisible({ timeout: 10_000 });

    // Real assertion: no worker-type badge shows the raw uppercase enum.
    // The friendly labels are "Employee" / "Contractor" / "Trainee" /
    // "Unclassified".
    const badgeTexts = await page
      .locator('[data-testid="sign-matrix-worker-type"]')
      .allInnerTexts();
    expect(badgeTexts.length).toBeGreaterThan(0);
    for (const t of badgeTexts) {
      // Nothing in the matrix should be the raw uppercase enum. If any
      // badge is a worker-type label, it should be the friendly cased
      // version — never "EMPLOYEE" / "CONTRACTOR" / "TRAINEE".
      expect(t).not.toBe("EMPLOYEE");
      expect(t).not.toBe("CONTRACTOR");
      expect(t).not.toBe("TRAINEE");
    }

    // Positive check: at least one of the recognized worker-type labels
    // is present.
    const hasWorkerTypeLabel = badgeTexts.some((t) =>
      ["Employee", "Contractor", "Trainee", "Unclassified"].includes(t.trim()),
    );
    expect(hasWorkerTypeLabel).toBe(true);
  });

  test("unclassified warning is absent when no worker is unclassified", async ({ page }) => {
    // The dev DB seeds all workers with a workerType. In steady state
    // this warning row should NOT render. If it starts rendering, either
    // (a) someone accidentally created an approved WORKER-role user
    // without a workerType — which is the real thing the warning is
    // there to catch — or (b) the seed logic drifted.
    await gotoSuperCompliance(page);

    const matrixToggle = page.getByRole("button", { name: /^Sign matrix$/i });
    await matrixToggle.click();

    // Wait until the matrix has rendered SOMETHING (badge or table row).
    await expect(
      page.locator('[data-testid="sign-matrix-worker-type"]').first(),
    ).toBeVisible({ timeout: 10_000 });

    // The warning row uses the phrasing "workers have no worker type set"
    // (or "worker has..." for the singular case).
    const warningText = page.getByText(/worker(s)? (has|have) no worker type set/i);
    // Should NOT be visible in a clean seed state.
    const count = await warningText.count();
    // Documented behavior: expected to be 0 in clean dev state. If your
    // dev DB ever contains an unclassified WORKER-role user this will
    // fail — that's still useful signal.
    expect(count).toBe(0);
  });
});
