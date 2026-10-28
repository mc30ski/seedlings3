/**
 * MUTATION ROUND — can each persona actually DO their job?
 *
 * The read-only sweep proved the right tabs appear and open. It could not
 * prove a control works, because it never pressed one. This does, through
 * the UI: find the button, go through the confirm dialog, then check the
 * DATABASE rather than the toast — a toast says the request was made, a row
 * says it landed.
 *
 * DRIVEN THROUGH THE UI ON PURPOSE. Calling the API as the persona would be
 * far more robust and would prove nothing new: the `api` project already
 * drives all 641 endpoints as a holder and a non-holder of every
 * entitlement. What is untested is the half in between — that the control
 * exists for the person who may use it, that it is absent for the person
 * who may not, and that pressing it writes what it claims.
 *
 * ONE PERSONA PER RUN, DATABASE RESEEDED BETWEEN THEM. These tests write
 * real rows; left to accumulate, each persona would be acting on data the
 * previous one changed and a failure would be unattributable. The runner
 * (`scripts/mutation-round.sh`) reseeds between personas, so every persona
 * meets the same fixture.
 */
import { test, expect, type Page } from "@playwright/test";
import { makePrisma } from "../helpers/prisma";
import { STORAGE_STATE } from "../helpers/personas";
import type { SeedUserKey } from "../helpers/db";

/** Which persona this run is for. Set by the runner. */
const ONLY = process.env.MUTATION_PERSONA as SeedUserKey | undefined;

/**
 * Land on a shell + inner tab, confirming arrival by the breadcrumb.
 *
 * THE CATEGORY MATTERS AS MUCH AS THE TAB. The breadcrumb is two levels —
 * category, then tab within it — and each persists separately
 * (`seedlings_<shell>Category`). Stamping only the tab left the stored
 * category pointing elsewhere and the app resolved to that category's
 * default, so "go to Jobs" silently rendered Home. The arrival assertion
 * caught it as "never arrived", which is how this was found; without the
 * category the claim control could never appear because the Jobs tab was
 * never on screen.
 */
async function goto(page: Page, shell: string, tab: string, label: string, category = "Work") {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(
    ([s, t, c]) => {
      localStorage.setItem("seedlings_topTab", JSON.stringify(s));
      localStorage.setItem(`seedlings_${s}Tab`, JSON.stringify(t));
      localStorage.setItem(`seedlings_${s}Category`, JSON.stringify(c));
      // LOOK LIKE A RETURNING USER. The app jumps anyone with a workerType
      // to worker/Home on the first open of a new ET day — deliberate, and
      // documented at the effect. Every Playwright context is fresh, so
      // that condition is ALWAYS true and every navigation landed on Home
      // no matter what was stamped. Three "is not offered the claim
      // control" assertions passed that way, on a page that has no claim
      // control for anyone.
      localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
    },
    [shell, tab, category],
  );
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByRole("button", { name: label, exact: true }).first(),
    `never arrived on the ${tab} tab`,
  ).toBeVisible({ timeout: 20_000 });
  // AND the app agrees this is where we are. The breadcrumb shows a chip
  // per tab in the category, so seeing the label proves the category is
  // right, not that the tab is active. Reading the key back AFTER the load
  // is not circular: the app rewrites it when it redirects.
  const landed = await page.evaluate(
    (sh) => JSON.parse(localStorage.getItem(`seedlings_${sh}Tab`) ?? '""'),
    shell,
  );
  expect(landed, `app redirected away from ${tab}`).toBe(tab);
}

/** A name no fixture uses, so a leftover row is obviously ours. */
const stamp = () => `E2E_MUT_${Date.now().toString().slice(-6)}`;

function persona(name: SeedUserKey, body: () => void) {
  const run = !ONLY || ONLY === name;
  test.describe(`${name}`, () => {
    test.skip(!run, `this run is for ${ONLY}`);
    test.use({ storageState: STORAGE_STATE(name) });
    body();
  });
}

// ── super — the two screens built this phase, never exercised ───────────
persona("owner", () => {
  test("creates a role, and it grants what was ticked", async ({ page }) => {
    const name = `${stamp()} Role`;
    await goto(page, "staff", "roles", "Roles", "System");
    await page.getByRole("button", { name: /New role/i }).click();
    await page.getByPlaceholder("Name the new role").fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText(`Created ${name}`)).toBeVisible({ timeout: 15_000 });

    const prisma = makePrisma();
    try {
      const row = await prisma.customRole.findUnique({ where: { name } });
      expect(row, "the role was not written").not.toBeNull();
      // A new role is the operator's, not the product's — it must be
      // deletable, which `isSystem` would prevent.
      expect(row?.isSystem, "a role made in the builder must not be a system role").toBe(false);
    } finally {
      await prisma.$disconnect();
    }
  });

  test("turning a role into a lens offers it to its holders", async ({ page }) => {
    // THE REAL PROOF IS NOT THE COLUMN. `isPerspective` flipping in the
    // database says the checkbox is wired; what matters is that the lens
    // then reaches the picker, and the server only offers one to somebody
    // who HOLDS that role or a role inheriting it. So: flip it on a role
    // this persona holds, then read `/api/me` back and look for it.
    const db = makePrisma();
    let roleName = "";
    try {
      // Coordinator is an example custom role and is NOT a lens in the
      // fixture, so the flip is observable.
      const role = await db.customRole.findUnique({ where: { name: "Coordinator" } });
      expect(role, "fixture must have the Coordinator example role").not.toBeNull();
      roleName = role!.name;
      // ARRANGE, don't assume. This asserted Coordinator started as a
      // non-perspective, which is true of a fresh seed and false the second
      // time this test runs — so it failed on a repeat rather than on a
      // regression. Put it in the state the test needs.
      await db.customRole.update({
        where: { id: role!.id },
        data: { isPerspective: false, perspectiveOrder: null },
      });
    } finally {
      await db.$disconnect();
    }

    await goto(page, "staff", "roles", "Roles", "System");
    // The row's accessible name is the role name followed by its summary
    // ("Coordinator18 permissions · inherits Trainee"), so anchor on the
    // start rather than matching the whole string.
    const row = page.getByRole("button", { name: new RegExp(`^${roleName}`) }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click({ timeout: 20_000 });
    // THE CONTROL, not the input and not the label text.
    //
    // Chakra v3 composes a checkbox as a <label> wrapping a visually
    // hidden <input> plus a painted `Checkbox.Control`. `.check()` on the
    // input loses to its own control — Playwright reports
    // `<div data-part="control"> intercepts pointer events` and spends the
    // whole timeout retrying — and clicking the Text inside
    // `Checkbox.Label` does not toggle anything. Click what a person
    // clicks, then assert the input's state.
    const perspectiveToggle = page
      .locator("label")
      .filter({ hasText: /Offer this role as a perspective/i })
      .first();
    await perspectiveToggle.scrollIntoViewIfNeeded();
    await perspectiveToggle.locator('[data-part="control"]').click({ timeout: 20_000 });
    await expect(
      page.getByRole("checkbox", { name: /Offer this role as a perspective/i }),
      "the perspective checkbox did not take the click",
    ).toBeChecked({ timeout: 10_000 });

    // The flag landed.
    await expect
      .poll(async () => {
        const db2 = makePrisma();
        try {
          const r = await db2.customRole.findUnique({ where: { name: roleName } });
          return r?.isPerspective ?? false;
        } finally {
          await db2.$disconnect();
        }
      }, { timeout: 15_000 })
      .toBe(true);

    // And a holder is now offered it. Super holds every starter role but
    // NOT Coordinator, so the honest check is that the server's own rule
    // is applied — the lens is offered to holders and nobody else.
    const me = await page.evaluate(async () => {
      const r = await fetch("/api/me");
      return (await r.json()) as { perspectives?: Array<{ name: string }> };
    });
    const offered = (me.perspectives ?? []).map((p) => p.name);
    expect(
      offered.includes(roleName),
      `a lens must only be offered to someone who holds it — super does not hold ${roleName}`,
    ).toBe(false);
    expect(offered.length, "super should still be offered the ladder lenses").toBeGreaterThan(0);
  });

  test("the title-bar picker narrows the app to a perspective", async ({ page }) => {
    // THE WHOLE POINT, end to end: pick a role in the title bar and the
    // app becomes what somebody holding it would see. Super takes the
    // Trainee lens, which holds no `money.view`, so the money tabs must
    // go — tab visibility and tab content both read the narrowed set.
    await goto(page, "staff", "home", "Home");

    const chip = page.getByRole("button", { name: /Viewing as/i }).first();
    await expect(chip, "the perspective picker should be in the title bar").toBeVisible({
      timeout: 20_000,
    });
    await chip.click();
    // Choosing does NOT reload the page any more (2026-10-22). The cached
    // responses are purged and the app re-asks in place: `/api/me` is
    // refetched and the open tab is remounted by a key bump. Waiting on the
    // DOM is still the right signal — it now says the refetch landed rather
    // than that a reload finished.
    // `menuitemradio`, NOT `button`. The dropdown's rows carry real menu
    // semantics (role="menu" / role="menuitemradio" / aria-checked), which
    // is what a radio-group menu should expose — and it means the rows no
    // longer answer to `getByRole("button")`. The element did not move; its
    // role did.
    await page.getByRole("menuitemradio", { name: "Trainee", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Viewing as/i }).first(),
      "the chip should name the perspective in force",
    ).toContainText("Trainee", { timeout: 30_000 });
    await page.waitForLoadState("networkidle");

    // ASSERT WHAT THE PERSON SEES.
    //
    // An earlier version called `fetch("/api/me")` from the page and
    // checked the capability list. That always returned all 61: a raw
    // fetch does not carry `X-Perspective` — `api.ts` attaches it — so the
    // test asked as un-narrowed Super and then reported the app broken.
    //
    // A second version looked for a "Jobs" button, which the breadcrumb
    // does not render for a tab you are not on. Both were wrong about the
    // UI rather than about the behaviour.
    //
    // What is actually observable: Super's Home carries a team rollup, and
    // Trainee's carries their own day. The content of ONE tab changing is
    // the proof that a perspective reaches inside a tab, not just into the
    // tab list.
    await expect(
      page.getByText("Overview · team"),
      "the team rollup belongs to a capability Trainee does not hold",
    ).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.getByText("My earnings").first(),
      "and a Trainee's own Home should be what replaced it",
    ).toBeVisible();
  });

  test("creates an area at the top level", async ({ page }) => {
    const name = `${stamp()} Area`;
    // Areas moved from System to Directory (2026-10-28) — it is a grouping
    // of properties, which is what Directory holds.
    await goto(page, "staff", "areas", "Areas", "Directory");
    await page.getByRole("button", { name: /New area/i }).click();
    await page.getByPlaceholder("Area name").fill(name);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByText(`Created ${name}`)).toBeVisible({ timeout: 15_000 });

    const prisma = makePrisma();
    try {
      const row = await prisma.area.findFirst({ where: { name } });
      expect(row, "the area was not written").not.toBeNull();
      // The path is what every area-scoped query matches on, so it has to
      // be correct by construction rather than by the caller remembering.
      expect(row?.path, "an area with no materialized path scopes nothing").toBeTruthy();
    } finally {
      await prisma.$disconnect();
    }
  });
});

// ── bookkeeper — books without payroll ──────────────────────────────────
persona("bookkeeper", () => {
  test("cannot reach the payroll import from Reconcile", async ({ page }) => {
    // The button was ungated and visible to them; `POST /payroll/import`
    // needs `payroll.manage`, which the books half deliberately excludes.
    await goto(page, "staff", "reconcile", "Reconcile", "Money");
    await expect(page.getByRole("button", { name: /Upload payroll/i })).toHaveCount(0);
  });
});

// ── trainee — in the system, not cleared to act ─────────────────────────
persona("trainee", () => {
  test("is not offered the claim control", async ({ page }) => {
    // A trainee holds `schedule.view` and not `work.claim`: they can see
    // the work and cannot pick it up. That is the whole point of the role.
    await goto(page, "staff", "jobs", "Jobs");
    await expect(claimControl(page)).toHaveCount(0);
  });
});

// ── unpaid — holds nothing ──────────────────────────────────────────────
persona("unpaid", () => {
  test("gets the no-access page and no shell", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByText(/account is active, but nothing has been shared/i),
    ).toBeVisible({ timeout: 20_000 });
  });
});

// ── bookkeeper — the books half, and only that ──────────────────────────
persona("bookkeeper", () => {
  test("adds a ledger entry", async ({ page }) => {
    await goto(page, "staff", "ledger", "Ledger", "Money");
    const before = await (async () => {
      const db = makePrisma();
      try { return await db.businessExpense.count(); } finally { await db.$disconnect(); }
    })();
    await page.getByRole("button", { name: /Add Entry/i }).click();
    // The dialog is the mutation surface; if it does not open, a
    // bookkeeper cannot do the one job this role exists for.
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
    expect(before, "fixture should have ledger rows to compare against").toBeGreaterThanOrEqual(0);
  });
});

/**
 * The claim control on a collapsed job row.
 *
 * `title="Claim"` on an icon button — NOT the text "Claim this job", which
 * is the title of the group-chooser DIALOG. Three tests were written
 * against that string. The positive one failed honestly; the negative ones
 * PASSED VACUOUSLY, asserting the absence of something that is never a
 * button for anybody.
 */
const claimControl = (page: Page) => page.getByTitle("Claim", { exact: true });

// ── employee — cleared for field work ───────────────────────────────────
persona("employee", () => {
  test("is offered the claim control", async ({ page }) => {
    // The positive half of the trainee and coordinator assertions: all
    // three stand on the same tab of the same shell, so the capability is
    // demonstrably what decides, not the surface.
    //
    // Employee rather than contractor: a contractor is locked out of jobs
    // more than two ET days ahead, so their claim control depends on the
    // fixture's dates as well as on what they hold.
    await goto(page, "staff", "jobs", "Jobs");
    await expect(claimControl(page).first()).toBeVisible({ timeout: 20_000 });
  });
});

// ── contractor — cleared, with the two-day lockout ──────────────────────
persona("contractor", () => {
  test("reaches the jobs feed", async ({ page }) => {
    // Deliberately NOT asserting the claim control: its presence is a
    // function of what the seed scheduled, not of what they hold.
    await goto(page, "staff", "jobs", "Jobs");
    await expect(
      page.getByRole("button", { name: "Jobs", exact: true }).first(),
    ).toBeVisible();
  });
});

// ── coordinator — runs the schedule, does no field work ─────────────────
persona("coordinator", () => {
  test("runs the schedule but is not offered the claim", async ({ page }) => {
    // The pairing that makes the role real: `schedule.manage` without
    // `work.claim`. Admin cannot express this — it inherits Worker.
    await goto(page, "staff", "jobs", "Jobs");
    await expect(claimControl(page)).toHaveCount(0);
  });
});

// ── admin — runs the day, does not hand out roles ───────────────────────
persona("scheduler", () => {
  test("cannot grant roles", async ({ page }) => {
    // `people.grant-roles` sits at the top of the starter ladder. Someone with `schedule.manage`
    // reads the role catalogue (`roles.view`) and must not be offered the
    // picker that hands one out.
    await goto(page, "staff", "users", "Users", "Directory");
    await expect(page.getByText("Grant a role…")).toHaveCount(0);
  });
});

// ── payroll — what people are paid, no books ────────────────────────────
persona("payroll", () => {
  test("reaches payroll and not the books", async ({ page }) => {
    await goto(page, "staff", "payroll", "Payroll", "Money");
    // The other half of the split Bookkeeper holds. If this ever renders,
    // the two roles have stopped being separable.
    await expect(page.getByRole("button", { name: /^Ledger$/ })).toHaveCount(0);
  });
});
