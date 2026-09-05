// ─────────────────────────────────────────────────────────────────────────────
// Education guides — catalog, authoring workflow, and media library.
//
// Canonical spec: docs/features/education.md
//
// THE SHAPE: a Guide is a stable parent row; a GuideVersion is an
// append-only revision; `Guide.currentVersionId` points at the single
// PUBLISHED version workers read. Editing never mutates what is live — it
// creates a new DRAFT that re-enters review while the published version
// keeps serving.
//
// Deliberately mirrors PolicyDocument/PolicyDocumentVersion without
// sharing it: policies carry signatures, compliance state and forced
// re-signing, none of which apply to training material, and a shared table
// would drag those semantics along forever.
//
// VISIBILITY IS A QUERY, NOT A FLAG. A worker's list is scoped by
// `currentVersionId is not null` in the WHERE clause, so an unapproved
// guide is not merely hidden by the client — it cannot be returned.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import { Prisma, PrismaClient, GuideVersionStatus, GuideAssetKind } from "@prisma/client";
import { prisma } from "../db/prisma";
import { ServiceError } from "../lib/errors";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { getUploadUrl, getDownloadUrl, deleteObject, headObject } from "../lib/r2";

type Tx = PrismaClient | Prisma.TransactionClient;

/** Who is asking, and therefore what they may see and do. */
export type GuideViewer =
  | { kind: "worker"; userId: string }
  | { kind: "admin"; userId: string }
  | { kind: "super"; userId: string };

const BUCKET = "guide-media" as const;

// ── Settings ─────────────────────────────────────────────────────────────────

async function readSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function readJsonSetting<T>(key: string, fallback: T): Promise<T> {
  const raw = await readSetting(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readMbSetting(key: string, fallbackMb: number): Promise<number> {
  const raw = await readSetting(key);
  const n = raw == null ? NaN : Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : fallbackMb) * 1024 * 1024;
}

export type GuideCategory = { key: string; label: string };

export async function listCategories(): Promise<GuideCategory[]> {
  return readJsonSetting<GuideCategory[]>("GUIDE_CATEGORIES", []);
}

export type MediaLimits = {
  imageMaxBytes: number;
  videoMaxBytes: number;
  videoHardCeilingBytes: number;
  allowedTypes: string[];
  allowedEmbedDomains: string[];
};

export async function mediaLimits(): Promise<MediaLimits> {
  const [imageMaxBytes, videoMaxBytes, videoHardCeilingBytes, allowedTypes, allowedEmbedDomains] =
    await Promise.all([
      readMbSetting("GUIDE_MAX_IMAGE_MB", 10),
      readMbSetting("GUIDE_MAX_VIDEO_MB", 200),
      readMbSetting("GUIDE_VIDEO_HARD_CEILING_MB", 2048),
      readJsonSetting<string[]>("GUIDE_MEDIA_ALLOWED_TYPES", []),
      readJsonSetting<string[]>("GUIDE_ALLOWED_EMBED_DOMAINS", []),
    ]);
  return { imageMaxBytes, videoMaxBytes, videoHardCeilingBytes, allowedTypes, allowedEmbedDomains };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function digestOf(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/** URL-safe handle derived from the title, uniquified on collision. */
export async function makeSlug(title: string): Promise<string> {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "guide";
  let slug = base;
  for (let i = 2; await prisma.guide.findUnique({ where: { slug } }); i++) {
    slug = `${base}-${i}`;
  }
  return slug;
}

function assertAuthor(viewer: GuideViewer) {
  if (viewer.kind === "worker") {
    throw new ServiceError("FORBIDDEN", "Workers can read guides but not edit them.", 403);
  }
}

function assertSuper(viewer: GuideViewer) {
  if (viewer.kind !== "super") {
    throw new ServiceError("FORBIDDEN", "Only a Super can do that.", 403);
  }
}

/**
 * Assets referenced by a guide's markdown, as `guide-asset:<id>` tokens.
 *
 * The renderer resolves these to signed URLs at read time, so the markdown
 * never contains a URL that can expire. It also makes reference-checking a
 * string search instead of an HTML parse.
 */
export function referencedAssetIds(markdown: string): string[] {
  return [...markdown.matchAll(/guide-asset:([a-z0-9]+)/gi)].map((m) => m[1]);
}

/** Media extensions a bare markdown target may name. Anything else in a link
 *  is prose or an external URL and is left alone. */
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov|m4v)$/i;

/**
 * Asset names a body references, e.g. `![alt](grass-id-chart.png)`.
 *
 * A target counts only when it has no scheme and no path — `image.png`, never
 * `https://…/image.png` or `./assets/image.png`. That keeps an external image
 * URL working as an external image URL.
 */
export function referencedAssetNames(markdown: string): string[] {
  const out = new Set<string>();
  const targets = [
    ...[...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/^:::video\s+(\S+)\s*$/gim)].map((m) => m[1]),
  ];
  for (const t of targets) {
    if (t.includes(":") || t.includes("/")) continue; // scheme or path — not a name
    if (MEDIA_EXT.test(t)) out.add(normalizeAssetName(t));
  }
  return [...out];
}

/**
 * The stored form of an asset name.
 *
 * Lower-cased so `Chart.PNG` and `chart.png` are the same asset — a name-based
 * reference that is case-sensitive would fail in exactly the way that wastes an
 * afternoon. Uniqueness in the database is on this value.
 */
export function normalizeAssetName(name: string): string {
  return name.trim().toLowerCase();
}

/** The name a superseded row keeps: still readable, but no longer the bare
 *  name, so the replacement can take it under the unique index. */
export function supersededName(name: string, assetId: string): string {
  return `${normalizeAssetName(name)}.superseded.${assetId}`;
}

// ── Catalog + read ───────────────────────────────────────────────────────────

/**
 * Which guides this viewer may see at all.
 *
 * A worker only ever sees guides with a published version. Authors also
 * see unpublished ones so they can find their own drafts — but the
 * VERSION they read is still resolved per-role below.
 */
function visibilityWhere(viewer: GuideViewer): Prisma.GuideWhereInput {
  if (viewer.kind === "worker") {
    return { archivedAt: null, currentVersionId: { not: null } };
  }
  return { archivedAt: null };
}

export type GuideListItem = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  categoryKey: string;
  tags: string[];
  isPublished: boolean;
  updatedAt: string;
  /** Author surfaces only — what is waiting on a Super right now. */
  pendingVersionId?: string | null;
  draftVersionId?: string | null;
  /** Sent back by a Super. Without this the catalog shows a rejected guide
   *  as a bare "Not published" and the author has no way to tell it needs
   *  their attention short of opening every unpublished row. */
  rejectedVersionId?: string | null;
};

export async function listGuides(
  viewer: GuideViewer,
  opts?: { q?: string; categoryKey?: string },
): Promise<GuideListItem[]> {
  const q = (opts?.q ?? "").trim();
  const where: Prisma.GuideWhereInput = {
    ...visibilityWhere(viewer),
    ...(opts?.categoryKey ? { categoryKey: opts.categoryKey } : {}),
  };

  // Search across title, summary, tags AND the published body. `contains`
  // rather than Postgres full-text: at catalog scale (tens to hundreds of
  // pages) it is indistinguishable and needs no tsvector column or GIN
  // index. See the spec for the upgrade path.
  if (q) {
    const bodyMatch: Prisma.GuideWhereInput =
      viewer.kind === "worker"
        ? { currentVersion: { contentMarkdown: { contains: q, mode: "insensitive" } } }
        : { versions: { some: { contentMarkdown: { contains: q, mode: "insensitive" } } } };
    where.AND = [
      {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { summary: { contains: q, mode: "insensitive" } },
          { tags: { has: q.toLowerCase() } },
          bodyMatch,
        ],
      },
    ];
  }

  const rows = await prisma.guide.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    include: {
      versions:
        viewer.kind === "worker"
          ? false
          : { select: { id: true, status: true }, orderBy: { versionNumber: "desc" } },
    },
  });

  return rows.map((g) => {
    const versions = (g as { versions?: { id: string; status: GuideVersionStatus }[] }).versions ?? [];
    return {
      id: g.id,
      slug: g.slug,
      title: g.title,
      summary: g.summary,
      categoryKey: g.categoryKey,
      tags: g.tags,
      isPublished: !!g.currentVersionId,
      updatedAt: g.updatedAt.toISOString(),
      ...(viewer.kind === "worker"
        ? {}
        : {
            pendingVersionId:
              versions.find((v) => v.status === "PENDING_APPROVAL")?.id ?? null,
            draftVersionId: versions.find((v) => v.status === "DRAFT")?.id ?? null,
            rejectedVersionId: versions.find((v) => v.status === "REJECTED")?.id ?? null,
          }),
    };
  });
}

export async function getGuide(viewer: GuideViewer, idOrSlug: string) {
  const guide = await prisma.guide.findFirst({
    where: {
      ...visibilityWhere(viewer),
      OR: [{ id: idOrSlug }, { slug: idOrSlug }],
    },
    include: {
      currentVersion: true,
      createdBy: { select: { displayName: true } },
      versions:
        viewer.kind === "worker"
          ? false
          : {
              orderBy: { versionNumber: "desc" },
              include: {
                createdBy: { select: { displayName: true } },
                submittedBy: { select: { displayName: true } },
                approvedBy: { select: { displayName: true } },
                publishedBy: { select: { displayName: true } },
                rejectedBy: { select: { displayName: true } },
              },
            },
    },
  });
  if (!guide) throw new ServiceError("NOT_FOUND", "Guide not found.", 404);
  // `isPublished` is derived, and the list endpoint already returns it.
  // Without it here the detail payload silently lacked the field while the
  // client type promised it, so every `guide.isPublished` check read as
  // false: the Unpublish button never rendered, the archive confirm
  // dropped its "workers are reading this right now" warning, and the
  // author status strip rendered as an empty orange box on every guide.
  return { ...guide, isPublished: !!guide.currentVersionId };
}

/** Versions awaiting a Super. Drives the alert badge + Tasks section. */
export async function listPendingApprovals() {
  return prisma.guideVersion.findMany({
    where: { status: "PENDING_APPROVAL", guide: { archivedAt: null } },
    orderBy: { submittedAt: "asc" },
    include: {
      guide: { select: { id: true, slug: true, title: true } },
      submittedBy: { select: { displayName: true } },
    },
  });
}

export async function pendingApprovalCount(): Promise<number> {
  return prisma.guideVersion.count({
    where: { status: "PENDING_APPROVAL", guide: { archivedAt: null } },
  });
}

// ── Authoring workflow ───────────────────────────────────────────────────────

export async function createGuide(
  viewer: GuideViewer,
  input: { title: string; summary?: string | null; categoryKey: string; tags?: string[] },
) {
  assertAuthor(viewer);
  // Guard the type as well as emptiness: the body is passed through
  // unvalidated (`createGuide(viewer, req.body ?? {})`), so a missing title
  // would otherwise throw a TypeError and surface as a 500.
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new ServiceError("BAD_REQUEST", "Title is required.", 400);

  const cats = await listCategories();
  if (cats.length && !cats.some((c) => c.key === input.categoryKey)) {
    throw new ServiceError("BAD_REQUEST", "Unknown category.", 400);
  }

  const slug = await makeSlug(title);
  return prisma.$transaction(async (tx) => {
    const guide = await tx.guide.create({
      data: {
        slug,
        title,
        summary: input.summary?.trim() || null,
        categoryKey: input.categoryKey,
        tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
        createdById: viewer.userId,
        versions: {
          create: {
            versionNumber: 1,
            contentMarkdown: "",
            contentDigest: digestOf(""),
            changeNote: "Initial draft",
            status: "DRAFT",
            createdById: viewer.userId,
          },
        },
      },
      include: { versions: true },
    });
    await writeAudit(tx, AUDIT.GUIDE.CREATED, viewer.userId, {
      guideId: guide.id,
      slug,
      title,
      categoryKey: input.categoryKey,
    });
    return guide;
  });
}

/** Catalog metadata only — the body lives on versions and goes through review. */
export async function updateGuideMeta(
  viewer: GuideViewer,
  guideId: string,
  input: { title?: string; summary?: string | null; categoryKey?: string; tags?: string[] },
) {
  assertAuthor(viewer);
  const before = await prisma.guide.findUnique({ where: { id: guideId } });
  if (!before) throw new ServiceError("NOT_FOUND", "Guide not found.", 404);

  // The same two rules `createGuide` enforces. They were missing here, so
  // the edit path was a back door around both: a guide could be renamed
  // to "" (rendering a blank row in the catalog) or moved into a category
  // that does not exist in GUIDE_CATEGORIES (grouping it under a heading
  // that falls back to the raw key). Validate on every path that writes
  // the field, not just the one that creates it.
  if (input.title !== undefined && !input.title.trim()) {
    throw new ServiceError("BAD_REQUEST", "Title is required.", 400);
  }
  if (input.categoryKey !== undefined) {
    const cats = await listCategories();
    if (cats.length && !cats.some((c) => c.key === input.categoryKey)) {
      throw new ServiceError("BAD_REQUEST", "Unknown category.", 400);
    }
  }

  return prisma.$transaction(async (tx) => {
    const guide = await tx.guide.update({
      where: { id: guideId },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
        ...(input.categoryKey !== undefined ? { categoryKey: input.categoryKey } : {}),
        ...(input.tags !== undefined
          ? { tags: input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean) }
          : {}),
      },
    });
    await writeAudit(tx, AUDIT.GUIDE.UPDATED, viewer.userId, {
      guideId,
      before: { title: before.title, summary: before.summary, categoryKey: before.categoryKey, tags: before.tags },
      after: { title: guide.title, summary: guide.summary, categoryKey: guide.categoryKey, tags: guide.tags },
    });
    return guide;
  });
}

/**
 * Write the working draft.
 *
 * Reuses an existing DRAFT if there is one, otherwise opens the next
 * version number. Never touches a PUBLISHED version — that is what keeps
 * what a worker is reading stable while someone edits.
 */
export async function saveDraft(
  viewer: GuideViewer,
  guideId: string,
  input: { contentMarkdown: string; changeNote?: string },
) {
  assertAuthor(viewer);
  const guide = await prisma.guide.findUnique({
    where: { id: guideId },
    include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
  });
  if (!guide) throw new ServiceError("NOT_FOUND", "Guide not found.", 404);

  const existingDraft = await prisma.guideVersion.findFirst({
    where: { guideId, status: { in: ["DRAFT", "REJECTED"] } },
    orderBy: { versionNumber: "desc" },
  });

  return prisma.$transaction(async (tx) => {
    const version = existingDraft
      ? await tx.guideVersion.update({
          where: { id: existingDraft.id },
          data: {
            contentMarkdown: input.contentMarkdown,
            contentDigest: digestOf(input.contentMarkdown),
            ...(input.changeNote !== undefined ? { changeNote: input.changeNote } : {}),
            // A rejected version being edited becomes a fresh draft again.
            status: "DRAFT",
            rejectedAt: null,
            rejectedById: null,
            rejectionNote: null,
          },
        })
      : await tx.guideVersion.create({
          data: {
            guideId,
            versionNumber: (guide.versions[0]?.versionNumber ?? 0) + 1,
            contentMarkdown: input.contentMarkdown,
            contentDigest: digestOf(input.contentMarkdown),
            changeNote: input.changeNote ?? "",
            status: "DRAFT",
            createdById: viewer.userId,
          },
        });
    // audit-allow: bumps updatedAt so the catalog sorts by recency. The
    // draft write above already carries the GUIDE.UPDATED row for this edit.
    await tx.guide.update({ where: { id: guideId }, data: { updatedAt: new Date() } });
    await writeAudit(tx, AUDIT.GUIDE.UPDATED, viewer.userId, {
      guideId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      digest: version.contentDigest,
    });
    return version;
  });
}

/**
 * Throw away an unsubmitted draft.
 *
 * Two shapes, because a draft means different things depending on whether
 * the guide has ever been readable:
 *
 *   - The guide HAS other versions -> delete just the draft. Whatever was
 *     published stays published; this is "cancel my edit".
 *   - The draft is the ONLY version -> there is no guide without it, so the
 *     guide goes too. Otherwise the operator is left with an empty shell
 *     they can only remove by archiving it first.
 *
 * Accepts DRAFT and REJECTED, mirroring submitForApproval — both are the
 * author's to act on, and a rejected draft is exactly the thing you'd want
 * to throw away. The rejection itself stays on the record: it was audited
 * as GUIDE.REJECTED when it happened.
 *
 * Not available once submitted — a PENDING_APPROVAL version is sitting in
 * someone else's queue and is withdrawn by rejection, not deletion.
 */
export async function discardDraft(viewer: GuideViewer, versionId: string) {
  assertAuthor(viewer);
  const version = await prisma.guideVersion.findUnique({
    where: { id: versionId },
    include: { guide: { include: { versions: { select: { id: true } } } } },
  });
  if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
  if (version.status !== "DRAFT" && version.status !== "REJECTED") {
    throw new ServiceError(
      "BAD_STATE",
      version.status === "PENDING_APPROVAL"
        ? "This is awaiting approval — a Super has to reject it before it can be discarded."
        : "Only an unsubmitted draft can be discarded.",
      400,
    );
  }
  const guide = version.guide;
  const isOnlyVersion = guide.versions.length === 1;

  return prisma.$transaction(async (tx) => {
    // Snapshot BEFORE deleting — the audit row is the only remaining record.
    await writeAudit(tx, AUDIT.GUIDE.DRAFT_DISCARDED, viewer.userId, {
      guideId: guide.id,
      versionId,
      versionNumber: version.versionNumber,
      guideDeleted: isOnlyVersion,
      snapshot: {
        title: guide.title,
        slug: guide.slug,
        changeNote: version.changeNote,
        contentDigest: version.contentDigest,
        contentMarkdown: version.contentMarkdown,
      },
    });
    // Never leave the guide pointing at a row that is about to disappear.
    if (guide.currentVersionId === versionId) {
      // audit-allow: GUIDE.DRAFT_DISCARDED above snapshots the version and
      // records whether the guide goes with it.
      await tx.guide.update({ where: { id: guide.id }, data: { currentVersionId: null } });
    }
    // audit-allow: see above — part of the discard, snapshotted first.
    await tx.guideVersion.delete({ where: { id: versionId } });
    if (isOnlyVersion) {
      // Assets live in the shared library and may be referenced elsewhere —
      // detach rather than cascade-delete, same as purge().
      // audit-allow: see above — part of the discard, snapshotted first.
      await tx.guideAsset.updateMany({ where: { guideId: guide.id }, data: { guideId: null } });
      // audit-allow: see above — part of the discard, snapshotted first.
      await tx.guide.delete({ where: { id: guide.id } });
    }
    return { guideDeleted: isOnlyVersion };
  });
}

export async function submitForApproval(viewer: GuideViewer, versionId: string) {
  assertAuthor(viewer);
  const version = await prisma.guideVersion.findUnique({
    where: { id: versionId },
    include: { guide: true },
  });
  if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
  if (version.status !== "DRAFT" && version.status !== "REJECTED") {
    throw new ServiceError("BAD_STATE", "Only a draft can be submitted.", 400);
  }
  if (!version.contentMarkdown.trim()) {
    throw new ServiceError("BAD_REQUEST", "Nothing to submit — the page is empty.", 400);
  }
  if (!version.changeNote.trim()) {
    throw new ServiceError(
      "BAD_REQUEST",
      "Describe what changed — the approver sees this instead of diffing by eye.",
      400,
    );
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.guideVersion.update({
      where: { id: versionId },
      data: { status: "PENDING_APPROVAL", submittedAt: new Date(), submittedById: viewer.userId },
    });
    await writeAudit(tx, AUDIT.GUIDE.SUBMITTED, viewer.userId, {
      guideId: version.guideId,
      versionId,
      versionNumber: version.versionNumber,
      changeNote: version.changeNote,
    });
    return updated;
  });
}

/**
 * Approve AND publish in one step.
 *
 * Policies split these because a policy version can be approved but held
 * back behind a grace period. A guide has no such need, and a two-step
 * flow would leave APPROVED versions sitting invisible to everyone —
 * approved but not readable is a state nobody asked for.
 */
export async function approveAndPublish(viewer: GuideViewer, versionId: string) {
  assertSuper(viewer);
  const version = await prisma.guideVersion.findUnique({
    where: { id: versionId },
    include: { guide: true },
  });
  if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
  if (version.status !== "PENDING_APPROVAL") {
    throw new ServiceError("BAD_STATE", "Only a pending version can be approved.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const updated = await tx.guideVersion.update({
      where: { id: versionId },
      data: {
        status: "PUBLISHED",
        approvedAt: now,
        approvedById: viewer.userId,
        publishedAt: now,
        publishedById: viewer.userId,
      },
    });
    // Demote whatever was live. Kept as ROLLED_BACK rather than deleted so
    // the history stays readable and a rollback target still exists.
    if (version.guide.currentVersionId && version.guide.currentVersionId !== versionId) {
      // audit-allow: demoting the outgoing version is part of publishing,
      // and GUIDE.PUBLISHED below records it as `replacedVersionId`.
      await tx.guideVersion.update({
        where: { id: version.guide.currentVersionId },
        data: { status: "ROLLED_BACK" },
      });
    }
    // audit-allow: moving the pointer IS the publish; GUIDE.PUBLISHED below
    // is that row.
    await tx.guide.update({ where: { id: version.guideId }, data: { currentVersionId: versionId } });
    await writeAudit(tx, AUDIT.GUIDE.APPROVED, viewer.userId, {
      guideId: version.guideId,
      versionId,
      versionNumber: version.versionNumber,
      submittedById: version.submittedById,
    });
    await writeAudit(tx, AUDIT.GUIDE.PUBLISHED, viewer.userId, {
      guideId: version.guideId,
      versionId,
      versionNumber: version.versionNumber,
      replacedVersionId: version.guide.currentVersionId,
    });
    return updated;
  });
}

export async function rejectVersion(viewer: GuideViewer, versionId: string, note: string) {
  assertSuper(viewer);
  if (!note.trim()) {
    throw new ServiceError("BAD_REQUEST", "Say why — a bare rejection tells the author nothing.", 400);
  }
  const version = await prisma.guideVersion.findUnique({ where: { id: versionId } });
  if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
  if (version.status !== "PENDING_APPROVAL") {
    throw new ServiceError("BAD_STATE", "Only a pending version can be rejected.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.guideVersion.update({
      where: { id: versionId },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectedById: viewer.userId,
        rejectionNote: note.trim(),
      },
    });
    await writeAudit(tx, AUDIT.GUIDE.REJECTED, viewer.userId, {
      guideId: version.guideId,
      versionId,
      versionNumber: version.versionNumber,
      note: note.trim(),
    });
    return updated;
  });
}

/** Pull a guide out of the catalog without destroying anything. */
export async function unpublish(viewer: GuideViewer, guideId: string) {
  assertSuper(viewer);
  const guide = await prisma.guide.findUnique({ where: { id: guideId } });
  if (!guide?.currentVersionId) {
    throw new ServiceError("BAD_STATE", "That guide is not published.", 400);
  }
  return prisma.$transaction(async (tx) => {
    // audit-allow: clearing the pointer IS the unpublish; the row follows.
    await tx.guide.update({ where: { id: guideId }, data: { currentVersionId: null } });
    await writeAudit(tx, AUDIT.GUIDE.UNPUBLISHED, viewer.userId, {
      guideId,
      versionId: guide.currentVersionId,
    });
  });
}

/** Make a previously published version live again. */
export async function rollbackTo(viewer: GuideViewer, versionId: string) {
  assertSuper(viewer);
  const version = await prisma.guideVersion.findUnique({
    where: { id: versionId },
    include: { guide: true },
  });
  if (!version) throw new ServiceError("NOT_FOUND", "Version not found.", 404);
  if (version.status !== "ROLLED_BACK" && version.status !== "PUBLISHED") {
    throw new ServiceError("BAD_STATE", "Only a previously published version can be restored.", 400);
  }
  return prisma.$transaction(async (tx) => {
    if (version.guide.currentVersionId && version.guide.currentVersionId !== versionId) {
      // audit-allow: the three writes here are one action. GUIDE.ROLLED_BACK
      // below records both the restored and the replaced version.
      await tx.guideVersion.update({
        where: { id: version.guide.currentVersionId },
        data: { status: "ROLLED_BACK" },
      });
    }
    // audit-allow: see above — part of the single rollback action.
    await tx.guideVersion.update({ where: { id: versionId }, data: { status: "PUBLISHED" } });
    // audit-allow: see above — part of the single rollback action.
    await tx.guide.update({ where: { id: version.guideId }, data: { currentVersionId: versionId } });
    await writeAudit(tx, AUDIT.GUIDE.ROLLED_BACK, viewer.userId, {
      guideId: version.guideId,
      versionId,
      versionNumber: version.versionNumber,
      replacedVersionId: version.guide.currentVersionId,
    });
  });
}

export async function setArchived(viewer: GuideViewer, guideId: string, archived: boolean) {
  assertSuper(viewer);
  const guide = await prisma.guide.findUnique({ where: { id: guideId } });
  if (!guide) throw new ServiceError("NOT_FOUND", "Guide not found.", 404);
  return prisma.$transaction(async (tx) => {
    await tx.guide.update({
      where: { id: guideId },
      data: archived
        ? { archivedAt: new Date(), archivedById: viewer.userId, currentVersionId: null }
        : { archivedAt: null, archivedById: null },
    });
    await writeAudit(
      tx,
      archived ? AUDIT.GUIDE.ARCHIVED : AUDIT.GUIDE.UNARCHIVED,
      viewer.userId,
      { guideId, title: guide.title },
    );
  });
}

/**
 * Irreversible. Destroys the guide, every version, and unlinks its assets.
 *
 * Only allowed on an ALREADY-ARCHIVED guide, so nobody reaches this from a
 * live catalog by mis-clicking, and the audit row carries a full snapshot
 * because afterwards it is the only record the guide ever existed.
 */
export async function purge(viewer: GuideViewer, guideId: string) {
  assertSuper(viewer);
  const guide = await prisma.guide.findUnique({
    where: { id: guideId },
    include: { versions: { orderBy: { versionNumber: "asc" } }, assets: true },
  });
  if (!guide) throw new ServiceError("NOT_FOUND", "Guide not found.", 404);
  if (!guide.archivedAt) {
    throw new ServiceError(
      "BAD_STATE",
      "Archive the guide first. Permanent deletion is only available on an archived guide.",
      400,
    );
  }

  return prisma.$transaction(async (tx) => {
    await writeAudit(tx, AUDIT.GUIDE.PURGED, viewer.userId, {
      guideId,
      snapshot: {
        slug: guide.slug,
        title: guide.title,
        summary: guide.summary,
        categoryKey: guide.categoryKey,
        tags: guide.tags,
        createdById: guide.createdById,
        createdAt: guide.createdAt.toISOString(),
        versions: guide.versions.map((v) => ({
          versionNumber: v.versionNumber,
          status: v.status,
          changeNote: v.changeNote,
          contentDigest: v.contentDigest,
          contentMarkdown: v.contentMarkdown,
          createdById: v.createdById,
          createdAt: v.createdAt.toISOString(),
        })),
        assetIds: guide.assets.map((a) => a.id),
      },
    });
    // Assets survive the guide — they live in the library and may be
    // referenced elsewhere. Detach rather than cascade-delete.
    // audit-allow: GUIDE.PURGED above snapshots the guide, every version and
    // the asset ids BEFORE any of these run — that row is the whole record.
    await tx.guideAsset.updateMany({ where: { guideId }, data: { guideId: null } });
    // audit-allow: see above — part of the purge, snapshotted first.
    await tx.guide.update({ where: { id: guideId }, data: { currentVersionId: null } });
    // audit-allow: see above — part of the purge, snapshotted first.
    await tx.guideVersion.deleteMany({ where: { guideId } });
    // audit-allow: see above — part of the purge, snapshotted first.
    await tx.guide.delete({ where: { id: guideId } });
  });
}

// ── Media library ────────────────────────────────────────────────────────────
//
// Assets are IMMUTABLE. There is no replace-in-place, because a published
// page's media would otherwise change without an approver ever seeing it —
// the approval gate would quietly become advisory. "Replacing" an image
// means uploading a new asset and editing the page, which re-enters review.
//
// Video is SUPER-ONLY. It is the one asset class that can silently become
// expensive, and the one with a format trap (phones record HEVC .mov,
// which desktop Chrome and Firefox often will not play). Concentrating it
// in one uploader means that is learned once rather than repeatedly.

export function kindForContentType(contentType: string): GuideAssetKind | null {
  if (contentType.startsWith("image/")) return "IMAGE";
  if (contentType.startsWith("video/")) return "VIDEO";
  return null;
}

/** Formats that play everywhere vs. formats that play where they were made. */
export function playbackWarningFor(contentType: string, filename: string): string | null {
  const lower = filename.toLowerCase();
  if (contentType === "video/quicktime" || lower.endsWith(".mov")) {
    return (
      "This is a QuickTime/.mov file. Phones record these as HEVC, which Safari " +
      "plays but desktop Chrome and Firefox often will not — some workers may see " +
      "a black box. Export as MP4 (H.264), or on iPhone set Camera → Formats → " +
      "Most Compatible."
    );
  }
  return null;
}

export type PresignResult = {
  uploadUrl: string;
  r2Key: string;
  /** Non-blocking advice shown before the upload starts. */
  warning: string | null;
  /** True when the Super must explicitly confirm an over-size video. */
  requiresOverride: boolean;
};

export async function presignAssetUpload(
  viewer: GuideViewer,
  input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
    guideId?: string | null;
    overrideSizeLimit?: boolean;
  },
): Promise<PresignResult> {
  assertAuthor(viewer);
  const kind = kindForContentType(input.contentType);
  if (!kind) throw new ServiceError("BAD_REQUEST", "Only images and video can be uploaded.", 400);

  if (kind === "VIDEO" && viewer.kind !== "super") {
    throw new ServiceError(
      "FORBIDDEN",
      "Only a Super can add video. You can reference any video already in the library.",
      403,
    );
  }

  const limits = await mediaLimits();
  if (limits.allowedTypes.length && !limits.allowedTypes.includes(input.contentType)) {
    throw new ServiceError(
      "BAD_REQUEST",
      `${input.contentType} isn't an allowed format. Allowed: ${limits.allowedTypes.join(", ")}.`,
      400,
    );
  }

  if (kind === "IMAGE") {
    // HARD limit. Admins are many, so this is a real ceiling.
    if (input.sizeBytes > limits.imageMaxBytes) {
      throw new ServiceError(
        "TOO_LARGE",
        `Image is larger than the ${Math.round(limits.imageMaxBytes / 1024 / 1024)} MB limit.`,
        400,
      );
    }
  } else {
    // Absolute cap first — an override protects against "bigger than
    // usual", not against selecting the wrong file entirely.
    if (input.sizeBytes > limits.videoHardCeilingBytes) {
      throw new ServiceError(
        "TOO_LARGE",
        `Video exceeds the hard ceiling of ${Math.round(limits.videoHardCeilingBytes / 1024 / 1024)} MB. That is not overridable — check you picked the right file.`,
        400,
      );
    }
    if (input.sizeBytes > limits.videoMaxBytes && !input.overrideSizeLimit) {
      return {
        uploadUrl: "",
        r2Key: "",
        warning: `This video is ${Math.round(input.sizeBytes / 1024 / 1024)} MB, over the ${Math.round(limits.videoMaxBytes / 1024 / 1024)} MB guideline.`,
        requiresOverride: true,
      };
    }
  }

  // Fail with something an operator can act on. Without this the missing
  // env var surfaces as an opaque AWS SDK error from deep inside the
  // presign call, which reads like a broken feature rather than an
  // unfinished setup step. Checked LAST so a genuinely bad request still
  // gets its own precise error instead of being masked by this one.
  if (!process.env.R2_GUIDE_MEDIA_BUCKET_NAME) {
    throw new ServiceError(
      "NOT_CONFIGURED",
      "Guide media storage isn't set up yet — R2_GUIDE_MEDIA_BUCKET_NAME is unset. See docs/features/education.md.",
      503,
    );
  }

  const ext = (input.filename.split(".").pop() ?? "bin").toLowerCase().slice(0, 8);
  const r2Key = `guides/${input.guideId ?? "library"}/${crypto.randomUUID()}.${ext}`;
  const uploadUrl = await getUploadUrl(r2Key, input.contentType, 900, BUCKET);

  return {
    uploadUrl,
    r2Key,
    warning: playbackWarningFor(input.contentType, input.filename),
    requiresOverride: false,
  };
}

/**
 * Published guides that display a given asset, by id OR by name.
 *
 * Used to tell an author what replacing an image would actually change before
 * they confirm it — "3 published guides show this" is the difference between
 * an informed choice and a blind one.
 */
async function guidesUsingAsset(
  assetId: string,
  filename: string,
): Promise<Array<{ id: string; title: string; slug: string }>> {
  return prisma.guide.findMany({
    where: {
      archivedAt: null,
      currentVersion: {
        OR: [
          { contentMarkdown: { contains: `guide-asset:${assetId}` } },
          { contentMarkdown: { contains: filename } },
        ],
      },
    },
    select: { id: true, title: true, slug: true },
    take: 20,
  });
}

/**
 * Record the asset AFTER the bytes have landed.
 *
 * Reads the true size back from R2 rather than trusting the browser: a
 * presigned PUT is signed on content-type only, so the declared size is
 * unenforceable. Storing an unverified number as metadata is how a figure
 * ends up wrong for a year without anyone noticing.
 */
export async function finalizeAsset(
  viewer: GuideViewer,
  input: {
    r2Key: string;
    contentType: string;
    originalFilename: string;
    altText?: string | null;
    guideId?: string | null;
    overrodeSizeLimit?: boolean;
    /**
     * Take over the name held by this asset.
     *
     * Names are unique because guides reference them, so an upload that
     * reuses one is rejected with NAME_TAKEN and the details of the holder.
     * The UI turns that into "update the existing image, or cancel"; choosing
     * update sends the id back here.
     */
    replaceAssetId?: string | null;
  },
) {
  assertAuthor(viewer);
  const kind = kindForContentType(input.contentType);
  if (!kind) throw new ServiceError("BAD_REQUEST", "Unsupported media type.", 400);
  if (kind === "VIDEO" && viewer.kind !== "super") {
    throw new ServiceError("FORBIDDEN", "Only a Super can add video.", 403);
  }

  const head = await headObject(input.r2Key, BUCKET);
  if (!head) {
    throw new ServiceError("BAD_STATE", "That upload didn't complete — try again.", 400);
  }

  const limits = await mediaLimits();
  const overLimit =
    kind === "IMAGE" ? head.sizeBytes > limits.imageMaxBytes : head.sizeBytes > limits.videoMaxBytes;
  const overCeiling = kind === "VIDEO" && head.sizeBytes > limits.videoHardCeilingBytes;

  // The declared size can be wrong (a bug, or a client that lied). If what
  // actually landed breaks a HARD rule, delete it rather than keep it.
  if (overCeiling || (kind === "IMAGE" && overLimit)) {
    await deleteObject(input.r2Key, BUCKET).catch(() => {});
    throw new ServiceError(
      "TOO_LARGE",
      "The uploaded file is larger than allowed and has been discarded.",
      400,
    );
  }

  // ── The name is the handle, so it has to be free ──────────────────────────
  const name = normalizeAssetName(input.originalFilename);
  const holder = await prisma.guideAsset.findFirst({
    where: { originalFilename: name, supersededAt: null },
    select: { id: true, originalFilename: true, sizeBytes: true, uploadedAt: true, kind: true },
  });
  if (holder && holder.id !== input.replaceAssetId) {
    // Discard the bytes we just accepted: keeping them would leave an orphan
    // in the bucket that nothing can ever reference.
    await deleteObject(input.r2Key, BUCKET).catch(() => {});
    throw new ServiceError(
      "NAME_TAKEN",
      `"${name}" is already used by another image.`,
      409,
      {
        id: holder.id,
        filename: holder.originalFilename,
        kind: holder.kind,
        sizeBytes: holder.sizeBytes,
        uploadedAt: holder.uploadedAt,
        // What replacing would actually change, so the prompt isn't a blind
        // yes/no — a published guide showing new media without an approver
        // seeing it is the tradeoff being made here.
        publishedGuides: await guidesUsingAsset(holder.id, holder.originalFilename),
      },
    );
  }

  return prisma.$transaction(async (tx) => {
    if (holder) {
      // Supersede rather than delete. The old row and its object stay as the
      // record of what a published page used to show; only the NAME moves.
      await tx.guideAsset.update({
        where: { id: holder.id },
        data: {
          originalFilename: supersededName(holder.originalFilename, holder.id),
          supersededAt: new Date(),
        },
      });
    }
    const asset = await tx.guideAsset.create({
      data: {
        kind,
        r2Key: input.r2Key,
        contentType: head.contentType ?? input.contentType,
        originalFilename: name,
        sizeBytes: head.sizeBytes,
        altText: input.altText?.trim() || null,
        sizeOverride: !!overLimit,
        guideId: input.guideId ?? null,
        uploadedById: viewer.userId,
      },
    });
    await writeAudit(tx, AUDIT.GUIDE_ASSET.CREATED, viewer.userId, {
      assetId: asset.id,
      kind,
      sizeBytes: head.sizeBytes,
      contentType: asset.contentType,
      guideId: input.guideId ?? null,
      filename: name,
      // Snapshot what was displaced. Every guide referencing this name now
      // shows different media, and this row is the only place that is recorded.
      replacedAssetId: holder?.id ?? null,
      replacedSizeBytes: holder?.sizeBytes ?? null,
    });
    if (holder) {
      await tx.guideAsset.update({
        where: { id: holder.id },
        data: { supersededById: asset.id },
      });
    }
    if (overLimit) {
      await writeAudit(tx, AUDIT.GUIDE_ASSET.SIZE_LIMIT_OVERRIDDEN, viewer.userId, {
        assetId: asset.id,
        kind,
        sizeBytes: head.sizeBytes,
        limitBytes: kind === "IMAGE" ? limits.imageMaxBytes : limits.videoMaxBytes,
      });
    }
    return asset;
  });
}

export const GUIDE_ASSET_PAGE_SIZE = 20;

/**
 * Paged, because this list only ever grows.
 *
 * Every guide that has ever used an image keeps that asset alive — they
 * are immutable and reference-checked before deletion — so the library is
 * an append-mostly log. Returning all of it meant the payload, and the
 * row count on screen, grew without bound. `{ items, total }` with
 * page/pageSize matches audit.ts and the expenses tab.
 */
export async function listAssets(
  viewer: GuideViewer,
  opts?: { kind?: GuideAssetKind; q?: string; page?: number; pageSize?: number },
): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(opts?.pageSize ?? GUIDE_ASSET_PAGE_SIZE, 1), 100);
  const page = Math.max(opts?.page ?? 1, 1);

  const where: Prisma.GuideAssetWhereInput = {
    ...(opts?.kind ? { kind: opts.kind } : {}),
    ...(opts?.q
      ? {
          OR: [
            { originalFilename: { contains: opts.q, mode: "insensitive" } },
            { altText: { contains: opts.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  // Workers never reach the library UI, but read access is harmless and
  // keeps the guard in one place: authorship is what is gated, not sight.
  const [rows, total] = await Promise.all([
    prisma.guideAsset.findMany({
      where,
      orderBy: { uploadedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { uploadedBy: { select: { id: true, displayName: true } } },
    }),
    prisma.guideAsset.count({ where }),
  ]);

  const items = rows.map((a) => ({
    id: a.id,
    kind: a.kind,
    contentType: a.contentType,
    originalFilename: a.originalFilename,
    sizeBytes: a.sizeBytes,
    altText: a.altText,
    sizeOverride: a.sizeOverride,
    uploadedAt: a.uploadedAt.toISOString(),
    uploadedById: a.uploadedById,
    uploadedByName: a.uploadedBy.displayName,
    /** Whether THIS viewer may delete it — drives the UI affordance. */
    canManage: viewer.kind === "super" || a.uploadedById === viewer.userId,
  }));

  return { items, total, page, pageSize };
}

/** Signed URL for rendering. Short-lived; never stored in markdown. */
/**
 * Signed URL for an in-app image or video.
 *
 * Scoped for workers: the asset must appear in the body of a guide they
 * can actually read. Every other worker-facing read in this file is a
 * WHERE clause; this one was the exception, resting on asset ids being
 * unguessable cuids. That is a capability URL, not access control — and
 * the ids are not secret, they sit in plain sight inside the markdown of
 * any guide the caller can already fetch. A worker could hold on to an
 * id from a guide that was later unpublished and keep pulling the media.
 *
 * Authors are exempt: previewing a draft requires seeing the draft's own
 * images, which by definition are not in any published body yet.
 */
export async function assetUrl(viewer: GuideViewer, assetId: string): Promise<string> {
  const asset = await prisma.guideAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new ServiceError("NOT_FOUND", "Asset not found.", 404);

  if (viewer.kind === "worker") {
    const referenced = await prisma.guide.findFirst({
      where: {
        ...visibilityWhere(viewer),
        currentVersion: { contentMarkdown: { contains: `guide-asset:${assetId}` } },
      },
      select: { id: true },
    });
    // Same 404 as a missing asset — a worker must not be able to tell
    // "no such asset" from "an asset you may not see".
    if (!referenced) throw new ServiceError("NOT_FOUND", "Asset not found.", 404);
  }

  return getDownloadUrl(asset.r2Key, 3600, BUCKET, {
    mode: "inline",
    filename: asset.originalFilename,
  });
}

/**
 * Resolve one markdown reference — an id OR a bare filename — to a signed URL.
 *
 * The name path deliberately excludes superseded rows: a replaced image must
 * stop resolving, or "update the existing image" would silently do nothing.
 */
export async function assetUrlByRef(
  viewer: GuideViewer,
  ref: string,
): Promise<{ id: string; url: string }> {
  const byId = /^guide-asset:([a-z0-9]+)$/i.exec(ref.trim());
  if (byId) return { id: byId[1], url: await assetUrl(viewer, byId[1]) };

  const name = normalizeAssetName(ref);
  const asset = await prisma.guideAsset.findFirst({
    where: { originalFilename: name, supersededAt: null },
    select: { id: true, r2Key: true, originalFilename: true },
  });
  if (!asset) throw new ServiceError("NOT_FOUND", "Asset not found.", 404);

  if (viewer.kind === "worker") {
    // Same rule as the id path: a worker may only fetch media a guide they
    // can actually see references. Identical 404 either way, so "no such
    // asset" and "an asset you may not see" stay indistinguishable.
    const referenced = await prisma.guide.findFirst({
      where: {
        ...visibilityWhere(viewer),
        currentVersion: {
          OR: [
            { contentMarkdown: { contains: name } },
            { contentMarkdown: { contains: `guide-asset:${asset.id}` } },
          ],
        },
      },
      select: { id: true },
    });
    if (!referenced) throw new ServiceError("NOT_FOUND", "Asset not found.", 404);
  }

  return {
    id: asset.id,
    url: await getDownloadUrl(asset.r2Key, 3600, BUCKET, {
      mode: "inline",
      filename: asset.originalFilename,
    }),
  };
}

/** Guides whose markdown still references an asset, in ANY live version. */
/**
 * Resolve `guide:<slug>` cross-reference tokens to the guides they name.
 *
 * Scoped by the SAME `visibilityWhere` as the catalog, which is the whole
 * point: a published guide may link to one that is still in draft, and a
 * worker must not learn that the draft exists — not its title, not that
 * the slug resolves to anything. Unresolvable slugs are simply absent
 * from the result and the renderer degrades to plain text.
 *
 * Authors DO get unpublished targets back, flagged, so they can see a
 * link is not yet live before submitting for approval.
 */
export async function resolveGuideLinks(
  viewer: GuideViewer,
  slugs: string[],
): Promise<Array<{ slug: string; id: string; title: string; isPublished: boolean }>> {
  const wanted = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))].slice(0, 100);
  if (wanted.length === 0) return [];
  const rows = await prisma.guide.findMany({
    where: { ...visibilityWhere(viewer), slug: { in: wanted } },
    select: { id: true, slug: true, title: true, currentVersionId: true },
  });
  return rows.map((g) => ({
    slug: g.slug,
    id: g.id,
    title: g.title,
    isPublished: !!g.currentVersionId,
  }));
}

/**
 * Guides whose body links TO this one.
 *
 * Unlike an asset reference, an inbound guide link is not a hard block —
 * a link that stops resolving degrades to plain text rather than breaking
 * the page. It is a warning, so a Super unpublishing something can see
 * they are about to blank a cross-reference in three other guides.
 */
export async function guidesLinkingTo(slug: string) {
  const versions = await prisma.guideVersion.findMany({
    where: {
      contentMarkdown: { contains: `guide:${slug}` },
      guide: { archivedAt: null, slug: { not: slug } },
    },
    select: { guide: { select: { id: true, title: true, slug: true } } },
  });
  const seen = new Map<string, { id: string; title: string; slug: string }>();
  for (const v of versions) seen.set(v.guide.id, v.guide);
  return [...seen.values()];
}

export async function guidesReferencing(assetId: string) {
  const versions = await prisma.guideVersion.findMany({
    where: {
      contentMarkdown: { contains: `guide-asset:${assetId}` },
      guide: { archivedAt: null },
    },
    select: { guide: { select: { id: true, title: true, slug: true } } },
  });
  const seen = new Map<string, { id: string; title: string; slug: string }>();
  for (const v of versions) seen.set(v.guide.id, v.guide);
  return [...seen.values()];
}

/**
 * Delete an asset, refusing when a guide still points at it.
 *
 * Assets are managed separately from pages, so without this someone
 * eventually deletes the image a live guide uses and a worker standing in
 * a field gets a broken page. A Super deleting a video especially needs
 * telling, since they may not have written the page that uses it.
 */
export async function deleteAsset(viewer: GuideViewer, assetId: string) {
  assertAuthor(viewer);
  const asset = await prisma.guideAsset.findUnique({ where: { id: assetId } });
  if (!asset) throw new ServiceError("NOT_FOUND", "Asset not found.", 404);

  if (viewer.kind !== "super" && asset.uploadedById !== viewer.userId) {
    throw new ServiceError("FORBIDDEN", "You can only manage media you uploaded.", 403);
  }
  if (asset.kind === "VIDEO" && viewer.kind !== "super") {
    throw new ServiceError("FORBIDDEN", "Only a Super can manage video.", 403);
  }

  const users = await guidesReferencing(assetId);
  if (users.length) {
    throw new ServiceError(
      "IN_USE",
      `Still used by ${users.length} guide${users.length === 1 ? "" : "s"}: ${users
        .map((g) => g.title)
        .join(", ")}. Remove the reference first.`,
      409,
      { guides: users },
    );
  }

  await prisma.$transaction(async (tx) => {
    await writeAudit(tx, AUDIT.GUIDE_ASSET.DELETED, viewer.userId, {
      assetId,
      kind: asset.kind,
      r2Key: asset.r2Key,
      sizeBytes: asset.sizeBytes,
      originalFilename: asset.originalFilename,
      uploadedById: asset.uploadedById,
    });
    await tx.guideAsset.delete({ where: { id: assetId } });
  });
  await deleteObject(asset.r2Key, BUCKET).catch(() => {});
}
