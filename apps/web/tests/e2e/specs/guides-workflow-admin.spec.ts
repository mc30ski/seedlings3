// ─────────────────────────────────────────────────────────────────────────────
// Education guides — the approval workflow, end to end, as a Super.
//
// Canonical spec: docs/features/education.md.
//
// Runs under the `super` project, so the signed-in user holds SUPER. What
// this proves that the build gate cannot: the state machine actually
// round-trips against a database — submit → reject → re-edit → submit →
// approve → workers can read it → unpublish → workers cannot.
//
// The load-bearing assertion throughout is `currentVersionId`. Visibility
// is that column, not a status flag, so every transition is checked
// against it rather than against what the page happens to render.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  USERS,
  createScratchGuide,
  cleanupScratchGuides,
  createScratchAssets,
  cleanupScratchAssets,
} from "../helpers/db";
import { gotoGuides } from "../helpers/nav";
import { apiAs } from "../helpers/api";

let prisma: PrismaClient;

const V1_BODY = "ZQV1BODY the first approved revision";
const V2_BODY = "ZQV2BODY the edit that must be re-reviewed";

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.beforeEach(async () => {
  await cleanupScratchGuides(prisma);
  await cleanupScratchAssets(prisma);
});

test.afterAll(async () => {
  await cleanupScratchGuides(prisma);
  await cleanupScratchAssets(prisma);
  await prisma.$disconnect();
});


test.describe("Education guides — approval workflow", () => {
  test("a guide is invisible to workers until a Super approves it", async ({ page }) => {
    await gotoGuides(page, "super");

    // ── Author ───────────────────────────────────────────────────────────
    const created = await apiAs(page, "POST", "/api/guides", {
      title: "E2E Workflow Guide",
      summary: "Round-trips the whole state machine",
      categoryKey: "lawn-care",
      tags: ["e2e"],
    });
    expect(created.status).toBe(200);
    const guideId: string = created.json.id;

    // Rename the slug into the scratch namespace so cleanup collects it
    // even if this test fails partway through.
    const slug = `e2e-scratch-guide-${guideId.slice(-8)}`;
    await prisma.guide.update({ where: { id: guideId }, data: { slug } });

    // A brand-new guide is NOT published — that is the point of the gate.
    expect(
      (await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId,
    ).toBeNull();

    // ── Draft ────────────────────────────────────────────────────────────
    const draft = await apiAs(page, "POST", `/api/guides/${guideId}/draft`, {
      contentMarkdown: `# Workflow\n\n${V1_BODY}\n`,
      changeNote: "First pass",
    });
    expect(draft.status).toBe(200);
    const v1Id: string = draft.json.id;
    expect(
      (await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId,
      "saving a draft published it",
    ).toBeNull();

    // ── Submit ───────────────────────────────────────────────────────────
    expect((await apiAs(page, "POST", `/api/guides/versions/${v1Id}/submit`)).status).toBe(200);
    expect((await prisma.guideVersion.findUnique({ where: { id: v1Id } }))?.status).toBe(
      "PENDING_APPROVAL",
    );

    // It shows up in the review queue.
    const queue = await apiAs(page, "GET", "/api/guides/pending-approvals");
    expect(queue.status).toBe(200);
    expect(queue.json.map((v: any) => v.id)).toContain(v1Id);

    // Still not published — submitted is not approved.
    expect(
      (await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId,
    ).toBeNull();

    // ── Reject, and confirm the note comes back to the author ────────────
    const rejected = await apiAs(page, "POST", `/api/guides/versions/${v1Id}/reject`, {
      note: "Add the application rate.",
    });
    expect(rejected.status).toBe(200);
    let v1 = await prisma.guideVersion.findUnique({ where: { id: v1Id } });
    expect(v1?.status).toBe("REJECTED");
    expect(v1?.rejectionNote).toBe("Add the application rate.");

    // ── Re-edit: a rejected version becomes a fresh draft ────────────────
    const reEdited = await apiAs(page, "POST", `/api/guides/${guideId}/draft`, {
      contentMarkdown: `# Workflow\n\n${V1_BODY}\n\nApply at 1 lb/1000 sq ft.\n`,
      changeNote: "Added the rate",
    });
    expect(reEdited.status).toBe(200);
    expect(reEdited.json.id, "re-editing should reuse the rejected version").toBe(v1Id);
    v1 = await prisma.guideVersion.findUnique({ where: { id: v1Id } });
    expect(v1?.status).toBe("DRAFT");
    expect(v1?.rejectionNote, "the stale rejection note survived a re-edit").toBeNull();

    // ── Submit → approve ─────────────────────────────────────────────────
    await apiAs(page, "POST", `/api/guides/versions/${v1Id}/submit`);
    const approved = await apiAs(page, "POST", `/api/guides/versions/${v1Id}/approve`);
    expect(approved.status).toBe(200);

    const afterApprove = await prisma.guide.findUnique({ where: { id: guideId } });
    expect(afterApprove?.currentVersionId, "approve did not publish").toBe(v1Id);
    expect((await prisma.guideVersion.findUnique({ where: { id: v1Id } }))?.status).toBe(
      "PUBLISHED",
    );

    // The queue is now clear of it.
    const queueAfter = await apiAs(page, "GET", "/api/guides/pending-approvals");
    expect(queueAfter.json.map((v: any) => v.id)).not.toContain(v1Id);

    // ── An edit does NOT disturb what workers are reading ────────────────
    const v2 = await apiAs(page, "POST", `/api/guides/${guideId}/draft`, {
      contentMarkdown: `# Workflow\n\n${V2_BODY}\n`,
      changeNote: "Rewrite",
    });
    expect(v2.status).toBe(200);
    const v2Id: string = v2.json.id;
    expect(v2Id, "editing a published guide must create a NEW version").not.toBe(v1Id);
    expect(
      (await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId,
      "an unapproved edit changed what workers read",
    ).toBe(v1Id);

    // The published body is still v1's.
    const readBack = await apiAs(page, "GET", `/api/me/guides/${slug}`);
    expect(readBack.json.currentVersion.contentMarkdown).toContain(V1_BODY);
    expect(readBack.json.currentVersion.contentMarkdown).not.toContain(V2_BODY);

    // ── Approving v2 promotes it and demotes v1 ──────────────────────────
    await apiAs(page, "POST", `/api/guides/versions/${v2Id}/submit`);
    await apiAs(page, "POST", `/api/guides/versions/${v2Id}/approve`);
    expect((await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId).toBe(
      v2Id,
    );
    expect(
      (await prisma.guideVersion.findUnique({ where: { id: v1Id } }))?.status,
      "the outgoing version should be demoted, not left PUBLISHED",
    ).toBe("ROLLED_BACK");

    // ── Unpublish takes it away from workers again ───────────────────────
    expect((await apiAs(page, "POST", `/api/guides/${guideId}/unpublish`)).status).toBe(200);
    expect(
      (await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId,
      "unpublish left the guide readable",
    ).toBeNull();
  });

  test("permanent delete requires archiving first, and snapshots what it destroys", async ({
    page,
  }) => {
    await gotoGuides(page, "super");

    const g = await createScratchGuide(prisma, {
      title: "E2E Purge Me",
      contentMarkdown: `# Purge\n\n${V1_BODY}\n`,
      status: "PUBLISHED",
      createdById: USERS.super,
    });

    // A live guide cannot be purged. Otherwise "permanent delete" is one
    // mis-click from destroying something workers are reading right now.
    const tooSoon = await apiAs(page, "POST", `/api/guides/${g.guideId}/purge`);
    expect(tooSoon.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.guide.findUnique({ where: { id: g.guideId } })).not.toBeNull();

    expect((await apiAs(page, "POST", `/api/guides/${g.guideId}/archive`)).status).toBe(200);
    expect((await apiAs(page, "POST", `/api/guides/${g.guideId}/purge`)).status).toBe(200);
    expect(await prisma.guide.findUnique({ where: { id: g.guideId } })).toBeNull();

    // The audit row is now the ONLY record the guide existed, so it has to
    // carry the body — a row saying "something was deleted" is not a record.
    const event = await prisma.auditEvent.findFirst({
      where: { scope: "GUIDE", verb: "PURGED" },
      orderBy: { createdAt: "desc" },
    });
    expect(event, "purge wrote no audit event").toBeTruthy();
    const meta = JSON.stringify(event?.metadata ?? {});
    expect(meta).toContain("E2E Purge Me");
    expect(meta, "the purge snapshot omitted the content it destroyed").toContain(V1_BODY);
  });

  test("the Tasks alert and the review section agree on the pending count", async ({ page }) => {
    // The alert badge and the Tasks-page section are separate code paths
    // reading the same queue. When they disagree, a Super sees a badge
    // that leads to an empty section.
    await createScratchGuide(prisma, {
      title: "E2E Awaiting One",
      contentMarkdown: "# One",
      status: "PENDING_APPROVAL",
      createdById: USERS.admin,
    });
    await createScratchGuide(prisma, {
      title: "E2E Awaiting Two",
      contentMarkdown: "# Two",
      status: "PENDING_APPROVAL",
      createdById: USERS.admin,
    });

    await gotoGuides(page, "super");

    const count = await apiAs(page, "GET", "/api/guides/pending-approvals/count");
    const queue = await apiAs(page, "GET", "/api/guides/pending-approvals");
    expect(count.status).toBe(200);
    expect(count.json.count).toBe(queue.json.length);
    expect(count.json.count).toBeGreaterThanOrEqual(2);

    // An archived guide's pending version must drop out of BOTH — nobody
    // should be asked to review something already shelved.
    //
    // Pick one of OUR OWN rows, never `queue.json[0]`. The queue is
    // ordered oldest-first, so index 0 is a seeded guide — archiving it
    // silently strips it from the dev database and every later manual
    // check of this tab is then looking at data a test broke.
    const first = queue.json.find((v: any) =>
      String(v.guide.slug).startsWith("e2e-scratch-guide-"),
    );
    expect(first, "no scratch guide in the pending queue").toBeTruthy();
    await prisma.guide.update({
      where: { id: first.guide.id },
      data: { archivedAt: new Date() },
    });
    const after = await apiAs(page, "GET", "/api/guides/pending-approvals");
    const afterCount = await apiAs(page, "GET", "/api/guides/pending-approvals/count");
    expect(after.json.map((v: any) => v.id)).not.toContain(first.id);
    expect(afterCount.json.count).toBe(after.json.length);
  });
});

test.describe("Education guides — media library paging", () => {
  // The library is append-mostly: assets are immutable and outlive the
  // guides that referenced them, so this list only grows. Returning it
  // whole meant an unbounded payload and an unbounded wall of rows.
  const PAGE_SIZE = 20;
  const EXTRA = 25;

  test("the API pages, and pages do not overlap", async ({ page }) => {
    await createScratchAssets(prisma, EXTRA, USERS.super);
    await gotoGuides(page, "super");

    const p1 = await apiAs(page, "GET", "/api/guides/assets?page=1");
    expect(p1.status).toBe(200);
    expect(Array.isArray(p1.json.items), "the payload must be a page, not a bare array").toBe(true);
    expect(p1.json.items.length).toBe(PAGE_SIZE);
    expect(p1.json.total).toBeGreaterThanOrEqual(EXTRA);

    const p2 = await apiAs(page, "GET", "/api/guides/assets?page=2");
    expect(p2.status).toBe(200);
    expect(p2.json.items.length).toBeGreaterThan(0);

    // No row appears on two pages — an unstable sort would duplicate some
    // rows and silently drop others.
    const ids1 = p1.json.items.map((a: any) => a.id);
    const ids2 = p2.json.items.map((a: any) => a.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);

    // And a page past the end is empty rather than an error.
    const far = await apiAs(page, "GET", "/api/guides/assets?page=999");
    expect(far.status).toBe(200);
    expect(far.json.items).toEqual([]);
    expect(far.json.total).toBe(p1.json.total);
  });

  test("search narrows the total, not just the visible page", async ({ page }) => {
    // A pager over a filtered set has to count the FILTERED rows. Counting
    // everything would offer pages that render empty.
    await createScratchAssets(prisma, EXTRA, USERS.super);
    await gotoGuides(page, "super");

    const all = await apiAs(page, "GET", "/api/guides/assets?page=1");
    const filtered = await apiAs(
      page,
      "GET",
      "/api/guides/assets?page=1&q=" + encodeURIComponent("e2e-pager-00"),
    );
    expect(filtered.status).toBe(200);
    expect(filtered.json.total).toBeLessThan(all.json.total);
    expect(filtered.json.total).toBe(10); // e2e-pager-000 … 009
    for (const a of filtered.json.items) expect(a.originalFilename).toContain("e2e-pager-00");
  });

  test("the pager renders and moves between pages", async ({ page }) => {
    await createScratchAssets(prisma, EXTRA, USERS.super);
    await gotoGuides(page, "super");

    await page.getByText(/MEDIA LIBRARY/i).click();
    await expect(page.getByText(/page 1 of 2/i)).toBeVisible({ timeout: 30_000 });

    const firstRow = await page.getByText(/e2e-pager-0\d\d\.png/).first().textContent();
    await page.getByRole("button", { name: /Next/ }).click();
    await expect(page.getByText(/page 2 of 2/i)).toBeVisible({ timeout: 30_000 });

    // The visible rows actually changed — a pager that renumbers without
    // refetching looks identical to one that works.
    const afterRow = await page.getByText(/e2e-pager-0\d\d\.png/).first().textContent();
    expect(afterRow, "page 2 shows the same first row as page 1").not.toBe(firstRow);

    await page.getByRole("button", { name: /Prev/ }).click();
    await expect(page.getByText(/page 1 of 2/i)).toBeVisible({ timeout: 30_000 });

    // The range line is present at every size, including a single page —
    // hiding the whole footer when everything fits made the library look
    // unpaged and answered nothing about how many files there are.
    await expect(page.getByText(/1–20 of \d+/)).toBeVisible({ timeout: 30_000 });
  });
});
