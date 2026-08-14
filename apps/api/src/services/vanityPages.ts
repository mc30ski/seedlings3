import { prisma } from "../db/prisma";
import { z } from "zod";
import { randomUUID } from "crypto";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../lib/r2";
import type { VanityPage } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// Vanity URLs service — configurable branded shortcuts.
//
// See schema.prisma model VanityPage for the data-shape rationale.
// Serves two flows:
//   • Public read (from Next.js SSR) — routes/public.ts GET /public/vanity/:slug
//   • Super CRUD (from the admin editor) — routes/vanityPages.ts
//
// Hostname enforcement lives at the ROUTE layer (currently hardcoded to
// seedlings.pro; moves to an ALLOWED_DOMAINS Setting when Phase 2 of the
// promo multi-domain work lands). Not this service's concern.
// ─────────────────────────────────────────────────────────────────────────────

// Slugs that MUST NOT be used as vanity URLs. Enforced both at editor
// validation time (so operator gets a clear error) and at the public
// route layer (defense in depth — someone creating a row via psql
// wouldn't bypass the block). Extend when adding new top-level routes.
//
// Grouped by reason:
//   - App-owned routes: sign-in, opt-out, pay, promotion, vanity
//   - Reserved for future promo short URLs: mo
//   - Admin-adjacent: admin, super
//   - Next.js / infra: api, _next, favicon.ico, robots.txt, sitemap.xml
export const RESERVED_SLUGS = new Set<string>([
  "sign-in",
  "opt-out",
  "pay",
  "promotion",
  "api",
  "mo",
  "_next",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "vanity",
  "admin",
  "super",
]);

// Slug format: lowercase kebab-case + digits, 1–40 chars, no leading/
// trailing hyphens, no consecutive hyphens. Matches typical URL-safe
// vanity patterns without allowing anything weird.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;

export function isValidSlugFormat(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

// Validation payload shared by create + update. Kind-conditional
// required fields:
//   LANDING  — headline required (that's the h1); everything else optional
//   REDIRECT — redirectUrl required + valid URL
const vanitySaveSchema = z
  .object({
    slug: z.string().min(1).max(40),
    kind: z.enum(["LANDING", "REDIRECT"]),
    isDefault: z.boolean().default(false),
    title: z.string().max(200).default(""),
    headline: z.string().max(300).default(""),
    body: z.string().max(20000).default(""),
    ctaText: z.string().max(200).nullable().optional(),
    ctaUrl: z.string().url().nullable().optional(),
    imageR2Key: z.string().max(500).nullable().optional(),
    redirectUrl: z.string().url().nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (!isValidSlugFormat(val.slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message:
          "Slug must be lowercase letters, digits, and single hyphens (1–40 chars, no leading/trailing hyphen, no double hyphens).",
      });
    }
    if (isReservedSlug(val.slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: `"${val.slug}" is a reserved path and can't be used as a vanity URL.`,
      });
    }
    if (val.kind === "LANDING" && !val.headline.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["headline"],
        message: "Landing pages need a headline.",
      });
    }
    if (val.kind === "REDIRECT" && !val.redirectUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redirectUrl"],
        message: "Redirect URLs need a destination.",
      });
    }
    if (val.isDefault && val.kind !== "LANDING") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isDefault"],
        message:
          "Only landing pages can be marked as default (bouncing every unknown slug to a redirect would loop bad UX).",
      });
    }
  });

export type VanitySavePayload = z.infer<typeof vanitySaveSchema>;

// ── Reads ─────────────────────────────────────────────────────────────

export async function listVanityPages(): Promise<VanityPage[]> {
  return prisma.vanityPage.findMany({
    orderBy: [{ isDefault: "desc" }, { slug: "asc" }],
  });
}

export async function getVanityPageById(id: string): Promise<VanityPage | null> {
  return prisma.vanityPage.findUnique({ where: { id } });
}

// Public read used by the Next.js dynamic route. Only returns enabled
// pages — disabled rows are treated as not-found so the fallback default
// kicks in. Returns null when nothing matches; the caller decides
// whether to show the default or 404.
export async function getPublicVanityPageBySlug(
  slug: string,
): Promise<VanityPage | null> {
  return prisma.vanityPage.findFirst({
    where: { slug, enabled: true },
  });
}

// The single "default" fallback page — rendered when a visitor hits a
// slug that doesn't exist (or is disabled). Only ONE row can carry
// isDefault=true; the setter enforces that.
export async function getDefaultVanityPage(): Promise<VanityPage | null> {
  return prisma.vanityPage.findFirst({
    where: { isDefault: true, enabled: true },
  });
}

// Resolve a rendered vanity page for public display. Includes the
// presigned image URL when the row has an image key. Bumps view count
// on every hit (fire-and-forget — the caller shouldn't await this).
//
// Returns null when nothing matches and there's no default configured
// (caller should return 404 in that case).
export async function resolvePublicVanityPage(slug: string): Promise<
  | (VanityPage & { imageUrl: string | null })
  | null
> {
  const explicit = await getPublicVanityPageBySlug(slug);
  const fallback = explicit ? null : await getDefaultVanityPage();
  const chosen = explicit ?? fallback;
  if (!chosen) return null;
  const imageUrl = chosen.imageR2Key
    ? await getDownloadUrl(chosen.imageR2Key, 6 * 3600, "promotion-images").catch(() => null)
    : null;
  // Fire-and-forget view count bump. The slug used here is the one the
  // visitor actually typed (chosen.slug will be the default slug when we
  // fell through) — attribute to the RENDERED page so metrics reflect
  // what was actually shown.
  void incrementVanityPageViewCount(chosen.id).catch(() => {});
  return { ...chosen, imageUrl };
}

async function incrementVanityPageViewCount(id: string): Promise<void> {
  await prisma.vanityPage.update({
    where: { id },
    data: { viewCount: { increment: 1 } },
  });
}

// ── Writes (Super only — auth enforced at route layer) ────────────────

export async function createVanityPage(params: {
  actorUserId: string;
  payload: unknown;
}): Promise<VanityPage> {
  const parsed = vanitySaveSchema.safeParse(params.payload);
  if (!parsed.success) {
    const err: any = new Error(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    err.code = "VALIDATION";
    err.issues = parsed.error.issues;
    throw err;
  }
  const data = parsed.data;
  return prisma.$transaction(async (tx) => {
    // Enforce single-default: if this row is being marked default,
    // clear the flag on every other row first. Same tx so we never
    // have two defaults visible simultaneously.
    if (data.isDefault) {
      await tx.vanityPage.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }
    const created = await tx.vanityPage.create({
      data: {
        slug: data.slug.toLowerCase(),
        kind: data.kind,
        isDefault: data.isDefault,
        title: data.title,
        headline: data.headline,
        body: data.body,
        ctaText: data.ctaText ?? null,
        ctaUrl: data.ctaUrl ?? null,
        imageR2Key: data.imageR2Key ?? null,
        redirectUrl: data.redirectUrl ?? null,
        enabled: data.enabled,
        createdById: params.actorUserId,
        updatedById: params.actorUserId,
      },
    });
    await writeAudit(tx, AUDIT.VANITY.CREATED, params.actorUserId, {
      vanityPageId: created.id,
      slug: created.slug,
      kind: created.kind,
      isDefault: created.isDefault,
    });
    return created;
  });
}

export async function updateVanityPage(params: {
  id: string;
  actorUserId: string;
  payload: unknown;
}): Promise<VanityPage> {
  const existing = await prisma.vanityPage.findUnique({ where: { id: params.id } });
  if (!existing) {
    const err: any = new Error("Vanity page not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  const parsed = vanitySaveSchema.safeParse(params.payload);
  if (!parsed.success) {
    const err: any = new Error(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    err.code = "VALIDATION";
    err.issues = parsed.error.issues;
    throw err;
  }
  const data = parsed.data;
  return prisma.$transaction(async (tx) => {
    if (data.isDefault && !existing.isDefault) {
      await tx.vanityPage.updateMany({
        where: { isDefault: true, id: { not: params.id } },
        data: { isDefault: false },
      });
    }
    const updated = await tx.vanityPage.update({
      where: { id: params.id },
      data: {
        slug: data.slug.toLowerCase(),
        kind: data.kind,
        isDefault: data.isDefault,
        title: data.title,
        headline: data.headline,
        body: data.body,
        ctaText: data.ctaText ?? null,
        ctaUrl: data.ctaUrl ?? null,
        imageR2Key: data.imageR2Key ?? null,
        redirectUrl: data.redirectUrl ?? null,
        enabled: data.enabled,
        updatedById: params.actorUserId,
      },
    });
    await writeAudit(tx, AUDIT.VANITY.UPDATED, params.actorUserId, {
      vanityPageId: updated.id,
      slug: updated.slug,
      kind: updated.kind,
      isDefault: updated.isDefault,
    });
    return updated;
  });
}

export async function deleteVanityPage(params: {
  id: string;
  actorUserId: string;
}): Promise<void> {
  const existing = await prisma.vanityPage.findUnique({ where: { id: params.id } });
  if (!existing) {
    const err: any = new Error("Vanity page not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  // Refuse to delete the default — operator should reassign default
  // first, then delete. Prevents a moment where no default exists and
  // unknown slugs 404 instead of gracefully falling back.
  if (existing.isDefault) {
    const err: any = new Error(
      "Cannot delete the default vanity page. Mark another page as default first, then delete this one.",
    );
    err.code = "CANNOT_DELETE_DEFAULT";
    throw err;
  }
  await prisma.$transaction(async (tx) => {
    await tx.vanityPage.delete({ where: { id: params.id } });
    await writeAudit(tx, AUDIT.VANITY.DELETED, params.actorUserId, {
      vanityPageId: params.id,
      slug: existing.slug,
    });
  });
  // Best-effort R2 cleanup — image object is orphaned but bytes are
  // small and R2 storage cost is negligible. Never blocks the delete.
  if (existing.imageR2Key) {
    void deleteObject(existing.imageR2Key, "promotion-images").catch(() => {});
  }
}

// ── R2 image upload ──────────────────────────────────────────────────

// Presigned R2 PUT URL for a vanity page's hero image. Client uploads
// the resized/compressed blob directly to R2 (bypasses our API), then
// calls confirmVanityPageImageUpload with the returned key. 5-min window.
//
// Reuses the "promotion-images" bucket — same operator, same policy,
// same lifecycle. Keys are namespaced under `vanity/` to keep browsing
// R2 sane.
export async function getVanityPageImageUploadUrl(params: {
  vanityPageId: string;
  contentType: string;
}): Promise<{ uploadUrl: string; key: string }> {
  const key = `vanity/${params.vanityPageId}/${randomUUID()}`;
  const uploadUrl = await getUploadUrl(key, params.contentType, 300, "promotion-images");
  return { uploadUrl, key };
}

export async function confirmVanityPageImageUpload(params: {
  vanityPageId: string;
  key: string;
  actorUserId: string;
}): Promise<void> {
  const prev = await prisma.vanityPage.findUnique({
    where: { id: params.vanityPageId },
    select: { imageR2Key: true },
  });
  await prisma.vanityPage.update({
    where: { id: params.vanityPageId },
    data: { imageR2Key: params.key, updatedById: params.actorUserId },
  });
  // Clean up the prior image so replacements don't orphan bytes.
  if (prev?.imageR2Key && prev.imageR2Key !== params.key) {
    void deleteObject(prev.imageR2Key, "promotion-images").catch(() => {});
  }
}

export const vanityPages = {
  listVanityPages,
  getVanityPageById,
  getPublicVanityPageBySlug,
  getDefaultVanityPage,
  resolvePublicVanityPage,
  createVanityPage,
  updateVanityPage,
  deleteVanityPage,
  getVanityPageImageUploadUrl,
  confirmVanityPageImageUpload,
  isValidSlugFormat,
  isReservedSlug,
  RESERVED_SLUGS,
};
