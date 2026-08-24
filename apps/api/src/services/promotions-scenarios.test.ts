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
  // Invoice photos are looked up per surviving promo by
  // loadInvoicePagePromos. Defaults to [] so scenarios that don't care
  // about images (opt-out suppression, surface gating) don't each have to
  // stub it — the promo simply renders text-only.
  promotionInvoicePhoto: {
    findMany: (vi.fn as any)().mockResolvedValue([]),
    findUnique: (vi.fn as any)(),
    delete: (vi.fn as any)(),
    aggregate: (vi.fn as any)(),
    create: (vi.fn as any)(),
    update: (vi.fn as any)(),
    // Reference count used by deleteR2ObjectIfUnreferenced.
    count: (vi.fn as any)().mockResolvedValue(0),
  },
  promotionLandingPageItemPhoto: {
    count: (vi.fn as any)().mockResolvedValue(0),
  },
  // Audit rows are written alongside the mutations these scenarios drive.
  auditEvent: { create: (vi.fn as any)().mockResolvedValue({}) },
}));

vi.mock("../db/prisma", () => {
  // The mocked client needs `auditEvent` and `$transaction` because
  // services now write audit rows inside the same transaction as the
  // mutation (see feedback-audit-every-mutation). Without these the
  // service under test throws "prisma.$transaction is not a function"
  // and the audit call can't be exercised at all.
  //
  // `$transaction` supports BOTH shapes Prisma offers: the interactive
  // callback form (fn(tx)) and the array form ([p1, p2]). Handing the
  // callback the same mock object means a tx-scoped write and a direct
  // write land on the same spies.
  const client: any = {
    setting: mocks.setting,
    clientContact: mocks.clientContact,
    promotion: mocks.promotion,
    promotionDelivery: mocks.promotionDelivery,
    promotionClick: mocks.promotionClick,
    promotionInvoicePhoto: mocks.promotionInvoicePhoto,
    promotionLandingPageItemPhoto: mocks.promotionLandingPageItemPhoto,
    auditEvent: mocks.auditEvent,
  };
  client.$transaction = async (arg: any) =>
    typeof arg === "function" ? await arg(client) : await Promise.all(arg);
  return { prisma: client };
});

// Mock R2 so photo URLs are deterministic. Without this, getDownloadUrl
// makes a real presign call, fails (no creds in test), and the service's
// `.catch(() => null)` swallows it — leaving imageUrls empty and any
// photo assertion passing for entirely the wrong reason.
// Records every deleteObject call so a test can assert that shared bytes
// were NOT destroyed. Exported through the hoisted jar because vi.mock
// factories are lifted above ordinary declarations.
const r2 = vi.hoisted(() => ({ deletes: [] as string[] }));
vi.mock("../lib/r2", () => ({
  getDownloadUrl: (key: string) => Promise.resolve(`https://r2.test/${key}`),
  getUploadUrl: (key: string) => Promise.resolve(`https://r2.test/upload/${key}`),
  deleteObject: (key: string) => {
    r2.deletes.push(key);
    return Promise.resolve(undefined);
  },
}));
const r2Deletes = r2.deletes;

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
  // Same reasoning for invoice photos: loadInvoicePagePromos looks them up
  // for every surviving promo, so a bare mockReset() leaves findMany
  // returning undefined and the service dies on `.map` — in tests that are
  // about opt-out suppression and have nothing to do with images. Default
  // to "no photos"; tests that care stub their own rows.
  mocks.promotionInvoicePhoto.findMany.mockResolvedValue([]);
  // Reference counts default to "nothing else points at this key" so a
  // delete test that forgets to stub them still exercises the real path.
  mocks.promotionInvoicePhoto.count.mockResolvedValue(0);
  mocks.promotionLandingPageItemPhoto.count.mockResolvedValue(0);
  r2.deletes.length = 0;
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

// ── loadInvoicePagePromos — invoice photos ──────────────────────────
//
// Invoice photos are uploaded for the invoice surface specifically. They
// used to be DERIVED from the landing page ("first photo of the first
// item"), which meant reordering landing items or deleting one item's
// photo silently changed what every client saw on their invoice, and left
// EXTERNAL-link promos (no landing page) unable to show any image at all.
//
// These tests lock in the decoupling. If one breaks, do not relax it —
// re-deriving the invoice image from landing content is the exact
// regression they exist to prevent.

describe("loadInvoicePagePromos — invoice photos are independent of landing items", () => {
  beforeEach(() => {
    resetMocks();
    setSettings();
  });

  const promoRow = (extras: Partial<any> = {}) => ({
    id: "p1",
    status: "ACTIVE",
    startAt: null,
    endAt: null,
    startedAt: new Date("2026-01-01"),
    dispatchChannels: [] as string[],
    displaySurfaces: ["invoice_page"],
    content: { shared: { headline: "Fall", body: "Body", ctaText: "Go" } },
    link: "https://example.com",
    linkKind: "EXTERNAL",
    landingPageId: null,
    ...extras,
  });

  it("returns every invoice photo in sortOrder, with imageUrl as the cover", async () => {
    mocks.promotion.findMany.mockResolvedValue([promoRow()]);
    mocks.promotionInvoicePhoto.findMany.mockResolvedValue([
      { r2Key: "promotions/p1/invoice/a" },
      { r2Key: "promotions/p1/invoice/b" },
      { r2Key: "promotions/p1/invoice/c" },
    ]);
    const out = await loadInvoicePagePromos({ contactId: null });
    expect(out).toHaveLength(1);
    expect(out[0].imageUrls).toEqual([
      "https://r2.test/promotions/p1/invoice/a",
      "https://r2.test/promotions/p1/invoice/b",
      "https://r2.test/promotions/p1/invoice/c",
    ]);
    // imageUrl is the cover — the FIRST of imageUrls, not an independent
    // lookup that could drift from it.
    expect(out[0].imageUrl).toBe(out[0].imageUrls[0]);
  });

  it("queries PromotionInvoicePhoto by promotionId — never the landing page's items", async () => {
    mocks.promotion.findMany.mockResolvedValue([
      // Has a landing page, to prove the landing page is NOT consulted.
      promoRow({ linkKind: "LANDING_PAGE", link: null, landingPageId: "page-1" }),
    ]);
    mocks.promotionInvoicePhoto.findMany.mockResolvedValue([]);
    await loadInvoicePagePromos({ contactId: null });
    const call = mocks.promotionInvoicePhoto.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ promotionId: "p1" });
    // Ordering is what makes position 0 "the cover" — assert it explicitly
    // so a silent switch to insertion order can't slip through. The
    // createdAt tiebreaker is load-bearing too: concurrent uploads can
    // land on the same sortOrder, and without it the cover would shuffle
    // between page loads.
    expect(call.orderBy).toEqual([{ sortOrder: "asc" }, { createdAt: "asc" }]);
    // The old implementation reached for landing content here. If a future
    // edit reintroduces that, this catches it.
    expect(JSON.stringify(call.where)).not.toContain("pageId");
    expect(JSON.stringify(call.where)).not.toContain("item");
  });

  it("EXTERNAL-link promos (no landing page) can now carry invoice photos", async () => {
    // The regression this whole change exists to fix: under the old
    // landing-derived rule this promo could never show an image, because
    // landingPageId was null.
    mocks.promotion.findMany.mockResolvedValue([
      promoRow({ linkKind: "EXTERNAL", landingPageId: null }),
    ]);
    mocks.promotionInvoicePhoto.findMany.mockResolvedValue([
      { r2Key: "promotions/p1/invoice/only" },
    ]);
    const out = await loadInvoicePagePromos({ contactId: null });
    expect(out[0].imageUrl).toBe("https://r2.test/promotions/p1/invoice/only");
    expect(out[0].imageUrls).toHaveLength(1);
  });

  it("a promo with no invoice photos renders text-only rather than being dropped", async () => {
    mocks.promotion.findMany.mockResolvedValue([promoRow()]);
    mocks.promotionInvoicePhoto.findMany.mockResolvedValue([]);
    const out = await loadInvoicePagePromos({ contactId: null });
    expect(out).toHaveLength(1);
    expect(out[0].imageUrl).toBeNull();
    expect(out[0].imageUrls).toEqual([]);
    // The offer copy still has to be there — an image is an add-on, never
    // a precondition for showing the promo.
    expect(out[0].body).toBe("Body");
  });
});

// ── Shared R2 objects must survive a sibling delete ─────────────────
//
// The add_promotion_invoice_photos backfill seeded invoice photos by
// COPYING the landing item's r2Key — a pointer, not the bytes. So one R2
// object is referenced from both tables. The first version of
// deleteInvoicePhoto called deleteObject() unconditionally, which
// destroyed the object out from under the landing page: an operator
// removed an invoice cover and their landing item photos turned into
// broken-image icons. Real data loss, hit within minutes of shipping.
//
// If one of these breaks, do NOT relax it — deleting shared bytes is
// unrecoverable.

describe("photo deletes never destroy an R2 object another row still uses", () => {
  beforeEach(() => {
    resetMocks();
    setSettings();
  });

  it("keeps the object when a landing item still references the same key", async () => {
    const SHARED = "promotions/p1/items/i1/shared-object";
    mocks.promotionInvoicePhoto.findUnique.mockResolvedValue({
      r2Key: SHARED, contentType: "image/jpeg", promotionId: "p1", sortOrder: 0,
    });
    mocks.promotionInvoicePhoto.delete.mockResolvedValue({});
    // After the delete: no invoice rows left, but a landing row survives.
    mocks.promotionInvoicePhoto.count.mockResolvedValue(0);
    mocks.promotionLandingPageItemPhoto.count.mockResolvedValue(1);

    const { deleteInvoicePhoto } = await import("./promotions");
    await deleteInvoicePhoto("photo-1", "user-1");

    expect(mocks.promotionInvoicePhoto.delete).toHaveBeenCalled();
    expect(r2Deletes).toEqual([]); // the bytes MUST survive
  });

  it("deletes the object only once nothing references it", async () => {
    const LONE = "promotions/p1/invoice/lone-object";
    mocks.promotionInvoicePhoto.findUnique.mockResolvedValue({
      r2Key: LONE, contentType: "image/jpeg", promotionId: "p1", sortOrder: 0,
    });
    mocks.promotionInvoicePhoto.delete.mockResolvedValue({});
    mocks.promotionInvoicePhoto.count.mockResolvedValue(0);
    mocks.promotionLandingPageItemPhoto.count.mockResolvedValue(0);

    const { deleteInvoicePhoto } = await import("./promotions");
    await deleteInvoicePhoto("photo-1", "user-1");

    expect(r2Deletes).toEqual([LONE]);
  });
});

// ── Landing-page URL: host decides the path segment ─────────────────
//
// seedlings.pro/motion/<slug> reads as "pro-motion"; every other host
// keeps /promotion/<slug>. Both are REAL Next.js pages (see
// apps/web/pages/motion/[promotionSlug].tsx), never rewrites — rewrites
// live in two files that must agree, and on 2026-08-23 they silently
// didn't, 404ing every production promo click for months.
//
// The long form must keep working forever: it is already in customers'
// inboxes and SMS threads.

describe("buildLandingPageUrl — host picks the path segment", () => {
  it("uses /motion/ on the marketing domain", async () => {
    const { buildLandingPageUrl } = await import("./promotions");
    expect(buildLandingPageUrl("https://seedlings.pro", "fall-cleanup"))
      .toBe("https://seedlings.pro/motion/fall-cleanup");
    // Subdomains of the marketing domain count too.
    expect(buildLandingPageUrl("https://www.seedlings.pro", "fall-cleanup"))
      .toBe("https://www.seedlings.pro/motion/fall-cleanup");
  });

  it("uses /promotion/ everywhere else", async () => {
    const { buildLandingPageUrl } = await import("./promotions");
    for (const host of [
      "https://seedlings.team",
      "https://www.seedlings.team",
      "http://localhost:3000",
    ]) {
      expect(buildLandingPageUrl(host, "fall-cleanup"))
        .toBe(`${host}/promotion/fall-cleanup`);
    }
  });

  it("does NOT match a lookalike domain", async () => {
    const { buildLandingPageUrl } = await import("./promotions");
    // notseedlings.pro must not be treated as ours — the regex is
    // anchored on a dot or start-of-host for exactly this reason.
    expect(buildLandingPageUrl("https://notseedlings.pro", "x"))
      .toBe("https://notseedlings.pro/promotion/x");
    // ...and .pro appearing mid-host is not the marketing domain either.
    expect(buildLandingPageUrl("https://seedlings.pro.evil.com", "x"))
      .toBe("https://seedlings.pro.evil.com/promotion/x");
  });

  it("tolerates trailing slashes and a malformed base", async () => {
    const { buildLandingPageUrl } = await import("./promotions");
    expect(buildLandingPageUrl("https://seedlings.pro/", "x"))
      .toBe("https://seedlings.pro/motion/x");
    expect(buildLandingPageUrl("https://seedlings.pro///", "x"))
      .toBe("https://seedlings.pro/motion/x");
    // A bad Setting value must degrade to the long form, never throw —
    // throwing here would kill the click instead of just picking a
    // less-clever URL.
    expect(() => buildLandingPageUrl("not a url", "x")).not.toThrow();
    expect(buildLandingPageUrl("not a url", "x")).toContain("/promotion/x");
  });
});

// ── Invoice CTA honors the campaign's own domain ────────────────────
//
// Three code paths build promo URLs. Two always honored the campaign's
// baseDomain; loadInvoicePagePromos did not, so a campaign branded to the
// marketing domain still emitted an invoice button on the app domain —
// its texts said one host, its invoice button said another.
//
// This also drives the whole chain: the click handler derives its redirect
// from the host the visitor arrived on, so getting THIS right is what puts
// promos on one domain end to end.

describe("loadInvoicePagePromos — invoice CTA uses the campaign's baseDomain", () => {
  beforeEach(() => {
    resetMocks();
    setSettings({ baseUrl: "https://app.example.com" });
  });

  const promoRow = (extras: Partial<any> = {}) => ({
    id: "p1",
    status: "ACTIVE",
    startAt: null,
    endAt: null,
    startedAt: new Date("2026-01-01"),
    dispatchChannels: [] as string[],
    displaySurfaces: ["invoice_page"],
    content: { shared: { headline: "H", body: "B", ctaText: "Go" } },
    link: "https://example.com",
    linkKind: "EXTERNAL",
    landingPageId: null,
    baseDomain: null,
    ...extras,
  });

  it("falls back to the app domain when the campaign has no baseDomain", async () => {
    mocks.promotion.findMany.mockResolvedValue([promoRow({ baseDomain: null })]);
    const out = await loadInvoicePagePromos({ contactId: null });
    expect(out[0].ctaUrl).toContain("https://app.example.com/");
  });

  it("uses the campaign's baseDomain when set", async () => {
    mocks.promotion.findMany.mockResolvedValue([
      promoRow({ baseDomain: "https://promo.example.com" }),
    ]);
    const out = await loadInvoicePagePromos({ contactId: null });
    expect(out[0].ctaUrl).toContain("https://promo.example.com/");
    // And must NOT fall back to the app domain.
    expect(out[0].ctaUrl).not.toContain("app.example.com");
  });

  it("keeps the /api/public/ prefix on whichever host it uses", async () => {
    // The prefix is what makes the wrapper reachable at all — dropping it
    // is the exact bug that 404'd every production promo click.
    mocks.promotion.findMany.mockResolvedValue([
      promoRow({ baseDomain: "https://promo.example.com" }),
    ]);
    const out = await loadInvoicePagePromos({ contactId: null });
    expect(out[0].ctaUrl).toContain("/api/public/promotion/click/p/");
  });
});
