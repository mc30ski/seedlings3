// ─────────────────────────────────────────────────────────────────────────────
// Education guides — what an ADMIN cannot do.
//
// Canonical spec: docs/features/education.md.
//
// Runs under the `admin-role` project, so the signed-in user holds ADMIN
// and NOT super. Everything the super spec exercises happily must be
// refused here — that asymmetry is the entire security model, and it is
// invisible to any test that signs in as a Super.
//
// Two rules live here:
//   1. An Admin cannot publish their own work. Content stalls when the
//      Super is away; that is the accepted cost of the gate.
//   2. An Admin cannot add or remove video. Video is the asset class that
//      silently becomes expensive and carries the HEVC playback trap, so
//      uploads are concentrated in one person.
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import { makePrisma, USERS, createScratchGuide, cleanupScratchGuides } from "../helpers/db";
import { gotoGuides } from "../helpers/nav";
import { apiAs } from "../helpers/api";

let prisma: PrismaClient;

let pending: { guideId: string; versionId: string; slug: string };
let live: { guideId: string; versionId: string; slug: string };

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.beforeEach(async () => {
  await cleanupScratchGuides(prisma);
  pending = await createScratchGuide(prisma, {
    title: "E2E Admin Pending",
    contentMarkdown: "# Pending\n\nSubmitted by an admin.\n",
    status: "PENDING_APPROVAL",
    createdById: USERS.admin,
  });
  live = await createScratchGuide(prisma, {
    title: "E2E Admin Live",
    contentMarkdown: "# Live\n\nAlready approved.\n",
    status: "PUBLISHED",
    createdById: USERS.admin,
  });
});

test.afterAll(async () => {
  await cleanupScratchGuides(prisma);
  await prisma.$disconnect();
});


test.describe("Education guides — admin restrictions", () => {
  test("an admin CAN author and submit", async ({ page }) => {
    // The control for everything below. Without it, a blanket 403 on the
    // whole feature would make the refusal tests pass for the wrong reason.
    await gotoGuides(page, "admin");

    const created = await apiAs(page, "POST", "/api/guides", {
      title: "E2E Admin Authored",
      categoryKey: "lawn-care",
    });
    expect(created.status).toBe(200);
    const guideId: string = created.json.id;
    await prisma.guide.update({
      where: { id: guideId },
      data: { slug: `e2e-scratch-guide-${guideId.slice(-8)}` },
    });

    const draft = await apiAs(page, "POST", `/api/guides/${guideId}/draft`, {
      contentMarkdown: "# Authored by an admin\n",
      changeNote: "First",
    });
    expect(draft.status).toBe(200);

    const submitted = await apiAs(page, "POST", `/api/guides/versions/${draft.json.id}/submit`);
    expect(submitted.status).toBe(200);
    expect((await prisma.guideVersion.findUnique({ where: { id: draft.json.id } }))?.status).toBe(
      "PENDING_APPROVAL",
    );

    // …and it is still not readable by anyone until a Super acts.
    expect(
      (await prisma.guide.findUnique({ where: { id: guideId } }))?.currentVersionId,
    ).toBeNull();
  });

  test("an admin cannot approve, publish, roll back, archive or purge", async ({ page }) => {
    await gotoGuides(page, "admin");

    const attempts: Array<[string, string, any?]> = [
      ["POST", `/api/guides/versions/${pending.versionId}/approve`],
      ["POST", `/api/guides/versions/${pending.versionId}/reject`, { note: "nope" }],
      ["POST", `/api/guides/versions/${live.versionId}/rollback`],
      ["POST", `/api/guides/${live.guideId}/unpublish`],
      ["POST", `/api/guides/${live.guideId}/archive`],
      ["POST", `/api/guides/${live.guideId}/purge`],
      ["GET", "/api/guides/pending-approvals"],
      ["GET", "/api/guides/pending-approvals/count"],
    ];

    for (const [method, path, payload] of attempts) {
      const res = await apiAs(page, method, path, payload);
      expect(res.status, `admin got ${res.status} from ${method} ${path}`).toBe(403);
    }

    // Nothing moved.
    expect((await prisma.guideVersion.findUnique({ where: { id: pending.versionId } }))?.status).toBe(
      "PENDING_APPROVAL",
    );
    const stillLive = await prisma.guide.findUnique({ where: { id: live.guideId } });
    expect(stillLive?.currentVersionId).toBe(live.versionId);
    expect(stillLive?.archivedAt).toBeNull();
  });

  test("an admin cannot upload video, but can still reference one", async ({ page }) => {
    await gotoGuides(page, "admin");

    const refused = await apiAs(page, "POST", "/api/guides/assets/upload-url", {
      filename: "mowing.mp4",
      contentType: "video/mp4",
      sizeBytes: 5 * 1024 * 1024,
    });
    expect(refused.status, "an admin was handed a video upload URL").toBe(403);
    expect(JSON.stringify(refused.json)).toMatch(/only a super/i);

    // The refusal must be about VIDEO, not about the media library in
    // general — an admin still uploads images and browses everything.
    const library = await apiAs(page, "GET", "/api/guides/assets");
    expect(library.status, "an admin lost access to the media library entirely").toBe(200);

    const videos = await apiAs(page, "GET", "/api/guides/assets?kind=VIDEO");
    expect(videos.status, "an admin cannot see the videos they're allowed to reference").toBe(200);

    const limits = await apiAs(page, "GET", "/api/guides/limits");
    expect(limits.status).toBe(200);
  });

  test("an admin cannot delete a video from the library", async ({ page }) => {
    // Referencing is allowed, managing is not. Deletion is the half that
    // affects everyone else's pages.
    const asset = await prisma.guideAsset.create({
      data: {
        kind: "VIDEO",
        r2Key: `guides/library/e2e-${Date.now()}.mp4`,
        contentType: "video/mp4",
        originalFilename: "e2e.mp4",
        sizeBytes: 1024,
        uploadedById: USERS.super,
      },
    });

    try {
      await gotoGuides(page, "admin");
      const res = await apiAs(page, "DELETE", `/api/guides/assets/${asset.id}`);
      expect(res.status, "an admin deleted a video").toBe(403);
      expect(await prisma.guideAsset.findUnique({ where: { id: asset.id } })).not.toBeNull();
    } finally {
      await prisma.guideAsset.deleteMany({ where: { id: asset.id } });
    }
  });

  test("an oversized image is refused outright, with no override offered", async ({ page }) => {
    // The image ceiling is HARD — there is no requiresOverride path for
    // it, unlike video. Admins are many; this is a real limit.
    await gotoGuides(page, "admin");

    const res = await apiAs(page, "POST", "/api/guides/assets/upload-url", {
      filename: "huge.png",
      contentType: "image/png",
      sizeBytes: 500 * 1024 * 1024,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.json?.requiresOverride, "an override was offered for an image").toBeFalsy();
    expect(res.json?.uploadUrl).toBeFalsy();
  });

  test("a disallowed format is refused", async ({ page }) => {
    await gotoGuides(page, "admin");

    const res = await apiAs(page, "POST", "/api/guides/assets/upload-url", {
      filename: "payload.svg",
      contentType: "image/svg+xml",
      sizeBytes: 1024,
    });
    expect(res.status, "an unlisted content type was presigned").toBeGreaterThanOrEqual(400);
    expect(res.json?.uploadUrl).toBeFalsy();
  });
});
