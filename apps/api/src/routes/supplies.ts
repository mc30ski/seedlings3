import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt, evaluateHoursApproval, loadHoursApprovalVarianceThreshold, loadPriorPersonMinutes } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import * as displays from "../services/displays";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, etTomorrow, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { InstructionScope, JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { portfolioWhere, portfolioWhereVia } from "../lib/portfolioScope";
import { WORKER_TYPES, classify, isFeeable, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate, occInEditableState } from "./_shared";
import { fetchWeatherAlerts } from "../services/weatherAlerts";
import { cached } from "../lib/cache";
import { businessLatLng } from "../lib/businessLocation";
import { hourlyForecastForOccurrence } from "../services/hourlyForecast";
import { ServiceError } from "../lib/errors";
import { persistCompletionSplits } from "../services/payments";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { redactObserverFieldsForCaller, redactPeekFieldsForCaller, redactUnclearedFieldsForCaller } from "../lib/observerRedaction";
import { capabilitiesForUsers, userCan } from "../lib/userCapabilities";

export default async function supplyRoutes(app: FastifyInstance) {
  const SUPPLY_PHOTO_LIMIT = 10;
  const { requires, approvedUser } = makeGuards(app);
  const req_inventoryPull = requires("inventory.pull");
  const req_suppliesManage = requires("supplies.manage");
  const req_suppliesView = requires("supplies.view");

  app.get("/supplies/:id", req_suppliesView, async (req: any) => {
    const row = await services.supplies.getById(String(req.params.id));
    if (!row) throw app.httpErrors.notFound("Supply not found");
    return row;
  });
  app.post("/supplies", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.create(uid, callerCanFn(req), {
      name: String(b.name ?? ""),
      description: b.description != null ? String(b.description) : null,
      unit: String(b.unit ?? ""),
      upc: b.upc != null ? String(b.upc) : null,
      category: b.category != null ? String(b.category) : null,
      clientUnitPrice: Number(b.clientUnitPrice ?? 0),
      clientMarkupPercent: b.clientMarkupPercent == null ? null : Number(b.clientMarkupPercent),
    });
  });
  app.patch("/supplies/:id", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    const input: any = {};
    if ("name" in b) input.name = String(b.name);
    if ("description" in b) input.description = b.description != null ? String(b.description) : null;
    if ("unit" in b) input.unit = String(b.unit);
    if ("upc" in b) input.upc = b.upc != null ? String(b.upc) : null;
    if ("category" in b) input.category = b.category != null ? String(b.category) : null;
    if ("clientUnitPrice" in b) input.clientUnitPrice = Number(b.clientUnitPrice);
    // Present-and-null is how a markup is cleared, so forward the key itself.
    if ("clientMarkupPercent" in b) {
      input.clientMarkupPercent =
        b.clientMarkupPercent == null ? null : Number(b.clientMarkupPercent);
    }
    return services.supplies.update(uid, callerCanFn(req), String(req.params.id), input);
  });
  app.post("/supplies/:id/archive", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.archive(uid, callerCanFn(req), String(req.params.id));
  });
  app.post("/supplies/:id/unarchive", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.unarchive(uid, callerCanFn(req), String(req.params.id));
  });
  app.post("/supplies/:id/purchases", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.recordPurchase(uid, callerCanFn(req), String(req.params.id), {
      quantity: Number(b.quantity),
      totalCost: Number(b.totalCost),
      date: b.date != null ? String(b.date) : null,
      notes: b.notes != null ? String(b.notes) : null,
      // OPTIONAL LEDGER BREADCRUMB, set at record time. The service has always
      // accepted it and the seed used it, but this route dropped it — so the
      // only way to link a purchase to its receipt was the separate
      // ledger-link PATCH, which nothing in the UI called. Many purchases may
      // point at one row; no total reads it.
      businessExpenseId: b.businessExpenseId != null ? String(b.businessExpenseId) : null,
    });
  });
  app.delete("/supplies/purchases/:purchaseId", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.reversePurchase(uid, callerCanFn(req), String(req.params.purchaseId));
  });
  app.post("/supplies/:id/adjustments", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.recordAdjustment(uid, callerCanFn(req), String(req.params.id), {
      delta: Number(b.delta),
      reason: String(b.reason ?? ""),
    });
  });
  app.post("/supplies/:id/photos/upload-url", req_suppliesManage, async (req: any) => {
    const supplyId = String(req.params.id);
    const { fileName, contentType } = (req.body || {}) as { fileName?: string; contentType?: string };
    const name = fileName || `photo-${Date.now()}.jpg`;
    const ct = contentType || "image/jpeg";
    const key = `supply/${supplyId}/${Date.now()}-${name}`;
    const uploadUrl = await getUploadUrl(key, ct, 300, "equipment-photos");
    return { uploadUrl, key, contentType: ct };
  });
  app.post("/supplies/:id/photos/confirm", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const supplyId = String(req.params.id);
    const { key, fileName, contentType, description } = (req.body || {}) as {
      key: string; fileName?: string; contentType?: string; description?: string;
    };
    if (!key) throw app.httpErrors.badRequest("key is required");
    // The key is built server-side above, but the client hands it back — so
    // check it still addresses THIS supply. Otherwise a confirm could attach
    // an object written under another supply's prefix.
    if (!key.startsWith(`supply/${supplyId}/`)) {
      throw app.httpErrors.badRequest("That upload key does not belong to this supply.");
    }
    const count = await prisma.supplyPhoto.count({ where: { supplyId } });
    if (count >= SUPPLY_PHOTO_LIMIT) {
      throw app.httpErrors.badRequest(`Maximum ${SUPPLY_PHOTO_LIMIT} photos per supply.`);
    }
    return prisma.$transaction(async (tx) => {
      const photo = await tx.supplyPhoto.create({
        data: {
          supplyId,
          r2Key: key,
          fileName: fileName ?? null,
          contentType: contentType ?? null,
          description: description?.trim() || null,
          sortOrder: count,
          uploadedById: uid,
        },
      });
      await writeAudit(tx, AUDIT.SUPPLY.UPDATED, uid, {
        supplyId,
        photoId: photo.id,
        action: "photo_added",
        fileName: photo.fileName,
        r2Key: photo.r2Key,
        affectsMoney: false,
        affectsStock: false,
      });
      return photo;
    });
  });
  app.get("/supplies/:id/photos", req_suppliesView, async (req: any) => {
    const supplyId = String(req.params.id);
    const photos = await prisma.supplyPhoto.findMany({
      where: { supplyId },
      orderBy: { sortOrder: "asc" },
    });
    return Promise.all(
      photos.map(async (p) => ({
        ...p,
        url: await getDownloadUrl(p.r2Key, 86400, "equipment-photos"),
      })),
    );
  });
  app.patch("/supplies/:id/photos/:photoId", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const supplyId = String(req.params.id);
    const photoId = String(req.params.photoId);
    const body = req.body || {};
    const existing = await prisma.supplyPhoto.findFirst({ where: { id: photoId, supplyId } });
    if (!existing) throw app.httpErrors.notFound("Photo not found.");
    const data: any = {};
    if ("description" in body) {
      data.description = body.description != null ? String(body.description).trim() || null : null;
    }
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    return prisma.$transaction(async (tx) => {
      const photo = await tx.supplyPhoto.update({ where: { id: photoId }, data });
      await writeAudit(tx, AUDIT.SUPPLY.UPDATED, uid, {
        supplyId,
        photoId,
        action: "photo_updated",
        descriptionBefore: existing.description,
        descriptionAfter: photo.description,
        affectsMoney: false,
        affectsStock: false,
      });
      return photo;
    });
  });
  app.delete("/supplies/:id/photos/:photoId", req_suppliesManage, async (req: any) => {
    const uid = await currentUserId(req);
    const supplyId = String(req.params.id);
    const photoId = String(req.params.photoId);
    const existing = await prisma.supplyPhoto.findFirst({ where: { id: photoId, supplyId } });
    if (!existing) throw app.httpErrors.notFound("Photo not found.");
    await prisma.$transaction(async (tx) => {
      await tx.supplyPhoto.delete({ where: { id: photoId } });
      // SNAPSHOT WHAT IS DESTROYED, before it is gone. The R2 object is left
      // in place deliberately: deleting bytes on a row delete makes an
      // accidental click unrecoverable, and an orphaned object costs cents.
      await writeAudit(tx, AUDIT.SUPPLY.UPDATED, uid, {
        supplyId,
        photoId,
        action: "photo_deleted",
        fileName: existing.fileName,
        description: existing.description,
        r2Key: existing.r2Key,
        affectsMoney: false,
        affectsStock: false,
      });
    });
    return { deleted: true };
  });
  // UPC lookup: tries the internal Supply table first, then the keyless
  // UPCitemdb trial endpoint as a best-effort fallback (rate-limited per IP,
  // ~100/day — fine for our scale). Returns both fields so the UI can decide
  // whether to open Buy More (existing match) or Add Supply (prefill).
  app.get("/supplies/upc-lookup", req_suppliesManage, async (req: any) => {
    const code = String((req.query?.code ?? "")).trim();
    if (!code) throw app.httpErrors.badRequest("Missing 'code' query parameter.");

    const matchExisting = await prisma.supply.findFirst({
      where: { upc: code, archivedAt: null },
      select: { id: true, name: true, unit: true, clientUnitPrice: true, onHand: true, category: true },
    });

    let lookup: { found: boolean; title?: string; brand?: string; description?: string } | null = null;
    if (!matchExisting) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 5000);
        const r = await fetch(
          `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`,
          { signal: ac.signal },
        );
        clearTimeout(t);
        if (r.ok) {
          const data: any = await r.json();
          const item = data?.items?.[0];
          if (item?.title) {
            lookup = {
              found: true,
              title: String(item.title),
              brand: item.brand ? String(item.brand) : undefined,
              description: item.description ? String(item.description) : undefined,
            };
          } else {
            lookup = { found: false };
          }
        } else {
          lookup = { found: false };
        }
      } catch {
        // Timeout or network error — degrade gracefully to "not found"
        lookup = { found: false };
      }
    }

    return { code, matchExisting, lookup };
  });
  app.get("/supplies", req_suppliesView, async (req: any) => {
    const q = (req.query || {}) as { includeArchived?: string; q?: string };
    // `includeHoldDetails` says WHO is holding stock, so it follows the
    // capability to reserve it rather than the URL that asked. The deleted
    // `/supplies` twin set it unconditionally on the same entitlement.
    return services.supplies.list({
      includeArchived: q.includeArchived === "true",
      q: q.q,
      includeHoldDetails: callerCan(req, "supplies.hold"),
    });
  });
  // Read-only history for workers/holders of `supplies.manage` (Inventory tab). Same shape as the
  // super route, but ownership-gated since the data is operational
  // (purchases / holds / adjustments per supply) — no tax-action surface.
  app.get("/supplies/:id/history", req_suppliesView, async (req: any) => {
    // THE CUTOFF APPLIES TO EVERYONE, which it did not before: the
    // `/supplies/:id/history` twin resolved the Business Start Date
    // filter and this one did not, so the LESS privileged route was the one
    // returning pre-cutoff purchase history. Money hidden from a caller with `supplies.manage`
    // surface must not be visible from the worker surface.
    const cutoff = await resolveCutoff(req);
    return services.supplies.listHistory(String(req.params.id), { cutoff });
  });
  app.delete("/supply-holds/:holdId", req_inventoryPull, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.removeHold(uid, callerCanFn(req), String(req.params.holdId));
  });
  app.patch("/supply-holds/:holdId", req_inventoryPull, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.adjustHold(uid, callerCanFn(req), String(req.params.holdId), Number(b.quantity));
  });
}
