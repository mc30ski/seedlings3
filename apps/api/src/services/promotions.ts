import { prisma } from "../db/prisma";
import { z } from "zod";
import { randomUUID, createHash } from "crypto";
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

export const promotionContentSchema = z.object({
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
    for (const c of val.dispatchChannels) {
      if (!val.content[c]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content", c],
          message: `Missing content for enabled channel: ${c}`,
        });
      }
    }
    for (const s of val.displaySurfaces) {
      if (!val.content[s]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["content", s],
          message: `Missing content for enabled surface: ${s}`,
        });
      }
    }
    if (val.linkKind === "EXTERNAL" && !val.link) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["link"],
        message: "External promotions require a link URL",
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

export async function loadPromotionSettings(): Promise<{
  hmacSecret: string;
  emailFooter: string;
  smsFooter: string;
  businessAddress: string;
  baseUrl: string;
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
        ],
      },
    },
    select: { key: true, value: true },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    hmacSecret: map.get(SETTING_HMAC_SECRET) ?? "",
    emailFooter: map.get(SETTING_EMAIL_FOOTER) ?? "",
    smsFooter: map.get(SETTING_SMS_FOOTER) ?? "",
    businessAddress: map.get(SETTING_BUSINESS_ADDRESS) ?? "",
    baseUrl: map.get(SETTING_PAY_BASE_URL) ?? "https://www.seedlings.team",
  };
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

function requireSecret(secret: string) {
  if (!secret || secret.length < 32) {
    throw new Error("PROMOTION_HMAC_SECRET must be at least 32 characters");
  }
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
  if (!secret || !deliveryId || !token) return false;
  const expected = signDeliveryClickToken(secret, deliveryId);
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

export function verifyPromoClickToken(
  secret: string,
  promotionId: string,
  contactId: string | null,
  token: string,
): boolean {
  if (!secret || !promotionId || !token) return false;
  const expected = signPromoClickToken(secret, promotionId, contactId);
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// URL embedded in outbound SMS/email + manual-burst messages.
export function buildClickWrapperUrl(
  baseUrl: string,
  hmacSecret: string,
  deliveryId: string,
): string {
  const token = signDeliveryClickToken(hmacSecret, deliveryId);
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/promotion/click/d/${deliveryId}?t=${encodeURIComponent(token)}`;
}

// URL embedded in the invoice-page promo section's CTA button. No
// delivery row exists — click lands with (promotionId, contactId) only.
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
  return `${trimmed}/promotion/click/p/${promotionId}?${qs.toString()}`;
}

// ── Destination resolver ─────────────────────────────────────────────────

// Given a Promotion row, computes the URL the wrapper redirect should
// 302 to. External promotions return their stored URL verbatim; landing
// page promotions build `${baseUrl}/promotion/${slug}`. Returns null when
// the promo is misconfigured (no URL / no slug) — caller decides what
// to do (redirect to base URL, 404, etc.).
export async function resolveDestinationUrl(
  baseUrl: string,
  promo: {
    linkKind: string;
    link: string | null;
    landingPageId: string | null;
  },
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
    const trimmed = baseUrl.replace(/\/$/, "");
    return { url: `${trimmed}/promotion/${page.slug}`, destination: "landing_page" };
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
  const contacts = await prisma.clientContact.findMany({
    where: { ...where, status: "ACTIVE" },
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
    const c = promotion.content.email;
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
      subject: c.subject,
      body: c.body,
      ctaText: c.ctaText ?? "",
      ctaUrl,
      footer,
    };
  }
  if (channel === "sms") {
    const c = promotion.content.sms;
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
      ctaText: c.ctaText ?? "",
      ctaUrl,
      footer,
    };
  }
  // invoice_page
  const c = promotion.content.invoice_page;
  if (!c) throw new Error("Invoice-page content missing");
  return {
    headline: c.headline,
    body: c.body,
    ctaText: c.ctaText ?? "",
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
}): Promise<{
  bodyAppend: string;
  emailFooter: string | null;
  smsFooter: string | null;
  writeDeliveries: () => Promise<void>;
}> {
  const settings = await loadPromotionSettings();
  if (!settings.hmacSecret) {
    // Refuse to ship promos without a signed opt-out URL — fail closed.
    return { bodyAppend: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
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
    return { bodyAppend: "", emailFooter: null, smsFooter: null, writeDeliveries: async () => {} };
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
  };
  const pending: PendingDelivery[] = [];
  const surviving: {
    promotion: (typeof candidates)[number];
    deliveryId: string;
    snapshot: ReturnType<typeof buildContentSnapshot>;
  }[] = [];

  for (const p of candidates) {
    const content = (p.content ?? {}) as PromotionContent;
    // Skip if no content for this channel (should have been caught at save).
    if (!content[params.channel]) continue;

    const deliveryId = randomUUID();
    const unsubscribeLink = buildUnsubscribeUrl(
      settings.baseUrl,
      settings.hmacSecret,
      contact.id,
      params.channel,
    );
    // Every CTA URL shipped to a recipient is a wrapper — never the raw
    // destination. The wrapper endpoint verifies the HMAC, writes a
    // PromotionClick row, then 302s to `resolveDestinationUrl(promo)`.
    const wrapperUrl = buildClickWrapperUrl(
      settings.baseUrl,
      settings.hmacSecret,
      deliveryId,
    );
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
      });
      continue;
    }

    surviving.push({ promotion: p, deliveryId, snapshot });
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
    // Email: subject is handled elsewhere; body includes CTA line.
    const parts: string[] = [];
    if (snapshot.body) parts.push(snapshot.body);
    if (snapshot.ctaText && snapshot.ctaUrl) {
      parts.push(`${snapshot.ctaText}: ${snapshot.ctaUrl}`);
    } else if (snapshot.ctaUrl) {
      parts.push(snapshot.ctaUrl);
    }
    return parts.join("\n");
  });

  // Compose the append blob including opt-out footer as the LAST line.
  // Multiple concurrent promos concatenate; a single opt-out footer at
  // the very end applies to all of them (per-channel opt-out semantics).
  let bodyAppend = "";
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
    } else {
      smsFooterOut = assembleSmsFooter({
        footerTemplate: settings.smsFooter,
        unsubscribeLink: firstUnsubscribeLink,
      });
      bodyAppend = separator + bodyPieces.join(separator) + "\n" + smsFooterOut;
    }
    for (const { promotion, deliveryId, snapshot } of surviving) {
      pending.push({
        deliveryId,
        promotionId: promotion.id,
        channel: params.channel,
        deliver: true,
        skippedReason: null,
        snapshot,
      });
    }
  }

  return {
    bodyAppend,
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
  // Overlap guard — reject if a burst started within the last 5 minutes.
  if (promo.lastDispatchStartedAt) {
    const ageMs = Date.now() - promo.lastDispatchStartedAt.getTime();
    if (ageMs < 5 * 60 * 1000) {
      throw new Error("A send burst is already in progress");
    }
  }
  const dispatchId = randomUUID();
  await prisma.promotion.update({
    where: { id: params.promotionId },
    data: { lastDispatchStartedAt: new Date() },
  });

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
      const hasChannelContent = !!content[channel];
      if (!hasChannelContent) continue;
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
      const wrapperUrl = buildClickWrapperUrl(
        settings.baseUrl,
        settings.hmacSecret,
        deliveryId,
      );
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
          },
        });
        skipped++;
        continue;
      }
      try {
        if (channel === "email") {
          const emailBody = [
            snapshot.body,
            snapshot.ctaText && snapshot.ctaUrl
              ? `${snapshot.ctaText}: ${snapshot.ctaUrl}`
              : snapshot.ctaUrl ?? "",
            "",
            snapshot.footer ?? "",
          ]
            .filter(Boolean)
            .join("\n\n");
          const res = await sendEmail(target, snapshot.subject ?? promo.title, emailBody);
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
  if (!content[params.channel]) throw new Error(`No content for ${params.channel}`);

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
  const snapshot = buildContentSnapshot({
    promotion: { link: promo.link, content },
    channel: params.channel,
    unsubscribeLink,
    emailFooterTemplate: settings.emailFooter,
    smsFooterTemplate: settings.smsFooter,
    businessAddress: settings.businessAddress,
  });

  let subject: string | undefined;
  let body: string;
  if (params.channel === "email") {
    subject = `[TEST] ${snapshot.subject ?? promo.title}`;
    body = [
      "[TEST] This is a test send of a promotional message.\n",
      snapshot.body,
      snapshot.ctaText && snapshot.ctaUrl
        ? `${snapshot.ctaText}: ${snapshot.ctaUrl}`
        : snapshot.ctaUrl ?? "",
      "",
      snapshot.footer ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
  } else {
    body = "[TEST] " + renderSmsPromoBody(snapshot);
  }

  if (mode === "SERVER") {
    // Server-side dispatch via Resend/Twilio. If the underlying
    // provider is misconfigured (e.g. Twilio disabled), surface the
    // real error text — much more useful than a generic "check your X".
    if (params.channel === "email") {
      const res = await sendEmail(target, subject!, body);
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
  }[]
> {
  // Suppress the promo display entirely if the viewing contact is opted
  // out of ALL dispatch channels — per the spec, that surface then
  // shows only the "Opt in to promotion offers" affordance instead.
  if (params.contactId) {
    const contact = await prisma.clientContact.findUnique({
      where: { id: params.contactId },
      select: { promoEmailOptedOut: true, promoSmsOptedOut: true },
    });
    if (contact && contact.promoEmailOptedOut && contact.promoSmsOptedOut) {
      return [];
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
  }[] = [];
  for (const p of promos) {
    const surfaces = Array.isArray(p.displaySurfaces)
      ? (p.displaySurfaces as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    if (!surfaces.includes("invoice_page")) continue;
    const content = (p.content ?? {}) as PromotionContent;
    if (!content.invoice_page) continue;
    // Build a wrapper URL for the CTA — logs the click before 302 to the
    // resolved destination. Skipped when HMAC secret isn't configured
    // (fail-closed on send-side; same on display-side).
    const wrapperUrl = settings.hmacSecret
      ? buildInvoicePageClickUrl(settings.baseUrl, settings.hmacSecret, p.id, params.contactId)
      : null;
    const snap = buildContentSnapshot({
      promotion: { link: wrapperUrl, content },
      channel: "invoice_page",
      unsubscribeLink: null,
    });
    out.push({
      id: p.id,
      headline: snap.headline,
      body: snap.body,
      ctaText: snap.ctaText,
      ctaUrl: snap.ctaUrl,
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
    select: { id: true, slug: true, promotion: { select: { status: true } } },
  });
  if (!page) throw new Error("Landing page not found");
  const nextSlug =
    params.payload.slug && params.payload.slug !== page.slug
      ? await (async () => {
          if (page.promotion && page.promotion.status !== "DRAFT") {
            throw new Error("Cannot change slug once promotion is out of DRAFT");
          }
          return ensureUniqueSlug(params.payload.slug!, page.id);
        })()
      : page.slug;
  const updated = await prisma.promotionLandingPage.update({
    where: { id: params.pageId },
    data: {
      slug: nextSlug,
      headline: params.payload.headline ?? undefined,
      intro: params.payload.intro ?? undefined,
      updatedById: params.actorUserId,
    },
    select: { id: true, slug: true },
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
  items: {
    id: string;
    title: string;
    description: string;
    imageR2Key: string | null;
    imageUrl: string | null;
    imageMimeType: string | null;
    ordinal: number;
  }[];
} | null> {
  const page = await prisma.promotionLandingPage.findUnique({
    where: { id: params.pageId },
    include: {
      items: { orderBy: { ordinal: "asc" } },
    },
  });
  if (!page) return null;
  const items = await Promise.all(
    page.items.map(async (i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      imageR2Key: i.imageR2Key,
      imageMimeType: i.imageMimeType,
      ordinal: i.ordinal,
      imageUrl: i.imageR2Key
        ? await getDownloadUrl(i.imageR2Key, 6 * 3600, "promotion-images").catch(() => null)
        : null,
    })),
  );
  return {
    id: page.id,
    slug: page.slug,
    headline: page.headline,
    intro: page.intro,
    viewCount: page.viewCount,
    items,
  };
}

// Item CRUD — create appends at the end (max ordinal + 1), update
// mutates title/description, delete removes row + best-effort R2 object.
export async function createLandingPageItem(params: {
  pageId: string;
  title: string;
  description: string;
}): Promise<{ id: string }> {
  const max = await prisma.promotionLandingPageItem.aggregate({
    where: { pageId: params.pageId },
    _max: { ordinal: true },
  });
  const nextOrd = (max._max.ordinal ?? -1) + 1;
  const item = await prisma.promotionLandingPageItem.create({
    data: {
      pageId: params.pageId,
      title: params.title,
      description: params.description,
      ordinal: nextOrd,
    },
    select: { id: true },
  });
  return item;
}

export async function updateLandingPageItem(params: {
  itemId: string;
  title?: string;
  description?: string;
}): Promise<void> {
  await prisma.promotionLandingPageItem.update({
    where: { id: params.itemId },
    data: {
      title: params.title,
      description: params.description,
    },
  });
}

export async function deleteLandingPageItem(params: {
  itemId: string;
}): Promise<void> {
  const item = await prisma.promotionLandingPageItem.findUnique({
    where: { id: params.itemId },
    select: { imageR2Key: true },
  });
  await prisma.promotionLandingPageItem.delete({ where: { id: params.itemId } });
  if (item?.imageR2Key) {
    // Fire-and-forget — R2 cleanup shouldn't block the delete.
    void deleteObject(item.imageR2Key, "promotion-images").catch(() => {});
  }
}

// Reorder a page's items in a single write. Payload is an array of
// itemIds in the desired display order; server assigns ordinal indexes
// 0..N-1. Any items belonging to the page but not in the list are
// pushed to the end (defensive — normal usage passes the full list).
export async function reorderLandingPageItems(params: {
  pageId: string;
  itemIds: string[];
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
  await prisma.$transaction(
    ordered.map((id, ordinal) =>
      prisma.promotionLandingPageItem.update({
        where: { id },
        data: { ordinal },
      }),
    ),
  );
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
export async function confirmLandingPageImageUpload(params: {
  itemId: string;
  key: string;
  contentType: string;
}): Promise<void> {
  const prev = await prisma.promotionLandingPageItem.findUnique({
    where: { id: params.itemId },
    select: { imageR2Key: true },
  });
  await prisma.promotionLandingPageItem.update({
    where: { id: params.itemId },
    data: { imageR2Key: params.key, imageMimeType: params.contentType },
  });
  if (prev?.imageR2Key && prev.imageR2Key !== params.key) {
    void deleteObject(prev.imageR2Key, "promotion-images").catch(() => {});
  }
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
      // Fall back to logging with just the raw promotionId — the URL
      // shape includes the promoId in the path even without a valid
      // token, so we can still credit the click to the campaign.
      promotionId = params.primaryId;
      anonymousReason = "forwarded_or_manual_share";
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
  const resolved = await resolveDestinationUrl(settings.baseUrl, promo);

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

// Public loader for a landing page by slug. Only returns the page when
// its parent promotion is ACTIVE and within the window — DRAFT/PAUSED/
// CLOSED promotions render as "This offer has ended" client-side.
export async function loadLandingPageForPublic(slug: string): Promise<{
  headline: string | null;
  intro: string | null;
  items: {
    id: string;
    title: string;
    description: string;
    imageUrl: string | null;
  }[];
  promotionActive: boolean;
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
      items: { orderBy: { ordinal: "asc" } },
      promotion: {
        select: { status: true, startAt: true, endAt: true },
      },
    },
  });
  if (!page) return null;
  const now = new Date();
  const promotionActive =
    !!page.promotion &&
    page.promotion.status === "ACTIVE" &&
    (!page.promotion.startAt || page.promotion.startAt <= now) &&
    (!page.promotion.endAt || page.promotion.endAt >= now);
  const items = await Promise.all(
    page.items.map(async (i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      imageUrl: i.imageR2Key
        ? await getDownloadUrl(i.imageR2Key, 6 * 3600, "promotion-images").catch(() => null)
        : null,
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
  return {
    headline: page.headline,
    intro: page.intro,
    items,
    promotionActive,
    business: {
      name: bizMap.get("BUSINESS_NAME") ?? "",
      phone: bizMap.get("BUSINESS_PHONE") ?? "",
      email: bizMap.get("BUSINESS_EMAIL") ?? "",
      address: bizMap.get("BUSINESS_ADDRESS") ?? "",
      socialLinks,
    },
  };
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
  incrementLandingPageViewCount,
};
