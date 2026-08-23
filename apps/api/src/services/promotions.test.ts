// Unit tests for the pure helpers in services/promotions.ts.
//
// Everything here operates on in-memory arguments only — no Prisma, no
// HTTP, no external services. These are the algorithmic building blocks
// of the promotion pipeline (footer assembly, SMS char accounting,
// content shape validation, snapshot construction, SMS body rendering).
// The DB-touching functions (selectPromotionsForPiggyback,
// runManualSendBurst, loadInvoicePagePromos) are tested at a higher
// level by the build-gate + integration suites.

import { describe, it, expect } from "vitest";
import {
  isGsm7,
  smsSegmentInfo,
  assembleEmailFooter,
  assembleSmsFooter,
  buildContentSnapshot,
  renderSmsPromoBody,
  promotionSavePayloadSchema,
  promotionContentSchema,
  buildUnsubscribeUrl,
  slugifyTitle,
  signDeliveryClickToken,
  verifyDeliveryClickToken,
  signPromoClickToken,
  verifyPromoClickToken,
  buildClickWrapperUrl,
  buildInvoicePageClickUrl,
} from "./promotions";

// ── isGsm7 / smsSegmentInfo ────────────────────────────────────────────

describe("isGsm7", () => {
  it("accepts plain ASCII letters and digits", () => {
    expect(isGsm7("Hello world 123")).toBe(true);
  });

  it("accepts GSM-7 extension characters (curly braces, tilde, etc)", () => {
    expect(isGsm7("{hi}~")).toBe(true);
  });

  it("accepts newline + carriage return", () => {
    expect(isGsm7("line 1\nline 2\rline 3")).toBe(true);
  });

  it("accepts the Euro sign (in the extension set)", () => {
    expect(isGsm7("€50 off")).toBe(true);
  });

  it("rejects emoji", () => {
    expect(isGsm7("hello 😀")).toBe(false);
  });

  it("rejects curly quotes (common autocorrect trap)", () => {
    expect(isGsm7("it’s here")).toBe(false); // U+2019 RIGHT SINGLE QUOTATION MARK
  });

  it("rejects em dash", () => {
    expect(isGsm7("A — B")).toBe(false);
  });
});

describe("smsSegmentInfo", () => {
  it("returns 1 segment for a short GSM-7 message", () => {
    const info = smsSegmentInfo("Hello, world!");
    expect(info.encoding).toBe("gsm7");
    expect(info.chars).toBe(13);
    expect(info.segments).toBe(1);
    expect(info.perSegment).toBe(160);
  });

  it("returns 1 segment right at the GSM-7 boundary (160 chars)", () => {
    const text = "a".repeat(160);
    const info = smsSegmentInfo(text);
    expect(info.segments).toBe(1);
    expect(info.encoding).toBe("gsm7");
  });

  it("returns 2 segments just over the GSM-7 boundary (161 chars → 153+ split)", () => {
    const text = "a".repeat(161);
    const info = smsSegmentInfo(text);
    expect(info.segments).toBe(2);
  });

  it("switches to UCS-2 when a single emoji is present", () => {
    // Emoji drops the per-segment cap to 70. Even short messages can be
    // multi-segment when they include emoji.
    const info = smsSegmentInfo("Short 😀 message");
    expect(info.encoding).toBe("ucs2");
    expect(info.perSegment).toBe(70);
  });

  it("returns 2 segments just over the UCS-2 boundary (71 chars w/ emoji → 67+ split)", () => {
    const text = "😀" + "a".repeat(70); // emoji forces UCS-2, then 70 filler chars
    const info = smsSegmentInfo(text);
    expect(info.encoding).toBe("ucs2");
    expect(info.segments).toBe(2);
  });

  it("counts characters by codepoint, not UTF-16 units", () => {
    // A single emoji is one codepoint even though it takes 2 UTF-16
    // code units. The counter uses [...text] to spread codepoints.
    const info = smsSegmentInfo("😀");
    expect(info.chars).toBe(1);
  });
});

// ── Footer assembly ────────────────────────────────────────────────────

describe("assembleEmailFooter", () => {
  it("interpolates {{businessAddress}} and {{unsubscribeLink}}", () => {
    const out = assembleEmailFooter({
      footerTemplate:
        "Sent by Seedlings.\n{{businessAddress}}\nUnsubscribe: {{unsubscribeLink}}",
      businessAddress: "123 Main St, Raleigh NC 27601",
      unsubscribeLink: "https://s.example.com/opt-out?t=abc",
    });
    expect(out).toContain("123 Main St, Raleigh NC 27601");
    expect(out).toContain("https://s.example.com/opt-out?t=abc");
    expect(out).not.toContain("{{businessAddress}}");
    expect(out).not.toContain("{{unsubscribeLink}}");
  });

  it("replaces every occurrence of a placeholder", () => {
    const out = assembleEmailFooter({
      footerTemplate: "{{unsubscribeLink}} — {{unsubscribeLink}}",
      businessAddress: "",
      unsubscribeLink: "URL",
    });
    expect(out).toBe("URL — URL");
  });

  it("leaves the template unchanged when no placeholders present", () => {
    const template = "Static footer with no placeholders.";
    const out = assembleEmailFooter({
      footerTemplate: template,
      businessAddress: "IGNORED",
      unsubscribeLink: "IGNORED",
    });
    expect(out).toBe(template);
  });
});

describe("assembleSmsFooter", () => {
  it("interpolates {{unsubscribeLink}}", () => {
    const out = assembleSmsFooter({
      footerTemplate: "Stop promos: {{unsubscribeLink}}",
      unsubscribeLink: "https://s.example.com/opt-out?t=abc",
    });
    expect(out).toBe("Stop promos: https://s.example.com/opt-out?t=abc");
  });

  it("does not touch {{businessAddress}} (SMS is exempt from CAN-SPAM address rule)", () => {
    // If someone accidentally puts {{businessAddress}} in the SMS template,
    // it should stay as a literal placeholder — SMS footer assembly only
    // knows about the unsubscribe link.
    const out = assembleSmsFooter({
      footerTemplate: "{{businessAddress}} {{unsubscribeLink}}",
      unsubscribeLink: "URL",
    });
    expect(out).toBe("{{businessAddress}} URL");
  });
});

// ── promotionContentSchema / promotionSavePayloadSchema ───────────────

describe("promotionContentSchema", () => {
  it("accepts a valid content payload", () => {
    const parsed = promotionContentSchema.parse({
      sms: { body: "Fall promo!", ctaText: "Learn more" },
      email: { subject: "Fall promo", body: "Details here", ctaText: "Read" },
      invoice_page: { headline: "Fall!", body: "Body", ctaText: "Go" },
    });
    expect(parsed.sms?.body).toBe("Fall promo!");
    expect(parsed.email?.subject).toBe("Fall promo");
    expect(parsed.invoice_page?.headline).toBe("Fall!");
  });

  it("rejects an empty sms body", () => {
    const result = promotionContentSchema.safeParse({
      sms: { body: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized sms body (>2000 chars)", () => {
    const result = promotionContentSchema.safeParse({
      sms: { body: "a".repeat(2001) },
    });
    expect(result.success).toBe(false);
  });

  it("defaults missing ctaText fields to empty string", () => {
    const parsed = promotionContentSchema.parse({
      sms: { body: "hi" },
    });
    expect(parsed.sms?.ctaText).toBe("");
  });
});

describe("promotionSavePayloadSchema", () => {
  const validBase = {
    title: "Fall Offers 2026",
    description: "Fall + winter services promo",
    link: "https://seedlings.example.com/fall",
    audienceSpec: { kind: "all" as const },
    triggerConfig: {},
    cooldownDays: 7,
  };

  it("accepts a display-only promotion with no dispatch channels or trigger", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      dispatchChannels: [],
      displaySurfaces: ["invoice_page"],
      triggerKind: null,
      content: { invoice_page: { body: "Fall promo!" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a promotion with no channels AND no surfaces", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      dispatchChannels: [],
      displaySurfaces: [],
      triggerKind: null,
      content: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("dispatchChannels");
    }
  });

  it("rejects a dispatch-only promotion missing triggerKind", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      dispatchChannels: ["email"],
      displaySurfaces: [],
      triggerKind: null,
      content: { email: { subject: "s", body: "b" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("triggerKind");
    }
  });

  it("rejects a promotion whose enabled channel has no content entry", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      dispatchChannels: ["sms", "email"],
      displaySurfaces: [],
      triggerKind: "on_invoice_sent",
      // sms enabled but no sms content
      content: { email: { subject: "s", body: "b" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("content.sms");
    }
  });

  it("rejects a promotion whose enabled display surface has no content entry", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      dispatchChannels: [],
      displaySurfaces: ["invoice_page"],
      triggerKind: null,
      content: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("content.invoice_page");
    }
  });

  it("accepts a fully-populated on_invoice_sent promotion", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      dispatchChannels: ["email", "sms"],
      displaySurfaces: ["invoice_page"],
      triggerKind: "on_invoice_sent",
      content: {
        sms: { body: "Fall promo!", ctaText: "See more" },
        email: { subject: "Fall promo", body: "Details", ctaText: "Read" },
        invoice_page: { body: "Fall promo!", ctaText: "Learn more" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid link URL", () => {
    const result = promotionSavePayloadSchema.safeParse({
      ...validBase,
      link: "not-a-url",
      dispatchChannels: [],
      displaySurfaces: ["invoice_page"],
      triggerKind: null,
      content: { invoice_page: { body: "hi" } },
    });
    expect(result.success).toBe(false);
  });
});

// ── buildContentSnapshot ────────────────────────────────────────────────

describe("buildContentSnapshot", () => {
  const promotion = {
    link: "https://s.example.com/fall",
    content: {
      sms: { body: "Fall!", ctaText: "See" },
      email: { subject: "Fall promo", body: "Body here", ctaText: "Read" },
      invoice_page: { headline: "Fall!", body: "Body", ctaText: "Go" },
    },
  };

  it("builds an email snapshot with subject + footer", () => {
    const snap = buildContentSnapshot({
      promotion,
      channel: "email",
      unsubscribeLink: "https://s/opt?t=abc",
      emailFooterTemplate: "{{businessAddress}} | {{unsubscribeLink}}",
      businessAddress: "123 Main",
      smsFooterTemplate: "ignored",
    });
    expect(snap.subject).toBe("Fall promo");
    expect(snap.body).toBe("Body here");
    expect(snap.ctaText).toBe("Read");
    expect(snap.ctaUrl).toBe("https://s.example.com/fall");
    expect(snap.footer).toContain("123 Main");
    expect(snap.footer).toContain("https://s/opt?t=abc");
  });

  it("builds an sms snapshot without a subject", () => {
    const snap = buildContentSnapshot({
      promotion,
      channel: "sms",
      unsubscribeLink: "https://s/opt?t=abc",
      smsFooterTemplate: "Stop: {{unsubscribeLink}}",
    });
    expect(snap.subject).toBeUndefined();
    expect(snap.body).toBe("Fall!");
    expect(snap.ctaText).toBe("See");
    expect(snap.footer).toBe("Stop: https://s/opt?t=abc");
  });

  it("builds an invoice_page snapshot with headline and no footer", () => {
    const snap = buildContentSnapshot({
      promotion,
      channel: "invoice_page",
      unsubscribeLink: null,
    });
    expect(snap.headline).toBe("Fall!");
    expect(snap.body).toBe("Body");
    expect(snap.ctaText).toBe("Go");
    expect(snap.footer).toBeUndefined();
  });

  it("omits the email footer when no unsubscribe link is provided", () => {
    const snap = buildContentSnapshot({
      promotion,
      channel: "email",
      unsubscribeLink: null,
      emailFooterTemplate: "{{unsubscribeLink}}",
    });
    expect(snap.footer).toBeUndefined();
  });

  it("throws when the target channel's content is missing", () => {
    expect(() =>
      buildContentSnapshot({
        promotion: { link: null, content: {} },
        channel: "email",
        unsubscribeLink: null,
      }),
    ).toThrow(/Email content missing/);
  });
});

// ── renderSmsPromoBody ─────────────────────────────────────────────────

describe("renderSmsPromoBody", () => {
  it("emits body + CTA + URL + footer with newlines", () => {
    const out = renderSmsPromoBody({
      body: "Fall promo!",
      ctaText: "Learn more",
      ctaUrl: "https://s/fall",
      footer: "Stop: https://s/opt?t=abc",
    });
    expect(out).toBe(
      "Fall promo!\nLearn more https://s/fall\nStop: https://s/opt?t=abc",
    );
  });

  it("emits raw URL when no CTA text is provided", () => {
    const out = renderSmsPromoBody({
      body: "Fall!",
      ctaText: "",
      ctaUrl: "https://s/fall",
      footer: "Stop: URL",
    });
    expect(out).toBe("Fall!\nhttps://s/fall\nStop: URL");
  });

  it("omits the CTA line entirely when there's no URL", () => {
    const out = renderSmsPromoBody({
      body: "Fall!",
      ctaText: "Learn more",
      ctaUrl: null,
      footer: undefined,
    });
    expect(out).toBe("Fall!");
  });
});

// ── buildUnsubscribeUrl ────────────────────────────────────────────────

// New behavior: returns a plain static URL to the /opt-out landing
// page. No tokens, no per-recipient state. The signature preserves
// the hmacSecret/contactId/channel args for backward compatibility
// with existing callers.
describe("buildUnsubscribeUrl", () => {
  it("returns the static /opt-out URL", () => {
    const url = buildUnsubscribeUrl(
      "https://seedlings.example.com",
      "unused-secret",
      "unused_contact",
      "email",
    );
    expect(url).toBe("https://seedlings.example.com/opt-out");
  });

  it("strips a trailing slash on the base URL", () => {
    const url = buildUnsubscribeUrl(
      "https://seedlings.example.com/",
      "unused-secret",
      "unused_contact",
      "sms",
    );
    expect(url).toBe("https://seedlings.example.com/opt-out");
  });

  it("returns the same URL regardless of contactId or channel (no per-recipient info)", () => {
    const a = buildUnsubscribeUrl("https://s.example.com", "s", "contact_a", "email");
    const b = buildUnsubscribeUrl("https://s.example.com", "s", "contact_b", "sms");
    expect(a).toBe(b);
  });
});

// ── slugifyTitle ────────────────────────────────────────────────────────

describe("slugifyTitle", () => {
  it("kebab-cases a plain title", () => {
    expect(slugifyTitle("Fall Offers 2026")).toBe("fall-offers-2026");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(slugifyTitle("Fall! & Winter — Specials!!")).toBe("fall-winter-specials");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugifyTitle("   spaces around   ")).toBe("spaces-around");
    expect(slugifyTitle("!!leading-junk--")).toBe("leading-junk");
  });

  it("caps length at 64 chars", () => {
    const long = "a".repeat(200);
    expect(slugifyTitle(long).length).toBeLessThanOrEqual(64);
  });

  it("falls back to 'promotion' when the input has no valid chars", () => {
    expect(slugifyTitle("!!!")).toBe("promotion");
    expect(slugifyTitle("")).toBe("promotion");
    expect(slugifyTitle("   ")).toBe("promotion");
  });

  it("handles unicode / emoji by dropping to ASCII", () => {
    // Emoji + non-Latin punctuation collapse to a run of dashes,
    // which then trim. If nothing survives → "promotion".
    expect(slugifyTitle("🐛 Bug 🐛")).toBe("bug");
    expect(slugifyTitle("🎃🎃")).toBe("promotion");
  });
});

// ── Click token HMAC ────────────────────────────────────────────────────

const SECRET2 = "test-secret-with-at-least-32-characters-of-length";

describe("signDeliveryClickToken / verifyDeliveryClickToken", () => {
  it("round-trips a delivery id", () => {
    const t = signDeliveryClickToken(SECRET2, "delivery_abc");
    expect(verifyDeliveryClickToken(SECRET2, "delivery_abc", t)).toBe(true);
  });

  it("rejects a token for a different delivery id (forgery guard)", () => {
    const t = signDeliveryClickToken(SECRET2, "delivery_a");
    expect(verifyDeliveryClickToken(SECRET2, "delivery_b", t)).toBe(false);
  });

  it("rejects under a different secret", () => {
    const t = signDeliveryClickToken(SECRET2, "delivery_a");
    expect(verifyDeliveryClickToken("different-secret-with-32+-characters-long", "delivery_a", t)).toBe(false);
  });

  it("refuses to sign under a short secret", () => {
    expect(() => signDeliveryClickToken("short", "delivery_a")).toThrow();
  });

  it("d-flavor token does NOT verify as a p-flavor token (namespace isolation)", () => {
    // Both flavors sign with a discriminator prefix so a token minted
    // for one flavor can never be reused as the other — even if the
    // ids happen to collide.
    const t = signDeliveryClickToken(SECRET2, "same_id");
    expect(verifyPromoClickToken(SECRET2, "same_id", null, t)).toBe(false);
  });
});

describe("signPromoClickToken / verifyPromoClickToken", () => {
  it("round-trips (promotionId, contactId)", () => {
    const t = signPromoClickToken(SECRET2, "promo_a", "contact_a");
    expect(verifyPromoClickToken(SECRET2, "promo_a", "contact_a", t)).toBe(true);
  });

  it("round-trips (promotionId, null) — anonymous invoice-page viewer", () => {
    const t = signPromoClickToken(SECRET2, "promo_a", null);
    expect(verifyPromoClickToken(SECRET2, "promo_a", null, t)).toBe(true);
  });

  it("rejects a token minted with a different contactId", () => {
    const t = signPromoClickToken(SECRET2, "promo_a", "contact_a");
    expect(verifyPromoClickToken(SECRET2, "promo_a", "contact_b", t)).toBe(false);
  });

  it("rejects when contactId presence flips", () => {
    const t = signPromoClickToken(SECRET2, "promo_a", "contact_a");
    expect(verifyPromoClickToken(SECRET2, "promo_a", null, t)).toBe(false);
    const t2 = signPromoClickToken(SECRET2, "promo_a", null);
    expect(verifyPromoClickToken(SECRET2, "promo_a", "contact_a", t2)).toBe(false);
  });
});

describe("buildClickWrapperUrl / buildInvoicePageClickUrl", () => {
  // NOTE: wrapper URLs are prefixed with /api/public/ so Vercel's
  // /api/(.*) rewrite forwards to the API server. Without the /api/
  // prefix, Next.js sees /promotion/click/... and 404s (the only
  // /promotion/* page is [slug].tsx — single-segment). This class of
  // bug shipped once; the prefix is now load-bearing.
  it("delivery wrapper URL matches the /api/public/.../d/ route shape", () => {
    const url = buildClickWrapperUrl("https://s.example.com", SECRET2, "delivery_a");
    expect(url).toMatch(/^https:\/\/s\.example\.com\/api\/public\/promotion\/click\/d\/delivery_a\?t=/);
  });

  it("invoice-page URL matches the /api/public/.../p/ route shape with c= param", () => {
    const url = buildInvoicePageClickUrl("https://s.example.com", SECRET2, "promo_a", "contact_a");
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/public/promotion/click/p/promo_a");
    expect(parsed.searchParams.get("c")).toBe("contact_a");
    expect(parsed.searchParams.get("t")).toBeTruthy();
  });

  it("invoice-page URL omits c= when contactId is null (anonymous viewer)", () => {
    const url = buildInvoicePageClickUrl("https://s.example.com", SECRET2, "promo_a", null);
    const parsed = new URL(url);
    expect(parsed.searchParams.has("c")).toBe(false);
    expect(parsed.searchParams.get("t")).toBeTruthy();
  });

  it("verifies its own tokens end-to-end", () => {
    const durl = buildClickWrapperUrl("https://s.example.com", SECRET2, "delivery_z");
    const dtok = new URL(durl).searchParams.get("t")!;
    expect(verifyDeliveryClickToken(SECRET2, "delivery_z", dtok)).toBe(true);

    const purl = buildInvoicePageClickUrl("https://s.example.com", SECRET2, "promo_z", "contact_z");
    const ptok = new URL(purl).searchParams.get("t")!;
    expect(verifyPromoClickToken(SECRET2, "promo_z", "contact_z", ptok)).toBe(true);
  });

  it("strips trailing slash on base URL", () => {
    const url = buildClickWrapperUrl("https://s.example.com/", SECRET2, "delivery_a");
    expect(url).toMatch(/^https:\/\/s\.example\.com\/api\/public\/promotion\/click\/d\//);
  });
});

// ── promotionSavePayloadSchema — linkKind ────────────────────────────────

describe("promotionSavePayloadSchema — linkKind semantics", () => {
  const base = {
    title: "test",
    description: "",
    audienceSpec: { kind: "all" as const },
    triggerConfig: {},
    cooldownDays: 7,
    displaySurfaces: ["invoice_page" as const],
    dispatchChannels: [],
    triggerKind: null,
    content: { invoice_page: { body: "hi" } },
  };

  // POLICY 2026-08-22: a destination is required only when the promo
  // actually SENDS something. linkKind defaults to EXTERNAL, so demanding a
  // URL from a display-only invoice promo made it impossible to create one
  // without inventing a link — and the invoice renders text-only with no
  // destination anyway (buildContentSnapshot sets ctaUrl: null).
  it("EXTERNAL requires a link URL only when the promo dispatches", () => {
    // Display-only (no dispatch channels): valid with no link.
    const displayOnly = promotionSavePayloadSchema.safeParse({ ...base, linkKind: "EXTERNAL" });
    expect(
      displayOnly.success,
      JSON.stringify(displayOnly.success ? [] : displayOnly.error.issues),
    ).toBe(true);

    // Dispatching: a message with no destination is still rejected.
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      linkKind: "EXTERNAL",
      dispatchChannels: ["email"],
      triggerKind: "on_invoice_sent",
      content: { shared: { headline: "Subject", body: "hi" } },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("link");
    }
  });

  it("EXTERNAL with a valid URL passes", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      linkKind: "EXTERNAL",
      link: "https://example.com/fall",
    });
    expect(r.success).toBe(true);
  });

  it("LANDING_PAGE does not require a link URL", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      linkKind: "LANDING_PAGE",
    });
    expect(r.success).toBe(true);
  });

  it("defaults linkKind to EXTERNAL", () => {
    const r = promotionSavePayloadSchema.safeParse({
      ...base,
      link: "https://example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.linkKind).toBe("EXTERNAL");
  });
});
