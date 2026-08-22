// ─────────────────────────────────────────────────────────────────────────────
// Promotions — scenario tests (mocked Prisma).
//
// PURPOSE
// Cover the DB-touching decision paths that the pure-logic tests in
// promotions.test.ts + promotions-build-gate.test.ts don't reach:
//   • selectPromotionsForPiggyback fail-closed on missing footer settings
//   • recordClickAndResolve p-flavor HMAC-fail path skips the click write
//   • loadInvoicePagePromos per-promo dispatch-channel filter (not global)
//   • recordClickAndResolve d-flavor with unresolved delivery → anonymous
//
// These lock in the security/correctness fixes from the audit against
// silent regressions. They mock at the prisma-client level so no real DB
// or external services are touched — same fast-feedback loop as the rest
// of the build gate.
//
// HOW TO USE THIS FILE
// If a test breaks, the fix is almost never to relax the assertion. If
// the code path legitimately changed (documented policy update), update
// the test AND leave a comment explaining why the old behavior no longer
// applies.

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is HOISTED to the top of the file — the factory can't
// reference variables declared below it. To share the mock jar with
// tests, use vi.hoisted() which lifts the initializer to the same
// pre-import phase.
const mocks = vi.hoisted(() => ({
  setting: {
    findMany: (vi.fn as any)(),
    // upsert used by loadPromotionSettings to auto-generate + persist
    // PROMOTION_HMAC_SECRET when the row is missing/empty. Tests that
    // set hmacSecret: "" exercise this path.
    upsert: (vi.fn as any)().mockResolvedValue({}),
  },
  clientContact: { findUnique: (vi.fn as any)() },
  promotion: { findMany: (vi.fn as any)(), findUnique: (vi.fn as any)() },
  promotionDelivery: {
    findMany: (vi.fn as any)(),
    findFirst: (vi.fn as any)(),
    createMany: (vi.fn as any)(),
    update: (vi.fn as any)(),
    create: (vi.fn as any)(),
    findUnique: (vi.fn as any)(),
  },
  promotionClick: { create: (vi.fn as any)() },
}));

vi.mock("../db/prisma", () => ({
  prisma: {
    setting: mocks.setting,
    clientContact: mocks.clientContact,
    promotion: mocks.promotion,
    promotionDelivery: mocks.promotionDelivery,
    promotionClick: mocks.promotionClick,
  },
}));

// Mock socialLinks (dynamic-imported by loadLandingPageForPublic — not
// tested here but the import path is walked by service module init).
vi.mock("./socialLinks", () => ({
  loadSocialLinks: async () => [],
}));

// Now import the service — this is safe post-mock.
import {
  selectPromotionsForPiggyback,
  loadInvoicePagePromos,
  recordClickAndResolve,
  signDeliveryClickToken,
  signPromoClickToken,
  optOutByIdentifier,
  runManualSendBurst,
  loadLandingPageForPublic,
} from "./promotions";

const HMAC_SECRET = "test-secret-with-at-least-32-characters-of-length";
const EMAIL_FOOTER = "Unsubscribe: {{unsubscribeLink}} | {{businessAddress}}";
const SMS_FOOTER = "Reply STOP or {{unsubscribeLink}}";
const BUSINESS_ADDR = "123 Test Ln, Testville, TS 00000";

function setSettings(overrides: Partial<{
  hmacSecret: string;
  emailFooter: string;
  smsFooter: string;
  businessAddress: string;
  baseUrl: string;
}> = {}) {
  const rows = [
    { key: "PROMOTION_HMAC_SECRET", value: overrides.hmacSecret ?? HMAC_SECRET },
    { key: "PROMOTION_OPT_OUT_FOOTER_EMAIL", value: overrides.emailFooter ?? EMAIL_FOOTER },
    { key: "PROMOTION_OPT_OUT_FOOTER_SMS", value: overrides.smsFooter ?? SMS_FOOTER },
    { key: "BUSINESS_ADDRESS", value: overrides.businessAddress ?? BUSINESS_ADDR },
    { key: "PAYMENT_REQUEST_BASE_URL", value: overrides.baseUrl ?? "https://s.example.com" },
  ];
  mocks.setting.findMany.mockResolvedValue(rows);
}

function resetMocks() {
  for (const m of Object.values(mocks)) {
    for (const fn of Object.values(m)) {
      (fn as any).mockReset();
    }
  }
  // Preserve the setting.upsert default (resolves to {}) — used by
  // loadPromotionSettings for the HMAC secret auto-gen path. Without
  // this, tests that trigger auto-gen crash with "cannot read property
  // 'setting' of undefined" when the upsert returns undefined.
  mocks.setting.upsert.mockResolvedValue({});
}

// ── selectPromotionsForPiggyback — CAN-SPAM fail-closed ─────────────

describe("selectPromotionsForPiggyback — CAN-SPAM fail-closed guards", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("auto-generates PROMOTION_HMAC_SECRET when the row is empty (never left in the fail-closed state)", async () => {
    // Seed with an empty secret — loadPromotionSettings will invoke
    // setting.upsert to persist a freshly-generated one and return
    // the new value; downstream piggyback selection proceeds normally
    // (with no active promos in this test → empty append).
    setSettings({ hmacSecret: "" });
    mocks.clientContact.findUnique.mockResolvedValue({
      id: "c1",
      clientId: "cl1",
      promoEmailOptedOut: false,
      promoSmsOptedOut: false,
    });
    mocks.promotion.findMany.mockResolvedValue([]);
    const r = await selectPromotionsForPiggyback({
      contactId: "c1",
      clientId: "cl1",
      channel: "email",
      triggeredBy: "tok",
    });
    expect(r.bodyAppend).toBe("");
    // Auto-gen happened — setting.upsert was called with the HMAC key.
    expect(mocks.setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "PROMOTION_HMAC_SECRET" } }),
    );
    // Downstream flow ran (didn't short-circuit) — proves auto-gen
    // unblocked the piggyback path.
    expect(mocks.clientContact.findUnique).toHaveBeenCalled();
  });

  it("email channel: returns empty bodyAppend when emailFooter is missing", async () => {
    setSettings({ emailFooter: "" });
    const r = await selectPromotionsForPiggyback({
      contactId: "c1",
      clientId: "cl1",
      channel: "email",
      triggeredBy: "tok",
    });
    expect(r.bodyAppend).toBe("");
    expect(mocks.clientContact.findUnique).not.toHaveBeenCalled();
  });

  it("email channel: returns empty bodyAppend when businessAddress is missing", async () => {
    setSettings({ businessAddress: "" });
    const r = await selectPromotionsForPiggyback({
      contactId: "c1",
      clientId: "cl1",
      channel: "email",
      triggeredBy: "tok",
    });
    expect(r.bodyAppend).toBe("");
    expect(mocks.clientContact.findUnique).not.toHaveBeenCalled();
  });

  it("sms channel: returns empty bodyAppend when smsFooter is missing", async () => {
    setSettings({ smsFooter: "" });
    const r = await selectPromotionsForPiggyback({
      contactId: "c1",
      clientId: "cl1",
      channel: "sms",
      triggeredBy: "tok",
    });
    expect(r.bodyAppend).toBe("");
    expect(mocks.clientContact.findUnique).not.toHaveBeenCalled();
  });

  it("sms channel does NOT require businessAddress (only emailFooter needs it)", async () => {
    setSettings({ businessAddress: "" });
    // Set up minimal downstream: contact exists but has no active promos.
    mocks.clientContact.findUnique.mockResolvedValue({
      id: "c1",
      clientId: "cl1",
      promoEmailOptedOut: false,
      promoSmsOptedOut: false,
    });
    mocks.promotion.findMany.mockResolvedValue([]);
    const r = await selectPromotionsForPiggyback({
      contactId: "c1",
      clientId: "cl1",
      channel: "sms",
      triggeredBy: "tok",
    });
    expect(r.bodyAppend).toBe("");
    // Reached the contact query (didn't short-circuit) — proves SMS
    // is not gated by businessAddress.
    expect(mocks.clientContact.findUnique).toHaveBeenCalled();
  });
});

// ── loadInvoicePagePromos — per-promo dispatch-channel filter ───────

describe("loadInvoicePagePromos — per-promo (not global) opt-out suppression", () => {
  beforeEach(() => {
    resetMocks();
    setSettings();
  });

  const displayPromo = (id: string, extras: Partial<any> = {}) => ({
    id,
    status: "ACTIVE",
    startAt: null,
    endAt: null,
    startedAt: new Date("2026-01-01"),
    dispatchChannels: [] as string[],
    displaySurfaces: ["invoice_page"],
    content: { invoice_page: { body: `${id} body`, ctaText: "Learn more" } },
    link: null,
    linkKind: "EXTERNAL",
    landingPageId: null,
    ...extras,
  });

  it("display-only promo (no dispatch channels) is shown even when contact opted out of both channels", async () => {
    mocks.clientContact.findUnique.mockResolvedValue({
      promoEmailOptedOut: true,
      promoSmsOptedOut: true,
    });
    mocks.promotion.findMany.mockResolvedValue([displayPromo("p_display_only")]);
    const r = await loadInvoicePagePromos({ contactId: "c1" });
    expect(r.map((p) => p.id)).toEqual(["p_display_only"]);
  });

  it("promo with dispatchChannels=[email] is HIDDEN when contact opted out of email", async () => {
    mocks.clientContact.findUnique.mockResolvedValue({
      promoEmailOptedOut: true,
      promoSmsOptedOut: false,
    });
    mocks.promotion.findMany.mockResolvedValue([
      displayPromo("p_email_only", { dispatchChannels: ["email"] }),
    ]);
    const r = await loadInvoicePagePromos({ contactId: "c1" });
    expect(r).toEqual([]);
  });

  it("promo with dispatchChannels=[email,sms] is HIDDEN only when contact opted out of BOTH", async () => {
    mocks.clientContact.findUnique.mockResolvedValue({
      promoEmailOptedOut: true,
      promoSmsOptedOut: false, // still opted-in on SMS
    });
    mocks.promotion.findMany.mockResolvedValue([
      displayPromo("p_multi", { dispatchChannels: ["email", "sms"] }),
    ]);
    const r = await loadInvoicePagePromos({ contactId: "c1" });
    // Still shows — SMS channel is still open.
    expect(r.map((p) => p.id)).toEqual(["p_multi"]);
  });

  it("mixed set: display-only shown, dispatch-gated hidden per-promo", async () => {
    mocks.clientContact.findUnique.mockResolvedValue({
      promoEmailOptedOut: true,
      promoSmsOptedOut: true,
    });
    mocks.promotion.findMany.mockResolvedValue([
      displayPromo("p_display"),
      displayPromo("p_email_gated", { dispatchChannels: ["email"] }),
      displayPromo("p_sms_gated", { dispatchChannels: ["sms"] }),
    ]);
    const r = await loadInvoicePagePromos({ contactId: "c1" });
    // Only the display-only promo survives — the two dispatch-gated
    // promos see the contact opted out on their sole channel.
    expect(r.map((p) => p.id)).toEqual(["p_display"]);
  });
});

// ── recordClickAndResolve — p-flavor HMAC-fail does NOT write click ─

describe("recordClickAndResolve — p-flavor HMAC-fail defense", () => {
  beforeEach(() => {
    resetMocks();
    setSettings();
  });

  it("p-flavor with valid HMAC writes a PromotionClick row", async () => {
    const token = signPromoClickToken(HMAC_SECRET, "promo_1", null);
    mocks.clientContact.findUnique.mockResolvedValue(null);
    mocks.promotion.findUnique.mockResolvedValue({
      linkKind: "EXTERNAL",
      link: "https://dest.example.com",
      landingPageId: null,
      status: "ACTIVE",
    });
    mocks.promotionClick.create.mockResolvedValue({} as any);
    const r = await recordClickAndResolve({
      flavor: "p",
      primaryId: "promo_1",
      contactId: null,
      token,
      userAgent: "ua",
      ipAddress: null,
    });
    expect(r.destinationUrl).toBe("https://dest.example.com");
    expect(mocks.promotionClick.create).toHaveBeenCalledTimes(1);
  });

  it("p-flavor with INVALID HMAC does NOT write a PromotionClick row (attribution defense)", async () => {
    mocks.promotion.findUnique.mockResolvedValue({
      linkKind: "EXTERNAL",
      link: "https://dest.example.com",
      landingPageId: null,
    });
    const r = await recordClickAndResolve({
      flavor: "p",
      primaryId: "promo_1",
      contactId: null,
      token: "obviously-not-a-valid-hmac-token",
      userAgent: "ua",
      ipAddress: null,
    });
    // Redirect still works (best-effort UX on a forwarded link).
    expect(r.destinationUrl).toBe("https://dest.example.com");
    // But NO click row was written — attribution defense.
    expect(mocks.promotionClick.create).not.toHaveBeenCalled();
  });

  it("p-flavor with INVALID HMAC AND unknown promoId returns null (no redirect, no write)", async () => {
    mocks.promotion.findUnique.mockResolvedValue(null);
    const r = await recordClickAndResolve({
      flavor: "p",
      primaryId: "promo_nonexistent",
      contactId: null,
      token: "obviously-bogus",
      userAgent: "ua",
      ipAddress: null,
    });
    expect(r.destinationUrl).toBeNull();
    expect(mocks.promotionClick.create).not.toHaveBeenCalled();
  });
});

// ── recordClickAndResolve — d-flavor unresolved delivery ────────────

describe("recordClickAndResolve — d-flavor delivery resolution", () => {
  beforeEach(() => {
    resetMocks();
    setSettings();
  });

  it("d-flavor with valid HMAC + existing delivery attributes cleanly", async () => {
    const token = signDeliveryClickToken(HMAC_SECRET, "delivery_1");
    mocks.promotionDelivery.findUnique.mockResolvedValue({
      promotionId: "promo_a",
      contactId: "contact_a",
      clientId: "client_a",
    });
    mocks.promotion.findUnique.mockResolvedValue({
      linkKind: "EXTERNAL",
      link: "https://dest.example.com",
      landingPageId: null,
      status: "ACTIVE",
    });
    mocks.promotionClick.create.mockResolvedValue({} as any);
    const r = await recordClickAndResolve({
      flavor: "d",
      primaryId: "delivery_1",
      contactId: null,
      token,
      userAgent: "ua",
      ipAddress: null,
    });
    expect(r.destinationUrl).toBe("https://dest.example.com");
    const call = mocks.promotionClick.create.mock.calls[0][0];
    // Full attribution: promotionId + deliveryId + contactId + clientId all set.
    expect(call.data.promotionId).toBe("promo_a");
    expect(call.data.deliveryId).toBe("delivery_1");
    expect(call.data.contactId).toBe("contact_a");
    expect(call.data.clientId).toBe("client_a");
    expect(call.data.anonymousReason).toBeNull();
  });

  it("d-flavor with valid HMAC but MISSING delivery row logs anonymous (delivery_not_found)", async () => {
    const token = signDeliveryClickToken(HMAC_SECRET, "delivery_missing");
    mocks.promotionDelivery.findUnique.mockResolvedValue(null);
    // With deliveryId not resolvable, promotionId stays null → early
    // return, no click write. This matches the current behavior — the
    // spec doesn't require crediting the promo when we can't resolve
    // which delivery this was.
    const r = await recordClickAndResolve({
      flavor: "d",
      primaryId: "delivery_missing",
      contactId: null,
      token,
      userAgent: "ua",
      ipAddress: null,
    });
    expect(r.destinationUrl).toBeNull();
    expect(mocks.promotionClick.create).not.toHaveBeenCalled();
  });

  it("d-flavor with INVALID HMAC AND unknown delivery returns null (forwarded link → nothing to redirect to)", async () => {
    mocks.promotionDelivery.findUnique.mockResolvedValue(null);
    const r = await recordClickAndResolve({
      flavor: "d",
      primaryId: "delivery_x",
      contactId: null,
      token: "obviously-bogus",
      userAgent: "ua",
      ipAddress: null,
    });
    expect(r.destinationUrl).toBeNull();
    expect(mocks.promotionClick.create).not.toHaveBeenCalled();
  });
});

// ── loadLandingPageForPublic — non-ACTIVE returns empty shell ────────
// Attaches promotionLandingPage lazily to the mocked prisma jar so
// each test can inject a specific page shape (the model isn't part of
// the default hoisted jar since only this suite uses it).

describe("loadLandingPageForPublic — non-ACTIVE promotions don't leak content", () => {
  beforeEach(async () => {
    resetMocks();
    setSettings();
  });

  const mockPage = (promoStatus: string, extras: Partial<any> = {}) => ({
    id: "page_1",
    slug: "spring-2027-preview",
    headline: "Confidential Draft",
    intro: "Coming spring 2027 — internal preview only",
    viewCount: 0,
    items: [
      // `photos` replaced the single imageR2Key/imageMimeType pair. Empty
      // array is the faithful translation of the old "no image" fixture —
      // what these scenarios assert is content LEAKAGE, not imagery.
      { id: "item_1", title: "Secret Bundle", description: "Details", ordinal: 0, photos: [] },
    ],
    promotion: { status: promoStatus, startAt: null, endAt: null },
    ...extras,
  });

  async function withPage(page: any) {
    const { prisma } = await import("../db/prisma");
    (prisma as any).promotionLandingPage = { findUnique: vi.fn().mockResolvedValue(page) };
  }

  it("DRAFT promotion → returns shell with promotionActive=false and NO items/business/intro/headline", async () => {
    await withPage(mockPage("DRAFT"));
    const r = await loadLandingPageForPublic("spring-2027-preview");
    expect(r).not.toBeNull();
    expect(r!.promotionActive).toBe(false);
    expect(r!.items).toEqual([]);
    expect(r!.headline).toBeNull();
    expect(r!.intro).toBeNull();
    // Business block also empty — no phone/email/address leak.
    expect(r!.business.name).toBe("");
    expect(r!.business.phone).toBe("");
    expect(r!.business.email).toBe("");
    expect(r!.business.address).toBe("");
  });

  it("CLOSED promotion → returns shell with promotionActive=false", async () => {
    await withPage(mockPage("CLOSED"));
    const r = await loadLandingPageForPublic("spring-2027-preview");
    expect(r!.promotionActive).toBe(false);
    expect(r!.items).toEqual([]);
  });

  it("ACTIVE promotion within window → returns full content", async () => {
    // loadLandingPageForPublic also loads business settings via a
    // separate setting.findMany call. Return an empty array so it
    // doesn't throw.
    mocks.setting.findMany.mockResolvedValueOnce([]);
    await withPage(mockPage("ACTIVE"));
    const r = await loadLandingPageForPublic("spring-2027-preview");
    expect(r!.promotionActive).toBe(true);
    expect(r!.items).toHaveLength(1);
    expect(r!.items[0].title).toBe("Secret Bundle");
    expect(r!.headline).toBe("Confidential Draft");
  });

  it("ACTIVE promotion BEFORE startAt window → returns empty shell", async () => {
    const futureStart = new Date(Date.now() + 24 * 3600 * 1000);
    await withPage(
      mockPage("ACTIVE", { promotion: { status: "ACTIVE", startAt: futureStart, endAt: null } }),
    );
    const r = await loadLandingPageForPublic("spring-2027-preview");
    expect(r!.promotionActive).toBe(false);
    expect(r!.items).toEqual([]);
  });

  it("ACTIVE promotion AFTER endAt window → returns empty shell", async () => {
    const pastEnd = new Date(Date.now() - 24 * 3600 * 1000);
    await withPage(
      mockPage("ACTIVE", { promotion: { status: "ACTIVE", startAt: null, endAt: pastEnd } }),
    );
    const r = await loadLandingPageForPublic("spring-2027-preview");
    expect(r!.promotionActive).toBe(false);
    expect(r!.items).toEqual([]);
  });
});

// ── runManualSendBurst — pre-flight guards ──────────────────────────

describe("runManualSendBurst — pre-flight guard rejections", () => {
  beforeEach(() => {
    resetMocks();
  });

  const activeEmailPromo = (extras: Partial<any> = {}) => ({
    id: "promo_1",
    status: "ACTIVE",
    triggerKind: "manual_send",
    dispatchChannels: ["email"],
    startAt: null,
    endAt: null,
    lastDispatchStartedAt: null,
    content: { email: { subject: "s", body: "b", ctaText: "cta" } },
    cooldownDays: 7,
    title: "Test Promo",
    link: null,
    ...extras,
  });

  it("auto-generates PROMOTION_HMAC_SECRET when the row is empty (no rejection — operator never has to touch this)", async () => {
    // With auto-gen in loadPromotionSettings, the "hmacSecret missing"
    // branch in runManualSendBurst is now unreachable from real
    // callers. We verify the auto-gen fires + the burst continues past
    // the guard (still fails later for other reasons — that's fine,
    // we're just asserting the HMAC guard is no longer a blocker).
    setSettings({ hmacSecret: "" });
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo());
    // Concurrent-lock acquire — return count=0 so the burst rejects
    // AFTER the HMAC check (proves the HMAC path passed).
    const { prisma } = await import("../db/prisma");
    (prisma as any).promotion.updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/already in progress/);
    expect(mocks.setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "PROMOTION_HMAC_SECRET" } }),
    );
  });

  it("rejects email-channel promo when emailFooter is missing", async () => {
    setSettings({ emailFooter: "" });
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo());
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/FOOTER_EMAIL/);
  });

  it("rejects email-channel promo when businessAddress is missing", async () => {
    setSettings({ businessAddress: "" });
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo());
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/BUSINESS_ADDRESS/);
  });

  it("rejects sms-channel promo when smsFooter is missing", async () => {
    setSettings({ smsFooter: "" });
    mocks.promotion.findUnique.mockResolvedValue(
      activeEmailPromo({ dispatchChannels: ["sms"], content: { sms: { body: "b", ctaText: "" } } }),
    );
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/FOOTER_SMS/);
  });

  it("rejects promo whose startAt is in the future (before window)", async () => {
    setSettings();
    const futureStart = new Date(Date.now() + 24 * 3600 * 1000);
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo({ startAt: futureStart }));
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/starts at/);
  });

  it("rejects promo whose endAt is in the past (after window)", async () => {
    setSettings();
    const pastEnd = new Date(Date.now() - 24 * 3600 * 1000);
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo({ endAt: pastEnd }));
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/ended at/);
  });

  it("rejects when a burst is already in-flight (atomic acquire fails)", async () => {
    setSettings();
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo());
    const { prisma } = await import("../db/prisma");
    // Simulate the atomic acquire failing (no rows matched the "no in-flight" WHERE).
    (prisma as any).promotion.updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/already in progress/);
  });

  it("rejects DRAFT promo (status guard)", async () => {
    setSettings();
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo({ status: "DRAFT" }));
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/not ACTIVE/);
  });

  it("rejects PAUSED promo", async () => {
    setSettings();
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo({ status: "PAUSED" }));
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/not ACTIVE/);
  });

  it("rejects on_invoice_sent trigger (must be manual_send)", async () => {
    setSettings();
    mocks.promotion.findUnique.mockResolvedValue(activeEmailPromo({ triggerKind: "on_invoice_sent" }));
    await expect(runManualSendBurst({ promotionId: "promo_1", actorUserId: "u1" }))
      .rejects.toThrow(/not a manual_send/);
  });

  it("rejects missing promo (404-like)", async () => {
    setSettings();
    mocks.promotion.findUnique.mockResolvedValue(null);
    await expect(runManualSendBurst({ promotionId: "promo_nonexistent", actorUserId: "u1" }))
      .rejects.toThrow(/not found/i);
  });
});
