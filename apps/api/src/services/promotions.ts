import { prisma } from "../db/prisma";
import { z } from "zod";
import { randomUUID, createHash, randomBytes } from "crypto";
import { type PromoChannel } from "../lib/promotionsHmac";
import { sendEmail, sendSMS } from "../lib/notifications";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../lib/r2";

// ─────────────────────────────────────────────────────────────────────────────
// Promotions — MVP-1 service.
//
// Responsibilities:
//   • Zod-validated per-channel content shape
//   • CRUD (with lifecycle enforcement — edit only in DRAFT/PAUSED)
//   • Opt-out helpers (contact-level, per-channel, audited)
//   • Dispatcher — piggyback + manual burst
//   • Content assembly (channel-appropriate body + CTA + opt-out footer)
//
// See docs/features/promotions.md when it lands; the design decisions
// (piggyback, cooldown, multi-promo per-channel policy, invoice_page-as-
// display-not-dispatch, CAN-SPAM address in email footer, HMAC opt-out
// URL, APPROVE-gated Super re-opt-in) are all encoded in this file.
// ─────────────────────────────────────────────────────────────────────────────

// ── Content shape (Zod) ────────────────────────────────────────────────────

const smsContentSchema = z.object({
  body: z.string().min(1).max(2000),
  ctaText: z.string().max(200).optional().default(""),
});
const emailContentSchema = z.object({
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
  ctaText: z.string().max(200).optional().default(""),
});
const invoicePageContentSchema = z.object({
  headline: z.string().max(200).optional(),
  body: z.string().min(1).max(20000),
  ctaText: z.string().max(200).optional().default(""),
});

// The ONE set of copy an operator writes. Every channel and surface uses
// this unless it carries an explicit override below.
//
// Before this existed, a promotion held up to four independent
// headline+body pairs (sms, email, invoice_page, and the landing page's
// own headline/intro columns) with nothing linking them — so the same
// offer read differently on the invoice and the landing page unless the
// operator remembered to type it four times and keep it in sync by hand.
const sharedContentSchema = z.object({
  headline: z.string().max(200).optional(),
  body: z.string().min(1).max(20000),
  ctaText: z.string().max(200).optional().default(""),
});

export const promotionContentSchema = z.object({
  /** Canonical copy. Channels inherit from here. */
  shared: sharedContentSchema.optional(),
  // Per-channel OVERRIDES. Present only when the operator deliberately
  // customized that channel — SMS is the common case, since 160 characters
  // needs its own wording. Absent = inherit `shared`.
  sms: smsContentSchema.optional(),
  email: emailContentSchema.optional(),
  invoice_page: invoicePageContentSchema.optional(),
});

export type PromotionContent = z.infer<typeof promotionContentSchema>;

const dispatchChannelSchema = z.enum(["email", "sms"]);
const displaySurfaceSchema = z.enum(["invoice_page"]);
const triggerKindSchema = z.enum(["on_invoice_sent", "manual_send"]);
const audienceSpecSchema = z.object({
  kind: z.literal("all"),
});
const triggerConfigSchema = z.record(z.unknown()).default({});
const linkKindSchema = z.enum(["EXTERNAL", "LANDING_PAGE"]);

// Payload accepted by create + update. Enforces:
//   • at least one channel or surface is enabled
//   • when dispatchChannels is non-empty, triggerKind is required
//   • content[channel] exists for each enabled channel/surface
//   • linkKind=EXTERNAL requires a well-formed `link` URL
//   • linkKind=LANDING_PAGE requires `link` to be null (server assigns
//     the resolved URL server-side when the landing page has a slug)
export const promotionSavePayloadSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(1000).default(""),
    linkKind: linkKindSchema.default("EXTERNAL"),
    link: z.string().url().nullable().optional(),
    audienceSpec: audienceSpecSchema.default({ kind: "all" }),
    dispatchChannels: z.array(dispatchChannelSchema).default([]),
    displaySurfaces: z.array(displaySurfaceSchema).default([]),
    triggerKind: triggerKindSchema.nullable().optional(),
    triggerConfig: triggerConfigSchema,
    cooldownDays: z.number().int().min(0).max(365).default(7),
    startAt: z.string().datetime().nullable().optional(),
    endAt: z.string().datetime().nullable().optional(),
    content: promotionContentSchema,
    // Short URL slug — kebab-case + digits, ≤40 chars, unique across
    // promotions. Locked once campaign leaves DRAFT (enforced service-
    // side by the update handler). Null means the campaign uses the
    // older long-form wrapper URL.
    shortSlug: z
      .string()
      .max(40)
      .regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/, {
        message: "Slug must be lowercase letters, digits, and single hyphens (1-40 chars, no leading/trailing hyphen, no double hyphens).",
      })
      .nullable()
      .optional(),
    // Per-campaign domain override. Full origin ("https://seedlings.pro").
    // Must be a member of ALLOWED_DOMAINS — validated at the write path
    // (not in this schema — that'd require a DB fetch here). Null means
    // the campaign uses the primary from PAYMENT_REQUEST_BASE_URL.
    baseDomain: z.string().url().nullable().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.dispatchChannels.length === 0 && val.displaySurfaces.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispatchChannels"],
        message: "At least one dispatch channel or display surface is required",
      });
    }
    if (val.dispatchChannels.length > 0 && !val.triggerKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerKind"],
        message: "Trigger is required when dispatch channels are selected",
      });
    }
    // A channel/surface is satisfied by its OWN override or by the shared
    // offer copy. Before the copy collapse this demanded per-channel
    // content, which would now reject the normal case: an operator writes
    // "The offer" once and enables three surfaces without customizing any
    // of them.
    //
    // The requirement itself is unchanged — every enabled destination must
    // have SOMETHING to say, or the dispatcher throws at send time. Only
    // where that content may come from has widened.
    // Validate through the RESOLVER, not truthiness of the raw key. These
    // must agree exactly: `body: z.string().min(1)` accepts "   ", so a
    // whitespace-only override used to SAVE and then throw at every
    // dispatch site — including inside the public /pay/:token render,
    // which has no try/catch and would 500 the whole invoice page for a
    // client trying to pay.
    for (const c of val.dispatchChannels) {
      if (!resolveChannelContent(val.content as PromotionContent, c)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content", c],
          message: `Missing content for enabled channel: ${c}. Write the shared offer copy, or give ${c} its own.`,
        });
      }
    }
    for (const s of val.displaySurfaces) {
      if (!resolveChannelContent(val.content as PromotionContent, s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content", s],
          message: `Missing content for enabled surface: ${s}. Write the shared offer copy, or give ${s} its own.`,
        });
      }
    }
    // M1: email's subject comes from shared.headline when the channel has
    // no override. Without this an operator enabling email with only a
    // body silently ships every message titled "A note from us".
    if (
      val.dispatchChannels.includes("email") &&
      !val.content.email &&
      !val.content.shared?.headline?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content", "shared", "headline"],
        message:
          "Email needs an offer title — it becomes the subject line. Add one, or give email its own subject.",
      });
    }
    // A destination is only REQUIRED when the promo actually sends
    // something — a text or email whose whole point is a link to tap.
    //
    // A display-only promo (invoice surface, no dispatch channels) renders
    // fine with no link: buildContentSnapshot sets ctaUrl: null and the
    // invoice simply omits the button, showing the offer as text. But
    // linkKind DEFAULTS to EXTERNAL, so this rule made it impossible to
    // create an invoice-only promo without inventing a URL — the operator
    // never chose EXTERNAL, it was just the default they never touched.
    if (
      val.linkKind === "EXTERNAL" &&
      !val.link &&
      val.dispatchChannels.length > 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["link"],
        message:
          "A promotion that sends email or SMS needs a destination — add an External URL, or switch to a Custom landing page.",
      });
    }
  });

export type PromotionSavePayload = z.infer<typeof promotionSavePayloadSchema>;

// ── Setting keys ──────────────────────────────────────────────────────────

const SETTING_HMAC_SECRET = "PROMOTION_HMAC_SECRET";
const SETTING_EMAIL_FOOTER = "PROMOTION_OPT_OUT_FOOTER_EMAIL";
const SETTING_SMS_FOOTER = "PROMOTION_OPT_OUT_FOOTER_SMS";
const SETTING_BUSINESS_ADDRESS = "BUSINESS_ADDRESS";
const SETTING_PAY_BASE_URL = "PAYMENT_REQUEST_BASE_URL";
const SETTING_ALLOWED_DOMAINS = "ALLOWED_DOMAINS";
// Where promotion LANDING pages live. Optional and opt-in: when unset,
// landing URLs are built from the visitor's own host exactly as before, so
// adding this key is the only thing that changes behavior.
//
// Exists because the marketing domain reads as the word: seedlings.pro +
// /motion/ = "pro-motion". Landing pages are fully public — no login, no
// stored browser state — so sending a client across domains for one costs
// nothing. Do NOT point invoice or app links here: those DO depend on
// login and per-domain browser storage.
const SETTING_LANDING_BASE_URL = "PROMOTION_LANDING_BASE_URL";

export async function loadPromotionSettings(): Promise<{
  hmacSecret: string;
  emailFooter: string;
  smsFooter: string;
  businessAddress: string;
  baseUrl: string;
  /** Optional override used ONLY for landing-page URLs. Empty = use baseUrl. */
  landingBaseUrl: string;
}> {
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          SETTING_HMAC_SECRET,
          SETTING_EMAIL_FOOTER,
          SETTING_SMS_FOOTER,
          SETTING_BUSINESS_ADDRESS,
          SETTING_PAY_BASE_URL,
          SETTING_LANDING_BASE_URL,
        ],
      },
    },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  // Auto-generate PROMOTION_HMAC_SECRET on first use in an environment
  // that doesn't have it. The secret is an internal implementation
  // detail (server-only, never leaves this DB) — no reason to put the
  // burden on the operator. Uses cryptographically-random 32 bytes
  // (base64url-encoded ~= 43 chars, comfortably above the 32-char
  // requireSecret() gate). Upsert-then-return-the-fresh-value keeps
  // subsequent calls fast (they find the row on the next lookup).
  //
  // Race note: if two API instances hit this branch simultaneously on
  // a fresh prod DB, both generate and one upsert loses. That's fine
  // — both values are ≥32 chars and cryptographically random; whichever
  // lands second is the persistent one; the loser only affected its
  // own in-flight call (which returned a valid, verifiable value at
  // that moment). No pending click URLs exist to invalidate.
  const previousSecret = map.get(SETTING_HMAC_SECRET) ?? "";
  let hmacSecret = previousSecret;
  if (!hmacSecret || hmacSecret.length < 32) {
    hmacSecret = randomBytes(32).toString("base64url");
    await prisma.setting.upsert({
      where: { key: SETTING_HMAC_SECRET },
      create: {
        key: SETTING_HMAC_SECRET,
        value: hmacSecret,
        section: "promotions",
        description: "HMAC secret used to sign promotion click-tracking URLs (server-only). Auto-generated on first use.",
      },
      update: { value: hmacSecret },
    });
    // Rewriting this row silently invalidates every outstanding signed
    // click/preview token. Audited ONLY on this branch — the read path
    // runs on every promo URL build and verify and must stay silent.
    // Actor is null: an anonymous public click can reach this code.
    //
    // Deliberately NOT wrapped in a transaction with the upsert above,
    // and failure-tolerant: this function sits on the anonymous public
    // click path, and a bookkeeping insert must never be able to break
    // URL signing/verification for a client tapping a link.
    try {
      await writeAudit(prisma, AUDIT.PROMOTION.HMAC_ROTATED, null, {
        reason: "auto_generated_on_first_use",
        // Distinguishes "no secret existed" (nothing to invalidate) from
        // "a too-short secret was overwritten" (live tokens just died).
        hadPreviousSecret: previousSecret.length > 0,
        previousSecretLength: previousSecret.length,
        previousSecretPreviewHash: previousSecret
          ? createHash("sha256").update(previousSecret).digest("hex").slice(0, 8)
          : null,
        rotatedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(
        { error: (e as Error).message },
        "[promotions] HMAC auto-generation audit write failed (continuing)",
      );
    }
  }
  return {
    hmacSecret,
    emailFooter: map.get(SETTING_EMAIL_FOOTER) ?? "",
    smsFooter: map.get(SETTING_SMS_FOOTER) ?? "",
    businessAddress: map.get(SETTING_BUSINESS_ADDRESS) ?? "",
    baseUrl: map.get(SETTING_PAY_BASE_URL) ?? "https://www.seedlings.team",
    landingBaseUrl: (map.get(SETTING_LANDING_BASE_URL) ?? "").trim(),
  };
}

// ── Allowed domains ──────────────────────────────────────────────────────
//
// Single source of truth for the "which hostnames does this app serve"
// question. Feeds:
//   • Promotion editor's per-campaign domain dropdown (operator picks
//     from known-good options, no free-text typos)
//   • Public-route Host-header allowlist (defense against Host-header
//     injection — attacker can't trick us into generating redirects to
//     an origin we don't own)
//   • Vanity URL public route's hostname check (same allowlist as
//     everywhere else; previously hardcoded)
//
// Reads the ALLOWED_DOMAINS setting (JSON array of "https://host"
// strings). Returns normalized bare hostnames (without protocol or
// port) so consumers can compare against `req.headers.host` after
// stripping the port.
//
// Falls back to the PAYMENT_REQUEST_BASE_URL hostname when the setting
// is missing/malformed — never returns an empty list so a broken
// setting can't accidentally lock every domain out at once. Logs the
// fallback so ops sees it in the API logs.
export async function loadAllowedDomains(): Promise<{
  origins: string[];   // full "https://host" values for URL building
  hostnames: string[]; // bare "host" values for Host-header comparisons
  primaryHostname: string; // matches PAYMENT_REQUEST_BASE_URL's hostname
}> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [SETTING_ALLOWED_DOMAINS, SETTING_PAY_BASE_URL] } },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const rawList = map.get(SETTING_ALLOWED_DOMAINS) ?? "";
  const primaryUrl = map.get(SETTING_PAY_BASE_URL) ?? "https://www.seedlings.team";
  let origins: string[] = [];
  try {
    const parsed = JSON.parse(rawList || "[]");
    if (Array.isArray(parsed)) {
      origins = parsed
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch {
    // Malformed JSON — swallow and fall through to the primary-only
    // fallback below so a bad setting never bricks routing.
  }
  // Always include the primary as a safety net — even if the operator
  // saved an ALLOWED_DOMAINS list that accidentally omitted it, we
  // can't have the primary be un-recognized (invoices would 404).
  if (!origins.includes(primaryUrl)) {
    origins = origins.length === 0 ? [primaryUrl] : [primaryUrl, ...origins];
  }
  const hostnames = origins
    .map((o) => {
      try {
        return new URL(o).hostname.toLowerCase();
      } catch {
        return null;
      }
    })
    .filter((h): h is string => !!h);
  let primaryHostname = "";
  try {
    primaryHostname = new URL(primaryUrl).hostname.toLowerCase();
  } catch {
    primaryHostname = hostnames[0] ?? "";
  }
  return { origins, hostnames, primaryHostname };
}

// True when the given request hostname (already stripped of port) is
// one of the app's known domains. Consumers that need a dev-mode
// escape hatch (allowing localhost during `npm run dev`) should
// combine this with their own NODE_ENV check.
export async function isHostAllowed(hostname: string): Promise<boolean> {
  const lower = hostname.toLowerCase();
  const { hostnames } = await loadAllowedDomains();
  return hostnames.includes(lower);
}

// ── Short URL builder ────────────────────────────────────────────────────
//
// Emits the branded per-recipient URL used when a Promotion has
// shortSlug set: `<baseDomain>/mo/<slug>/<code>`.
//
// baseDomain comes from the promo's per-campaign override when set,
// otherwise from the primary (PAYMENT_REQUEST_BASE_URL). Callers
// should pass the origin form ("https://seedlings.pro") — this helper
// just concatenates the path.
//
// The anonymous variant (`<baseDomain>/mo/<slug>`) is not built by a
// dedicated helper — it's simply the short URL with the code stripped,
// so callers that need it (e.g. the editor preview or an ops UI)
// build it inline.
export function buildShortWrapperUrl(
  baseUrl: string,
  slug: string,
  code: string,
): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/mo/${encodeURIComponent(slug)}/${encodeURIComponent(code)}`;
}

// Anonymous shareable variant — the "share on a lawn sign / social /
// word-of-mouth" URL. Same as buildShortWrapperUrl minus the recipient
// code. Clicks are logged with anonymousReason="anonymous_slug_only"
// and no attribution to a specific delivery.
export function buildAnonymousShortUrl(baseUrl: string, slug: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/mo/${encodeURIComponent(slug)}`;
}

// ── Short URL slug + code format ─────────────────────────────────────────

// Promo short-URL slug: kebab-case + digits, 1–40 chars. Same rules as
// vanity URL slugs so operators don't have to context-switch. Enforced
// both at the save-payload Zod schema and at slug-lock-check time.
// Short-slug format. Cap raised 40 -> 64 on 2026-08-22 to match the
// landing-page slug cap (slugifyTitle), so the short code can always
// mirror the landing page address — the two used to disagree, which made
// mirroring impossible for longer campaign names and forced operators to
// invent a second name by hand.
//
// 64 is a sanity bound, not a product rule: the column is unconstrained
// and a path segment this long is still valid. Length ABOVE 40 is now a
// UI warning (SMS segment cost — see smsSegmentInfo and Invariant E)
// rather than a hard stop, per operator decision.
const PROMO_SHORT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/** Length beyond which a short slug starts meaningfully eating into an
 *  SMS segment. Advisory only — callers warn, they don't reject. */
export const SHORT_SLUG_SMS_ADVISORY_LENGTH = 40;

export function isValidShortSlugFormat(slug: string): boolean {
  return PROMO_SHORT_SLUG_PATTERN.test(slug);
}

// Per-recipient short code: 4 chars, lowercase alphanumeric. ~1.7M
// combinations per campaign. Deliberately excludes visually confusable
// chars (0/o, 1/l/i) so operators reading a delivery log at a glance
// can distinguish similar codes.
const SHORT_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i
const SHORT_CODE_LENGTH = 4;

export function generateShortCode(): string {
  let out = "";
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    out += SHORT_CODE_ALPHABET.charAt(
      Math.floor(Math.random() * SHORT_CODE_ALPHABET.length),
    );
  }
  return out;
}

// Pull a fresh code that isn't already used within a promotion. Retries
// up to N times on collision (astronomically unlikely below ~10k
// deliveries — birthday collision math). If we can't find one after
// the retry budget, throw — the campaign has exhausted the 4-char
// space, which means it's time to bump SHORT_CODE_LENGTH to 5.
export async function generateUniqueShortCode(
  promotionId: string,
  maxAttempts = 8,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = generateShortCode();
    const exists = await prisma.promotionDelivery.findUnique({
      where: { promotionId_shortCode: { promotionId, shortCode: candidate } },
      select: { id: true },
    });
    if (!exists) return candidate;
  }
  throw new Error(
    `Could not find a unique short code for promotion ${promotionId} after ${maxAttempts} attempts — code space may be exhausted, consider bumping SHORT_CODE_LENGTH.`,
  );
}

// ── Slug util ─────────────────────────────────────────────────────────────

// Auto-slug from title: kebab-case ASCII, trim, cap at 64 chars. Callers
// are responsible for uniqueness (append -2, -3, etc. on collision) —
// this is a pure formatter so it can be unit-tested trivially.
export function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "promotion";
}

// Ensures the desired slug is unique across PromotionLandingPage rows
// (excluding the current row if updating). Appends -2, -3, … on collision.
export async function ensureUniqueSlug(
  desired: string,
  currentPageId: string | null,
): Promise<string> {
  let candidate = slugifyTitle(desired);
  let attempt = 2;
  // Bounded loop — if we can't find a unique slug in 100 tries the title
  // is pathological (all overlaps) and we should surface that rather
  // than spin forever.
  while (attempt < 100) {
    const existing = await prisma.promotionLandingPage.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing || existing.id === currentPageId) return candidate;
    candidate = `${slugifyTitle(desired)}-${attempt}`;
    attempt++;
  }
  throw new Error(`Unable to find a unique slug for "${desired}" after 100 attempts`);
}

// ── Click wrapper HMAC + URL builders ────────────────────────────────────

import { createHmac, timingSafeEqual } from "crypto";

// Two wrapper URL flavors:
//
//   d-flavor  — /promotion/click/d/<deliveryId>?t=<hmac>
//     Used by piggyback (SMS/email) and manual-send bursts. HMAC signs
//     the deliveryId. Click resolves via the delivery row's promotion.
//
//   p-flavor  — /promotion/click/p/<promotionId>?c=<contactId>&t=<hmac>
//     Used by invoice-page CTA buttons. There's no PromotionDelivery to
//     tie to (invoice-page is a display surface, not a dispatch), so
//     the token signs the (promotionId, contactId) tuple directly.
//
// Both are refused under weak secrets. Both use base64url for URL safety.

// Enforced at sign time (fails loudly at message-send / URL-build so
// the operator sees the misconfig immediately). Verify path uses
// isSecretValid + return-false so click routes don't 500 on missing
// or rotated secrets — anonymous-click fallback still runs.
function requireSecret(secret: string) {
  if (!secret || secret.length < 32) {
    throw new Error("PROMOTION_HMAC_SECRET must be at least 32 characters");
  }
}
function isSecretValid(secret: string): boolean {
  return !!secret && secret.length >= 32;
}

export function signDeliveryClickToken(secret: string, deliveryId: string): string {
  requireSecret(secret);
  return createHmac("sha256", secret).update(`d:${deliveryId}`).digest("base64url");
}

export function verifyDeliveryClickToken(
  secret: string,
  deliveryId: string,
  token: string,
): boolean {
  // Verify never throws — an unset/short/rotated secret returns false
  // (falls through to anonymous-click log + best-effort redirect) so
  // the click endpoint doesn't 500 on every hit while ops investigates.
  if (!isSecretValid(secret) || !deliveryId || !token) return false;
  const expected = createHmac("sha256", secret).update(`d:${deliveryId}`).digest("base64url");
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signPromoClickToken(
  secret: string,
  promotionId: string,
  contactId: string | null,
): string {
  requireSecret(secret);
  const payload = `p:${promotionId}:${contactId ?? ""}`;
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Preview-token lifetime. Short: a preview link bypasses the ACTIVE
 *  check, so it must stop working soon after the operator stops using it.
 *  Expressed in minutes then converted, to stay clear of the build gate's
 *  spelled-out-millisecond rules. */
export const LANDING_PREVIEW_TTL_MINUTES = 30;

/**
 * Sign a preview token for one landing-page slug.
 *
 * Third HMAC flavor alongside delivery (`d:`) and promo (`p:`) click
 * tokens, namespaced `v:` so it can never cross-verify with either — the
 * same isolation Invariants I and M lock in for the other two.
 *
 * The expiry is BOTH inside the signed payload and carried in the token
 * (`<expiryMs>.<sig>`), so a tampered expiry changes the payload and
 * fails the signature. There's no server-side state to store or revoke.
 */
export function signLandingPreviewToken(
  secret: string,
  slug: string,
  expiresAtMs: number,
): string {
  requireSecret(secret);
  const sig = createHmac("sha256", secret)
    .update(`v:${slug}:${expiresAtMs}`)
    .digest("base64url");
  return `${expiresAtMs}.${sig}`;
}

/**
 * Verify a preview token for a slug. Never throws — this runs on a public
 * route, same 500-safety rule as the other verifiers.
 *
 * Returns false for: bad secret, malformed token, expired token, or a
 * signature that doesn't match. Expiry is checked BEFORE the HMAC so an
 * expired token is cheap to reject.
 */
export function verifyLandingPreviewToken(
  secret: string,
  slug: string,
  token: string,
  nowMs: number,
): boolean {
  if (!isSecretValid(secret) || !slug || !token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!sig || !/^[0-9]{1,15}$/.test(expRaw)) return false;
  const expiresAtMs = Number(expRaw);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  const expected = createHmac("sha256", secret)
    .update(`v:${slug}:${expiresAtMs}`)
    .digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyPromoClickToken(
  secret: string,
  promotionId: string,
  contactId: string | null,
  token: string,
): boolean {
  // See verifyDeliveryClickToken — verify never throws for the same
  // 500-safety reason.
  if (!isSecretValid(secret) || !promotionId || !token) return false;
  const payload = `p:${promotionId}:${contactId ?? ""}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// URL embedded in outbound SMS/email + manual-burst messages.
//
// Path is `/api/public/promotion/click/d/<id>` — the `/api/` prefix hits
// Vercel's rewrite rule (`/api/(.*)` → `/api/_proxy/$1`), which forwards
// to the API server. Without the prefix, Next.js sees `/promotion/click/...`
// and 404s (the only /promotion/* Next page is `[slug].tsx`, single-segment).
export function buildClickWrapperUrl(
  baseUrl: string,
  hmacSecret: string,
  deliveryId: string,
): string {
  const token = signDeliveryClickToken(hmacSecret, deliveryId);
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/api/public/promotion/click/d/${deliveryId}?t=${encodeURIComponent(token)}`;
}

// URL embedded in the invoice-page promo section's CTA button. No
// delivery row exists — click lands with (promotionId, contactId) only.
// Same `/api/public/` prefix as the d-flavor wrapper for the same
// Vercel-rewrite reason.
export function buildInvoicePageClickUrl(
  baseUrl: string,
  hmacSecret: string,
  promotionId: string,
  contactId: string | null,
): string {
  const token = signPromoClickToken(hmacSecret, promotionId, contactId);
  const trimmed = baseUrl.replace(/\/$/, "");
  const qs = new URLSearchParams({ t: token });
  if (contactId) qs.set("c", contactId);
  // `s=inv` marks "this click started on an invoice", so the landing page
  // can offer a way back to it. Deliberately NOT the payment token: that
  // token IS the invoice's auth, and a marketing URL gets forwarded and
  // shared. This is a boolean breadcrumb that grants nothing.
  //
  // Unsigned on purpose. It drives one navigation affordance, so forging
  // it buys an attacker a back button that goes nowhere. Signing it would
  // imply it gates something.
  qs.set("s", "inv");
  return `${trimmed}/api/public/promotion/click/p/${promotionId}?${qs.toString()}`;
}

// ── Destination resolver ─────────────────────────────────────────────────

// Given a Promotion row, computes the URL the wrapper redirect should
// 302 to. External promotions return their stored URL verbatim; landing
// page promotions build `${baseUrl}/promotion/${slug}`. Returns null when
// the promo is misconfigured (no URL / no slug) — caller decides what
// to do (redirect to base URL, 404, etc.).
/**
 * The ONE place that decides a landing page's public URL.
 *
 * Path segment depends on the host, so the address reads as a word on the
 * marketing domain: seedlings.pro/motion/<slug> is "pro-motion". Anywhere
 * else stays /promotion/<slug>.
 *
 * Both routes are real Next.js pages and both render the same component, so
 * every URL ever sent to a client keeps working forever — nothing already
 * in someone's inbox breaks when this changes.
 *
 * Deliberately NOT a redirect rule. Prod rewrites live in vercel.json and
 * dev rewrites in next.config.js, and on 2026-08-23 those two silently
 * disagreed for months — every promotion click URL 404'd in production
 * while working perfectly in dev. A real page file cannot drift that way.
 */
export function buildLandingPageUrl(baseUrl: string, slug: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  let host = "";
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    // Malformed base (bad Setting value) — fall back to the long form
    // rather than throwing and killing the click.
  }
  const segment = /(^|\.)seedlings\.pro$/.test(host) ? "motion" : "promotion";
  return `${trimmed}/${segment}/${slug}`;
}

/**
 * A landing-page URL that carries its own click-tracking payload.
 *
 * The invoice CTA uses this instead of the /promotion/click/ wrapper so a
 * visitor's history is simply invoice -> landing, with no intermediate
 * entry for the back button to bounce off (mobile Safari keeps redirect
 * entries; desktop drops them, which is why this only ever broke on
 * phones).
 *
 * The token is the SAME HMAC the wrapper carried, so attribution is
 * unchanged and no new secret is exposed — it authenticates "this click
 * belongs to this promotion + contact" and grants nothing else. The
 * landing page's server render posts it back with ?record=1 and then
 * strips these params from the address bar.
 *
 * Returns null when the page can't be resolved, so the caller falls back
 * to the wrapper rather than emitting a dead link.
 */
export async function buildTrackedLandingUrl(params: {
  promotionId: string;
  landingPageId: string;
  base: string;
  hmacSecret: string;
  contactId: string | null;
}): Promise<string | null> {
  const page = await prisma.promotionLandingPage.findUnique({
    where: { id: params.landingPageId },
    select: { slug: true },
  });
  if (!page) return null;
  const url = new URL(buildLandingPageUrl(params.base, page.slug));
  // Marks the visit as invoice-originated, which is what reveals the
  // "Back to your invoice" bar.
  url.searchParams.set("from", "invoice");
  url.searchParams.set("p", params.promotionId);
  url.searchParams.set("t", signPromoClickToken(params.hmacSecret, params.promotionId, params.contactId));
  if (params.contactId) url.searchParams.set("c", params.contactId);
  return url.toString();
}

export async function resolveDestinationUrl(
  baseUrl: string,
  promo: {
    linkKind: string;
    link: string | null;
    landingPageId: string | null;
  },
  /**
   * Optional host for LANDING pages only (PROMOTION_LANDING_BASE_URL).
   * Empty/omitted keeps the visitor on the domain they arrived from —
   * i.e. exactly the behavior before this option existed.
   *
   * Safe to cross domains here ONLY because landing pages are fully
   * public: no login, no per-domain browser storage. Invoice and app
   * links must never use this.
   */
  landingBaseUrl?: string,
): Promise<{ url: string; destination: "external" | "landing_page" } | null> {
  if (promo.linkKind === "EXTERNAL") {
    if (!promo.link) return null;
    return { url: promo.link, destination: "external" };
  }
  if (promo.linkKind === "LANDING_PAGE") {
    if (!promo.landingPageId) return null;
    const page = await prisma.promotionLandingPage.findUnique({
      where: { id: promo.landingPageId },
      select: { slug: true },
    });
    if (!page) return null;
    const base = (landingBaseUrl ?? "").trim() || baseUrl;
    return { url: buildLandingPageUrl(base, page.slug), destination: "landing_page" };
  }
  return null;
}

// ── Unsubscribe URL builder ──────────────────────────────────────────────

// Static URL to the /opt-out landing page — the client enters their own
// email or phone and we look them up server-side. No per-recipient
// token, no HMAC, nothing to leak or invalidate. Same URL for every
// message; short and stable across campaigns.
//
// Signature preserved (hmacSecret + contactId + channel are still in
// the arg list) so existing callers don't have to change, but only
// baseUrl is actually used. The unused params will get cleaned up when
// callsites are updated.
export function buildUnsubscribeUrl(
  baseUrl: string,
  _hmacSecret: string,
  _contactId: string,
  _channel: PromoChannel,
): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/opt-out`;
}

// ── Footer assembly ──────────────────────────────────────────────────────

export function assembleEmailFooter(params: {
  footerTemplate: string;
  businessAddress: string;
  unsubscribeLink: string;
}): string {
  return params.footerTemplate
    .replace(/\{\{businessAddress\}\}/g, params.businessAddress)
    .replace(/\{\{unsubscribeLink\}\}/g, params.unsubscribeLink);
}

export function assembleSmsFooter(params: {
  footerTemplate: string;
  unsubscribeLink: string;
}): string {
  return params.footerTemplate.replace(/\{\{unsubscribeLink\}\}/g, params.unsubscribeLink);
}

// ── SMS char encoding awareness ──────────────────────────────────────────

// GSM-7 default alphabet + common extensions. Anything outside this set
// forces UCS-2 encoding (70 chars/segment instead of 160). Matches what
// Twilio uses to bill segments.
const GSM7_BASE =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = "\f^{}\\[~]|€";

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASE.includes(ch) && !GSM7_EXT.includes(ch)) return false;
  }
  return true;
}

export function smsSegmentInfo(fullText: string): {
  encoding: "gsm7" | "ucs2";
  chars: number;
  segments: number;
  perSegment: number;
} {
  const gsm = isGsm7(fullText);
  const chars = [...fullText].length;
  const perSegment = gsm ? 160 : 70;
  const perMulti = gsm ? 153 : 67;
  let segments: number;
  if (chars <= perSegment) segments = 1;
  else segments = Math.ceil(chars / perMulti);
  return { encoding: gsm ? "gsm7" : "ucs2", chars, segments, perSegment };
}

// ── Opt-out helpers (audited) ────────────────────────────────────────────

export type OptSource =
  | "client_self_public_page"
  | "client_self_invoice_page"
  | "super_manual"
  | "hard_bounce";

export async function setContactOptOut(params: {
  contactId: string;
  channel: PromoChannel;
  optedOut: boolean;
  source: OptSource;
  actorUserId: string | null;
  reason?: string;
}): Promise<void> {
  const field = params.channel === "email" ? "promoEmailOptedOut" : "promoSmsOptedOut";
  await prisma.$transaction(async (tx) => {
    const contact = await tx.clientContact.findUnique({
      where: { id: params.contactId },
      select: { id: true, clientId: true, [field]: true } as any,
    });
    if (!contact) throw new Error("Contact not found");
    // No-op guard — don't emit an audit row when the state isn't
    // actually changing (e.g. double-clicking an unsubscribe link).
    if ((contact as any)[field] === params.optedOut) return;
    await tx.clientContact.update({
      where: { id: params.contactId },
      data: { [field]: params.optedOut },
    });
    await writeAudit(
      tx,
      params.optedOut ? AUDIT.PROMO_OPT.OPTED_OUT : AUDIT.PROMO_OPT.OPTED_IN,
      params.actorUserId,
      {
        contactId: params.contactId,
        clientId: (contact as any).clientId,
        channel: params.channel,
        source: params.source,
        reason: params.reason ?? null,
      },
    );
  });
}

// Public opt-out by self-supplied identifier (email or phone). Used by
// the /opt-out landing page — client types their email or phone, we
// look up all matching ClientContacts (a person may appear as a
// contact on multiple Clients) and flip BOTH channel flags on every
// match. Idempotent.
//
// Silent-success semantic: returns { matched: 0 } when nothing
// matches. We don't distinguish "already opted out" from "not a
// customer" to the client — same message either way — but the
// server-side audit log has the truth.
export async function optOutByIdentifier(params: {
  identifier: string;
}): Promise<{ matched: number }> {
  const raw = params.identifier.trim();
  if (!raw) return { matched: 0 };
  const isEmail = raw.includes("@");
  const where = isEmail
    ? { email: { equals: raw, mode: "insensitive" as const } }
    : {
        normalizedPhone: normalizePhoneForLookup(raw),
      };
  // Opt-out is orthogonal to contact status — a PAUSED or ARCHIVED
  // contact whose identifier matches still gets the flag flipped so a
  // future re-activation doesn't accidentally resume promo sends.
  const contacts = await prisma.clientContact.findMany({
    where,
    select: {
      id: true,
      promoEmailOptedOut: true,
      promoSmsOptedOut: true,
    },
  });
  let matched = 0;
  for (const c of contacts) {
    // Flip both channels — the client asked to stop, we honor it for
    // every channel we have on file. Each flip runs through
    // setContactOptOut so audits + no-op guards fire consistently.
    if (!c.promoEmailOptedOut) {
      await setContactOptOut({
        contactId: c.id,
        channel: "email",
        optedOut: true,
        source: "client_self_public_page",
        actorUserId: null,
      });
    }
    if (!c.promoSmsOptedOut) {
      await setContactOptOut({
        contactId: c.id,
        channel: "sms",
        optedOut: true,
        source: "client_self_public_page",
        actorUserId: null,
      });
    }
    matched++;
  }
  return { matched };
}

// Best-effort phone normalization for identifier lookup. Strips
// everything except digits and +, so "864-555-1234" and "+1 (864)
// 555-1234" both normalize to a form that has a chance of matching
// the stored normalizedPhone (which uses E.164 like "+18645551234").
// Not perfect — a US caller who types "8645551234" without the +1
// won't match a stored "+18645551234" without additional heuristics.
// Fine for MVP; we can layer country-code inference later.
function normalizePhoneForLookup(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  // Bare 10-digit US number → prepend +1.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

// ── Content snapshot builder ────────────────────────────────────────────

// Assembles the exact body that will ship for one (promotion, channel,
// contact) tuple. Returned snapshot is what gets written to
// PromotionDelivery.contentSnapshot so audit reconstruction is trivial.
/**
 * Resolve the copy a channel actually uses: its own override if it has
 * one, otherwise the shared copy.
 *
 * This is THE place that answers "what does this surface say". Every
 * renderer, dispatcher, and preview must go through it, or the operator's
 * preview stops matching what the client receives.
 *
 * Returns null when neither exists — callers decide whether that's an
 * error (dispatch) or simply nothing to show (display surface).
 */
/**
 * The heading + body a landing page shows.
 *
 * Shared offer copy wins; the page's own headline/intro columns remain as
 * the fallback for promotions authored before the copy collapse.
 *
 * Called by BOTH loadLandingPageForPublic and loadLandingPageForEditor.
 * They previously computed this independently and the editor one never
 * joined `promotion.content` at all — so the editor showed stale columns
 * while the live page showed the real copy. Same offer, two answers.
 */
export function resolveLandingHeader(
  page: { headline: string | null; intro: string | null },
  promotionContent: PromotionContent | null | undefined,
): { headline: string | null; intro: string | null } {
  const shared = (promotionContent ?? {}).shared;
  return {
    // `||` not `??` — an empty string is "unset" here, same as null.
    headline: shared?.headline || page.headline,
    intro: shared?.body || page.intro,
  };
}

export function resolveChannelContent(
  content: PromotionContent,
  channel: "email" | "sms" | "invoice_page",
): { subject?: string; headline?: string; body: string; ctaText: string } | null {
  const shared = content.shared;
  const own = content[channel] as
    | { subject?: string; headline?: string; body?: string; ctaText?: string }
    | undefined;

  // Body is what makes content real. BOTH sides must be trim-checked: a
  // whitespace-only body is "no content", whether it's an override or the
  // shared copy. Checking only the override let `shared: { body: "   " }`
  // resolve to a blank message that would ship to a client.
  const ownBody = own?.body?.trim() ? own.body : undefined;
  const sharedBody = shared?.body?.trim() ? shared.body : undefined;
  const body = ownBody ?? sharedBody;
  if (!body) return null;

  return {
    // Email subject has no shared equivalent — it's email-only. Fall back
    // to the shared headline so a subject line is never empty.
    // `||` not `??` throughout: an empty string means "unset", same as
    // undefined. Mixing the two made the same input resolve two ways
    // depending on which call site you asked.
    subject: (own as any)?.subject || shared?.headline,
    headline: (own as any)?.headline || shared?.headline,
    body,
    ctaText: own?.ctaText?.trim() ? own.ctaText : (shared?.ctaText || ""),
  };
}

export function buildContentSnapshot(params: {
  promotion: {
    link: string | null;
    content: PromotionContent;
  };
  channel: "email" | "sms" | "invoice_page";
  unsubscribeLink: string | null;
  emailFooterTemplate?: string;
  smsFooterTemplate?: string;
  businessAddress?: string;
}): {
  subject?: string;
  headline?: string;
  body: string;
  ctaText: string;
  ctaUrl: string | null;
  footer?: string;
} {
  const { promotion, channel } = params;
  const ctaUrl = promotion.link ?? null;
  if (channel === "email") {
    // Inherits `shared` unless email carries its own override.
    const c = resolveChannelContent(promotion.content, "email");
    if (!c) throw new Error("Email content missing");
    const footer =
      params.unsubscribeLink && params.emailFooterTemplate
        ? assembleEmailFooter({
            footerTemplate: params.emailFooterTemplate,
            businessAddress: params.businessAddress ?? "",
            unsubscribeLink: params.unsubscribeLink,
          })
        : undefined;
    return {
      // A subject is mandatory for email; resolveChannelContent falls back
      // to the shared headline, and this is the last-resort default.
      subject: c.subject || c.headline || "A note from us",
      body: c.body,
      ctaText: c.ctaText,
      ctaUrl,
      footer,
    };
  }
  if (channel === "sms") {
    const c = resolveChannelContent(promotion.content, "sms");
    if (!c) throw new Error("SMS content missing");
    const footer =
      params.unsubscribeLink && params.smsFooterTemplate
        ? assembleSmsFooter({
            footerTemplate: params.smsFooterTemplate,
            unsubscribeLink: params.unsubscribeLink,
          })
        : undefined;
    return {
      body: c.body,
      ctaText: c.ctaText,
      ctaUrl,
      footer,
    };
  }
  // invoice_page
  const c = resolveChannelContent(promotion.content, "invoice_page");
  if (!c) throw new Error("Invoice-page content missing");
  return {
    headline: c.headline,
    body: c.body,
    ctaText: c.ctaText,
    ctaUrl,
  };
}

// ── SMS body renderer (plain text) ──────────────────────────────────────

export function renderSmsPromoBody(snapshot: {
  body: string;
  ctaText: string;
  ctaUrl: string | null;
  footer?: string;
}): string {
  const parts: string[] = [snapshot.body];
  if (snapshot.ctaText && snapshot.ctaUrl) {
    parts.push(`${snapshot.ctaText} ${snapshot.ctaUrl}`);
  } else if (snapshot.ctaUrl) {
    parts.push(snapshot.ctaUrl);
  }
  if (snapshot.footer) parts.push(snapshot.footer);
  return parts.join("\n");
}

// ── Email body renderers (plain text + HTML) ────────────────────────────

// Plain-text body — always shipped as the `text` half of the multipart
// email so text-only clients + spam scanners see the content. Same
// content as the HTML render, minus the button chrome.
export function renderEmailPromoBodyText(snapshot: {
  body: string;
  ctaText: string;
  ctaUrl: string | null;
  footer?: string;
}): string {
  const parts: string[] = [snapshot.body];
  if (snapshot.ctaText && snapshot.ctaUrl) {
    parts.push(`${snapshot.ctaText}: ${snapshot.ctaUrl}`);
  } else if (snapshot.ctaUrl) {
    parts.push(snapshot.ctaUrl);
  }
  if (snapshot.footer) parts.push(snapshot.footer);
  return parts.filter(Boolean).join("\n\n");
}

// HTML body — shipped as the `html` half of the multipart email so
// modern clients render a proper clickable button instead of the raw
// wrapper URL. The CTA button hides the long tracking URL behind the
// operator's chosen label; hover reveals the destination as normal.
//
// Escaping: all snapshot values are HTML-escaped before interpolation
// (belt-and-suspenders — the Zod schema already caps content lengths
// and the Super-only editor is trusted, but escaping keeps the
// rendered mail immune to any accidental HTML in body text).
export function renderEmailPromoBodyHtml(snapshot: {
  body: string;
  ctaText: string;
  ctaUrl: string | null;
  footer?: string;
}): string {
  const esc = (s: string) => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const bodyHtml = esc(snapshot.body).replace(/\n/g, "<br>");
  const cta = snapshot.ctaText && snapshot.ctaUrl
    ? `<p style="margin:24px 0;"><a href="${esc(snapshot.ctaUrl)}" style="display:inline-block;background:#0a7cff;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${esc(snapshot.ctaText)}</a></p>`
    : snapshot.ctaUrl
    ? `<p style="margin:16px 0;"><a href="${esc(snapshot.ctaUrl)}" style="color:#0a7cff;word-break:break-all;">${esc(snapshot.ctaUrl)}</a></p>`
    : "";
  const footerHtml = snapshot.footer
    ? `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;"><p style="font-size:12px;color:#666;line-height:1.5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;white-space:pre-wrap;">${esc(snapshot.footer)}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:600px;margin:0 auto;padding:16px;line-height:1.5;"><div>${bodyHtml}</div>${cta}${footerHtml}</body></html>`;
}

// ── Piggyback dispatcher ────────────────────────────────────────────────

// Called from inside the invoice-send success path (services/paymentRequests.ts)
// AFTER the underlying email/SMS successfully shipped. Runs per-contact,
// per-channel — if the invoice went to two contacts, one via email one
// via SMS, this is called twice.
//
// Behavior:
//   • Load active promotions matching triggerKind="on_invoice_sent" and
//     including the outbound channel in dispatchChannels
//   • For each, check contact's per-channel opt-out flag — skip w/
//     skippedReason="opted_out" if opted out
//   • Cooldown check — skip if (promotion, contact) delivered within
//     cooldownDays; skippedReason="cooldown"
//   • Multi-promo policy — SMS keeps at most 1 (most-recently-started
//     wins; others skip with "sms_multi_promo_limit"); email concats all
//   • For each surviving promotion, write a PromotionDelivery row
//     stamped deliveredAt=now with a contentSnapshot; DO NOT actually
//     send anything (the invoice send already happened — the promo text
//     was appended before send). The caller is responsible for having
//     composed the outbound message body with the promo included.
//
// This function returns the promo-content pieces the caller should append
// to the outbound message body, plus the deliveries to persist AFTER a
// successful send. Design keeps the "did the invoice actually ship?"
// question local to the caller (which knows its send result) while
// centralizing all the promo-selection policy here.
export async function selectPromotionsForPiggyback(params: {
  contactId: string;
  clientId: string;
  channel: PromoChannel;
  triggeredBy: string | null;
  // Persistence mode:
  //   "deferred"           — default. Compute bodyAppend, return writeDeliveries
  //                           thunk. Caller decides when to persist (server path
  //                           only writes after a successful send).
  //   "claimer_immediate" — persist BEFORE returning, using skippedReason=
  //                           "claimer_pending" for rows that will ship (they
  //                           get flipped to delivered by recordClaimerHandoff
  //                           when the worker taps the ack). Same deliveryIds
  //                           get embedded in the wrapper URLs AND persisted,
  //                           so a later click resolves cleanly.
  //                           Idempotent per (triggeredBy, contactId, channel):
  //                           if pending rows already exist, their IDs are
  //                           reused so the wrapper URL from the first call
  //                           still resolves.
  mode?: "deferred" | "claimer_immediate";
}): Promise<{
  bodyAppend: string;
  // HTML variant of bodyAppend for email channel. Empty string when the
  // channel is SMS or no promos survive. Callers sending via HTML-capable
  // transport (Resend) pass this as the `html` option so the CTA renders
  // as a proper button instead of a raw wrapper URL. The plain-text
  // `bodyAppend` is still shipped as the `text` half of the multipart.
  bodyAppendHtml: string;
  emailFooter: string | null;
  smsFooter: string | null;
  writeDeliveries: () => Promise<void>;
}> {
  const mode = params.mode ?? "deferred";
  const settings = await loadPromotionSettings();
  if (!settings.hmacSecret) {
    // Refuse to ship promos without a signed opt-out URL — fail closed.
    return { bodyAppend: "", bodyAppendHtml: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
  }
  // Fail-closed on CAN-SPAM footer settings — refuse to compose ANY
  // promo append if the channel's footer template or business address
  // is missing (email requires both, SMS requires the footer template).
  // See services/promotions.ts note: outbound promos without an opt-out
  // mechanism are a per-message FTC violation.
  if (params.channel === "email" && (!settings.emailFooter || !settings.businessAddress)) {
    return { bodyAppend: "", bodyAppendHtml: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
  }
  if (params.channel === "sms" && !settings.smsFooter) {
    return { bodyAppend: "", bodyAppendHtml: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
  }
  const contact = await prisma.clientContact.findUnique({
    where: { id: params.contactId },
    select: {
      id: true,
      clientId: true,
      promoEmailOptedOut: true,
      promoSmsOptedOut: true,
    },
  });
  if (!contact) {
    return { bodyAppend: "", bodyAppendHtml: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
  }

  // Idempotency map for "claimer_immediate": look up any existing pending
  // rows keyed by (triggeredBy, contactId, channel) and reuse their IDs
  // per-promotion. Without this, a repeat /comms-handoff fetch would
  // insert duplicate pending rows and the URL from the first call would
  // still resolve to the first pending row (fine) — but multiple pending
  // rows would linger and reconciliation-by-token would be ambiguous.
  // Map from promotionId → { deliveryId, shortCode } of the reusable
  // pending row. Both fields must be preserved on reuse so the URL
  // that shipped in the earlier /comms-handoff body still resolves —
  // either the deliveryId (long URL) or the shortCode (short URL)
  // was baked into the outbound message.
  const existingPendingByPromo = new Map<string, { deliveryId: string; shortCode: string | null }>();
  if (mode === "claimer_immediate" && params.triggeredBy) {
    const existing = await prisma.promotionDelivery.findMany({
      where: {
        triggeredBy: params.triggeredBy,
        contactId: contact.id,
        channel: params.channel,
        skippedReason: "claimer_pending",
        deliveredAt: null,
      },
      select: { id: true, promotionId: true, shortCode: true },
    });
    for (const e of existing) {
      existingPendingByPromo.set(e.promotionId, { deliveryId: e.id, shortCode: e.shortCode });
    }
  }
  const now = new Date();
  const activePromos = await prisma.promotion.findMany({
    where: {
      status: "ACTIVE",
      triggerKind: "on_invoice_sent",
      AND: [
        { OR: [{ startAt: null }, { startAt: { lte: now } }] },
        { OR: [{ endAt: null }, { endAt: { gte: now } }] },
      ],
    },
    orderBy: { startedAt: "desc" },
  });

  // Filter to those whose dispatchChannels include our channel.
  const candidates = activePromos.filter((p) => {
    const channels = Array.isArray(p.dispatchChannels)
      ? (p.dispatchChannels as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    return channels.includes(params.channel);
  });

  const optedOut =
    params.channel === "email" ? contact.promoEmailOptedOut : contact.promoSmsOptedOut;

  // Skipped-collection accumulates rows we'll write regardless of send
  // success — for opted-out and multi-promo-limit we want the audit
  // trail even when the invoice send doesn't include the promo.
  //
  // deliveryId is pre-generated (randomUUID) BEFORE the DB write so the
  // wrapper URL that ships in the message body can encode it. writeDeliveries
  // then inserts rows with these explicit ids so the click log resolves
  // cleanly when a recipient taps the CTA.
  type PendingDelivery = {
    deliveryId: string;
    promotionId: string;
    channel: PromoChannel;
    deliver: boolean;
    skippedReason: string | null;
    snapshot: ReturnType<typeof buildContentSnapshot>;
    // Present when the promo has shortSlug set — the per-recipient
    // short code that gets embedded in the short URL AND persisted on
    // the PromotionDelivery row so the click handler can resolve it.
    // Null for long-form (legacy) URLs which use deliveryId directly.
    shortCode: string | null;
  };
  const pending: PendingDelivery[] = [];
  const surviving: {
    promotion: (typeof candidates)[number];
    deliveryId: string;
    snapshot: ReturnType<typeof buildContentSnapshot>;
    shortCode: string | null;
  }[] = [];

  for (const p of candidates) {
    const content = (p.content ?? {}) as PromotionContent;
    // Skip if no content for this channel (should have been caught at save).
    // Resolver gate — see loadInvoicePagePromos. This one was worse: the
    // `continue` fires BEFORE the pending/surviving arrays, so a
    // shared-only promo produced no PromotionDelivery row at all — not
    // even a skip row with a reason. The operator saw zero deliveries and
    // nothing explaining why.
    if (!resolveChannelContent(content, params.channel)) continue;

    // Reuse the existing pending row's IDs when idempotency map has a
    // hit so the wrapper URL that shipped in the earlier /comms-handoff
    // body still resolves to the same delivery. Fresh values otherwise.
    const reused = existingPendingByPromo.get(p.id);
    const deliveryId = reused?.deliveryId ?? randomUUID();
    const unsubscribeLink = buildUnsubscribeUrl(
      settings.baseUrl,
      settings.hmacSecret,
      contact.id,
      params.channel,
    );
    // Every CTA URL shipped to a recipient is a wrapper — never the raw
    // destination.
    //
    // Two URL shapes:
    //   SHORT: promo has shortSlug set. Generates a per-recipient
    //          shortCode + embeds it in /mo/<slug>/<code>. Uses
    //          per-campaign baseDomain when set, else settings.baseUrl.
    //   LONG:  promo has no shortSlug. Uses the legacy HMAC-signed
    //          wrapper /api/public/promotion/click/d/<id>?t=<hmac>.
    //          Backward compat — existing campaigns keep working.
    const outboundBase = p.baseDomain ?? settings.baseUrl;
    let wrapperUrl: string;
    let shortCode: string | null = null;
    if (p.shortSlug) {
      // Reuse the code the earlier /comms-handoff call already baked
      // into the outbound message when we hit the idempotency path —
      // generating a fresh one would leave the earlier URL orphaned.
      shortCode = reused?.shortCode ?? (await generateUniqueShortCode(p.id));
      wrapperUrl = buildShortWrapperUrl(outboundBase, p.shortSlug, shortCode);
    } else {
      wrapperUrl = buildClickWrapperUrl(
        outboundBase,
        settings.hmacSecret,
        deliveryId,
      );
    }
    const snapshot = buildContentSnapshot({
      // Feed the wrapper URL as the promo's link so the snapshot's
      // ctaUrl (what actually ships + what audit shows) is the wrapper.
      promotion: { link: wrapperUrl, content },
      channel: params.channel,
      unsubscribeLink,
      emailFooterTemplate: settings.emailFooter,
      smsFooterTemplate: settings.smsFooter,
      businessAddress: settings.businessAddress,
    });

    if (optedOut) {
      pending.push({
        deliveryId,
        promotionId: p.id,
        channel: params.channel,
        deliver: false,
        skippedReason: "opted_out",
        snapshot,
        shortCode,
      });
      continue;
    }

    // Cooldown check — count recent successful deliveries. Elapsed-time
    // arithmetic on the instant axis (not a business date), so this is
    // a documented exception to the ET-day rule.
    // date-handling-allow: elapsed-time window on the instant axis
    const cutoff = new Date(now.getTime() - p.cooldownDays * 24 * 3600 * 1000);
    const recent = await prisma.promotionDelivery.findFirst({
      where: {
        promotionId: p.id,
        contactId: contact.id,
        channel: params.channel,
        deliveredAt: { gte: cutoff, not: null },
      },
      select: { id: true },
    });
    if (recent) {
      pending.push({
        deliveryId,
        promotionId: p.id,
        channel: params.channel,
        deliver: false,
        skippedReason: "cooldown",
        snapshot,
        shortCode,
      });
      continue;
    }

    surviving.push({ promotion: p, deliveryId, snapshot, shortCode });
  }

  // Multi-promo per-channel policy.
  if (params.channel === "sms" && surviving.length > 1) {
    // Most-recently-started wins (already sorted DESC). Bump the rest to
    // skipped so the audit trail explains what happened.
    for (const runnerUp of surviving.slice(1)) {
      pending.push({
        deliveryId: runnerUp.deliveryId,
        promotionId: runnerUp.promotion.id,
        channel: params.channel,
        deliver: false,
        skippedReason: "sms_multi_promo_limit",
        snapshot: runnerUp.snapshot,
        shortCode: runnerUp.shortCode,
      });
    }
    surviving.length = 1;
  }

  // Build the outbound body append.
  const separator = params.channel === "email" ? "\n\n— — —\n\n" : "\n— — —\n";
  const bodyPieces = surviving.map(({ snapshot }) => {
    if (params.channel === "sms") {
      return renderSmsPromoBody(snapshot);
    }
    // Email plain-text piece: body + `CTA: URL` line. HTML version
    // (below) turns the CTA into a proper button so the recipient
    // doesn't see the raw wrapper URL.
    const parts: string[] = [];
    if (snapshot.body) parts.push(snapshot.body);
    if (snapshot.ctaText && snapshot.ctaUrl) {
      parts.push(`${snapshot.ctaText}: ${snapshot.ctaUrl}`);
    } else if (snapshot.ctaUrl) {
      parts.push(snapshot.ctaUrl);
    }
    return parts.join("\n");
  });

  // Email-only: HTML pieces for the multipart `html` body. SMS never
  // uses HTML. Escaping matches renderEmailPromoBodyHtml (same rules).
  const bodyPiecesHtml =
    params.channel === "email"
      ? surviving.map(({ snapshot }) => {
          const esc = (s: string) => s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
          const bodyHtml = snapshot.body ? esc(snapshot.body).replace(/\n/g, "<br>") : "";
          const cta = snapshot.ctaText && snapshot.ctaUrl
            ? `<p style="margin:16px 0;"><a href="${esc(snapshot.ctaUrl)}" style="display:inline-block;background:#0a7cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">${esc(snapshot.ctaText)}</a></p>`
            : snapshot.ctaUrl
            ? `<p style="margin:12px 0;"><a href="${esc(snapshot.ctaUrl)}" style="color:#0a7cff;word-break:break-all;">${esc(snapshot.ctaUrl)}</a></p>`
            : "";
          return `<div>${bodyHtml}</div>${cta}`;
        })
      : [];

  // Compose the append blob including opt-out footer as the LAST line.
  // Multiple concurrent promos concatenate; a single opt-out footer at
  // the very end applies to all of them (per-channel opt-out semantics).
  let bodyAppend = "";
  let bodyAppendHtml = ""; // populated only for email; caller passes as `html` option
  let emailFooterOut: string | null = null;
  let smsFooterOut: string | null = null;
  if (surviving.length > 0) {
    // Opt-out URL for the FIRST surviving promo's contact — always
    // encodes (contactId, channel), not a specific promotion, so any
    // surviving promo's footer serves.
    const firstUnsubscribeLink = buildUnsubscribeUrl(
      settings.baseUrl,
      settings.hmacSecret,
      contact.id,
      params.channel,
    );
    if (params.channel === "email") {
      emailFooterOut = assembleEmailFooter({
        footerTemplate: settings.emailFooter,
        businessAddress: settings.businessAddress,
        unsubscribeLink: firstUnsubscribeLink,
      });
      bodyAppend = separator + bodyPieces.join(separator) + "\n\n" + emailFooterOut;
      // HTML variant — <hr> separator, joined promo pieces, then the
      // footer with the unsubscribe link as a proper <a>. Escaped
      // footer text; the unsubscribe URL is a plain baseUrl+/opt-out
      // so it's safe to render as an anchor without extra parsing.
      const escFooter = emailFooterOut
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(new RegExp(firstUnsubscribeLink.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
          `<a href="${firstUnsubscribeLink}" style="color:#666;">${firstUnsubscribeLink}</a>`);
      bodyAppendHtml = `<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0;">${bodyPiecesHtml.join('<hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0;">')}<hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0;"><p style="font-size:12px;color:#666;line-height:1.5;white-space:pre-wrap;">${escFooter}</p>`;
    } else {
      // SMS: `renderSmsPromoBody` already appends `snapshot.footer`
      // (which was assembled by `buildContentSnapshot` from
      // settings.smsFooter + unsubscribeLink) — see how bodyPieces is
      // built above. Concatenating smsFooterOut here would double the
      // footer in the outbound message (shipped bug — showed "Opt out:
      // <url>" twice). We still populate smsFooterOut so callers that
      // need the assembled footer for other purposes (audit, tests)
      // get it, but do NOT re-append it to the body.
      smsFooterOut = assembleSmsFooter({
        footerTemplate: settings.smsFooter,
        unsubscribeLink: firstUnsubscribeLink,
      });
      bodyAppend = separator + bodyPieces.join(separator);
    }
    for (const { promotion, deliveryId, snapshot, shortCode } of surviving) {
      pending.push({
        deliveryId,
        promotionId: promotion.id,
        channel: params.channel,
        deliver: true,
        skippedReason: null,
        snapshot,
        shortCode,
      });
    }
  }

  // In "claimer_immediate" mode we persist NOW so the wrapper URL that
  // ships in the outbound body resolves to a real DB row when the
  // recipient taps it — even if the worker never comes back to
  // acknowledge the handoff. Deliverable rows are stamped
  // skippedReason="claimer_pending" (with deliveredAt=null) so
  // recordClaimerHandoff can flip them to delivered without a re-lookup.
  //
  // Skipped rows (opted_out / cooldown / sms_multi_promo_limit) are
  // persisted with their normal reason.
  //
  // Idempotency: rows whose deliveryId came from existingPendingByPromo
  // are UPDATED in place (contentSnapshot may have drifted between
  // /comms-handoff fetches); rows with fresh IDs are inserted with
  // createMany({ skipDuplicates: true }) so a race between two
  // concurrent /comms-handoff fetches lands cleanly.
  if (mode === "claimer_immediate" && pending.length > 0) {
    const reused = pending.filter((p) => existingPendingByPromo.has(p.promotionId));
    const fresh = pending.filter((p) => !existingPendingByPromo.has(p.promotionId));
    // Update in-place for reused rows so contentSnapshot reflects the
    // current promo body (in case the operator edited between fetches).
    for (const r of reused) {
      await prisma.promotionDelivery.update({
        where: { id: r.deliveryId },
        data: {
          contentSnapshot: r.snapshot as any,
          // Deliverable rows stay pending; skipped rows carry their
          // real reason. Never regress a delivered row (guard by only
          // touching rows already at skippedReason=claimer_pending —
          // enforced by the idempotency query filter above).
          skippedReason: r.deliver ? "claimer_pending" : r.skippedReason,
          // Preserve the shortCode when we generated one (reused rows
          // already have it, but be explicit — sets to null if the
          // promo dropped its shortSlug between fetches).
          shortCode: r.shortCode,
        },
      });
    }
    if (fresh.length > 0) {
      await prisma.promotionDelivery.createMany({
        skipDuplicates: true,
        data: fresh.map((p) => ({
          id: p.deliveryId,
          promotionId: p.promotionId,
          clientId: contact.clientId,
          contactId: contact.id,
          channel: p.channel,
          triggeredBy: params.triggeredBy,
          contentSnapshot: p.snapshot as any,
          // Deliverable rows land as claimer_pending; skipped rows
          // carry their real reason. deliveredAt stays null in both
          // cases — recordClaimerHandoff will stamp deliverable rows.
          deliveredAt: null,
          skippedReason: p.deliver ? "claimer_pending" : p.skippedReason,
          shortCode: p.shortCode,
        })),
      });
    }
    // No-op thunk since persistence already happened.
    return {
      bodyAppend,
      bodyAppendHtml,
      emailFooter: emailFooterOut,
      smsFooter: smsFooterOut,
      writeDeliveries: async () => {},
    };
  }

  return {
    bodyAppend,
    bodyAppendHtml,
    emailFooter: emailFooterOut,
    smsFooter: smsFooterOut,
    writeDeliveries: async () => {
      if (pending.length === 0) return;
      await prisma.promotionDelivery.createMany({
        data: pending.map((p) => ({
          id: p.deliveryId,
          promotionId: p.promotionId,
          clientId: contact.clientId,
          contactId: contact.id,
          channel: p.channel,
          triggeredBy: params.triggeredBy,
          contentSnapshot: p.snapshot as any,
          deliveredAt: p.deliver ? new Date() : null,
          skippedReason: p.skippedReason,
          shortCode: p.shortCode,
        })),
      });
    },
  };
}

// ── Manual send burst ────────────────────────────────────────────────────

// Blast a manual_send promotion to its audience. Iterates primary contacts
// per Client, checks opt-out at delivery time (not snapshot time), sends
// via each configured dispatch channel, records deliveries.
export async function runManualSendBurst(params: {
  promotionId: string;
  actorUserId: string;
}): Promise<{ dispatchId: string; sent: number; skipped: number }> {
  const settings = await loadPromotionSettings();
  if (!settings.hmacSecret) {
    throw new Error("Cannot send: PROMOTION_HMAC_SECRET is not configured");
  }
  const promo = await prisma.promotion.findUnique({ where: { id: params.promotionId } });
  if (!promo) throw new Error("Promotion not found");
  if (promo.status !== "ACTIVE") throw new Error("Promotion is not ACTIVE");
  if (promo.triggerKind !== "manual_send") {
    throw new Error("Promotion is not a manual_send trigger");
  }
  // Fail-closed on CAN-SPAM footer settings — same defense as the
  // /start lifecycle gate. Prevents shipping a promo email/SMS with no
  // unsubscribe link + no business address (per-message FTC penalty).
  const dispatchChannelsCheck = Array.isArray(promo.dispatchChannels)
    ? (promo.dispatchChannels as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (dispatchChannelsCheck.includes("email")) {
    if (!settings.emailFooter) throw new Error("Cannot send: PROMOTION_OPT_OUT_FOOTER_EMAIL is not configured");
    if (!settings.businessAddress) throw new Error("Cannot send: BUSINESS_ADDRESS is not configured");
  }
  if (dispatchChannelsCheck.includes("sms") && !settings.smsFooter) {
    throw new Error("Cannot send: PROMOTION_OPT_OUT_FOOTER_SMS is not configured");
  }
  // Fail-closed on the promotion window — if now is outside [startAt,
  // endAt], the operator either forgot to Retire the campaign or is
  // firing it before it should ship. Piggyback and invoice-page display
  // both honor the window; manual burst must too.
  const nowGate = new Date();
  if (promo.startAt && promo.startAt > nowGate) {
    throw new Error(`Cannot send: promotion starts at ${promo.startAt.toISOString()}`);
  }
  if (promo.endAt && promo.endAt < nowGate) {
    throw new Error(`Cannot send: promotion ended at ${promo.endAt.toISOString()}`);
  }
  // Overlap guard — reject if a burst started within the last 5 minutes.
  // Atomic acquire: updateMany with a WHERE clause matching "no
  // in-flight burst" is a single SQL statement, so two concurrent
  // /send-now calls can't both pass the check.
  const dispatchId = randomUUID();
  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000);
  const acquired = await prisma.promotion.updateMany({
    where: {
      id: params.promotionId,
      OR: [
        { lastDispatchStartedAt: null },
        { lastDispatchStartedAt: { lt: staleCutoff } },
      ],
    },
    data: { lastDispatchStartedAt: new Date() },
  });
  if (acquired.count === 0) {
    throw new Error("A send burst is already in progress");
  }

  const dispatchChannels = Array.isArray(promo.dispatchChannels)
    ? (promo.dispatchChannels as unknown[]).filter((c): c is PromoChannel =>
        c === "email" || c === "sms",
      )
    : [];

  // MVP audience: all clients with a primary contact.
  const contacts = await prisma.clientContact.findMany({
    where: {
      status: "ACTIVE",
      isPrimary: true,
      client: { status: "ACTIVE" },
    },
    select: {
      id: true,
      firstName: true,
      email: true,
      normalizedPhone: true,
      phone: true,
      clientId: true,
      promoEmailOptedOut: true,
      promoSmsOptedOut: true,
    },
  });

  const content = (promo.content ?? {}) as PromotionContent;

  let sent = 0;
  let skipped = 0;

  for (const contact of contacts) {
    for (const channel of dispatchChannels) {
      // Resolver gate — same fix as the invoice/piggyback gates. Gating on
      // the raw key made "Send Now" silently no-op on a shared-only promo
      // AFTER consuming the 5-minute dispatch lock, so the retry was
      // blocked for five minutes with no explanation.
      const hasChannelContent = !!resolveChannelContent(content, channel);
      if (!hasChannelContent) continue;
      // Cooldown / idempotency: skip if this (promotion, contact, channel)
      // has a successful delivery within cooldownDays. Same rule the
      // piggyback path applies — protects against
      //   (a) intentional re-run: operator taps Send Now twice
      //   (b) crash-during-burst retry: lastDispatchStartedAt gets
      //       cleared after 5min, retry loops all contacts again.
      // Without this check, both cases result in duplicate sends.
      // Elapsed-time arithmetic on the instant axis (not a business
      // date) so this is a documented exception to the ET-day rule.
      // date-handling-allow: elapsed-time window on the instant axis
      const cooldownCutoff = new Date(Date.now() - promo.cooldownDays * 24 * 3600 * 1000);
      const priorDelivery = await prisma.promotionDelivery.findFirst({
        where: {
          promotionId: promo.id,
          contactId: contact.id,
          channel,
          deliveredAt: { gte: cooldownCutoff, not: null },
        },
        select: { id: true },
      });
      if (priorDelivery) {
        // Record the skip so audit reflects the dedup and the operator
        // can see WHY a given contact was skipped in the delivery log.
        await prisma.promotionDelivery.create({
          data: {
            promotionId: promo.id,
            clientId: contact.clientId,
            contactId: contact.id,
            channel,
            dispatchId,
            contentSnapshot: {} as any,
            skippedReason: "cooldown",
          },
        });
        skipped++;
        continue;
      }
      const optedOut =
        channel === "email" ? contact.promoEmailOptedOut : contact.promoSmsOptedOut;
      const target = channel === "email" ? contact.email : contact.normalizedPhone ?? contact.phone;
      if (!target) {
        await prisma.promotionDelivery.create({
          data: {
            promotionId: promo.id,
            clientId: contact.clientId,
            contactId: contact.id,
            channel,
            dispatchId,
            contentSnapshot: {} as any,
            skippedReason: channel === "email" ? "no_email_on_file" : "no_phone_on_file",
          },
        });
        skipped++;
        continue;
      }
      // Pre-generate the delivery ID so the wrapper URL that ships in
      // the body can encode it — click resolves back to this row.
      const deliveryId = randomUUID();
      const unsubscribeLink = buildUnsubscribeUrl(
        settings.baseUrl,
        settings.hmacSecret,
        contact.id,
        channel,
      );
      // Same short-URL branching as the piggyback path — see comments
      // in selectPromotionsForPiggyback for the rationale.
      const outboundBase = promo.baseDomain ?? settings.baseUrl;
      let wrapperUrl: string;
      let shortCode: string | null = null;
      if (promo.shortSlug) {
        shortCode = await generateUniqueShortCode(promo.id);
        wrapperUrl = buildShortWrapperUrl(outboundBase, promo.shortSlug, shortCode);
      } else {
        wrapperUrl = buildClickWrapperUrl(
          outboundBase,
          settings.hmacSecret,
          deliveryId,
        );
      }
      const snapshot = buildContentSnapshot({
        // Feed the wrapper as the promo's link so ctaUrl in the shipped
        // body + snapshot both point at the tracker.
        promotion: { link: wrapperUrl, content },
        channel,
        unsubscribeLink,
        emailFooterTemplate: settings.emailFooter,
        smsFooterTemplate: settings.smsFooter,
        businessAddress: settings.businessAddress,
      });
      if (optedOut) {
        await prisma.promotionDelivery.create({
          data: {
            id: deliveryId,
            promotionId: promo.id,
            clientId: contact.clientId,
            contactId: contact.id,
            channel,
            dispatchId,
            contentSnapshot: snapshot as any,
            skippedReason: "opted_out",
            shortCode,
          },
        });
        skipped++;
        continue;
      }
      try {
        if (channel === "email") {
          // Ship BOTH text and HTML so modern clients render a proper
          // clickable CTA button (hiding the long tracking URL) while
          // plain-text clients / spam scanners still see the content.
          const emailBody = renderEmailPromoBodyText({
            body: snapshot.body,
            ctaText: snapshot.ctaText,
            ctaUrl: snapshot.ctaUrl,
            footer: snapshot.footer,
          });
          const emailHtml = renderEmailPromoBodyHtml({
            body: snapshot.body,
            ctaText: snapshot.ctaText,
            ctaUrl: snapshot.ctaUrl,
            footer: snapshot.footer,
          });
          const res = await sendEmail(target, snapshot.subject ?? promo.title, emailBody, { html: emailHtml });
          if (!res.ok) throw new Error(res.error ?? "email send failed");
        } else {
          const smsBody = renderSmsPromoBody(snapshot);
          const res = await sendSMS(target, smsBody);
          if (!res.ok) throw new Error(res.error ?? "sms send failed");
        }
        await prisma.promotionDelivery.create({
          data: {
            id: deliveryId,
            promotionId: promo.id,
            clientId: contact.clientId,
            contactId: contact.id,
            channel,
            dispatchId,
            contentSnapshot: snapshot as any,
            deliveredAt: new Date(),
            shortCode,
          },
        });
        sent++;
      } catch (err: any) {
        await prisma.promotionDelivery.create({
          data: {
            id: deliveryId,
            promotionId: promo.id,
            clientId: contact.clientId,
            contactId: contact.id,
            channel,
            dispatchId,
            contentSnapshot: snapshot as any,
            skippedReason: `send_failed:${(err?.message ?? "unknown").slice(0, 80)}`,
            shortCode,
          },
        });
        skipped++;
      }
    }
  }

  // Clear the dispatch lock.
  await prisma.promotion.update({
    where: { id: promo.id },
    data: { lastDispatchStartedAt: null },
  });

  await writeAudit(prisma, AUDIT.PROMOTION.DISPATCHED, params.actorUserId, {
    promotionId: promo.id,
    dispatchId,
    sent,
    skipped,
  });

  return { dispatchId, sent, skipped };
}

// ── Send-to-self test ─────────────────────────────────────────────────────

// Dispatches the promotion's assembled content to the Super's own email
// / phone. Does NOT write PromotionDelivery rows (tests aren't audit
// data). Writes an AuditEvent for the test send itself.
// Test-send mirrors whichever comms mode the org (or Super's own
// profile) is currently on:
//
//   mode="SERVER"  → dispatch via Resend/Twilio server-side. Returns
//                    ok=true with no body payload; the client shows a
//                    plain success toast.
//   mode="CLAIMER" → compose the body server-side and return it +
//                    target. The client opens `sms:`/`mailto:` on the
//                    Super's device to actually send. No Twilio/Resend
//                    involvement.
//
// Uses the same resolveCommsMode helper the invoice flow uses so a
// test always reflects what a real invoice send would do right now.
export async function sendPromotionTest(params: {
  promotionId: string;
  actorUserId: string;
  channel: PromoChannel;
}): Promise<{
  ok: boolean;
  target: string | null;
  mode?: "SERVER" | "CLAIMER";
  subject?: string;
  body?: string;
  error?: string;
}> {
  const settings = await loadPromotionSettings();
  const [promo, actor] = await Promise.all([
    prisma.promotion.findUnique({ where: { id: params.promotionId } }),
    prisma.user.findUnique({
      where: { id: params.actorUserId },
      select: { email: true, phone: true },
    }),
  ]);
  if (!promo) throw new Error("Promotion not found");
  if (!actor) throw new Error("User not found");
  const target = params.channel === "email" ? actor.email : actor.phone;
  if (!target) {
    return { ok: false, target: null, error: "no_target_on_file" };
  }
  const content = (promo.content ?? {}) as PromotionContent;
  // No raw-key check: buildContentSnapshot below resolves through the
  // shared copy and throws its own accurate message when there genuinely
  // is nothing to send. The raw check 500'd on valid shared-only promos —
  // and this is the operator's own test-send affordance.

  // Resolve mode via the shared helper — dynamic import to keep the
  // module boundary clean (promotions.ts imported by paymentRequests.ts
  // for the piggyback path, so a static import would cycle).
  const { services: allServices } = await import(".");
  const mode = await allServices.paymentRequests.resolveCommsMode(params.actorUserId);

  // Use the same static /opt-out URL every real send does — no
  // per-recipient token to fake. Keeps the test message a byte-for-byte
  // preview of what a real recipient would see.
  const unsubscribeLink = buildUnsubscribeUrl(
    settings.baseUrl,
    settings.hmacSecret,
    "unused",
    params.channel,
  );
  // Build a wrapper URL with a sentinel deliveryId so the test message
  // exercises the SAME URL shape a real recipient would see (including
  // the /api/public/ prefix and HMAC). Without this, Super's test view
  // shows the raw destination and any wrapper-shape bug (e.g. missing
  // /api/ prefix that 404s in prod) doesn't surface until a real
  // customer clicks. The sentinel id won't resolve to a delivery row
  // — recordClickAndResolve falls through to anonymous + redirect,
  // which is exactly the forwarded-URL behavior; also fine here.
  //
  // For LANDING_PAGE promos, promo.link is null but the wrapper still
  // resolves correctly (recordClickAndResolve consults linkKind +
  // landingPageId server-side).
  const wrapperUrl = isSecretValid(settings.hmacSecret)
    ? buildClickWrapperUrl(settings.baseUrl, settings.hmacSecret, "test-send-sentinel")
    : promo.link;
  const snapshot = buildContentSnapshot({
    promotion: { link: wrapperUrl, content },
    channel: params.channel,
    unsubscribeLink,
    emailFooterTemplate: settings.emailFooter,
    smsFooterTemplate: settings.smsFooter,
    businessAddress: settings.businessAddress,
  });

  let subject: string | undefined;
  let body: string;
  let html: string | undefined;
  if (params.channel === "email") {
    subject = `[TEST] ${snapshot.subject ?? promo.title}`;
    // Prepend a [TEST] marker to the body so Super sees at a glance
    // that this is a preview, not a real send. Everything else is
    // byte-for-byte identical to what recipients will see.
    const bodyWithTestMarker = `[TEST] This is a test send of a promotional message.\n\n${snapshot.body}`;
    body = renderEmailPromoBodyText({
      body: bodyWithTestMarker,
      ctaText: snapshot.ctaText,
      ctaUrl: snapshot.ctaUrl,
      footer: snapshot.footer,
    });
    html = renderEmailPromoBodyHtml({
      body: bodyWithTestMarker,
      ctaText: snapshot.ctaText,
      ctaUrl: snapshot.ctaUrl,
      footer: snapshot.footer,
    });
  } else {
    body = "[TEST] " + renderSmsPromoBody(snapshot);
  }

  if (mode === "SERVER") {
    // Server-side dispatch via Resend/Twilio. If the underlying
    // provider is misconfigured (e.g. Twilio disabled), surface the
    // real error text — much more useful than a generic "check your X".
    if (params.channel === "email") {
      const res = await sendEmail(target, subject!, body, html ? { html } : undefined);
      if (!res.ok) {
        return { ok: false, target, mode, error: res.error ?? "send_failed" };
      }
    } else {
      const normalized = target.startsWith("+")
        ? target
        : `+1${target.replace(/[^\d]/g, "")}`;
      const res = await sendSMS(normalized, body);
      if (!res.ok) {
        return { ok: false, target: normalized, mode, error: res.error ?? "send_failed" };
      }
    }
    await writeAudit(prisma, AUDIT.PROMOTION.TEST_SENT, params.actorUserId, {
      promotionId: promo.id,
      channel: params.channel,
      mode,
    });
    return { ok: true, target, mode };
  }

  // CLAIMER mode — return the composed content so the client opens
  // the OS `sms:`/`mailto:` intent on the Super's device.
  await writeAudit(prisma, AUDIT.PROMOTION.TEST_SENT, params.actorUserId, {
    promotionId: promo.id,
    channel: params.channel,
    mode,
  });
  return { ok: true, target, mode, subject, body };
}

// ── Invoice-page display fetcher ────────────────────────────────────────

// Returns the currently-active promotions targeting invoice_page display.
// Used by the /public/pay/:token endpoint to render the promo section
// on the invoice page. Returns per-promotion snapshots (headline, body,
// ctaText, ctaUrl) already assembled, ready to render.
// The ctaUrl is a wrapper URL that lands on /promotion/click/p/... and
// logs a PromotionClick with (promotionId, contactId — anonymous if
// contact opts out later or view is unauthenticated).
export async function loadInvoicePagePromos(params: {
  contactId: string | null;
}): Promise<
  {
    id: string;
    headline?: string;
    body: string;
    ctaText: string;
    ctaUrl: string | null;
    /** Cover photo — the first of `imageUrls`. Null when the promo has no
     *  invoice photos uploaded. Kept alongside `imageUrls` so consumers
     *  that only ever wanted one image don't have to index. */
    imageUrl: string | null;
    /** All invoice photos in display order. Uploaded specifically for the
     *  invoice — independent of the landing page's items, which are no
     *  longer consulted for this surface. */
    imageUrls: string[];
  }[]
> {
  // Load the viewing contact's opt-out state (if any) so we can apply
  // per-promo, per-dispatch-channel suppression below. The old logic
  // suppressed ALL invoice-page promos when the contact was opted out of
  // BOTH email and SMS, which incorrectly killed display-only promos
  // (no dispatch channels, purely passive display) — the schema comment
  // explicitly documents that invoice-page display is NOT opt-out gated.
  let optedOutEmail = false;
  let optedOutSms = false;
  if (params.contactId) {
    const contact = await prisma.clientContact.findUnique({
      where: { id: params.contactId },
      select: { promoEmailOptedOut: true, promoSmsOptedOut: true },
    });
    if (contact) {
      optedOutEmail = contact.promoEmailOptedOut;
      optedOutSms = contact.promoSmsOptedOut;
    }
  }
  const settings = await loadPromotionSettings();
  const now = new Date();
  const promos = await prisma.promotion.findMany({
    where: {
      status: "ACTIVE",
      AND: [
        { OR: [{ startAt: null }, { startAt: { lte: now } }] },
        { OR: [{ endAt: null }, { endAt: { gte: now } }] },
      ],
    },
    orderBy: { startedAt: "desc" },
  });
  const out: {
    id: string;
    headline?: string;
    body: string;
    ctaText: string;
    ctaUrl: string | null;
    imageUrl: string | null;
    imageUrls: string[];
  }[] = [];
  for (const p of promos) {
    const surfaces = Array.isArray(p.displaySurfaces)
      ? (p.displaySurfaces as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    if (!surfaces.includes("invoice_page")) continue;
    const content = (p.content ?? {}) as PromotionContent;
    // Gate on the RESOLVER, not the raw key. Gating on `content.invoice_page`
    // meant a promo written with only shared copy saved fine, passed
    // validation, and then silently never appeared on ANY invoice.
    const resolvedInvoice = resolveChannelContent(content, "invoice_page");
    if (!resolvedInvoice) continue;
    // Per-promo suppression: only hide THIS promo if the viewing contact
    // is opted out of ALL of THIS promo's dispatch channels AND this
    // promo actually has dispatch channels. Display-only promos (empty
    // dispatchChannels) always show — invoice-page display is a passive
    // surface, not a dispatch, and is not opt-out gated per the schema
    // comment on PromotionDelivery.
    const dispatchChannels = Array.isArray(p.dispatchChannels)
      ? (p.dispatchChannels as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    if (dispatchChannels.length > 0) {
      const allSuppressed = dispatchChannels.every((ch) => {
        if (ch === "email") return optedOutEmail;
        if (ch === "sms") return optedOutSms;
        return false;
      });
      if (allSuppressed) continue;
    }
    // Build a wrapper URL for the CTA — logs the click before 302 to the
    // resolved destination. Skipped when HMAC secret isn't configured
    // (fail-closed on send-side; same on display-side).
    //
    // Honors the campaign's own domain, exactly like the two dispatch
    // paths do (selectPromotionsForPiggyback and runManualSendBurst both
    // use `baseDomain ?? settings.baseUrl`). This one used settings.baseUrl
    // alone, so a campaign branded to the marketing domain still emitted
    // an invoice CTA on the app domain — the short links in its texts said
    // one host and the button on the invoice said another.
    //
    // Knock-on effect, and the reason this alone gets promos onto one
    // domain end to end: the click handler derives its redirect target
    // from the host the visitor arrived on. Send them to the marketing
    // domain here and the landing page follows automatically — including
    // the /motion/ path, which buildLandingPageUrl picks from the host.
    //
    // Pay links are untouched: those come from PAYMENT_REQUEST_BASE_URL
    // via paymentRequests.ts and never consult baseDomain.
    const clickBase = p.baseDomain ?? settings.baseUrl;
    // For LANDING-PAGE promos, point the CTA STRAIGHT at the landing page
    // and carry the tracking token along; the landing page's server render
    // logs the click (see ?record=1 on the click route).
    //
    // The wrapper hop had to go. It occupied its own history entry on
    // mobile Safari (desktop drops it), so pressing back landed on the
    // wrapper, which fired forward again — the promo page appeared to
    // reload and only a rapid double-press escaped. With no intermediate
    // URL there is nothing to bounce off, on any browser.
    //
    // EXTERNAL promos keep the wrapper: we can't run a server render on
    // someone else's site, so the redirect is the only place to record.
    let wrapperUrl: string | null = null;
    if (settings.hmacSecret) {
      const direct =
        p.linkKind === "LANDING_PAGE" && p.landingPageId
          ? await buildTrackedLandingUrl({
              promotionId: p.id,
              landingPageId: p.landingPageId,
              base: (settings.landingBaseUrl || clickBase),
              hmacSecret: settings.hmacSecret,
              contactId: params.contactId,
            })
          : null;
      wrapperUrl =
        direct ??
        buildInvoicePageClickUrl(clickBase, settings.hmacSecret, p.id, params.contactId);
    }
    const snap = buildContentSnapshot({
      promotion: { link: wrapperUrl, content },
      channel: "invoice_page",
      unsubscribeLink: null,
    });
    // Invoice photos — uploaded for THIS surface specifically. Fetched per
    // surviving promo rather than joined into the list query above, because
    // the vast majority of promos are filtered out by the surface/opt-out
    // checks before reaching here.
    //
    // These used to be derived from the landing page ("first photo of the
    // first item"), which meant reordering landing items or deleting an
    // item's photo silently changed every client's invoice, and left
    // EXTERNAL-link promos (no landing page) unable to show any image at
    // all. Landing item photos are NOT consulted any more.
    const photoRows = await prisma.promotionInvoicePhoto.findMany({
      where: { promotionId: p.id },
      // createdAt tiebreaks concurrent uploads that landed on the same
      // sortOrder — see confirmInvoicePhotoUpload.
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { r2Key: true },
    });
    const signed = await Promise.all(
      photoRows.map((ph) =>
        getDownloadUrl(ph.r2Key, 6 * 3600, "promotion-images").catch(() => null),
      ),
    );
    // A presign failure drops that one image rather than the whole promo.
    const imageUrls = signed.filter((u): u is string => !!u);
    out.push({
      id: p.id,
      headline: snap.headline,
      body: snap.body,
      ctaText: snap.ctaText,
      ctaUrl: snap.ctaUrl,
      // Kept so existing consumers keep working — it's simply the first
      // of imageUrls now (sortOrder 0 = the cover).
      imageUrl: imageUrls[0] ?? null,
      imageUrls,
    });
  }
  return out;
}

// ── Landing page CRUD ────────────────────────────────────────────────────

export type LandingPagePayload = {
  slug?: string; // omitted → auto-slug from parent promotion title
  headline?: string | null;
  intro?: string | null;
};

// Create a landing page for a promotion. Called from the routes layer
// when the operator flips linkKind to LANDING_PAGE (or starts fresh in
// that mode). Idempotent per (promotionId) — returns the existing page
// when one is already linked.
export async function ensureLandingPageForPromotion(params: {
  promotionId: string;
  actorUserId: string;
  seedFromTitle: string;
  payload?: LandingPagePayload;
}): Promise<{ id: string; slug: string }> {
  const existing = await prisma.promotion.findUnique({
    where: { id: params.promotionId },
    select: { landingPageId: true },
  });
  if (existing?.landingPageId) {
    const page = await prisma.promotionLandingPage.findUnique({
      where: { id: existing.landingPageId },
      select: { id: true, slug: true },
    });
    if (page) return page;
  }
  const desiredSlug = params.payload?.slug || params.seedFromTitle;
  const slug = await ensureUniqueSlug(desiredSlug, null);
  const page = await prisma.$transaction(async (tx) => {
    const p = await tx.promotionLandingPage.create({
      data: {
        slug,
        headline: params.payload?.headline ?? null,
        intro: params.payload?.intro ?? null,
        createdById: params.actorUserId,
        updatedById: params.actorUserId,
      },
      select: { id: true, slug: true },
    });
    await tx.promotion.update({
      where: { id: params.promotionId },
      data: { landingPageId: p.id, linkKind: "LANDING_PAGE" },
    });
    // Mints a PUBLIC URL and repoints the campaign's destination at it.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId, {
      action: "landing_page_created",
      promotionId: params.promotionId,
      landingPageId: p.id,
      slug: p.slug,
      linkKind: "LANDING_PAGE",
    });
    return p;
  });
  return page;
}

// Update the landing page's headline/intro/slug. Slug changes are only
// permitted while the parent promotion is DRAFT (locked once ACTIVE so
// shipped URLs stay valid).
export async function updateLandingPage(params: {
  pageId: string;
  actorUserId: string;
  payload: LandingPagePayload;
}): Promise<{ id: string; slug: string }> {
  const page = await prisma.promotionLandingPage.findUnique({
    where: { id: params.pageId },
    select: { id: true, slug: true, promotion: { select: { id: true, status: true } } },
  });
  if (!page) throw new Error("Landing page not found");
  const nextSlug =
    params.payload.slug && params.payload.slug !== page.slug
      ? await (async () => {
          // Lock on FIRST SHIPPED DELIVERY, not on leaving DRAFT.
          //
          // The rule's whole purpose is "URLs already in a client's hands
          // must not 404". Status was only ever a proxy for that, and a
          // bad one: activating a campaign doesn't put the URL anywhere
          // by itself, so an operator who noticed a slug typo right after
          // activating was locked out of fixing a URL nobody had seen.
          //
          // `deliveredAt: { not: null }` is the schema's own definition of
          // shipped (see PromotionDelivery) — a row with deliveredAt null
          // and skippedReason null is still queued, and a skipped row
          // never carried the URL at all. Neither should lock the slug.
          if (page.promotion) {
            // CLOSED is terminal — the whole landing page is read-only,
            // shipped or not. Without this the delivery-count rule alone
            // would make a closed campaign's slug editable again, which
            // the previous status-based guard blocked as a side effect.
            if (page.promotion.status === "CLOSED") {
              throw new Error("Cannot change slug — this promotion is closed.");
            }
            const shipped = await prisma.promotionDelivery.count({
              where: { promotionId: page.promotion.id, deliveredAt: { not: null } },
            });
            if (shipped > 0) {
              throw new Error(
                `Cannot change slug — ${shipped} delivery${shipped === 1 ? "" : "s"} already carry this URL and would 404.`,
              );
            }
          }
          return ensureUniqueSlug(params.payload.slug!, page.id);
        })()
      : page.slug;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.promotionLandingPage.update({
      where: { id: params.pageId },
      data: {
        slug: nextSlug,
        headline: params.payload.headline ?? undefined,
        intro: params.payload.intro ?? undefined,
        updatedById: params.actorUserId,
      },
      select: { id: true, slug: true },
    });
    // A slug change rewrites the PUBLIC URL; headline/intro change what
    // every visitor reads.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId, {
      action: "landing_page_updated",
      promotionId: page.promotion?.id ?? null,
      landingPageId: row.id,
      slugChanged: row.slug !== page.slug,
      fromSlug: row.slug !== page.slug ? page.slug : null,
      toSlug: row.slug !== page.slug ? row.slug : null,
      headlineChanged: params.payload.headline !== undefined,
      introChanged: params.payload.intro !== undefined,
    });
    return row;
  });
  return updated;
}

// Full landing-page read for the editor + public renderer. Includes
// items sorted by ordinal + presigned image URLs.
export async function loadLandingPageForEditor(params: {
  pageId: string;
}): Promise<{
  id: string;
  slug: string;
  headline: string | null;
  intro: string | null;
  viewCount: number;
  /** True once at least one delivery has actually shipped this URL, so the
   *  slug can no longer change. Computed here rather than derived on the
   *  client from status/counts — the editor's enable state and
   *  updateLandingPage's guard must agree, and the only way to guarantee
   *  that is to answer the question once, server-side. */
  slugLocked: boolean;
  /** How many deliveries carry the URL — drives the explanatory copy. */
  shippedDeliveryCount: number;
  items: {
    id: string;
    title: string;
    description: string;
    ordinal: number;
    /** All photos, in display order. Empty array when none. */
    photos: { id: string; url: string | null; contentType: string | null }[];
  }[];
} | null> {
  const page = await prisma.promotionLandingPage.findUnique({
    where: { id: params.pageId },
    include: {
      items: {
        orderBy: { ordinal: "asc" },
        include: { photos: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
      },
      // `content` is required so the editor resolves the SAME header the
      // public page does — see resolveLandingHeader. Omitting it is what
      // made the editor show stale columns.
      promotion: { select: { id: true, content: true } },
    },
  });
  if (!page) return null;
  // Same predicate as updateLandingPage's guard — see the comment there
  // for why shipped-deliveries and not status.
  const shippedDeliveryCount = page.promotion
    ? await prisma.promotionDelivery.count({
        where: { promotionId: page.promotion.id, deliveredAt: { not: null } },
      })
    : 0;
  const items = await Promise.all(
    page.items.map(async (i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      ordinal: i.ordinal,
      photos: await Promise.all(
        i.photos.map(async (ph) => ({
          id: ph.id,
          contentType: ph.contentType,
          url: await getDownloadUrl(ph.r2Key, 6 * 3600, "promotion-images").catch(() => null),
        })),
      ),
    })),
  );
  return {
    id: page.id,
    slug: page.slug,
    ...resolveLandingHeader(page, page.promotion?.content as PromotionContent),
    viewCount: page.viewCount,
    slugLocked: shippedDeliveryCount > 0,
    shippedDeliveryCount,
    items,
  };
}

// Item CRUD — create appends at the end (max ordinal + 1), update
// mutates title/description, delete removes row + best-effort R2 object.
export async function createLandingPageItem(params: {
  pageId: string;
  title: string;
  description: string;
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null;
}): Promise<{ id: string }> {
  const max = await prisma.promotionLandingPageItem.aggregate({
    where: { pageId: params.pageId },
    _max: { ordinal: true },
  });
  const nextOrd = (max._max.ordinal ?? -1) + 1;
  const page = await prisma.promotionLandingPage.findUnique({
    where: { id: params.pageId },
    select: { promotion: { select: { id: true } } },
  });
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.promotionLandingPageItem.create({
      data: {
        pageId: params.pageId,
        title: params.title,
        description: params.description,
        ordinal: nextOrd,
      },
      select: { id: true },
    });
    // Adds a block of copy that renders on the public landing page.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "landing_item_created",
      promotionId: page?.promotion?.id ?? null,
      landingPageId: params.pageId,
      itemId: created.id,
      title: params.title,
      ordinal: nextOrd,
    });
    return created;
  });
  return item;
}

export async function updateLandingPageItem(params: {
  itemId: string;
  title?: string;
  description?: string;
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null;
}): Promise<void> {
  const before = await prisma.promotionLandingPageItem.findUnique({
    where: { id: params.itemId },
    select: {
      title: true,
      description: true,
      pageId: true,
      page: { select: { promotion: { select: { id: true } } } },
    },
  });
  await prisma.$transaction(async (tx) => {
    const after = await tx.promotionLandingPageItem.update({
      where: { id: params.itemId },
      data: {
        title: params.title,
        description: params.description,
      },
      select: { title: true, description: true },
    });
    // Rewrites copy that renders on the public landing page.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "landing_item_updated",
      promotionId: before?.page.promotion?.id ?? null,
      landingPageId: before?.pageId ?? null,
      itemId: params.itemId,
      fromTitle: before?.title ?? null,
      toTitle: after.title,
      fromDescription: before?.description ?? null,
      toDescription: after.description,
    });
  });
}

/**
 * Permanently delete a promotion that never reached anyone.
 *
 * Distinct from Retire, which moves a campaign to CLOSED and keeps it as
 * a record. This removes the row, its landing page, items, photos, and
 * R2 objects outright.
 *
 * GUARD, two tiers:
 *
 *  - No delivery rows at all → ordinary delete. Nothing ever reached a
 *    client, so there is no history to lose.
 *
 *  - ANY delivery rows (shipped OR skipped) → refused unless the caller
 *    passes `overrideConfirmation: "APPROVE"`. A delivery is the record
 *    that a message went to — or was deliberately withheld from — a named
 *    client contact. That is CAN-SPAM-relevant history, and destroying it
 *    to tidy a list is the mistake worth making hard.
 *
 * The override is verified HERE, not only in the UI. The existing
 * type-APPROVE surfaces (payment skip) gate at the UI layer, which is
 * fine for a reversible flag; this one is irreversible and removes audit
 * history, so the server refuses on its own rather than trusting that a
 * client asked the question.
 *
 * Retire remains the right answer for anything that has delivered.
 */
export async function hardDeletePromotion(params: {
  promotionId: string;
  actorUserId: string;
  /** Must be exactly "APPROVE" to delete a promotion that has deliveries. */
  overrideConfirmation?: string | null;
}): Promise<{ deleted: true; deliveriesDestroyed: number }> {
  const promo = await prisma.promotion.findUnique({
    where: { id: params.promotionId },
    select: {
      id: true,
      title: true,
      status: true,
      startedAt: true,
      landingPageId: true,
      // Invoice photos cascade away with the promotion, but their R2
      // objects don't — collect the keys or the files are orphaned
      // forever. Missing this leaked storage on every hard delete.
      invoicePhotos: { select: { r2Key: true } },
      landingPage: {
        select: {
          id: true,
          slug: true,
          items: {
            select: { imageR2Key: true, photos: { select: { r2Key: true } } },
          },
        },
      },
    },
  });
  if (!promo) throw new Error("Promotion not found");

  const deliveryCount = await prisma.promotionDelivery.count({
    where: { promotionId: promo.id },
  });
  if (deliveryCount > 0 && params.overrideConfirmation !== "APPROVE") {
    const err: any = new Error(
      `This promotion has ${deliveryCount} delivery record${deliveryCount === 1 ? "" : "s"}. Deleting it destroys that history permanently. Retire it instead, or type APPROVE to confirm.`,
    );
    // Shaped so the route can return a soft error the UI turns into the
    // type-APPROVE prompt, rather than a dead-end failure.
    err.code = "NEEDS_APPROVE";
    err.deliveryCount = deliveryCount;
    throw err;
  }

  // Collect R2 keys BEFORE the rows go: photo rows cascade away with the
  // landing page, but their stored objects don't.
  const r2Keys = new Set<string>();
  for (const item of promo.landingPage?.items ?? []) {
    for (const ph of item.photos) r2Keys.add(ph.r2Key);
    if (item.imageR2Key) r2Keys.add(item.imageR2Key);
  }
  for (const ph of promo.invoicePhotos) r2Keys.add(ph.r2Key);

  await prisma.$transaction(async (tx) => {
    // The landingPageId FK is Restrict specifically to stop a page being
    // deleted out from under a promotion still pointing at it. Clear the
    // pointer first (same transaction) or the delete fails — see the
    // schema comment on Promotion.landingPageId.
    if (promo.landingPageId) {
      await tx.promotion.update({
        where: { id: promo.id },
        data: { landingPageId: null, linkKind: "EXTERNAL" },
      });
      // Items and their photos cascade from the page.
      await tx.promotionLandingPage.delete({ where: { id: promo.landingPageId } });
    }
    await tx.promotion.delete({ where: { id: promo.id } });
    // Record enough to reconstruct WHAT was deleted — the row itself is
    // gone, so the audit entry is the only remaining trace.
    await writeAudit(tx, AUDIT.PROMOTION.DELETED, params.actorUserId, {
      promotionId: promo.id,
      title: promo.title,
      status: promo.status,
      startedAt: promo.startedAt ? promo.startedAt.toISOString() : null,
      landingSlug: promo.landingPage?.slug ?? null,
      photosDeleted: r2Keys.size,
      // Non-zero only on the override path — the thing a future reader
      // most needs to know is whether real send history was destroyed.
      deliveriesDestroyed: deliveryCount,
      overrideUsed: deliveryCount > 0,
    });
  });

  // Best-effort, outside the transaction: a stranded object costs pennies,
  // a failed request costs the operator their delete.
  //
  // Reference-checked: keys can be shared across records (the invoice-photo
  // backfill seeded rows with landing-item keys, and nothing stops two
  // promotions pointing at the same object). Deleting unconditionally here
  // would destroy another promotion's image as a side effect of deleting
  // this one.
  for (const key of r2Keys) {
    await deleteR2ObjectIfUnreferenced(key);
  }
  return { deleted: true, deliveriesDestroyed: deliveryCount };
}

export async function deleteLandingPageItem(params: {
  itemId: string;
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null;
}): Promise<void> {
  const item = await prisma.promotionLandingPageItem.findUnique({
    where: { id: params.itemId },
    select: {
      title: true,
      description: true,
      ordinal: true,
      pageId: true,
      imageR2Key: true,
      photos: { select: { id: true, r2Key: true } },
      page: { select: { promotion: { select: { id: true } } } },
    },
  });
  // The photo ROWS cascade on delete, but their R2 objects don't — collect
  // the keys before the row disappears or the files are orphaned forever.
  // Includes the deprecated single-image key so pre-migration leftovers
  // still get cleaned up.
  const keys = [
    ...(item?.photos.map((ph) => ph.r2Key) ?? []),
    ...(item?.imageR2Key ? [item.imageR2Key] : []),
  ];
  await prisma.$transaction(async (tx) => {
    await tx.promotionLandingPageItem.delete({ where: { id: params.itemId } });
    // Irreversible: the item row goes, its photo rows cascade away, and
    // the R2 objects are deleted below — this entry is the only record
    // any of it existed.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "landing_item_deleted",
      promotionId: item?.page.promotion?.id ?? null,
      landingPageId: item?.pageId ?? null,
      itemId: params.itemId,
      title: item?.title ?? null,
      description: item?.description ?? null,
      ordinal: item?.ordinal ?? null,
      photoIds: item?.photos.map((ph) => ph.id) ?? [],
      photoR2Keys: [...new Set(keys)],
    });
  });
  for (const key of new Set(keys)) {
    // Reference-checked: an invoice photo may point at this same object
    // (the backfill seeded them from landing-item keys), so deleting an
    // item could otherwise blank out the invoice cover.
    await deleteR2ObjectIfUnreferenced(key);
  }
}

// Reorder a page's items in a single write. Payload is an array of
// itemIds in the desired display order; server assigns ordinal indexes
// 0..N-1. Any items belonging to the page but not in the list are
// pushed to the end (defensive — normal usage passes the full list).
export async function reorderLandingPageItems(params: {
  pageId: string;
  itemIds: string[];
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null;
}): Promise<void> {
  const existing = await prisma.promotionLandingPageItem.findMany({
    where: { pageId: params.pageId },
    select: { id: true },
  });
  const existingSet = new Set(existing.map((i) => i.id));
  const requestedSet = new Set(params.itemIds);
  const ordered = [
    ...params.itemIds.filter((id) => existingSet.has(id)),
    ...existing.filter((i) => !requestedSet.has(i.id)).map((i) => i.id),
  ];
  const page = await prisma.promotionLandingPage.findUnique({
    where: { id: params.pageId },
    select: { promotion: { select: { id: true } } },
  });
  await prisma.$transaction(async (tx) => {
    for (let ordinal = 0; ordinal < ordered.length; ordinal++) {
      await tx.promotionLandingPageItem.update({
        where: { id: ordered[ordinal] },
        data: { ordinal },
      });
    }
    // Changes the order the blocks appear in on the public page.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "landing_items_reordered",
      promotionId: page?.promotion?.id ?? null,
      landingPageId: params.pageId,
      itemIds: ordered,
      count: ordered.length,
    });
  });
}

// Presigned R2 PUT URL for a new item image. Client uploads the
// resized/compressed blob directly to R2 (bypasses our API), then
// confirms with the returned key. 5-minute upload window.
export async function getLandingPageImageUploadUrl(params: {
  promotionId: string;
  itemId: string;
  contentType: string;
}): Promise<{ uploadUrl: string; key: string }> {
  const key = `promotions/${params.promotionId}/items/${params.itemId}/${randomUUID()}`;
  const uploadUrl = await getUploadUrl(key, params.contentType, 300, "promotion-images");
  return { uploadUrl, key };
}

// After a successful client-side upload, persist the R2 key on the
// item. Deletes any previous image (best-effort) so replacements don't
// orphan bytes.
/**
 * Confirm a finished R2 upload by APPENDING it to the item's photos.
 *
 * Replaced the old single-image behavior (overwrite `imageR2Key`, delete
 * the prior object). Items hold many photos now, so a second upload adds
 * rather than destroys — deleting a photo is an explicit action.
 */
export async function confirmLandingPageImageUpload(params: {
  itemId: string;
  key: string;
  contentType: string;
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null;
}): Promise<{ id: string }> {
  const item = await prisma.promotionLandingPageItem.findUnique({
    where: { id: params.itemId },
    select: { pageId: true, page: { select: { promotion: { select: { id: true } } } } },
  });
  const created = await prisma.$transaction(async (tx) => {
    // Append at the end. Aggregate rather than count() so a gap left by a
    // delete can't collide with an existing row.
    //
    // Read INSIDE the transaction: the picker uploads every selected file
    // concurrently, so reading it outside meant simultaneous confirms all
    // saw the same max and all claimed the same sortOrder — making the
    // first photo (the one used for og:image) arbitrary. Reads of these
    // photos also tiebreak on createdAt so ties stay stable rather than
    // shuffling between page loads. Same fix as the invoice photos.
    const max = await tx.promotionLandingPageItemPhoto.aggregate({
      where: { itemId: params.itemId },
      _max: { sortOrder: true },
    });
    const sortOrder = (max._max.sortOrder ?? -1) + 1;
    const row = await tx.promotionLandingPageItemPhoto.create({
      data: {
        itemId: params.itemId,
        r2Key: params.key,
        contentType: params.contentType,
        sortOrder,
      },
      select: { id: true },
    });
    // Publishes an image onto the public landing page.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "landing_photo_added",
      promotionId: item?.page.promotion?.id ?? null,
      landingPageId: item?.pageId ?? null,
      itemId: params.itemId,
      photoId: row.id,
      r2Key: params.key,
      contentType: params.contentType,
      sortOrder,
    });
    return row;
  });
  return created;
}

/** Delete one photo, and its R2 object best-effort. */
export async function deleteLandingPageItemPhoto(
  photoId: string,
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null,
): Promise<void> {
  const photo = await prisma.promotionLandingPageItemPhoto.findUnique({
    where: { id: photoId },
    select: {
      r2Key: true,
      contentType: true,
      itemId: true,
      item: {
        select: { pageId: true, page: { select: { promotion: { select: { id: true } } } } },
      },
    },
  });
  if (!photo) return;
  await prisma.$transaction(async (tx) => {
    await tx.promotionLandingPageItemPhoto.delete({ where: { id: photoId } });
    // Irreversible: the row goes and the R2 object is deleted right
    // below, so the key recorded here is the only trace of the image.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, actorUserId ?? null, {
      action: "landing_photo_deleted",
      promotionId: photo.item.page.promotion?.id ?? null,
      landingPageId: photo.item.pageId,
      itemId: photo.itemId,
      photoId,
      r2Key: photo.r2Key,
      contentType: photo.contentType,
    });
  });
  // Same shared-object hazard as deleteInvoicePhoto, in the other
  // direction: the invoice-photo backfill copied landing item keys, so a
  // landing photo's bytes may also be serving as an invoice cover. Only the
  // last reference standing may destroy them.
  await deleteR2ObjectIfUnreferenced(photo.r2Key);
}

/**
 * Reorder an item's photos to exactly the given id sequence.
 *
 * Ignores ids that don't belong to the item, so a stale client can't
 * reassign another item's photo. Any photo omitted from the list keeps a
 * stable position AFTER the listed ones rather than vanishing.
 */
export async function reorderLandingPageItemPhotos(params: {
  itemId: string;
  photoIds: string[];
  /** Optional so existing callers keep compiling; audit falls back to null. */
  actorUserId?: string | null;
}): Promise<void> {
  const owned = await prisma.promotionLandingPageItemPhoto.findMany({
    where: { itemId: params.itemId },
    select: { id: true },
    // createdAt tiebreaks concurrent uploads that landed on the same
    // sortOrder — see confirmLandingPageImageUpload.
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const ownedIds = new Set(owned.map((p) => p.id));
  const ordered = params.photoIds.filter((id) => ownedIds.has(id));
  const rest = owned.map((p) => p.id).filter((id) => !ordered.includes(id));
  const finalOrder = [...ordered, ...rest];
  const item = await prisma.promotionLandingPageItem.findUnique({
    where: { id: params.itemId },
    select: { pageId: true, page: { select: { promotion: { select: { id: true } } } } },
  });
  await prisma.$transaction(async (tx) => {
    for (let idx = 0; idx < finalOrder.length; idx++) {
      await tx.promotionLandingPageItemPhoto.update({
        where: { id: finalOrder[idx] },
        data: { sortOrder: idx },
      });
    }
    // Changes which image leads the item (and therefore the og:image on
    // the public page).
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "landing_photos_reordered",
      promotionId: item?.page.promotion?.id ?? null,
      landingPageId: item?.pageId ?? null,
      itemId: params.itemId,
      photoIds: finalOrder,
      count: finalOrder.length,
    });
  });
}

// ── Invoice photos ───────────────────────────────────────────────────────
//
// Photos rendered with a promotion on the client's invoice page. These are
// uploaded independently of the landing page's items.
//
// The invoice cover used to be derived — "first photo of the first landing
// item". That made two unrelated surfaces move together: reordering landing
// items, or deleting one item's first photo, silently changed what every
// client saw on their invoice, with nothing in the UI saying so. It also
// meant EXTERNAL-link promos (no landing page) could never show an image at
// all. These four functions mirror the landing-item photo flow exactly, so
// the presign → confirm → delete → reorder contract is identical.

/**
 * Presigned R2 PUT URL for a new invoice photo. Client uploads the
 * resized blob straight to R2, then confirms with the returned key.
 * 5-minute window, same as every other photo surface.
 */
export async function getInvoicePhotoUploadUrl(params: {
  promotionId: string;
  contentType: string;
}): Promise<{ uploadUrl: string; key: string }> {
  const key = `promotions/${params.promotionId}/invoice/${randomUUID()}`;
  const uploadUrl = await getUploadUrl(key, params.contentType, 300, "promotion-images");
  return { uploadUrl, key };
}

/**
 * Persist a finished upload by APPENDING it to the promotion's invoice
 * photos. Appends rather than replaces — removing a photo is an explicit
 * action, never a side effect of adding one.
 */
export async function confirmInvoicePhotoUpload(params: {
  promotionId: string;
  key: string;
  contentType: string;
  actorUserId?: string | null;
}): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    // Read the max INSIDE the transaction. The picker uploads every
    // selected file concurrently, so reading it outside meant five
    // simultaneous confirms all saw the same max and all claimed the same
    // sortOrder — leaving "which photo is the cover" up to chance.
    //
    // This narrows the window but doesn't close it (no row lock), so every
    // read of these photos also tiebreaks on createdAt. Ties are therefore
    // stable rather than arbitrary, which is what actually matters here:
    // an operator can always reorder, but the order must not shuffle on
    // its own between page loads.
    const max = await tx.promotionInvoicePhoto.aggregate({
      where: { promotionId: params.promotionId },
      _max: { sortOrder: true },
    });
    const sortOrder = (max._max.sortOrder ?? -1) + 1;
    const row = await tx.promotionInvoicePhoto.create({
      data: {
        promotionId: params.promotionId,
        r2Key: params.key,
        contentType: params.contentType,
        sortOrder,
      },
      select: { id: true },
    });
    // Publishes an image onto a client-facing invoice.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "invoice_photo_added",
      promotionId: params.promotionId,
      photoId: row.id,
      r2Key: params.key,
      contentType: params.contentType,
      sortOrder,
      // sortOrder 0 is the cover rendered beside the promo text.
      isCover: sortOrder === 0,
    });
    return row;
  });
}

/** Delete one invoice photo, and its R2 object best-effort. */
export async function deleteInvoicePhoto(
  photoId: string,
  actorUserId?: string | null,
): Promise<void> {
  const photo = await prisma.promotionInvoicePhoto.findUnique({
    where: { id: photoId },
    select: { r2Key: true, contentType: true, promotionId: true, sortOrder: true },
  });
  if (!photo) return;
  await prisma.$transaction(async (tx) => {
    await tx.promotionInvoicePhoto.delete({ where: { id: photoId } });
    // Irreversible: the row goes and the R2 object is deleted below, so
    // the key recorded here is the only remaining trace of the image.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, actorUserId ?? null, {
      action: "invoice_photo_deleted",
      promotionId: photo.promotionId,
      photoId,
      r2Key: photo.r2Key,
      contentType: photo.contentType,
      sortOrder: photo.sortOrder,
      wasCover: photo.sortOrder === 0,
    });
  });
  // Only destroy the stored object when NOTHING else points at it.
  //
  // r2Key is a pointer, not ownership. The add_promotion_invoice_photos
  // backfill seeded invoice photos by copying the landing item's key, so a
  // single R2 object is referenced by rows in BOTH tables. Deleting
  // unconditionally here nuked the bytes out from under the landing page —
  // the operator removed an invoice cover and their landing item photos
  // went to broken-image icons.
  //
  // A stranded object costs pennies; a destroyed one costs the operator
  // their photo. Bias to leaving it.
  await deleteR2ObjectIfUnreferenced(photo.r2Key);
}

/**
 * Delete an R2 object ONLY if no surviving row in either photo table still
 * references its key. Call AFTER the owning row is deleted.
 *
 * Both tables can legitimately point at the same key (see the backfill in
 * add_promotion_invoice_photos), so ownership of the bytes is shared and
 * the last reference standing is the only one allowed to delete.
 */
async function deleteR2ObjectIfUnreferenced(r2Key: string): Promise<void> {
  const [stillInvoice, stillLanding] = await Promise.all([
    prisma.promotionInvoicePhoto.count({ where: { r2Key } }),
    prisma.promotionLandingPageItemPhoto.count({ where: { r2Key } }),
  ]);
  if (stillInvoice > 0 || stillLanding > 0) return;
  // Best-effort: a failed delete strands bytes, which is recoverable.
  void deleteObject(r2Key, "promotion-images").catch(() => {});
}

/**
 * Reorder a promotion's invoice photos to exactly the given id sequence.
 *
 * Ignores ids belonging to another promotion, so a stale client can't
 * reassign someone else's photo. Photos omitted from the list keep a
 * stable position AFTER the listed ones rather than vanishing.
 */
export async function reorderInvoicePhotos(params: {
  promotionId: string;
  photoIds: string[];
  actorUserId?: string | null;
}): Promise<void> {
  const owned = await prisma.promotionInvoicePhoto.findMany({
    where: { promotionId: params.promotionId },
    select: { id: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const ownedIds = new Set(owned.map((p) => p.id));
  const ordered = params.photoIds.filter((id) => ownedIds.has(id));
  const rest = owned.map((p) => p.id).filter((id) => !ordered.includes(id));
  const finalOrder = [...ordered, ...rest];
  await prisma.$transaction(async (tx) => {
    for (let idx = 0; idx < finalOrder.length; idx++) {
      await tx.promotionInvoicePhoto.update({
        where: { id: finalOrder[idx] },
        data: { sortOrder: idx },
      });
    }
    // Changes which image leads on every client's invoice.
    await writeAudit(tx, AUDIT.PROMOTION.EDITED, params.actorUserId ?? null, {
      action: "invoice_photos_reordered",
      promotionId: params.promotionId,
      photoIds: finalOrder,
      count: finalOrder.length,
    });
  });
}

/** All invoice photos for a promotion, in display order, with signed URLs. */
export async function listInvoicePhotos(promotionId: string): Promise<
  { id: string; url: string | null; contentType: string | null; sortOrder: number }[]
> {
  const rows = await prisma.promotionInvoicePhoto.findMany({
    where: { promotionId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, r2Key: true, contentType: true, sortOrder: true },
  });
  return Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      url: await getDownloadUrl(r.r2Key, 6 * 3600, "promotion-images").catch(() => null),
      contentType: r.contentType,
      sortOrder: r.sortOrder,
    })),
  );
}

// ── Click recorder ───────────────────────────────────────────────────────

// Called from the wrapper redirect endpoint. Resolves the click to a
// specific delivery + contact when the HMAC verifies, otherwise falls
// back to anonymous. Always writes a PromotionClick row.
//
// Returns the resolved destination URL for the caller's 302 response,
// or null when the promotion has no valid destination (misconfigured);
// caller decides the fallback in that case.
export async function recordClickAndResolve(params: {
  flavor: "d" | "p";
  // For d-flavor: deliveryId to resolve. For p-flavor: promotionId.
  primaryId: string;
  // For p-flavor: contactId that came in the URL (optional).
  contactId?: string | null;
  // Signed token that came with the request. If verify fails we log
  // anonymously and still 302.
  token: string;
  // Optional sticky-domain inputs — when present, landing-page
  // destinations are built with this host+protocol instead of the
  // primary from PAYMENT_REQUEST_BASE_URL. Prevents dev clicks from
  // 302ing to the prod domain (which fails to load) — same fix the
  // short-URL flow uses. Callers that don't pass these get the legacy
  // primary-baseUrl behavior.
  requestHost?: string | null;
  requestProtocol?: string | null;
  userAgent: string | null;
  ipAddress: string | null;
}): Promise<{ destinationUrl: string | null; destination: "external" | "landing_page" | null }> {
  const settings = await loadPromotionSettings();
  const ipHash = params.ipAddress
    ? createHash("sha256").update(params.ipAddress).digest("hex")
    : null;
  let promotionId: string | null = null;
  let deliveryId: string | null = null;
  let contactId: string | null = null;
  let clientId: string | null = null;
  let anonymousReason: string | null = null;

  if (params.flavor === "d") {
    // Delivery-flavor: verify HMAC over deliveryId, then look up the
    // delivery row to resolve promotionId/contactId/clientId.
    const verified = settings.hmacSecret
      ? verifyDeliveryClickToken(settings.hmacSecret, params.primaryId, params.token)
      : false;
    if (verified) {
      const delivery = await prisma.promotionDelivery.findUnique({
        where: { id: params.primaryId },
        select: { promotionId: true, contactId: true, clientId: true },
      });
      if (delivery) {
        promotionId = delivery.promotionId;
        deliveryId = params.primaryId;
        contactId = delivery.contactId;
        clientId = delivery.clientId;
      } else {
        anonymousReason = "delivery_not_found";
      }
    } else {
      anonymousReason = "forwarded_or_manual_share";
    }
  } else {
    // Promo-flavor: verify HMAC over (promotionId, contactId).
    const verified = settings.hmacSecret
      ? verifyPromoClickToken(
          settings.hmacSecret,
          params.primaryId,
          params.contactId ?? null,
          params.token,
        )
      : false;
    if (verified) {
      promotionId = params.primaryId;
      contactId = params.contactId ?? null;
      if (contactId) {
        const contact = await prisma.clientContact.findUnique({
          where: { id: contactId },
          select: { clientId: true },
        });
        clientId = contact?.clientId ?? null;
      }
    } else {
      // SECURITY: on HMAC failure we do NOT trust the URL-supplied
      // promotionId — otherwise an attacker who guesses any promo id
      // could inflate its click counters from anywhere (the URL path
      // is not signed). We STILL redirect the browser (best-effort UX
      // on a forwarded/shared link) BUT we do NOT write a
      // PromotionClick row so aggregate counters stay honest.
      //
      // Compare with the d-flavor path: there, the token signs the
      // deliveryId itself, so an unverified token means we can't even
      // resolve which delivery this was — we naturally can't inflate
      // per-delivery counts. p-flavor URLs put the promoId in the path,
      // which is what the attacker can guess, hence this defense.
      const claimedPromo = await prisma.promotion.findUnique({
        where: { id: params.primaryId },
        select: { id: true, linkKind: true, link: true, landingPageId: true },
      });
      if (!claimedPromo) {
        // Unknown promo id AND bad token — no signal at all. Return
        // null so caller sends the browser to the base URL.
        return { destinationUrl: null, destination: null };
      }
      // Redirect but don't attribute. Sticky-domain same as the
      // verified path below.
      const anonBase = params.requestHost && params.requestProtocol
        ? `${params.requestProtocol}://${params.requestHost}`
        : settings.baseUrl;
      const resolvedAnon = await resolveDestinationUrl(anonBase, claimedPromo, settings.landingBaseUrl);
      return {
        destinationUrl: resolvedAnon?.url ?? null,
        destination: resolvedAnon?.destination ?? null,
      };
    }
  }

  if (!promotionId) {
    // No promotion id resolvable — nothing to redirect to.
    return { destinationUrl: null, destination: null };
  }

  // Resolve the destination. Even if the click was anonymous or the
  // delivery vanished, the promotion still has its configured URL.
  const promo = await prisma.promotion.findUnique({
    where: { id: promotionId },
    select: { linkKind: true, link: true, landingPageId: true, status: true },
  });
  if (!promo) return { destinationUrl: null, destination: null };
  // Sticky-domain base — use the visitor's actual host+protocol when
  // available so a click landing on localhost dev routes back to
  // localhost, not the prod PAYMENT_REQUEST_BASE_URL. Falls back to
  // the primary baseUrl for existing callsites that don't pass these.
  const destBase = params.requestHost && params.requestProtocol
    ? `${params.requestProtocol}://${params.requestHost}`
    : settings.baseUrl;
  const resolved = await resolveDestinationUrl(destBase, promo, settings.landingBaseUrl);

  await prisma.promotionClick.create({
    data: {
      promotionId,
      deliveryId,
      contactId,
      clientId,
      destination: resolved?.destination ?? "external",
      destinationUrl: resolved?.url ?? "",
      anonymousReason,
      userAgent: params.userAgent ?? undefined,
      ipHash: ipHash ?? undefined,
    },
  });

  return {
    destinationUrl: resolved?.url ?? null,
    destination: resolved?.destination ?? null,
  };
}

// Bump the landing page's viewCount on each render of /promotion/<slug>.
// Kept separate from click tracking — measures "someone actually looked
// at the page" (can double-count on refresh).
export async function incrementLandingPageViewCount(slug: string): Promise<void> {
  await prisma.promotionLandingPage.updateMany({
    where: { slug },
    data: { viewCount: { increment: 1 } },
  });
}

// ── Short URL click resolver ─────────────────────────────────────────────
//
// Handles clicks to `/mo/<slug>/<code>` (per-recipient) and `/mo/<slug>`
// (anonymous shareable). Unlike the older /d/ and /p/ flavors, this
// flow doesn't use HMAC — the shortCode itself is the auth (unique per
// promotion, ~1.7M combinations, rate-limited). The tradeoff is that
// per-recipient attribution CAN be poisoned by an attacker enumerating
// codes, but at 30 req/min per IP the code space takes ~40 days to
// exhaust — acceptable for a small business with no targeted-attack
// motive against click stats.
//
// Behavior:
//   1. Look up promotion by shortSlug. Not found → 404 (null destination).
//   2. Reject if status !== ACTIVE or outside startAt/endAt window.
//   3. If code provided: look up delivery in this promotion. Found →
//      attribute click to it. Not found → log anonymous with
//      reason="short_code_not_found".
//   4. If code omitted: log anonymous with reason="anonymous_slug_only".
//   5. Resolve destination URL. Use requestHost for landing-page
//      destinations (sticky domain — visitor stays on whichever
//      domain they clicked from). External URLs are returned verbatim.
//
// Non-ACTIVE / out-of-window returns null destination — the caller
// handles the 404 response.
export async function recordShortClickAndResolve(params: {
  slug: string;
  code: string | null;
  requestHost: string;
  // Fastify's request.protocol — respects trustProxy so it's "https"
  // behind Vercel edge, "http" on localhost dev. Used to build the
  // sticky-domain destination URL for landing-page destinations so
  // dev + prod both hit the correct scheme.
  requestProtocol: string;
  userAgent: string | null;
  ipAddress: string | null;
}): Promise<{ destinationUrl: string | null; destination: "external" | "landing_page" | null }> {
  const ipHash = params.ipAddress
    ? createHash("sha256").update(params.ipAddress).digest("hex")
    : null;

  const promo = await prisma.promotion.findUnique({
    where: { shortSlug: params.slug.toLowerCase() },
    select: {
      id: true,
      status: true,
      startAt: true,
      endAt: true,
      linkKind: true,
      link: true,
      landingPageId: true,
    },
  });
  if (!promo) return { destinationUrl: null, destination: null };

  // Status + window gate. Matches piggyback / manual-send / invoice-page
  // behavior — only ACTIVE campaigns within their window are clickable.
  const now = new Date();
  const active =
    promo.status === "ACTIVE" &&
    (!promo.startAt || promo.startAt <= now) &&
    (!promo.endAt || promo.endAt >= now);
  if (!active) return { destinationUrl: null, destination: null };

  // Attribution: look up delivery by code within this promotion.
  let deliveryId: string | null = null;
  let contactId: string | null = null;
  let clientId: string | null = null;
  let anonymousReason: string | null = null;
  if (params.code) {
    const delivery = await prisma.promotionDelivery.findUnique({
      where: {
        promotionId_shortCode: {
          promotionId: promo.id,
          shortCode: params.code.toLowerCase(),
        },
      },
      select: { id: true, contactId: true, clientId: true },
    });
    if (delivery) {
      deliveryId = delivery.id;
      contactId = delivery.contactId;
      clientId = delivery.clientId;
    } else {
      // Valid slug + unknown code = someone guessed or the delivery
      // was purged. Log as anonymous with a distinct reason so
      // attribution reports can distinguish this from the intentional
      // slug-only shareable flow.
      anonymousReason = "short_code_not_found";
    }
  } else {
    anonymousReason = "anonymous_slug_only";
  }

  // Destination — use the request Host + Protocol for landing-page
  // URLs (sticky domain: visitor came in on seedlings.pro, stays on
  // seedlings.pro; localhost:3000 stays on localhost:3000). External
  // URLs are returned verbatim regardless of host.
  //
  // Preserve the port (don't strip it) — localhost dev is on :3000,
  // stripping the port produces an unreachable `http://localhost/`.
  // The protocol comes from Fastify's req.protocol which is
  // trustProxy-aware (https behind Vercel, http on localhost).
  const destBase = params.requestHost
    ? `${params.requestProtocol}://${params.requestHost}`
    : "";
  // Landing-page host override (PROMOTION_LANDING_BASE_URL). Loaded here
  // rather than threaded in, because this path doesn't otherwise need
  // settings — and an unset key means "behave exactly as before".
  const { landingBaseUrl } = await loadPromotionSettings();
  const resolved = await resolveDestinationUrl(
    destBase,
    {
      linkKind: promo.linkKind,
      link: promo.link,
      landingPageId: promo.landingPageId,
    },
    landingBaseUrl,
  );

  await prisma.promotionClick.create({
    data: {
      promotionId: promo.id,
      deliveryId,
      contactId,
      clientId,
      destination: resolved?.destination ?? "external",
      destinationUrl: resolved?.url ?? "",
      anonymousReason,
      userAgent: params.userAgent ?? undefined,
      ipHash: ipHash ?? undefined,
    },
  });

  return {
    destinationUrl: resolved?.url ?? null,
    destination: resolved?.destination ?? null,
  };
}

// Public loader for a landing page by slug. Only returns the page when
// its parent promotion is ACTIVE and within the window — DRAFT/PAUSED/
// CLOSED promotions render as "This offer has ended" client-side.
export async function loadLandingPageForPublic(
  slug: string,
  opts?: {
    /** Set only after the ROUTE has verified a preview token for this
     *  exact slug. Bypasses the ACTIVE gate so the operator can see their
     *  own draft. Never derive this from user input directly. */
    previewUnlocked?: boolean;
  },
): Promise<{
  headline: string | null;
  intro: string | null;
  items: {
    id: string;
    title: string;
    description: string;
    /** All photos in display order. The first doubles as the og:image. */
    photos: { id: string; url: string }[];
  }[];
  promotionActive: boolean;
  /** Why the page isn't live, when promotionActive is false. Coarse on
   *  purpose — enough for the visitor to get an accurate message, with no
   *  campaign copy, imagery, dates, or contact info attached. Null while
   *  the promotion IS live.
   *
   *  This leaks nothing new: a non-existent slug already 404s, so whether
   *  a slug exists is public either way. What the privacy short-circuit
   *  below protects is the CONTENT, and that stays withheld. */
  inactiveReason: "not_started" | "ended" | "unavailable" | null;
  /** True when this content is being shown via an operator preview token
   *  rather than because the promotion is live. */
  preview: boolean;
  /** Button label from the shared offer copy. Null when unset. */
  ctaText: string | null;
  // Business contact block from Settings — always populated (fields
  // that aren't configured are empty strings / empty arrays). Rendered
  // as a "Get in touch" footer on the landing page so clients can
  // reach the operator directly from the promo.
  business: {
    name: string;
    phone: string;
    email: string;
    address: string;
    socialLinks: { label: string; url: string; iconDataUrl: string }[];
  };
} | null> {
  const page = await prisma.promotionLandingPage.findUnique({
    where: { slug },
    include: {
      items: {
        orderBy: { ordinal: "asc" },
        include: { photos: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
      },
      promotion: {
        // `content` carries the shared offer copy — the landing page header
        // renders from it so the operator writes title/description ONCE and
        // both this page and the invoice block show the same words.
        select: { status: true, startAt: true, endAt: true, content: true },
      },
    },
  });
  if (!page) return null;
  const now = new Date();
  // Preview bypass — a valid, unexpired, slug-scoped token lets the
  // operator see their own unpublished page. Deliberately does NOT set
  // promotionActive: the page must still render as a preview (banner,
  // no view-count bump), never as a live offer.
  const previewUnlocked = opts?.previewUnlocked === true;

  const promotionActive =
    !!page.promotion &&
    page.promotion.status === "ACTIVE" &&
    (!page.promotion.startAt || page.promotion.startAt <= now) &&
    (!page.promotion.endAt || page.promotion.endAt >= now);

  // Distinguish "not yet" from "over". A DRAFT campaign, or an ACTIVE one
  // whose window hasn't opened, has NOT ended — telling a visitor (or the
  // operator previewing their own draft) that it has is simply wrong.
  const inactiveReason: "not_started" | "ended" | "unavailable" | null = promotionActive
    ? null
    : !page.promotion
      ? "unavailable"
      : page.promotion.status === "DRAFT" ||
        (page.promotion.startAt != null && page.promotion.startAt > now)
        ? "not_started"
        : page.promotion.status === "CLOSED" ||
          (page.promotion.endAt != null && page.promotion.endAt < now)
          ? "ended"
          // PAUSED, or anything else that isn't cleanly before/after the
          // window — "not available right now" is the honest answer.
          : "unavailable";

  // PRIVACY: when the parent promotion isn't ACTIVE (or the window has
  // closed / hasn't opened), short-circuit and return an empty shell
  // with promotionActive=false. Otherwise slugs — which are auto-derived
  // kebab-case of the campaign title, easy to guess — would leak in-
  // progress copy, item images, and business contact info to anyone who
  // fetches by name.
  //
  // The frontend renders "This offer has ended" for promotionActive=false
  // and never reads the other fields, so returning empty values here
  // matches what the client actually needs while denying enumeration.
  if (!promotionActive && !previewUnlocked) {
    return {
      headline: null,
      intro: null,
      items: [],
      promotionActive: false,
      inactiveReason,
      preview: false,
      ctaText: null,
      business: { name: "", phone: "", email: "", address: "", socialLinks: [] },
    };
  }

  const items = await Promise.all(
    page.items.map(async (i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      // A photo whose presign fails is dropped rather than rendered as a
      // broken tile — the grid should never show an empty square.
      photos: (
        await Promise.all(
          i.photos.map(async (ph) => {
            const url = await getDownloadUrl(ph.r2Key, 6 * 3600, "promotion-images").catch(
              () => null,
            );
            return url ? { id: ph.id, url } : null;
          }),
        )
      ).filter((ph): ph is { id: string; url: string } => ph !== null),
    })),
  );
  // Business contact fields — same keys the pay page + client-facing
  // statements pull from. Loaded in one query so the render is a
  // single round-trip.
  const bizKeys = ["BUSINESS_NAME", "BUSINESS_PHONE", "BUSINESS_EMAIL", "BUSINESS_ADDRESS"];
  const bizRows = await prisma.setting.findMany({
    where: { key: { in: bizKeys } },
    select: { key: true, value: true },
  });
  const bizMap = new Map(bizRows.map((r) => [r.key, r.value ?? ""]));
  const { loadSocialLinks } = await import("./socialLinks");
  const socialLinks = await loadSocialLinks(prisma);
  // Shared copy wins; the page's own headline/intro columns remain as a
  // fallback so promotions authored before the collapse keep rendering.
  const header = resolveLandingHeader(page, page.promotion?.content as PromotionContent);
  const sharedCta = ((page.promotion?.content ?? {}) as PromotionContent).shared?.ctaText?.trim() || null;
  return {
    headline: header.headline,
    intro: header.intro,
    // "The offer" collects a Button label and says it shows on the landing
    // page — but the page had no CTA at all, so it was silently discarded.
    ctaText: sharedCta,
    items,
    promotionActive,
    inactiveReason,
    // True when content is only visible because of a preview token. The
    // page uses this to show an unmistakable "not live" banner.
    preview: !promotionActive && previewUnlocked,
    business: {
      name: bizMap.get("BUSINESS_NAME") ?? "",
      phone: bizMap.get("BUSINESS_PHONE") ?? "",
      email: bizMap.get("BUSINESS_EMAIL") ?? "",
      address: bizMap.get("BUSINESS_ADDRESS") ?? "",
      socialLinks,
    },
  };
}

// ── HMAC secret rotation ────────────────────────────────────────────
//
// Rotates PROMOTION_HMAC_SECRET to a freshly-generated cryptographically-
// random 32-byte base64url string. All in-flight promo click URLs
// (signed under the old secret) still redirect but their HMAC no longer
// verifies — the click handler falls through to anonymous logging.
//
// Audits the rotation with the old secret's SHA-256 preview hash (first
// 8 hex chars) so the audit trail can prove a rotation happened without
// exposing either secret. Never logs the secret itself.
export async function rotatePromotionHmacSecret(params: {
  actorUserId: string;
}): Promise<{ rotatedAt: string; secret: string }> {
  const previous = await prisma.setting.findUnique({
    where: { key: SETTING_HMAC_SECRET },
    select: { value: true },
  });
  const previousPreviewHash = previous?.value
    ? createHash("sha256").update(previous.value).digest("hex").slice(0, 8)
    : null;
  const newSecret = randomBytes(32).toString("base64url");
  const rotatedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: SETTING_HMAC_SECRET },
      create: {
        key: SETTING_HMAC_SECRET,
        value: newSecret,
        section: "promotions",
        description: "HMAC secret used to sign promotion click-tracking URLs (server-only). Auto-generated on first use; rotated via the Promotions tab.",
        updatedById: params.actorUserId,
      },
      update: {
        value: newSecret,
        updatedById: params.actorUserId,
      },
    });
    await writeAudit(tx, AUDIT.PROMOTION.HMAC_ROTATED, params.actorUserId, {
      previousSecretPreviewHash: previousPreviewHash,
      rotatedAt: rotatedAt.toISOString(),
    });
  });
  // Return the fresh secret so Super can reveal it immediately in the
  // Settings card without a page reload. Same trust boundary — Super
  // sees the current secret via /admin/settings anyway.
  return { rotatedAt: rotatedAt.toISOString(), secret: newSecret };
}

export const promotionsService = {
  loadPromotionSettings,
  buildUnsubscribeUrl,
  assembleEmailFooter,
  assembleSmsFooter,
  isGsm7,
  smsSegmentInfo,
  setContactOptOut,
  buildContentSnapshot,
  renderSmsPromoBody,
  renderEmailPromoBodyText,
  renderEmailPromoBodyHtml,
  selectPromotionsForPiggyback,
  runManualSendBurst,
  sendPromotionTest,
  loadInvoicePagePromos,
  ensureLandingPageForPromotion,
  updateLandingPage,
  loadLandingPageForEditor,
  loadLandingPageForPublic,
  createLandingPageItem,
  updateLandingPageItem,
  deleteLandingPageItem,
  reorderLandingPageItems,
  getLandingPageImageUploadUrl,
  confirmLandingPageImageUpload,
  recordClickAndResolve,
  recordShortClickAndResolve,
  incrementLandingPageViewCount,
  rotatePromotionHmacSecret,
  loadAllowedDomains,
  isHostAllowed,
  buildShortWrapperUrl,
  buildAnonymousShortUrl,
  isValidShortSlugFormat,
  generateShortCode,
  generateUniqueShortCode,
};
