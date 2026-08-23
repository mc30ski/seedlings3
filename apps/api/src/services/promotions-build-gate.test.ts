// ─────────────────────────────────────────────────────────────────────────────
// Promotions build gate
//
// PURPOSE
// Locks in the promo pipeline invariants that customer-facing behavior +
// CAN-SPAM defensive posture depend on. Runs on every build. A failure
// means one of: promo dispatch could send under a mis-signed URL, a
// snapshot could go missing (audit gap), a CAN-SPAM-non-compliant email
// footer could ship, an SMS could balloon to multi-segment cost silently,
// or the content Zod schema could accept a shape the dispatcher can't
// handle.
//
// SCOPE
// Pure invariants — no DB, no Prisma, no external services. Every
// invariant is one describe block. Grep the block titles below to
// understand what's guarded.
//
// INVARIANTS LOCKED IN
//
// (Invariants run A through R. The list below covers A-H; grep the
// `describe(` block titles for the full current set — I..R were added
// later for click-token namespace isolation, wrapper/short URL shapes,
// the slug generator, verify-never-throws, and landing preview tokens.)
//
//   A. Opt-out URL is static — no HMAC tokens leak through message
//      bodies; landing page collects identifier from the client.
//   B. Zod content schema requires content for every enabled channel
//      AND every enabled display surface (dispatcher blows up otherwise).
//   C. Zod payload rejects trigger-less dispatch and channel-less+surface-
//      less promotions (nothing to deliver).
//   D. Email footer template MUST include either {{businessAddress}} OR a
//      literal address the CAN-SPAM audit will accept — the assembler
//      leaves any placeholder that isn't provided as a literal, so we
//      test that {{businessAddress}} is preserved unless supplied.
//   E. SMS segment counter matches Twilio billing thresholds
//      (160/153 GSM-7, 70/67 UCS-2) — a regression here bills the
//      customer for 2x-3x SMS silently.
//   F. renderSmsPromoBody assembles body → CTA+URL → footer in the
//      documented order; missing components collapse cleanly.
//   G. buildContentSnapshot ALWAYS returns a body field (never
//      undefined) — PromotionDelivery.contentSnapshot is the audit
//      record, so it must never be null-shaped.
//   H. buildUnsubscribeUrl produces a well-formed URL with a token
//      that verify accepts.
//
// HOW TO USE THIS FILE
// If a test breaks, the fix is almost never to relax the assertion. The
// legitimate reasons are (a) a documented policy change with a memo
// under docs/features/, (b) refactoring a helper signature (update
// tests + helper in the same commit).

import { describe, it, expect } from "vitest";
import {
  promotionSavePayloadSchema,
  buildContentSnapshot,
  smsSegmentInfo,
  renderSmsPromoBody,
  assembleEmailFooter,
  buildUnsubscribeUrl,
  slugifyTitle,
  signDeliveryClickToken,
  verifyDeliveryClickToken,
  signPromoClickToken,
  verifyPromoClickToken,
  signLandingPreviewToken,
  verifyLandingPreviewToken,
  buildClickWrapperUrl,
  buildInvoicePageClickUrl,
  buildShortWrapperUrl,
  buildAnonymousShortUrl,
  isValidShortSlugFormat,
  generateShortCode,
} from "./promotions";

const SECRET = "test-secret-with-at-least-32-characters-of-length";

// ── A. Opt-out URL is a static page (no HMAC token) ──────────────────
// Opt-out no longer uses a signed URL. Client visits /opt-out and
// enters their own email or phone; server matches + flips flags on
// every matching ClientContact. Mirrors what real ESPs do — no
// per-recipient tokens leaking through message forwards.

describe("Invariant A — Opt-out URL is static (no tokens leak in message bodies)", () => {
  it("A1: buildUnsubscribeUrl returns a plain /opt-out URL", () => {
    const url = buildUnsubscribeUrl("https://s.example.com", SECRET, "c_1", "email");
    expect(url).toBe("https://s.example.com/opt-out");
  });

  it("A2: URL is identical regardless of contactId or channel (no recipient info baked in)", () => {
    const emailA = buildUnsubscribeUrl("https://s.example.com", SECRET, "contact_a", "email");
    const smsB = buildUnsubscribeUrl("https://s.example.com", SECRET, "contact_b", "sms");
    expect(emailA).toBe(smsB);
  });

  it("A3: URL has no query string (nothing to strip or leak)", () => {
    const url = buildUnsubscribeUrl("https://s.example.com", SECRET, "c_1", "email");
    expect(url).not.toContain("?");
    expect(url).not.toContain("t=");
  });
});

// ── B. Zod schema requires content per enabled channel/surface ────────

// POLICY CHANGE 2026-08-22 (the copy collapse): a channel/surface may be
// satisfied by its OWN content OR by the shared offer copy. The invariant
// itself is unchanged — every enabled destination must have something to
// say — but content can now be inherited rather than duplicated.
//
// B4/B5 below are the cases that matter now: shared copy alone must be
// ACCEPTED (that's the normal path), and truly-empty content must still be
// REJECTED (that's the invariant).
describe("Invariant B — content required for every enabled channel/surface", () => {
  const base = {
    title: "test",
    description: "",
    link: null,
    audienceSpec: { kind: "all" as const },
    triggerConfig: {},
    cooldownDays: 7,
  };

  it("B1: enabling sms without content.sms is rejected", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      dispatchChannels: ["sms"],
      displaySurfaces: [],
      triggerKind: "on_invoice_sent",
      content: {},
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("content.sms");
    }
  });

  it("B2: enabling email without content.email is rejected", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      dispatchChannels: ["email"],
      displaySurfaces: [],
      triggerKind: "on_invoice_sent",
      content: {},
    });
    expect(r.success).toBe(false);
    // Assert WHY. Without the path check this passed even when the payload
    // was rejected for an unrelated reason (a missing external link), which
    // means it wasn't testing content at all.
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join("."))).toContain("content.email");
    }
  });

  it("B4: shared copy ALONE satisfies every enabled channel and surface", () => {
    // The normal path after the collapse: write the offer once, enable
    // three destinations, customize none of them. Rejecting this would
    // make the shared-copy feature unusable.
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      // linkKind defaults to EXTERNAL, which separately requires a link —
      // without this the payload fails for the wrong reason and the test
      // proves nothing about content inheritance.
      link: "https://example.com",
      dispatchChannels: ["sms", "email"],
      displaySurfaces: ["invoice_page"],
      triggerKind: "on_invoice_sent",
      content: { shared: { headline: "Fall cleanups", body: "Book now.", ctaText: "Get a quote" } },
    });
    expect(r.success, JSON.stringify(r.success ? [] : r.error.issues)).toBe(true);
  });

  it("B5: shared copy with a blank body does NOT satisfy a channel", () => {
    // Whitespace isn't content. Without this, an operator who enabled a
    // channel and never typed anything would ship an empty message.
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      link: "https://example.com",
      dispatchChannels: ["sms"],
      displaySurfaces: [],
      triggerKind: "on_invoice_sent",
      content: { shared: { body: "   " } },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.path.join("."))).toContain("content.sms");
    }
  });

  it("B3: enabling invoice_page without content.invoice_page is rejected", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      dispatchChannels: [],
      displaySurfaces: ["invoice_page"],
      triggerKind: null,
      content: {},
    });
    expect(r.success).toBe(false);
  });
});

// ── C. Zod payload rejects incoherent combinations ────────────────────

describe("Invariant C — save payload rejects incoherent shapes", () => {
  const base = {
    title: "test",
    description: "",
    link: null,
    audienceSpec: { kind: "all" as const },
    triggerConfig: {},
    cooldownDays: 7,
  };

  it("C1: dispatch channels non-empty requires triggerKind", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      dispatchChannels: ["email"],
      displaySurfaces: [],
      triggerKind: null,
      content: { email: { subject: "s", body: "b" } },
    });
    expect(r.success).toBe(false);
  });

  it("C2: zero channels AND zero surfaces is rejected (nothing to deliver)", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      dispatchChannels: [],
      displaySurfaces: [],
      triggerKind: null,
      content: {},
    });
    expect(r.success).toBe(false);
  });

  it("C3: display-only (surfaces without dispatch) is allowed when EXTERNAL has a link", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      link: "https://example.com/fall",
      dispatchChannels: [],
      displaySurfaces: ["invoice_page"],
      triggerKind: null,
      content: { invoice_page: { body: "hi" } },
    });
    expect(r.success).toBe(true);
  });

  it("C4: display-only + LANDING_PAGE + null link is allowed (server assigns URL from slug)", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      linkKind: "LANDING_PAGE",
      dispatchChannels: [],
      displaySurfaces: ["invoice_page"],
      triggerKind: null,
      content: { invoice_page: { body: "hi" } },
    });
    expect(r.success).toBe(true);
  });
});

// ── D. Email footer preserves {{businessAddress}} placeholder ─────────

describe("Invariant D — email footer template placeholders", () => {
  it("D1: {{businessAddress}} is substituted when supplied", () => {
    const out = assembleEmailFooter({
      footerTemplate: "{{businessAddress}}",
      businessAddress: "123 Main St",
      unsubscribeLink: "URL",
    });
    expect(out).toBe("123 Main St");
  });

  it("D2: an empty businessAddress replaces the placeholder with empty string (never leaves the raw {{}} literal in shipping mail)", () => {
    // Rationale: shipping a literal "{{businessAddress}}" in a customer
    // email would be an ugly bug — but our footer template is expected
    // to always include a real address when configured. This test just
    // confirms the substitution happens even for empty input.
    const out = assembleEmailFooter({
      footerTemplate: "footer: {{businessAddress}}",
      businessAddress: "",
      unsubscribeLink: "URL",
    });
    expect(out).toBe("footer: ");
    expect(out).not.toContain("{{businessAddress}}");
  });

  it("D3: {{unsubscribeLink}} is always substituted", () => {
    const out = assembleEmailFooter({
      footerTemplate: "opt: {{unsubscribeLink}}",
      businessAddress: "",
      unsubscribeLink: "https://s/opt?t=abc",
    });
    expect(out).toBe("opt: https://s/opt?t=abc");
  });
});

// ── E. SMS segment counter matches Twilio billing ─────────────────────

describe("Invariant E — SMS segment counter matches Twilio billing thresholds", () => {
  it("E1: 160-char GSM-7 = 1 segment", () => {
    expect(smsSegmentInfo("a".repeat(160)).segments).toBe(1);
  });

  it("E2: 161-char GSM-7 = 2 segments (uses 153/segment for multi)", () => {
    expect(smsSegmentInfo("a".repeat(161)).segments).toBe(2);
  });

  it("E3: 306-char GSM-7 (153+153) = 2 segments", () => {
    expect(smsSegmentInfo("a".repeat(306)).segments).toBe(2);
  });

  it("E4: 307-char GSM-7 = 3 segments", () => {
    expect(smsSegmentInfo("a".repeat(307)).segments).toBe(3);
  });

  it("E5: 70-char UCS-2 (contains emoji) = 1 segment", () => {
    expect(smsSegmentInfo("😀" + "a".repeat(69)).segments).toBe(1);
  });

  it("E6: 71-char UCS-2 = 2 segments (uses 67/segment for multi)", () => {
    expect(smsSegmentInfo("😀" + "a".repeat(70)).segments).toBe(2);
  });

  it("E7: 134-char UCS-2 (67+67) = 2 segments", () => {
    expect(smsSegmentInfo("😀" + "a".repeat(133)).segments).toBe(2);
  });

  it("E8: em dash forces UCS-2 encoding (silent-segment-inflation regression guard)", () => {
    expect(smsSegmentInfo("Hi — there").encoding).toBe("ucs2");
  });

  it("E9: curly quote forces UCS-2 encoding", () => {
    expect(smsSegmentInfo("it’s here").encoding).toBe("ucs2");
  });
});

// ── F. SMS body renderer order + collapse ─────────────────────────────

describe("Invariant F — renderSmsPromoBody assembly order", () => {
  it("F1: full assembly is body → CTA+URL → footer in that order", () => {
    const out = renderSmsPromoBody({
      body: "BODY",
      ctaText: "CTA",
      ctaUrl: "URL",
      footer: "FOOT",
    });
    expect(out).toBe("BODY\nCTA URL\nFOOT");
  });

  it("F2: no ctaText but URL present → URL alone on its line", () => {
    const out = renderSmsPromoBody({
      body: "B",
      ctaText: "",
      ctaUrl: "URL",
      footer: "F",
    });
    expect(out).toBe("B\nURL\nF");
  });

  it("F3: no URL → CTA line is omitted entirely (never emits a naked CTA)", () => {
    const out = renderSmsPromoBody({
      body: "B",
      ctaText: "CTA",
      ctaUrl: null,
      footer: "F",
    });
    expect(out).toBe("B\nF");
  });

  it("F4: no footer → no trailing footer line", () => {
    const out = renderSmsPromoBody({
      body: "B",
      ctaText: "CTA",
      ctaUrl: "URL",
      footer: undefined,
    });
    expect(out).toBe("B\nCTA URL");
  });
});

// ── G. buildContentSnapshot always returns a body ─────────────────────

describe("Invariant G — buildContentSnapshot always shape-safe", () => {
  const promo = {
    link: "https://s/link",
    content: {
      sms: { body: "s", ctaText: "sc" },
      email: { subject: "sub", body: "e", ctaText: "ec" },
      invoice_page: { headline: "h", body: "ip", ctaText: "ipc" },
    },
  };

  it("G1: email snapshot has non-empty body", () => {
    const s = buildContentSnapshot({ promotion: promo, channel: "email", unsubscribeLink: null });
    expect(typeof s.body).toBe("string");
    expect(s.body.length).toBeGreaterThan(0);
  });

  it("G2: sms snapshot has non-empty body", () => {
    const s = buildContentSnapshot({ promotion: promo, channel: "sms", unsubscribeLink: null });
    expect(typeof s.body).toBe("string");
    expect(s.body.length).toBeGreaterThan(0);
  });

  it("G3: invoice_page snapshot has non-empty body", () => {
    const s = buildContentSnapshot({ promotion: promo, channel: "invoice_page", unsubscribeLink: null });
    expect(typeof s.body).toBe("string");
    expect(s.body.length).toBeGreaterThan(0);
  });

  it("G4: throws (never returns malformed snapshot) when channel content is missing", () => {
    expect(() =>
      buildContentSnapshot({
        promotion: { link: null, content: {} },
        channel: "email",
        unsubscribeLink: null,
      }),
    ).toThrow();
  });
});

// ── H. buildUnsubscribeUrl determinism ─────────────────────────────────

describe("Invariant H — buildUnsubscribeUrl determinism", () => {
  it("H1: URL always resolves to /opt-out (matches the Next.js page path)", () => {
    const url = buildUnsubscribeUrl("https://s.example.com", SECRET, "c_1", "sms");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/opt-out");
  });

  it("H2: identical base URL produces identical output (deterministic + stateless)", () => {
    const url1 = buildUnsubscribeUrl("https://s.example.com", SECRET, "c_1", "email");
    const url2 = buildUnsubscribeUrl("https://s.example.com", SECRET, "c_1", "email");
    expect(url1).toBe(url2);
  });
});

// ── I. Click-token HMAC — namespace isolation + tamper resistance ────────

describe("Invariant I — Click token HMAC namespace isolation", () => {
  it("I1: delivery-flavor token does not verify as promo-flavor (namespace safe)", () => {
    // A leaked delivery-token must NEVER succeed against the p-flavor
    // verifier. Discriminator prefix in the HMAC input prevents this
    // — regression would let an attacker log clicks against arbitrary
    // (promo, contact) tuples using a delivery-only token.
    const t = signDeliveryClickToken(SECRET, "shared_id");
    expect(verifyPromoClickToken(SECRET, "shared_id", null, t)).toBe(false);
  });

  it("I2: promo-flavor token with different contactId is rejected", () => {
    const t = signPromoClickToken(SECRET, "promo_a", "contact_a");
    expect(verifyPromoClickToken(SECRET, "promo_a", "contact_b", t)).toBe(false);
  });

  it("I3: promo-flavor token with null vs non-null contactId is rejected each way", () => {
    // Common leak vector: URL stripped of `c=` param but token was
    // signed with a contact. Must fail-closed.
    const tWith = signPromoClickToken(SECRET, "promo_a", "contact_a");
    expect(verifyPromoClickToken(SECRET, "promo_a", null, tWith)).toBe(false);
    const tWithout = signPromoClickToken(SECRET, "promo_a", null);
    expect(verifyPromoClickToken(SECRET, "promo_a", "contact_a", tWithout)).toBe(false);
  });

  it("I4: both signers refuse under a weak secret", () => {
    expect(() => signDeliveryClickToken("short", "d")).toThrow();
    expect(() => signPromoClickToken("short", "p", null)).toThrow();
  });

  it("I5: delivery + promo tokens round-trip via their own verifiers", () => {
    const d = signDeliveryClickToken(SECRET, "delivery_x");
    expect(verifyDeliveryClickToken(SECRET, "delivery_x", d)).toBe(true);
    const p = signPromoClickToken(SECRET, "promo_x", "contact_x");
    expect(verifyPromoClickToken(SECRET, "promo_x", "contact_x", p)).toBe(true);
  });
});

// ── J. Click wrapper URL shape ────────────────────────────────────────────

describe("Invariant J — Click wrapper URL shape", () => {
  // The /api/public/ prefix is load-bearing — without it, Vercel's
  // /api/(.*) rewrite doesn't fire and Next.js 404s on the wrapper URL.
  // This class of bug shipped once (every wrapper click 404'd in prod).
  it("J1: delivery wrapper URL always includes /api/public/promotion/click/d/ prefix", () => {
    const url = buildClickWrapperUrl("https://s.example.com", SECRET, "delivery_a");
    expect(url.startsWith("https://s.example.com/api/public/promotion/click/d/delivery_a?t=")).toBe(true);
  });

  it("J2: invoice-page URL always includes /api/public/promotion/click/p/ prefix", () => {
    const url = buildInvoicePageClickUrl("https://s.example.com", SECRET, "promo_a", "contact_a");
    expect(url.startsWith("https://s.example.com/api/public/promotion/click/p/promo_a?")).toBe(true);
  });

  it("J3: invoice-page URL omits c= when contactId is null", () => {
    // If we ever regress and always emit c=, the token would need to be
    // re-signed against "" as the contactId to verify — this test
    // catches that class of drift.
    const url = buildInvoicePageClickUrl("https://s.example.com", SECRET, "promo_a", null);
    const parsed = new URL(url);
    expect(parsed.searchParams.has("c")).toBe(false);
  });

  it("J4: wrapper URLs verify against their own tokens", () => {
    const d = buildClickWrapperUrl("https://s.example.com", SECRET, "delivery_z");
    const dt = new URL(d).searchParams.get("t")!;
    expect(verifyDeliveryClickToken(SECRET, "delivery_z", dt)).toBe(true);
    const p = buildInvoicePageClickUrl("https://s.example.com", SECRET, "promo_z", "contact_z");
    const pt = new URL(p).searchParams.get("t")!;
    expect(verifyPromoClickToken(SECRET, "promo_z", "contact_z", pt)).toBe(true);
  });
});

// ── K. Slug generator invariants ──────────────────────────────────────────

describe("Invariant K — Slug generator", () => {
  it("K1: never returns an empty string (fallback to 'promotion')", () => {
    // Empty slugs would collide catastrophically at the DB unique
    // constraint AND leave the /promotion/<slug> route ambiguous.
    expect(slugifyTitle("")).toBe("promotion");
    expect(slugifyTitle("   ")).toBe("promotion");
    expect(slugifyTitle("!!!")).toBe("promotion");
    expect(slugifyTitle("🎃🎃")).toBe("promotion");
  });

  it("K2: cap length at 64 chars — URL sanity", () => {
    // Postgres text has no meaningful limit, but URLs longer than ~64
    // chars in the slug get truncated in link previews and read as noise.
    expect(slugifyTitle("a".repeat(500)).length).toBeLessThanOrEqual(64);
  });

  it("K3: output is URL-safe (lowercase kebab, ASCII, no leading/trailing dashes)", () => {
    const s = slugifyTitle("  Fall! & Winter — Specials!!  ");
    expect(s).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });

  it("K4: is deterministic — same title → same slug (before uniqueness suffix)", () => {
    expect(slugifyTitle("Fall Offers")).toBe(slugifyTitle("Fall Offers"));
  });
});

// ── L. Verify tokens never throw ─────────────────────────────────────
// verifyDeliveryClickToken and verifyPromoClickToken must return false
// (not throw) on unset / short / rotated secrets so the click endpoint
// falls through to anonymous-log + best-effort redirect instead of
// returning 500 on every hit. Sign paths DO throw (loud misconfig
// signal at message-build time when the operator can still fix it).
describe("Invariant L — verify* never throws (500-safety on click endpoint)", () => {
  it("L1: verifyDeliveryClickToken returns false when secret is empty", () => {
    expect(() => verifyDeliveryClickToken("", "any", "any")).not.toThrow();
    expect(verifyDeliveryClickToken("", "any", "any")).toBe(false);
  });

  it("L2: verifyDeliveryClickToken returns false when secret is too short", () => {
    expect(() => verifyDeliveryClickToken("short", "any", "any")).not.toThrow();
    expect(verifyDeliveryClickToken("short", "any", "any")).toBe(false);
  });

  it("L3: verifyPromoClickToken returns false when secret is empty", () => {
    expect(() => verifyPromoClickToken("", "p", null, "t")).not.toThrow();
    expect(verifyPromoClickToken("", "p", null, "t")).toBe(false);
  });

  it("L4: verifyPromoClickToken returns false when secret is too short", () => {
    expect(() => verifyPromoClickToken("short", "p", null, "t")).not.toThrow();
    expect(verifyPromoClickToken("short", "p", null, "t")).toBe(false);
  });

  it("L5: sign* still throws on invalid secret (loud misconfig at build time)", () => {
    // The message-build path (buildClickWrapperUrl) is the right place
    // to surface a bad secret — throws while the operator can still fix
    // it before shipping. Verify is silent-fail because it runs on
    // customer traffic after the fact.
    expect(() => signDeliveryClickToken("", "delivery_a")).toThrow(/at least 32 characters/);
    expect(() => signDeliveryClickToken("short", "delivery_a")).toThrow(/at least 32 characters/);
    expect(() => signPromoClickToken("", "p", null)).toThrow(/at least 32 characters/);
  });
});

// ── M. HMAC flavor discriminators — cross-flavor replay is impossible ──
// Delivery tokens (d:) and promo tokens (p:) both sign with the same
// secret. If the payload string prefix collided, an attacker could
// forward a d-token as a p-token and get a p-flavor click accepted.
describe("Invariant M — HMAC flavors don't cross-replay", () => {
  it("M1: a token that verifies as delivery does NOT verify as promo (same string)", () => {
    // Same string used as deliveryId and as promotionId; the flavor
    // discriminator prefixed to the HMAC input prevents the collision.
    const same = "collision-candidate-id";
    const dtok = signDeliveryClickToken(SECRET, same);
    expect(verifyDeliveryClickToken(SECRET, same, dtok)).toBe(true);
    // Same token, tried against promo-flavor verify with same id — MUST fail.
    expect(verifyPromoClickToken(SECRET, same, null, dtok)).toBe(false);
  });

  it("M2: a token that verifies as promo does NOT verify as delivery (same string)", () => {
    const same = "collision-candidate-id";
    const ptok = signPromoClickToken(SECRET, same, null);
    expect(verifyPromoClickToken(SECRET, same, null, ptok)).toBe(true);
    expect(verifyDeliveryClickToken(SECRET, same, ptok)).toBe(false);
  });
});

// ── N. Wrapper URL prefix is /api/public/ (Vercel-rewrite requirement) ──
// Documented at length in the wrapper builder — dropping the prefix
// makes every promo click 404 in prod. This class of bug shipped once
// and every recipient's CTA silently failed until it was rolled back.
describe("Invariant N — Wrapper URL prefix", () => {
  it("N1: delivery wrapper URL starts with baseUrl + /api/public/", () => {
    const url = buildClickWrapperUrl("https://s.example.com", SECRET, "delivery_a");
    expect(url).toContain("/api/public/promotion/click/d/");
    // Belt-and-suspenders: check the FULL prefix so any regression
    // (e.g., accidental double slash, wrong prefix) fails loudly.
    expect(url.startsWith("https://s.example.com/api/public/")).toBe(true);
  });

  it("N2: invoice-page wrapper URL starts with baseUrl + /api/public/", () => {
    const url = buildInvoicePageClickUrl("https://s.example.com", SECRET, "promo_a", null);
    expect(url).toContain("/api/public/promotion/click/p/");
    expect(url.startsWith("https://s.example.com/api/public/")).toBe(true);
  });

  it("N3: wrapper URL never starts with baseUrl + /promotion/ (bare, sans /api/public/)", () => {
    // The bare shape is what triggered the shipped 404 — Next.js
    // /promotion/[slug].tsx accepts a single segment and 404s on
    // /promotion/click/d/anything. This is the negative-form guard.
    const durl = buildClickWrapperUrl("https://s.example.com", SECRET, "d1");
    const purl = buildInvoicePageClickUrl("https://s.example.com", SECRET, "p1", null);
    expect(durl.startsWith("https://s.example.com/promotion/")).toBe(false);
    expect(purl.startsWith("https://s.example.com/promotion/")).toBe(false);
  });
});

// ── O. Short URL builders — /mo/<slug>/<code> shape ─────────────────
// The short URL scheme is the opt-in modern format:
//   Personal:  seedlings.pro/mo/<slug>/<code>
//   Anonymous: seedlings.pro/mo/<slug>
// The route pattern is `/mo/:slug/:code?` — no `/api/public/` prefix
// (routed directly from the browser to the API's public endpoint via
// the Vercel rewrite). If a regression puts the /api/ prefix back
// we'd double-prefix in the URL and 404 real recipients.

describe("Invariant O — Short URL builders", () => {
  it("O1: per-recipient short URL has the exact /mo/<slug>/<code> shape", () => {
    const url = buildShortWrapperUrl("https://seedlings.pro", "fall-2026", "abcd");
    expect(url).toBe("https://seedlings.pro/mo/fall-2026/abcd");
  });

  it("O2: anonymous short URL has the exact /mo/<slug> shape (no code)", () => {
    const url = buildAnonymousShortUrl("https://seedlings.pro", "fall-2026");
    expect(url).toBe("https://seedlings.pro/mo/fall-2026");
  });

  it("O3: short URLs do NOT include /api/public/ prefix (route lives at /mo/)", () => {
    // Belt-and-suspenders: the /mo/ route is registered under /api on
    // the Fastify side but reached via Vercel rewrite so the browser
    // never sees /api/. Any accidental /api/ in the builder would
    // 404 real recipients.
    const personal = buildShortWrapperUrl("https://s.example.com", "s", "c");
    const anon = buildAnonymousShortUrl("https://s.example.com", "s");
    expect(personal).not.toContain("/api/");
    expect(anon).not.toContain("/api/");
  });

  it("O4: short URLs strip a trailing slash on the base URL", () => {
    const p = buildShortWrapperUrl("https://s.example.com/", "s", "c");
    const a = buildAnonymousShortUrl("https://s.example.com/", "s");
    expect(p).toBe("https://s.example.com/mo/s/c");
    expect(a).toBe("https://s.example.com/mo/s");
  });

  it("O5: short URLs URL-encode slug + code (defensive — validation should prevent bad chars)", () => {
    // Slug validation blocks anything but [a-z0-9-] so encoding is a
    // no-op in practice. But if a bad row slipped in (manual DB edit,
    // regression in validation), encoding prevents URL-injection.
    const url = buildShortWrapperUrl("https://s.example.com", "with space", "with/slash");
    expect(url).toContain("with%20space");
    expect(url).toContain("with%2Fslash");
  });
});

// ── P. Short slug format validation ─────────────────────────────────
describe("Invariant P — isValidShortSlugFormat", () => {
  it("P1: accepts kebab-case lowercase + digits", () => {
    expect(isValidShortSlugFormat("perties")).toBe(true);
    expect(isValidShortSlugFormat("fall-offer-2026")).toBe(true);
    expect(isValidShortSlugFormat("book2")).toBe(true);
  });

  it("P2: rejects uppercase / leading dash / trailing dash / double dash", () => {
    expect(isValidShortSlugFormat("Perties")).toBe(false);
    expect(isValidShortSlugFormat("-perties")).toBe(false);
    expect(isValidShortSlugFormat("perties-")).toBe(false);
    expect(isValidShortSlugFormat("fall--offer")).toBe(false);
  });

  // POLICY CHANGE 2026-08-22: cap raised 40 -> 64 so the short slug can
  // always mirror the landing-page slug, which uses the same 64 bound.
  // Operator decision: lengths over 40 are a UI warning about SMS segment
  // cost, not a rejection. The invariant that a cap EXISTS is what this
  // test protects — an unbounded slug is still a bug.
  it("P3: caps length at 64 chars (matches landing-page slug cap)", () => {
    expect(isValidShortSlugFormat("a".repeat(40))).toBe(true);
    expect(isValidShortSlugFormat("a".repeat(64))).toBe(true);
    expect(isValidShortSlugFormat("a".repeat(65))).toBe(false);
  });

  it("P4: rejects empty + special chars + non-ASCII", () => {
    expect(isValidShortSlugFormat("")).toBe(false);
    expect(isValidShortSlugFormat("perties!")).toBe(false);
    expect(isValidShortSlugFormat("naïve")).toBe(false);
  });
});

// ── Q. Short code alphabet ──────────────────────────────────────────
describe("Invariant Q — generateShortCode alphabet + length", () => {
  it("Q1: emits exactly 4 chars", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateShortCode()).toHaveLength(4);
    }
  });

  it("Q2: uses only unambiguous lowercase alphanumeric (excludes 0/o/1/l/i)", () => {
    // Confusable chars would burn operator brain cycles reading a
    // delivery log ("was that a zero or an oh?"). Locked in the
    // alphabet constant.
    const forbidden = new Set(["0", "o", "1", "l", "i"]);
    const allowed = /^[a-z0-9]+$/;
    for (let i = 0; i < 200; i++) {
      const code = generateShortCode();
      expect(code).toMatch(allowed);
      for (const ch of code) expect(forbidden.has(ch)).toBe(false);
    }
  });
});

// ── R. Landing-page preview tokens ───────────────────────────────────
// A preview token bypasses the ACTIVE gate on a PUBLIC route, so it is
// the most security-sensitive token in this file. Three properties have
// to hold or unpublished campaign copy leaks:
//   - it expires,
//   - it is bound to ONE slug,
//   - it cannot cross-verify with the delivery/promo click flavors.

describe("Invariant R — landing preview tokens", () => {
  const SLUG = "fall-offers-2026";
  const FUTURE = 4_000_000_000_000;
  const NOW = 3_999_999_000_000;

  it("R1: a freshly signed token verifies before its expiry", () => {
    const t = signLandingPreviewToken(SECRET, SLUG, FUTURE);
    expect(verifyLandingPreviewToken(SECRET, SLUG, t, NOW)).toBe(true);
  });

  it("R2: the SAME token is rejected once the expiry has passed", () => {
    const t = signLandingPreviewToken(SECRET, SLUG, FUTURE);
    expect(verifyLandingPreviewToken(SECRET, SLUG, t, FUTURE + 1)).toBe(false);
  });

  it("R3: a token for one slug does NOT unlock another slug", () => {
    const t = signLandingPreviewToken(SECRET, SLUG, FUTURE);
    expect(verifyLandingPreviewToken(SECRET, "some-other-campaign", t, NOW)).toBe(false);
  });

  it("R4: tampering with the carried expiry invalidates the signature", () => {
    const t = signLandingPreviewToken(SECRET, SLUG, FUTURE);
    const sig = t.slice(t.indexOf(".") + 1);
    const extended = `${FUTURE + 999_999_999}.${sig}`;
    expect(verifyLandingPreviewToken(SECRET, SLUG, extended, NOW)).toBe(false);
  });

  it("R5: click-flavor tokens do not verify as preview tokens", () => {
    const promoTok = signPromoClickToken(SECRET, "promo_1", null);
    const deliveryTok = signDeliveryClickToken(SECRET, "delivery_1");
    expect(verifyLandingPreviewToken(SECRET, SLUG, promoTok, NOW)).toBe(false);
    expect(verifyLandingPreviewToken(SECRET, SLUG, deliveryTok, NOW)).toBe(false);
  });

  it("R6: verify never throws under a missing/weak secret (public-route 500-safety)", () => {
    const t = signLandingPreviewToken(SECRET, SLUG, FUTURE);
    expect(verifyLandingPreviewToken("", SLUG, t, NOW)).toBe(false);
    expect(verifyLandingPreviewToken("short", SLUG, t, NOW)).toBe(false);
  });

  it("R7: malformed tokens are rejected rather than throwing", () => {
    for (const bad of ["", ".", "abc", "abc.def", ".sig", "99999999999999999999.sig"]) {
      expect(verifyLandingPreviewToken(SECRET, SLUG, bad, NOW)).toBe(false);
    }
  });
});
