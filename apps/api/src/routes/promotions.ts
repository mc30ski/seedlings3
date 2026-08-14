import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal } from "@prisma/client";
import { prisma } from "../db/prisma";
import { services } from "../services";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT, type AuditTuple } from "../lib/auditActions";
import {
  promotionSavePayloadSchema,
  runManualSendBurst,
  sendPromotionTest,
  setContactOptOut,
  ensureLandingPageForPromotion,
  updateLandingPage,
  loadLandingPageForEditor,
  createLandingPageItem,
  updateLandingPageItem,
  deleteLandingPageItem,
  reorderLandingPageItems,
  getLandingPageImageUploadUrl,
  confirmLandingPageImageUpload,
  rotatePromotionHmacSecret,
  loadAllowedDomains,
} from "../services/promotions";

// Super-only Promotions endpoints. All CRUD, lifecycle actions, manual
// send + test send, and the opt-out contact table live here.

async function currentUserId(req: any): Promise<string> {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

export default async function promotionsRoutes(app: FastifyInstance) {
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  // ── Allowed domains for the editor's per-campaign domain picker ────
  // Returns the same list the click-handler Host allowlist uses; the
  // editor renders a dropdown so operators can only pick a domain the
  // server will actually accept.
  app.get("/super/promotions/allowed-domains", superGuard, async () => {
    const { origins, primaryHostname } = await loadAllowedDomains();
    return { origins, primaryHostname };
  });

  // ── LIST ────────────────────────────────────────────────────────────
  app.get("/super/promotions", superGuard, async () => {
    const rows = await prisma.promotion.findMany({
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        updatedBy: { select: { id: true, displayName: true, email: true } },
        // landingPage is a 1:1 relation — including it here means the
        // detail panel (fed from this list) can render the public URL
        // and the View/Edit landing-page shortcuts without a second
        // fetch. Cheap join, small payload.
        landingPage: { select: { id: true, slug: true } },
        _count: { select: { deliveries: true } },
      },
    });
    // Cheap per-row aggregates the list header wants — delivered vs
    // skipped counts. One extra query for the whole set.
    const stats = await prisma.promotionDelivery.groupBy({
      by: ["promotionId", "skippedReason"],
      _count: true,
    });
    const statMap = new Map<string, { delivered: number; skipped: number }>();
    for (const s of stats) {
      const cur = statMap.get(s.promotionId) ?? { delivered: 0, skipped: 0 };
      if (s.skippedReason === null) cur.delivered += s._count;
      else cur.skipped += s._count;
      statMap.set(s.promotionId, cur);
    }
    return rows.map((r) => ({
      ...r,
      deliveredCount: statMap.get(r.id)?.delivered ?? 0,
      skippedCount: statMap.get(r.id)?.skipped ?? 0,
    }));
  });

  // ── GET one ─────────────────────────────────────────────────────────
  app.get("/super/promotions/:id", superGuard, async (req: any, reply: any) => {
    const id = String(req.params.id);
    const p = await prisma.promotion.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        updatedBy: { select: { id: true, displayName: true, email: true } },
        startedBy: { select: { id: true, displayName: true, email: true } },
        closedBy: { select: { id: true, displayName: true, email: true } },
        landingPage: { select: { id: true, slug: true } },
      },
    });
    if (!p) return reply.code(404).send({ error: "not_found" });
    return p;
  });

  // ── CREATE ──────────────────────────────────────────────────────────
  app.post("/super/promotions", superGuard, async (req: any, reply: any) => {
    const parsed = promotionSavePayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const uid = await currentUserId(req);
    const data = parsed.data;
    // Per-campaign domain must be a member of ALLOWED_DOMAINS when set.
    // Enforced at the write path because the Zod schema can't reach the
    // DB. Same allowlist the click handler uses — one source of truth.
    if (data.baseDomain) {
      const { loadAllowedDomains } = await import("../services/promotions");
      const { origins } = await loadAllowedDomains();
      if (!origins.includes(data.baseDomain)) {
        return reply.code(400).send({
          error: "domain_not_allowed",
          detail: `baseDomain must be one of: ${origins.join(", ")}`,
        });
      }
    }
    try {
      const created = await prisma.$transaction(async (tx) => {
        const p = await tx.promotion.create({
          data: {
            title: data.title,
            description: data.description,
            linkKind: data.linkKind,
            // link is only populated for EXTERNAL. LANDING_PAGE promotions
            // resolve their URL at click time from the associated
            // PromotionLandingPage.slug — the field is left null here.
            link: data.linkKind === "EXTERNAL" ? (data.link ?? null) : null,
            audienceSpec: data.audienceSpec,
            dispatchChannels: data.dispatchChannels,
            displaySurfaces: data.displaySurfaces,
            triggerKind: data.triggerKind ?? null,
            triggerConfig: data.triggerConfig as any,
            cooldownDays: data.cooldownDays,
            startAt: data.startAt ? new Date(data.startAt) : null,
            endAt: data.endAt ? new Date(data.endAt) : null,
            content: data.content as any,
            shortSlug: data.shortSlug?.toLowerCase() ?? null,
            baseDomain: data.baseDomain ?? null,
            createdById: uid,
            updatedById: uid,
            status: "DRAFT",
          },
        });
        await writeAudit(tx, AUDIT.PROMOTION.CREATED, uid, { promotionId: p.id });
        return p;
      });
      return created;
    } catch (err: any) {
      if (err?.code === "P2002" && err?.meta?.target?.includes?.("shortSlug")) {
        return reply.code(409).send({
          error: "slug_taken",
          detail: `The short URL slug "${data.shortSlug}" is already used by another promotion.`,
        });
      }
      throw err;
    }
  });

  // ── UPDATE (edit) ───────────────────────────────────────────────────
  app.patch("/super/promotions/:id", superGuard, async (req: any, reply: any) => {
    const id = String(req.params.id);
    const existing = await prisma.promotion.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing.status !== "DRAFT" && existing.status !== "PAUSED") {
      return reply
        .code(409)
        .send({ error: "not_editable", detail: "Only DRAFT/PAUSED promotions can be edited" });
    }
    const parsed = promotionSavePayloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", issues: parsed.error.issues });
    }
    const uid = await currentUserId(req);
    const data = parsed.data;
    // Slug lock — shortSlug is locked once the promotion has EVER been
    // ACTIVE (i.e., startedAt is set). Reason: URLs bearing the old
    // slug may already be in the wild; changing the slug would 404
    // every recipient's link. Even if the campaign is currently in
    // PAUSED, the fact that it's been ACTIVE at least once means old
    // URLs exist. Match the same lock semantics as landing page slug.
    const newSlug = data.shortSlug?.toLowerCase() ?? null;
    if (existing.startedAt && newSlug !== existing.shortSlug) {
      return reply.code(409).send({
        error: "slug_locked",
        detail: "Short URL slug can't change once the promotion has been started (would 404 every recipient's link).",
      });
    }
    // Per-campaign domain must be a member of ALLOWED_DOMAINS when set.
    if (data.baseDomain) {
      const { loadAllowedDomains } = await import("../services/promotions");
      const { origins } = await loadAllowedDomains();
      if (!origins.includes(data.baseDomain)) {
        return reply.code(400).send({
          error: "domain_not_allowed",
          detail: `baseDomain must be one of: ${origins.join(", ")}`,
        });
      }
    }
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.promotion.update({
          where: { id },
          data: {
            title: data.title,
            description: data.description,
            linkKind: data.linkKind,
            // link is only populated for EXTERNAL. LANDING_PAGE promotions
            // resolve their URL at click time from the associated
            // PromotionLandingPage.slug — the field is left null here.
            link: data.linkKind === "EXTERNAL" ? (data.link ?? null) : null,
            audienceSpec: data.audienceSpec,
            dispatchChannels: data.dispatchChannels,
            displaySurfaces: data.displaySurfaces,
            triggerKind: data.triggerKind ?? null,
            triggerConfig: data.triggerConfig as any,
            cooldownDays: data.cooldownDays,
            startAt: data.startAt ? new Date(data.startAt) : null,
            endAt: data.endAt ? new Date(data.endAt) : null,
            content: data.content as any,
            shortSlug: newSlug,
            baseDomain: data.baseDomain ?? null,
            updatedById: uid,
          },
        });
        await writeAudit(tx, AUDIT.PROMOTION.EDITED, uid, { promotionId: p.id });
        return p;
      });
      return updated;
    } catch (err: any) {
      if (err?.code === "P2002" && err?.meta?.target?.includes?.("shortSlug")) {
        return reply.code(409).send({
          error: "slug_taken",
          detail: `The short URL slug "${newSlug}" is already used by another promotion.`,
        });
      }
      throw err;
    }
  });

  // ── LIFECYCLE actions ───────────────────────────────────────────────
  // POST /super/promotions/:id/start   DRAFT→ACTIVE
  // POST /super/promotions/:id/pause   ACTIVE→PAUSED
  // POST /super/promotions/:id/resume  PAUSED→ACTIVE
  // POST /super/promotions/:id/retire  (any)→CLOSED
  // POST /super/promotions/:id/duplicate  → new DRAFT

  async function transition(
    id: string,
    from: string[],
    to: string,
    auditTuple: AuditTuple,
    actorUserId: string,
    extraFields: Record<string, unknown> = {},
  ) {
    const existing = await prisma.promotion.findUnique({ where: { id } });
    if (!existing) return { ok: false, code: 404, error: "not_found" as const };
    if (!from.includes(existing.status)) {
      return {
        ok: false,
        code: 409,
        error: "invalid_state" as const,
        detail: `Cannot transition to ${to} while ${existing.status}`,
      };
    }
    const updated = await prisma.$transaction(async (tx) => {
      const p = await tx.promotion.update({
        where: { id },
        data: { status: to as any, ...extraFields, updatedById: actorUserId },
      });
      await writeAudit(tx, auditTuple, actorUserId, {
        promotionId: id,
        fromStatus: existing.status,
        toStatus: to,
      });
      return p;
    });
    return { ok: true, promotion: updated };
  }

  app.post("/super/promotions/:id/start", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    // Fail-closed on CAN-SPAM prerequisites BEFORE flipping to ACTIVE.
    // If footer template or business address is missing, promo emails
    // ship with no unsubscribe link + no address = per-message FTC
    // penalty. Better to block the operator here than silently violate.
    const existing = await prisma.promotion.findUnique({
      where: { id: String(req.params.id) },
      select: { dispatchChannels: true },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const dispatchChannels = Array.isArray(existing.dispatchChannels)
      ? (existing.dispatchChannels as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    if (dispatchChannels.length > 0) {
      const { loadPromotionSettings } = await import("../services/promotions");
      // Side-effect: loadPromotionSettings auto-generates + persists a
      // fresh PROMOTION_HMAC_SECRET when the row is missing/empty, so
      // the secret is guaranteed present by the time this returns.
      const settings = await loadPromotionSettings();
      const missing: string[] = [];
      if (dispatchChannels.includes("email")) {
        if (!settings.emailFooter) missing.push("PROMOTION_OPT_OUT_FOOTER_EMAIL");
        if (!settings.businessAddress) missing.push("BUSINESS_ADDRESS");
      }
      if (dispatchChannels.includes("sms")) {
        if (!settings.smsFooter) missing.push("PROMOTION_OPT_OUT_FOOTER_SMS");
      }
      if (missing.length > 0) {
        return reply.code(409).send({
          error: "missing_settings",
          detail: `Cannot start — the following settings must be configured before an ACTIVE promotion with dispatch channels can ship: ${missing.join(", ")}. Edit them in the Settings tab under Promotions (or Neon UI for prod), then retry.`,
          missing,
        });
      }
    }
    const res = await transition(String(req.params.id), ["DRAFT", "PAUSED"], "ACTIVE",
      AUDIT.PROMOTION.STARTED, uid, { startedAt: new Date(), startedById: uid });
    if (!res.ok) return reply.code(res.code).send({ error: res.error, detail: (res as any).detail });
    return res.promotion;
  });

  app.post("/super/promotions/:id/pause", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    const res = await transition(String(req.params.id), ["ACTIVE"], "PAUSED",
      AUDIT.PROMOTION.PAUSED, uid);
    if (!res.ok) return reply.code(res.code).send({ error: res.error, detail: (res as any).detail });
    return res.promotion;
  });

  app.post("/super/promotions/:id/resume", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    const res = await transition(String(req.params.id), ["PAUSED"], "ACTIVE",
      AUDIT.PROMOTION.RESUMED, uid);
    if (!res.ok) return reply.code(res.code).send({ error: res.error, detail: (res as any).detail });
    return res.promotion;
  });

  app.post("/super/promotions/:id/retire", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    const res = await transition(
      String(req.params.id),
      ["DRAFT", "ACTIVE", "PAUSED"],
      "CLOSED",
      AUDIT.PROMOTION.RETIRED,
      uid,
      { closedAt: new Date(), closedById: uid },
    );
    if (!res.ok) return reply.code(res.code).send({ error: res.error, detail: (res as any).detail });
    return res.promotion;
  });

  app.post("/super/promotions/:id/duplicate", superGuard, async (req: any, reply: any) => {
    const src = await prisma.promotion.findUnique({ where: { id: String(req.params.id) } });
    if (!src) return reply.code(404).send({ error: "not_found" });
    const uid = await currentUserId(req);
    // Duplicate strategy:
    //   • For EXTERNAL promos: copy link + linkKind verbatim.
    //   • For LANDING_PAGE promos: reset to EXTERNAL with null link so
    //     the operator picks a fresh destination (either an external URL
    //     or Enable-landing-page again — which clones the landing page
    //     into a separate row). Previously the endpoint copied only
    //     src.link (null for LANDING_PAGE) and dropped linkKind, so the
    //     duplicate landed as EXTERNAL with null link and failed Zod
    //     validation on the next edit.
    const isSrcLanding = src.linkKind === "LANDING_PAGE";
    const copy = await prisma.$transaction(async (tx) => {
      const p = await tx.promotion.create({
        data: {
          title: `${src.title} (copy)`,
          description: src.description,
          linkKind: isSrcLanding ? "EXTERNAL" : src.linkKind,
          link: isSrcLanding ? null : src.link,
          // landingPageId intentionally omitted — landing pages are 1:1
          // with a promotion, so we don't share the FK with the source.
          audienceSpec: src.audienceSpec as any,
          dispatchChannels: src.dispatchChannels as any,
          displaySurfaces: src.displaySurfaces as any,
          triggerKind: src.triggerKind,
          triggerConfig: src.triggerConfig as any,
          cooldownDays: src.cooldownDays,
          startAt: null,
          endAt: null,
          content: src.content as any,
          status: "DRAFT",
          createdById: uid,
          updatedById: uid,
        },
      });
      await writeAudit(tx, AUDIT.PROMOTION.DUPLICATED, uid, {
        promotionId: p.id,
        sourcePromotionId: src.id,
        sourceLinkKind: src.linkKind,
      });
      return p;
    });
    return copy;
  });

  // ── Manual send burst ───────────────────────────────────────────────
  app.post("/super/promotions/:id/send-now", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    try {
      const res = await runManualSendBurst({
        promotionId: String(req.params.id),
        actorUserId: uid,
      });
      return res;
    } catch (err: any) {
      return reply.code(400).send({ error: "send_failed", detail: String(err?.message ?? err) });
    }
  });

  // ── Rotate the HMAC click-tracking secret ──────────────────────────
  // Super-only maintenance action. The secret is normally auto-managed
  // (auto-generated on first use, invisible in Settings) — rotation is
  // rare (leak suspicion, key-hygiene rotation). Every in-flight promo
  // click URL becomes anonymous after rotation (still redirects; the
  // HMAC no longer verifies, so attribution logs as null).
  app.post("/super/promotions/rotate-hmac-secret", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    try {
      const res = await rotatePromotionHmacSecret({ actorUserId: uid });
      return res;
    } catch (err: any) {
      return reply.code(500).send({ error: "rotate_failed", detail: String(err?.message ?? err) });
    }
  });

  // ── Send-to-self test ───────────────────────────────────────────────
  app.post("/super/promotions/:id/test-send", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    const channel = String((req.body ?? {}).channel);
    if (channel !== "email" && channel !== "sms") {
      return reply.code(400).send({ error: "invalid_channel" });
    }
    try {
      const res = await sendPromotionTest({
        promotionId: String(req.params.id),
        actorUserId: uid,
        channel: channel as "email" | "sms",
      });
      return res;
    } catch (err: any) {
      return reply.code(400).send({ error: "test_failed", detail: String(err?.message ?? err) });
    }
  });

  // ── Delivery log for one promotion ──────────────────────────────────
  // Includes a per-row click count so the operator can eyeball
  // engagement without leaving the delivery log. Aggregated in a single
  // groupBy query rather than N+1 counts.
  app.get("/super/promotions/:id/deliveries", superGuard, async (req: any) => {
    const id = String(req.params.id);
    const rows = await prisma.promotionDelivery.findMany({
      where: { promotionId: id },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        client: { select: { id: true, displayName: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const deliveryIds = rows.map((r) => r.id);
    const clickCounts = deliveryIds.length > 0
      ? await prisma.promotionClick.groupBy({
          by: ["deliveryId"],
          where: { deliveryId: { in: deliveryIds } },
          _count: { _all: true },
        })
      : [];
    const clickMap = new Map<string, number>();
    for (const c of clickCounts) {
      if (c.deliveryId) clickMap.set(c.deliveryId, c._count._all);
    }
    return rows.map((r) => ({ ...r, clickCount: clickMap.get(r.id) ?? 0 }));
  });

  // ── Audit history for one promotion ─────────────────────────────────
  // Filters by scope + metadata.promotionId JSON path — the `action`
  // column no longer carries the promotion id (it's the canonical
  // scope_verb string now). Metadata always includes promotionId for
  // every AUDIT.PROMOTION.* write path.
  app.get("/super/promotions/:id/audit", superGuard, async (req: any) => {
    const id = String(req.params.id);
    const rows = await prisma.auditEvent.findMany({
      where: {
        scope: "PROMOTION",
        metadata: { path: ["promotionId"], equals: id },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        actor: { select: { id: true, displayName: true, email: true } },
      },
    });
    return rows;
  });

  // ── Contact opt-out table + toggle ─────────────────────────────────
  app.get("/super/promotions/contacts", superGuard, async () => {
    const rows = await prisma.clientContact.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ client: { displayName: "asc" } }, { firstName: "asc" }],
      include: {
        client: { select: { id: true, displayName: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      client: r.client,
      promoEmailOptedOut: r.promoEmailOptedOut,
      promoSmsOptedOut: r.promoSmsOptedOut,
    }));
  });

  app.post("/super/promotions/contacts/:contactId/opt", superGuard, async (req: any, reply: any) => {
    const uid = await currentUserId(req);
    const contactId = String(req.params.contactId);
    const body = (req.body ?? {}) as {
      channel?: "email" | "sms";
      optedOut?: boolean;
      approve?: string;
      reason?: string;
    };
    if (body.channel !== "email" && body.channel !== "sms") {
      return reply.code(400).send({ error: "invalid_channel" });
    }
    if (typeof body.optedOut !== "boolean") {
      return reply.code(400).send({ error: "invalid_state" });
    }
    // Re-opt-in path — high-friction: require typed APPROVE + reason.
    if (body.optedOut === false) {
      if ((body.approve ?? "").trim().toUpperCase() !== "APPROVE") {
        return reply.code(400).send({ error: "approve_required" });
      }
      if (!body.reason || body.reason.trim().length < 3) {
        return reply.code(400).send({ error: "reason_required" });
      }
    }
    await setContactOptOut({
      contactId,
      channel: body.channel,
      optedOut: body.optedOut,
      source: "super_manual",
      actorUserId: uid,
      reason: body.reason,
    });
    return { ok: true };
  });

  // ── Per-contact opt history ────────────────────────────────────────
  // Filters by scope + metadata.contactId JSON path — same rationale as
  // the per-promotion audit above. Every setContactOptOut write includes
  // contactId in metadata.
  app.get("/super/promotions/contacts/:contactId/history", superGuard, async (req: any) => {
    const contactId = String(req.params.contactId);
    const rows = await prisma.auditEvent.findMany({
      where: {
        scope: "PROMO_OPT",
        metadata: { path: ["contactId"], equals: contactId },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        actor: { select: { id: true, displayName: true, email: true } },
      },
    });
    return rows;
  });

  // ── Landing page endpoints ─────────────────────────────────────────
  // GET landing page for editing (includes items + presigned image URLs)
  app.get("/super/promotions/:id/landing", superGuard, async (req: any, reply: any) => {
    const promoId = String(req.params.id);
    const promo = await prisma.promotion.findUnique({
      where: { id: promoId },
      select: { landingPageId: true },
    });
    if (!promo || !promo.landingPageId) return reply.code(404).send({ error: "not_found" });
    const page = await loadLandingPageForEditor({ pageId: promo.landingPageId });
    if (!page) return reply.code(404).send({ error: "not_found" });
    return page;
  });

  // Create-or-ensure landing page for a promotion. Also flips linkKind
  // to LANDING_PAGE. Called when the operator switches from External →
  // Custom landing page in the editor.
  app.post("/super/promotions/:id/landing", superGuard, async (req: any, reply: any) => {
    const promoId = String(req.params.id);
    const promo = await prisma.promotion.findUnique({
      where: { id: promoId },
      select: { title: true, status: true },
    });
    if (!promo) return reply.code(404).send({ error: "not_found" });
    if (promo.status !== "DRAFT" && promo.status !== "PAUSED") {
      return reply.code(409).send({ error: "not_editable" });
    }
    const uid = await currentUserId(req);
    const payload = (req.body ?? {}) as { slug?: string; headline?: string; intro?: string };
    const page = await ensureLandingPageForPromotion({
      promotionId: promoId,
      actorUserId: uid,
      seedFromTitle: promo.title,
      payload,
    });
    return page;
  });

  // PATCH landing-page (headline/intro/slug). Slug locked once ACTIVE.
  app.patch("/super/promotions/landing/:pageId", superGuard, async (req: any, reply: any) => {
    const pageId = String(req.params.pageId);
    const uid = await currentUserId(req);
    const payload = (req.body ?? {}) as { slug?: string; headline?: string; intro?: string };
    try {
      const page = await updateLandingPage({ pageId, actorUserId: uid, payload });
      return page;
    } catch (err: any) {
      return reply.code(400).send({ error: "update_failed", detail: String(err?.message ?? err) });
    }
  });

  // ── Landing-page items ─────────────────────────────────────────────
  app.post("/super/promotions/landing/:pageId/items", superGuard, async (req: any, reply: any) => {
    const pageId = String(req.params.pageId);
    const body = (req.body ?? {}) as { title?: string; description?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title_required" });
    const item = await createLandingPageItem({
      pageId,
      title: body.title.trim(),
      description: (body.description ?? "").trim(),
    });
    return item;
  });

  app.patch("/super/promotions/landing/items/:itemId", superGuard, async (req: any) => {
    const itemId = String(req.params.itemId);
    const body = (req.body ?? {}) as { title?: string; description?: string };
    await updateLandingPageItem({
      itemId,
      title: body.title?.trim(),
      description: body.description,
    });
    return { ok: true };
  });

  app.delete("/super/promotions/landing/items/:itemId", superGuard, async (req: any) => {
    const itemId = String(req.params.itemId);
    await deleteLandingPageItem({ itemId });
    return { ok: true };
  });

  app.post("/super/promotions/landing/:pageId/items/reorder", superGuard, async (req: any) => {
    const pageId = String(req.params.pageId);
    const body = (req.body ?? {}) as { itemIds?: string[] };
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
    await reorderLandingPageItems({ pageId, itemIds });
    return { ok: true };
  });

  // Presigned R2 upload URL for a specific item's image.
  app.post(
    "/super/promotions/landing/:pageId/items/:itemId/upload-url",
    superGuard,
    async (req: any, reply: any) => {
      const pageId = String(req.params.pageId);
      const itemId = String(req.params.itemId);
      const body = (req.body ?? {}) as { contentType?: string };
      const contentType = body.contentType || "image/jpeg";
      if (!/^image\//.test(contentType)) {
        return reply.code(400).send({ error: "invalid_content_type" });
      }
      // Resolve promotionId via the page relation so keys are namespaced
      // by promotion — makes cleanup + browsing R2 objects sane.
      const page = await prisma.promotionLandingPage.findUnique({
        where: { id: pageId },
        select: { promotion: { select: { id: true } } },
      });
      if (!page?.promotion) return reply.code(404).send({ error: "page_not_linked" });
      const res = await getLandingPageImageUploadUrl({
        promotionId: page.promotion.id,
        itemId,
        contentType,
      });
      return { ...res, contentType };
    },
  );

  // Confirm upload after the client PUT to R2 succeeds. Persists the
  // key on the item and cleans up any prior image (best-effort).
  app.post(
    "/super/promotions/landing/items/:itemId/confirm-image",
    superGuard,
    async (req: any, reply: any) => {
      const itemId = String(req.params.itemId);
      const body = (req.body ?? {}) as { key?: string; contentType?: string };
      if (!body.key) return reply.code(400).send({ error: "key_required" });
      await confirmLandingPageImageUpload({
        itemId,
        key: body.key,
        contentType: body.contentType || "image/jpeg",
      });
      return { ok: true };
    },
  );
}
