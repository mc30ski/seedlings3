// ─────────────────────────────────────────────────────────────────────────────
// Education guides — worker isolation, in a real browser.
//
// Canonical spec: docs/features/education.md.
//
// THIS IS THE TEST THAT MATTERS for the approval gate. The build gate
// (`guides-build-gate.test.ts`) asserts the worker `where` clause exists in
// the source; it cannot prove the query actually hides anything, because
// that needs a database and a signed-in session. This does.
//
// Three guides are seeded with deliberately distinctive body text — one
// published, one awaiting approval, one a bare draft. If visibility ever
// regresses to a client-side filter, the unapproved bodies show up in the
// response even while the UI still looks correct.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS, createScratchGuide, cleanupScratchGuides } from "../helpers/db";
import { gotoGuides, gotoGuidesByClicking } from "../helpers/nav";
import { apiAs } from "../helpers/api";

let prisma: PrismaClient;

// Strings chosen so none is a substring of another and none could occur
// naturally elsewhere in the app — a leak cannot hide behind a
// coincidental match.
const PUBLISHED_BODY = "ZQPUBLISHEDBODY furrow irrigation at dawn";
const PENDING_BODY = "ZQPENDINGBODY awaiting a super's blessing";
const DRAFT_BODY = "ZQDRAFTBODY nobody has even submitted this";

const PUBLISHED_TITLE = "E2E Published Guide";
const PENDING_TITLE = "E2E Pending Guide";
const DRAFT_TITLE = "E2E Draft Guide";

let published: { guideId: string; slug: string };
let pending: { guideId: string; slug: string };
let draft: { guideId: string; slug: string };

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.beforeEach(async () => {
  await cleanupScratchGuides(prisma);
  published = await createScratchGuide(prisma, {
    title: PUBLISHED_TITLE,
    summary: "A guide a worker is allowed to read",
    tags: ["e2e", "irrigation"],
    contentMarkdown: `# Published\n\n${PUBLISHED_BODY}\n`,
    status: "PUBLISHED",
    createdById: USERS.admin,
  });
  pending = await createScratchGuide(prisma, {
    title: PENDING_TITLE,
    summary: "Submitted but not approved",
    contentMarkdown: `# Pending\n\n${PENDING_BODY}\n`,
    status: "PENDING_APPROVAL",
    createdById: USERS.admin,
  });
  draft = await createScratchGuide(prisma, {
    title: DRAFT_TITLE,
    contentMarkdown: `# Draft\n\n${DRAFT_BODY}\n`,
    status: "DRAFT",
    createdById: USERS.admin,
  });
});

test.afterAll(async () => {
  await cleanupScratchGuides(prisma);
  await prisma.$disconnect();
});

test.describe("Education guides — worker view", () => {
  test("a worker can actually navigate to Guides through the UI", async ({ page }) => {
    // Every other spec here stamps localStorage to land on the tab, which
    // renders it even when the role's catMap has no entry for `guides` —
    // and that is precisely how it shipped: registered in the worker tab
    // list, mapped to no category, unreachable by clicking.
    await gotoGuidesByClicking(page, "worker");
    // The catalog itself, not a placeholder — placeholders are attributes
    // and never appear in textContent.
    const body = (await page.locator("body").textContent()) ?? "";
    expect(body, "Guides is not reachable from the worker's Records category").toContain(
      PUBLISHED_TITLE,
    );
    await expect(page.getByPlaceholder(/Search guides/i)).toBeVisible();
  });

  test("the catalog lists ONLY published guides", async ({ page }) => {
    await gotoGuides(page, "worker");
    // Anchor on the row RENDERING before reading the page. A fixed sleep
    // here was a guess that got shorter as the machine got busier, and it
    // made this assertion fail intermittently on content that arrived a
    // moment later — a rendering race dressed up as a visibility bug.
    await expect(page.getByText(PUBLISHED_TITLE).first()).toBeVisible({ timeout: 30_000 });

    const body = (await page.locator("body").textContent()) ?? "";

    expect(body, "a published guide should be in the catalog").toContain(PUBLISHED_TITLE);
    expect(body, "an unapproved guide appeared in the worker catalog").not.toContain(
      PENDING_TITLE,
    );
    expect(body, "a draft guide appeared in the worker catalog").not.toContain(DRAFT_TITLE);
  });

  test("the API response itself omits unapproved guides", async ({ page }) => {
    // The access control has to be in the RESPONSE. Asserting on the DOM
    // alone would pass if the client filtered a fuller payload.
    await gotoGuides(page, "worker");

    const list = await apiAs(page, "GET", "/api/me/guides");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json)).toBe(true);

    const ids: string[] = list.json.map((g: any) => g.id);
    expect(ids).toContain(published.guideId);
    expect(ids, "pending guide reached the worker payload").not.toContain(pending.guideId);
    expect(ids, "draft guide reached the worker payload").not.toContain(draft.guideId);

    // Every row a worker receives must be published, seeded rows included.
    for (const g of list.json) {
      expect(g.isPublished, `${g.title} was returned unpublished`).toBe(true);
    }
  });

  test("fetching an unapproved guide directly is a 404, not a body", async ({ page }) => {
    // The catalog hiding it is not enough — someone will guess a slug.
    await gotoGuides(page, "worker");

    for (const g of [pending, draft]) {
      const byId = await apiAs(page, "GET", `/api/me/guides/${g.guideId}`);
      expect(byId.status, "an unapproved guide was fetchable by id").toBe(404);
      expect(JSON.stringify(byId.json ?? "")).not.toContain("ZQ");

      const bySlug = await apiAs(page, "GET", `/api/me/guides/${g.slug}`);
      expect(bySlug.status, "an unapproved guide was fetchable by slug").toBe(404);
    }

    // Control: the published one IS reachable, so the 404s above mean
    // "hidden", not "the route is broken".
    const ok = await apiAs(page, "GET", `/api/me/guides/${published.slug}`);
    expect(ok.status).toBe(200);
    expect(ok.json.currentVersion.contentMarkdown).toContain(PUBLISHED_BODY);
  });

  test("search cannot reach an unapproved body", async ({ page }) => {
    // Search runs server-side across the body text. A worker searching the
    // exact words of a draft must find nothing — otherwise search is a
    // side channel around the approval gate.
    await gotoGuides(page, "worker");

    const hit = await apiAs(page, "GET", `/api/me/guides?q=${encodeURIComponent("ZQPUBLISHEDBODY")}`);
    expect(hit.status).toBe(200);
    expect(hit.json.map((g: any) => g.id), "search should find the published body").toContain(
      published.guideId,
    );

    for (const term of ["ZQPENDINGBODY", "ZQDRAFTBODY"]) {
      const miss = await apiAs(page, "GET", `/api/me/guides?q=${encodeURIComponent(term)}`);
      expect(miss.status).toBe(200);
      expect(miss.json, `search matched an unapproved body (${term})`).toHaveLength(0);
    }
  });

  test("a worker cannot author, submit, approve or delete", async ({ page }) => {
    // Read-only is the whole contract for this role. Each of these is a
    // separate guard in the routes; a single 403 would not prove the rest.
    await gotoGuides(page, "worker");

    const attempts: Array<[string, string, any?]> = [
      ["POST", "/api/guides", { title: "E2E worker should not create", categoryKey: "lawn-care" }],
      ["PATCH", `/api/guides/${published.guideId}`, { title: "renamed by a worker" }],
      ["POST", `/api/guides/${published.guideId}/draft`, { contentMarkdown: "x" }],
      ["GET", "/api/guides/pending-approvals"],
      ["POST", `/api/guides/${published.guideId}/archive`],
      ["POST", `/api/guides/${published.guideId}/purge`],
      ["GET", "/api/guides/assets"],
      ["POST", "/api/guides/assets/upload-url", { kind: "IMAGE", contentType: "image/png", filename: "x.png", sizeBytes: 1000 }],
    ];

    for (const [method, path, payload] of attempts) {
      const res = await apiAs(page, method, path, payload);
      expect(
        res.status,
        `worker got ${res.status} from ${method} ${path} — expected a 401/403`,
      ).toBeGreaterThanOrEqual(401);
      expect(res.status).toBeLessThan(404);
    }

    // And nothing actually changed.
    const stillNamed = await prisma.guide.findUnique({ where: { id: published.guideId } });
    expect(stillNamed?.title).toBe(PUBLISHED_TITLE);
    expect(stillNamed?.archivedAt).toBeNull();
  });

  test("a cross-reference link cannot leak an unapproved guide", async ({ page }) => {
    // The seeded published guide links to BOTH a published guide and one
    // still awaiting approval. Link resolution is a second door onto the
    // catalog: if it forgets to scope itself, a worker following that
    // link learns the pending guide's title and id — the exact leak the
    // catalog query exists to prevent.
    await gotoGuides(page, "worker");

    const res = await apiAs(
      page,
      "GET",
      "/api/me/guides/resolve?slugs=" +
        encodeURIComponent(
          [
            "before-you-start-the-mower", // published
            "mowing-heights-by-grass-type", // PENDING_APPROVAL
            "winter-overseeding", // REJECTED
            "old-billing-walkthrough", // archived
            published.slug, // this run's scratch published guide
            pending.slug,
            draft.slug,
          ].join(","),
        ),
    );
    expect(res.status).toBe(200);
    const slugs: string[] = res.json.map((r: any) => r.slug);

    expect(slugs, "a published target should resolve").toContain("before-you-start-the-mower");
    expect(slugs).toContain(published.slug);

    for (const hidden of [
      "mowing-heights-by-grass-type",
      "winter-overseeding",
      "old-billing-walkthrough",
      pending.slug,
      draft.slug,
    ]) {
      expect(slugs, `link resolution leaked ${hidden} to a worker`).not.toContain(hidden);
    }
    // Not even a title should come back for anything hidden.
    const blob = JSON.stringify(res.json);
    expect(blob).not.toContain("Mowing heights");
    expect(blob).not.toContain("Winter overseeding");
    expect(blob).not.toContain(PENDING_TITLE);
    for (const r of res.json) expect(r.isPublished).toBe(true);
  });

  test("a worker cannot reach the inbound-links endpoint", async ({ page }) => {
    // It reports which guides link to a given one, drafts included.
    await gotoGuides(page, "worker");
    const res = await apiAs(page, "GET", `/api/guides/${published.slug}/inbound-links`);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(404);
  });

  test("a published cross-reference renders as a link, a hidden one as plain text", async ({
    page,
  }) => {
    await gotoGuides(page, "worker");
    await page.getByText("Fertilizing Bermuda grass").first().click();
    // The links resolve through a second request after the body renders,
    // Wait for it to become an actual LINK, not just for the text.
    //
    // Cross-references resolve through a second request after the body
    // renders, and until it lands the label renders as an inert span with
    // the same text. `getByText` matched that span, so the wait passed
    // while the link was not yet clickable — clicking it did nothing and
    // the test timed out ~1 run in 8. `role="link"` is only set on the
    // resolved, navigable branch, so it is the honest anchor.
    await expect(
      page.getByRole("link", { name: "pre-start check" }),
    ).toBeVisible({ timeout: 30_000 });

    const body = (await page.locator("body").textContent()) ?? "";
    // The author-written label always shows; that text is approved content.
    expect(body).toContain("mowing heights by grass type");
    expect(body).toContain("pre-start check");
    // But a worker must never see the author-only markers.
    expect(body, "an author-only link marker rendered for a worker").not.toContain(
      "(not published)",
    );
    expect(body).not.toContain("(broken link)");

    // The published target is clickable and navigates in-app.
    await page.getByRole("link", { name: "pre-start check" }).click();
    await expect(
      page.getByText("Before you start the mower").first(),
      "clicking a cross-reference should open that guide",
    ).toBeVisible({ timeout: 30_000 });
  });

  test("no unapproved body text reaches the rendered page", async ({ page }) => {
    // Belt and braces on the surface the worker actually looks at,
    // including after opening a guide and running a search in the UI.
    await gotoGuides(page, "worker");
    await page.getByText(PUBLISHED_TITLE).first().click();
    await expect(page.getByText(PUBLISHED_BODY, { exact: false })).toBeVisible({ timeout: 30_000 });

    const body = (await page.locator("body").textContent()) ?? "";
    expect(body).toContain(PUBLISHED_BODY);
    expect(body, "a pending guide's body rendered for a worker").not.toContain(PENDING_BODY);
    expect(body, "a draft guide's body rendered for a worker").not.toContain(DRAFT_BODY);
  });
});
