import { prisma } from "../db/prisma";
import { z } from "zod";
import { randomUUID } from "crypto";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../lib/r2";
import { Prisma, type VanityPage } from "@prisma/client";

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

// Slug format: lowercase letters, digits, hyphens, and underscores.
// 1–40 chars. Leading/trailing hyphen or underscore not allowed — those
// read as awkward URLs. Everything else (double underscores, single
// char, etc.) is permitted since it's all URL-safe.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,38}[a-z0-9])?$/;

export function isValidSlugFormat(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug.toLowerCase());
}

// Vanity button — one entry in the LANDING page's buttons array.
//   URL   — target is a full https URL
//   PHONE — target is a phone number; renderer prefixes tel:
//   SMS   — target is a phone number; renderer prefixes sms:
//   EMAIL — target is an email address; renderer prefixes mailto:
export const vanityButtonSchema = z
  .object({
    kind: z.enum(["URL", "PHONE", "SMS", "EMAIL"]),
    label: z.string().min(1).max(200),
    // `target` is only meaningful when source === "literal". When
    // source is business_phone / business_email, target is ignored
    // and the value is looked up from Settings at render time (so
    // changing the BUSINESS_PHONE / BUSINESS_EMAIL setting flows
    // through to every button that references it).
    target: z.string().max(500).default(""),
    source: z
      .enum(["literal", "business_phone", "business_email"])
      .default("literal"),
  })
  .superRefine((val, ctx) => {
    if (val.source !== "literal") {
      // Server-side sanity: only phone/sms/email kinds can bind to a
      // settings source. URL buttons must always be literal (nothing
      // in Settings represents "the website" as of today).
      if (
        val.source === "business_phone" &&
        val.kind !== "PHONE" &&
        val.kind !== "SMS"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source"],
          message: "business_phone source only applies to phone/SMS buttons.",
        });
      }
      if (val.source === "business_email" && val.kind !== "EMAIL") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source"],
          message: "business_email source only applies to email buttons.",
        });
      }
      // Settings-bound buttons don't validate target — it's ignored.
      return;
    }
    if (!val.target.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Button destination required.",
      });
      return;
    }
    if (val.kind === "URL") {
      try {
        new URL(val.target);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target"],
          message: "URL buttons need a valid https:// destination.",
        });
      }
    }
    if (val.kind === "EMAIL" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Email buttons need a valid email address.",
      });
    }
    if ((val.kind === "PHONE" || val.kind === "SMS") && !/[\d]/.test(val.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target"],
        message: "Phone/SMS buttons need a phone number.",
      });
    }
  });
export type VanityButton = z.infer<typeof vanityButtonSchema>;

// Resolve a button's raw target to the href a browser can navigate to:
// URL → target, PHONE → tel:<digits>, SMS → sms:<digits>,
// EMAIL → mailto:<addr>.
export function resolveButtonHref(btn: {
  kind: "URL" | "PHONE" | "SMS" | "EMAIL";
  target: string;
}): string {
  if (btn.kind === "PHONE" || btn.kind === "SMS") {
    // Strip everything but digits + a leading + so tel:/sms: get a
    // clean dialable value. Preserves the raw text stored on the row.
    const cleaned = btn.target.replace(/[^\d+]/g, "");
    return `${btn.kind === "SMS" ? "sms" : "tel"}:${cleaned}`;
  }
  if (btn.kind === "EMAIL") return `mailto:${btn.target.trim()}`;
  return btn.target.trim();
}

// Validation payload shared by create + update. Kind-conditional
// required fields:
//   LANDING  — headline required (that's the h1); everything else optional
//   REDIRECT — redirectUrl required + valid URL
const vanitySaveSchema = z
  .object({
    slug: z.string().min(1).max(40),
    kind: z.enum(["LANDING", "REDIRECT", "ALIAS"]),
    isDefault: z.boolean().default(false),
    title: z.string().max(200).default(""),
    headline: z.string().max(300).default(""),
    body: z.string().max(20000).default(""),
    // Legacy single-button fields — accepted for API back-compat but
    // new writes should use `buttons` instead.
    ctaText: z.string().max(200).nullable().optional(),
    ctaUrl: z.string().url().nullable().optional(),
    // Multi-button array. Capped at 6 — enough for realistic vanity
    // pages ("Call", "Email", "Book online", "Instagram", ...); beyond
    // that the page becomes noise.
    buttons: z.array(vanityButtonSchema).max(6).nullable().optional(),
    imageR2Key: z.string().max(500).nullable().optional(),
    redirectUrl: z.string().url().nullable().optional(),
    aliasTargetId: z.string().min(1).nullable().optional(),
    enabled: z.boolean().default(true),
    showInStartupAnimation: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (!isValidSlugFormat(val.slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message:
          "Slug must be lowercase letters, digits, hyphens, or underscores (1–40 chars, no leading/trailing hyphen or underscore).",
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
    if (val.kind === "ALIAS" && !val.aliasTargetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["aliasTargetId"],
        message: "Aliases need a target vanity URL to mirror.",
      });
    }
    if (val.isDefault && val.kind !== "LANDING") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isDefault"],
        message:
          "Only landing pages can be marked as default (bouncing every unknown slug to a redirect or alias would be surprising).",
      });
    }
  });

export type VanitySavePayload = z.infer<typeof vanitySaveSchema>;

// ── Reads ─────────────────────────────────────────────────────────────

export async function listVanityPages(): Promise<(VanityPage & { imageUrl: string | null })[]> {
  // Order by operator-defined sortOrder first (used by upcoming
  // navigation-list features), with slug as a stable tiebreaker.
  // The default page's isDefault flag is orthogonal to sort order —
  // the row displays with a badge but stays in its ordered slot.
  //
  // Each row gets a presigned imageUrl so the editor can render the
  // hero image inline without a second round-trip. Presigning is
  // per-row (parallel) so total time stays under one round-trip's
  // worth even for a large list.
  const rows = await prisma.vanityPage.findMany({
    orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
  });
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      imageUrl: r.imageR2Key
        ? await getDownloadUrl(r.imageR2Key, 6 * 3600, "promotion-images").catch(() => null)
        : null,
    })),
  );
}

export async function getVanityPageById(id: string): Promise<
  (VanityPage & { imageUrl: string | null }) | null
> {
  const row = await prisma.vanityPage.findUnique({ where: { id } });
  if (!row) return null;
  const imageUrl = row.imageR2Key
    ? await getDownloadUrl(row.imageR2Key, 6 * 3600, "promotion-images").catch(() => null)
    : null;
  return { ...row, imageUrl };
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
  let chosen = explicit ?? fallback;
  if (!chosen) return null;
  // ALIAS resolution — follow to the target's content. Chains are NOT
  // allowed (validation prevents alias→alias); we still hard-cap
  // traversal at one hop as defense in depth. If the target is missing
  // or disabled or the alias link has been broken (target deleted →
  // FK nulled), we fall through to null → caller shows the default.
  if (chosen.kind === "ALIAS" && chosen.aliasTargetId) {
    const target = await prisma.vanityPage.findFirst({
      where: { id: chosen.aliasTargetId, enabled: true, kind: "LANDING" },
    });
    if (!target) return null;
    // Fire view against the ALIAS row (the URL the visitor typed) so
    // metrics reflect which shortcut got the traffic, not the shared
    // content page it resolves to.
    void incrementVanityPageViewCount(chosen.id).catch(() => {});
    const imageUrl = target.imageR2Key
      ? await getDownloadUrl(target.imageR2Key, 6 * 3600, "promotion-images").catch(() => null)
      : null;
    // Return the ALIAS's slug + kind (so URLs stay branded) but the
    // TARGET's content. Downstream renderers don't need to know an
    // alias was involved.
    return {
      ...target,
      id: chosen.id,
      slug: chosen.slug,
      isDefault: chosen.isDefault,
      sortOrder: chosen.sortOrder,
      imageUrl,
    };
  }
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

// Read-side normalizer — turns whatever a VanityPage row carries
// (new `buttons` JSON or legacy `ctaText`/`ctaUrl` pair) into a single
// canonical list the public renderer can iterate. Each entry has a
// pre-resolved `href` so the SSR page just renders — no protocol
// decisions in the view layer.
export function resolveVanityButtons(
  page: {
    buttons: unknown;
    ctaText: string | null;
    ctaUrl: string | null;
  },
  settings?: { businessPhone?: string; businessEmail?: string },
): { kind: "URL" | "PHONE" | "EMAIL"; label: string; target: string; href: string; source: "literal" | "business_phone" | "business_email" }[] {
  const businessPhone = (settings?.businessPhone ?? "").trim();
  const businessEmail = (settings?.businessEmail ?? "").trim();
  const parsed: VanityButton[] = [];
  if (Array.isArray(page.buttons)) {
    for (const raw of page.buttons) {
      const check = vanityButtonSchema.safeParse(raw);
      if (check.success) parsed.push(check.data);
    }
  }
  if (parsed.length > 0) {
    // Swap settings-bound buttons' target with the live setting value.
    // If the setting is empty, the button drops out — better than
    // rendering a "Call us" button that links to nothing.
    const resolved: {
      kind: "URL" | "PHONE" | "EMAIL";
      label: string;
      target: string;
      href: string;
      source: "literal" | "business_phone" | "business_email";
    }[] = [];
    for (const b of parsed) {
      let target = b.target;
      if (b.source === "business_phone") target = businessPhone;
      else if (b.source === "business_email") target = businessEmail;
      if (!target.trim()) continue;
      const materialized = { kind: b.kind, label: b.label, target };
      resolved.push({
        ...materialized,
        href: resolveButtonHref(materialized),
        source: b.source,
      });
    }
    return resolved;
  }
  // Legacy fallback — single URL button synthesized from ctaText/ctaUrl.
  // Rows created before the buttons column existed continue to render;
  // the editor migrates them into the new shape on next save.
  if (page.ctaText && page.ctaUrl) {
    const legacy = { kind: "URL" as const, label: page.ctaText, target: page.ctaUrl };
    return [{ ...legacy, href: resolveButtonHref(legacy), source: "literal" as const }];
  }
  return [];
}

// Ordered list of vanity slugs opted into the app's startup typing
// animation. Reads showInStartupAnimation AND enabled=true so hidden
// rows never surface. Ordered by sortOrder with slug as tiebreaker.
export async function listAnimationSlugs(): Promise<string[]> {
  const rows = await prisma.vanityPage.findMany({
    where: { enabled: true, showInStartupAnimation: true },
    orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
    select: { slug: true },
  });
  return rows.map((r) => r.slug);
}

async function incrementVanityPageViewCount(id: string): Promise<void> {
  await prisma.vanityPage.update({
    where: { id },
    data: { viewCount: { increment: 1 } },
  });
}

// Validate an alias target: must exist, must be a LANDING page (no
// aliasing a redirect or another alias — would either loop or defeat
// the point), and must not be the alias row itself (self-alias would
// resolve to nothing at runtime). Called before save.
async function assertValidAliasTarget(
  targetId: string,
  editingSelfId: string | null,
): Promise<void> {
  if (targetId === editingSelfId) {
    const err: any = new Error("An alias can't point at itself.");
    err.code = "VALIDATION";
    throw err;
  }
  const target = await prisma.vanityPage.findUnique({
    where: { id: targetId },
    select: { id: true, kind: true },
  });
  if (!target) {
    const err: any = new Error("Alias target vanity URL doesn't exist.");
    err.code = "VALIDATION";
    throw err;
  }
  if (target.kind !== "LANDING") {
    const err: any = new Error("Alias targets must be a LANDING page (can't alias a redirect or another alias).");
    err.code = "VALIDATION";
    throw err;
  }
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
  // Alias target existence / kind check — has to be an existing
  // LANDING page. Runs OUTSIDE the tx so a bad target fails fast
  // without holding a lock.
  if (data.kind === "ALIAS" && data.aliasTargetId) {
    await assertValidAliasTarget(data.aliasTargetId, null);
  }
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
    // New rows go at the bottom of the display order. Reserve enough
    // headroom (max + 10) so the operator can splice new rows above
    // this one without renumbering the whole set. reorderVanityPages
    // resequences to 10, 20, 30… when the operator explicitly drags.
    const maxRow = await tx.vanityPage.aggregate({
      _max: { sortOrder: true },
    });
    const newSortOrder = (maxRow._max.sortOrder ?? 0) + 10;
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
        buttons: data.buttons ?? Prisma.JsonNull,
        aliasTargetId: data.kind === "ALIAS" ? (data.aliasTargetId ?? null) : null,
        imageR2Key: data.imageR2Key ?? null,
        redirectUrl: data.redirectUrl ?? null,
        enabled: data.enabled,
        showInStartupAnimation: data.showInStartupAnimation,
        sortOrder: newSortOrder,
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
  if (data.kind === "ALIAS" && data.aliasTargetId) {
    await assertValidAliasTarget(data.aliasTargetId, params.id);
  }
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
        buttons: data.buttons ?? Prisma.JsonNull,
        aliasTargetId: data.kind === "ALIAS" ? (data.aliasTargetId ?? null) : null,
        imageR2Key: data.imageR2Key ?? null,
        redirectUrl: data.redirectUrl ?? null,
        enabled: data.enabled,
        showInStartupAnimation: data.showInStartupAnimation,
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
  // NOTE: deleting the default IS allowed — the UI warns extra loudly
  // in the confirm dialog. After a default deletion the site simply
  // has no fallback until the operator marks another row as default;
  // unknown slugs 404 in the meantime.
  // Refuse to delete when other vanity URLs alias this one — dropping
  // the target would silently break the aliases. Force the operator
  // to fix or delete the aliases first. Error carries the list of
  // dependents so the UI can name them in the dialog.
  const dependents = await prisma.vanityPage.findMany({
    where: { aliasTargetId: params.id },
    select: { id: true, slug: true },
  });
  if (dependents.length > 0) {
    const err: any = new Error(
      `Cannot delete: ${dependents.length} vanity URL${dependents.length === 1 ? "" : "s"} alias this page (${dependents.map((d) => d.slug).join(", ")}). Delete or reassign them first.`,
    );
    err.code = "ALIASED_BY_OTHERS";
    err.dependents = dependents;
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

// Set the default flag on ONE vanity page, clearing it on every other
// row in the same tx. Only landing pages can be default (redirects and
// aliases don't make sense as unknown-slug fallbacks). Returns the
// updated row so callers can render the fresh state without a re-fetch.
export async function setDefaultVanityPage(params: {
  id: string;
  actorUserId: string;
}): Promise<VanityPage> {
  const existing = await prisma.vanityPage.findUnique({ where: { id: params.id } });
  if (!existing) {
    const err: any = new Error("Vanity page not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (existing.kind !== "LANDING") {
    const err: any = new Error("Only landing pages can be set as default.");
    err.code = "NOT_LANDING";
    throw err;
  }
  return prisma.$transaction(async (tx) => {
    await tx.vanityPage.updateMany({
      where: { isDefault: true, id: { not: params.id } },
      data: { isDefault: false },
    });
    const updated = await tx.vanityPage.update({
      where: { id: params.id },
      data: { isDefault: true, updatedById: params.actorUserId },
    });
    await writeAudit(tx, AUDIT.VANITY.UPDATED, params.actorUserId, {
      vanityPageId: updated.id,
      slug: updated.slug,
      change: "set_default",
    });
    return updated;
  });
}

// Toggle the per-row startup-animation flag. Simple boolean flip
// (isolated endpoint so the tab's row-level toggle button doesn't
// have to round-trip the whole save payload).
export async function setVanityStartupAnimation(params: {
  id: string;
  enabled: boolean;
  actorUserId: string;
}): Promise<VanityPage> {
  const existing = await prisma.vanityPage.findUnique({ where: { id: params.id } });
  if (!existing) {
    const err: any = new Error("Vanity page not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  return prisma.$transaction(async (tx) => {
    const updated = await tx.vanityPage.update({
      where: { id: params.id },
      data: {
        showInStartupAnimation: params.enabled,
        updatedById: params.actorUserId,
      },
    });
    await writeAudit(tx, AUDIT.VANITY.UPDATED, params.actorUserId, {
      vanityPageId: updated.id,
      slug: updated.slug,
      change: params.enabled ? "startup_animation_on" : "startup_animation_off",
    });
    return updated;
  });
}

// Bulk reorder — accept a full ordered list of vanity IDs and stamp
// each with sortOrder = 10, 20, 30, … The gap-of-10 gives room to
// splice in future rows without renumbering everything.
export async function reorderVanityPages(params: {
  actorUserId: string;
  orderedIds: string[];
}): Promise<void> {
  const ids = params.orderedIds.map((s) => String(s ?? "")).filter(Boolean);
  if (ids.length === 0) return;
  // Sanity check — payload must include exactly the current rows.
  // Refuse a partial reorder (drops rows out of the ordering).
  const existing = await prisma.vanityPage.findMany({
    select: { id: true },
  });
  const existingIds = new Set(existing.map((r) => r.id));
  const payloadIds = new Set(ids);
  if (existingIds.size !== payloadIds.size || [...existingIds].some((id) => !payloadIds.has(id))) {
    const err: any = new Error("Reorder payload must contain every current vanity page id exactly once.");
    err.code = "INCOMPLETE_ORDER";
    throw err;
  }
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      await tx.vanityPage.update({
        where: { id: ids[i] },
        data: { sortOrder: (i + 1) * 10 },
      });
    }
    await writeAudit(tx, AUDIT.VANITY.UPDATED, params.actorUserId, {
      change: "reorder",
      count: ids.length,
    });
  });
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

// Clear the hero image (operator's "remove image" action). Deletes
// the underlying R2 object best-effort — image storage is cheap so
// the row update is what actually matters. Silent no-op when the row
// has no image (idempotent).
export async function clearVanityPageImage(params: {
  vanityPageId: string;
  actorUserId: string;
}): Promise<void> {
  const prev = await prisma.vanityPage.findUnique({
    where: { id: params.vanityPageId },
    select: { imageR2Key: true },
  });
  if (!prev) {
    const err: any = new Error("Vanity page not found");
    err.code = "NOT_FOUND";
    throw err;
  }
  if (!prev.imageR2Key) return;
  await prisma.vanityPage.update({
    where: { id: params.vanityPageId },
    data: { imageR2Key: null, updatedById: params.actorUserId },
  });
  void deleteObject(prev.imageR2Key, "promotion-images").catch(() => {});
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
  listAnimationSlugs,
  getVanityPageById,
  getPublicVanityPageBySlug,
  getDefaultVanityPage,
  resolvePublicVanityPage,
  resolveVanityButtons,
  createVanityPage,
  updateVanityPage,
  deleteVanityPage,
  setDefaultVanityPage,
  setVanityStartupAnimation,
  reorderVanityPages,
  getVanityPageImageUploadUrl,
  confirmVanityPageImageUpload,
  clearVanityPageImage,
  isValidSlugFormat,
  isReservedSlug,
  RESERVED_SLUGS,
};
