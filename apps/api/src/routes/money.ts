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
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereVia } from "../lib/areaScope";
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

export default async function moneyRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_equipmentView = requires("equipment.view");
  const req_materialsCharge = requires("materials.charge");
  const req_moneyApprove = requires("money.approve");
  const req_moneyView = requires("money.view");
  const req_moneyView_pending = requires("money.view");
  const req_pricingManage = requires("pricing.manage");
  const req_pricingView = requires("pricing.view");

  // Update a payment (admin)
  app.patch("/payments/:paymentId", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const input: any = {};
    if (body.amountPaid !== undefined) input.amountPaid = Number(body.amountPaid);
    if (body.method !== undefined) input.method = String(body.method);
    if ("note" in body) input.note = body.note ? String(body.note) : null;
    // paidAt — YYYY-MM-DD in ET, same contract as the approve route. Anchors
    // to ET-noon so the calendar day can't roll under a timezone offset.
    // Lets the operator correct a money-received date they got wrong at
    // approval time; see services/payments.ts updatePayment for what moves.
    if (body.paidAt !== undefined && body.paidAt !== null) {
      const key = String(body.paidAt);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        throw app.httpErrors.badRequest("paidAt must be YYYY-MM-DD");
      }
      input.paidAt = etInstantFromParts(key as EtDateKey, "12:00");
    }
    if (body.splits !== undefined) {
      if (!Array.isArray(body.splits)) throw app.httpErrors.badRequest("splits must be an array");
      input.splits = body.splits.map((sp: any) => ({
        userId: String(sp.userId),
        amount: Number(sp.amount),
      }));
    }
    return services.payments.updatePayment(uid, String(req.params.paymentId), input);
  });
  // Delete a payment (admin)
  app.delete("/payments/:paymentId", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    await services.payments.deletePayment(uid, String(req.params.paymentId));
    return { ok: true };
  });
  // List all payments (admin)
  app.get("/payments", req_moneyView, async (req: any) => {
    const { from, to, userId, method } = (req.query || {}) as {
      from?: string;
      to?: string;
      userId?: string;
      method?: string;
    };
    const cutoff = await resolveCutoff(req);
    // A Payment reaches its area through the occurrence it settles. Empty for
    // anyone holding money.view globally, so their query does not change.
    const areaWhere = areaWhereVia(req.principal, "money.view", "occurrence");
    return services.payments.listAllPayments({ from, to, userId, method, cutoff, areaWhere });
  });
  app.patch("/invoice-charges/:id/ledger-link", req_materialsCharge, async (req: any) => {
    const uid = await currentUserId(req);
    const invoiceChargeId = String(req.params.id);
    const businessExpenseId = (req.body || {}).businessExpenseId ?? null;
    const before = await prisma.invoiceCharge.findUnique({
      where: { id: invoiceChargeId },
      select: { id: true, businessExpenseId: true, occurrenceId: true },
    });
    if (!before) throw app.httpErrors.notFound("Invoice charge not found.");
    return prisma.$transaction(async (tx) => {
      // ONLY the pointer. Never cost, never description — this is a
      // reminder of what was bought, not a money edit.
      const row = await tx.invoiceCharge.update({
        where: { id: invoiceChargeId },
        data: { businessExpenseId },
        select: {
          id: true, businessExpenseId: true,
          businessExpense: {
            select: { id: true, cost: true, description: true, vendor: true, category: true, date: true },
          },
        },
      });
      await writeAudit(tx, AUDIT.EXPENSE.UPDATED, uid, {
        action: "ledger_link_changed",
        invoiceChargeId,
        occurrenceId: before.occurrenceId,
        businessExpenseIdBefore: before.businessExpenseId,
        businessExpenseIdAfter: businessExpenseId,
        affectsMoney: false,
      });
      return row;
    });
  });
  app.post("/pricing", req_pricingManage, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.label) throw app.httpErrors.badRequest("label is required");
    if (body.amount == null) throw app.httpErrors.badRequest("amount is required");
    if (!body.unit) throw app.httpErrors.badRequest("unit is required");

    // Generate key from label
    const key = "pricing_" + String(body.label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

    // Check for duplicate
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (existing) throw app.httpErrors.conflict("A pricing entry with a similar name already exists");

    // Normalize tags: accept either `jobTags: string[]` (new shape) or
    // legacy `jobTag: string` (single). Always persist the array form;
    // readers fall back to the legacy field for old rows.
    const incomingTags: string[] = Array.isArray(body.jobTags)
      ? body.jobTags.filter((t: any) => typeof t === "string" && t.length > 0).map(String)
      : body.jobTag
        ? [String(body.jobTag)]
        : [];
    const value = JSON.stringify({
      label: String(body.label),
      description: body.description ? String(body.description) : "",
      unit: String(body.unit),
      amount: Number(body.amount),
      sortOrder: body.sortOrder != null ? Number(body.sortOrder) : 100,
      // Optional bindings to one or more job tags (MOW, TRIM, EDGE, …)
      // so the add-on dialog and estimate workflow can surface this
      // entry as an inline reference price for any matching tag.
      // Pricing entries with no tags still appear on the Pricing tab —
      // they just don't drive any auto-match hint.
      jobTags: incomingTags,
    });

    return services.settings.set(uid, key, value);
  });
  app.patch("/pricing/:key", req_pricingManage, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    if (!key.startsWith("pricing_")) throw app.httpErrors.badRequest("Invalid pricing key");

    const existing = await prisma.setting.findUnique({ where: { key } });
    if (!existing) throw app.httpErrors.notFound("Pricing entry not found");

    let current: any = {};
    try { current = JSON.parse(existing.value); } catch {}

    const body = req.body || {};
    // Resolve the new jobTags array: prefer explicit `jobTags` (array),
    // fall back to legacy `jobTag` (single), then fall back to whatever
    // is currently stored — array or legacy single, normalized to array.
    let nextTags: string[];
    if (Array.isArray(body.jobTags)) {
      nextTags = body.jobTags.filter((t: any) => typeof t === "string" && t.length > 0).map(String);
    } else if ("jobTag" in body) {
      nextTags = body.jobTag ? [String(body.jobTag)] : [];
    } else if (Array.isArray(current.jobTags)) {
      nextTags = current.jobTags.filter((t: any) => typeof t === "string" && t.length > 0);
    } else if (current.jobTag) {
      nextTags = [String(current.jobTag)];
    } else {
      nextTags = [];
    }
    const value = JSON.stringify({
      label: body.label != null ? String(body.label) : current.label,
      description: body.description != null ? String(body.description) : current.description,
      unit: body.unit != null ? String(body.unit) : current.unit,
      amount: body.amount != null ? Number(body.amount) : current.amount,
      sortOrder: body.sortOrder != null ? Number(body.sortOrder) : current.sortOrder,
      jobTags: nextTags,
    });

    return services.settings.set(uid, key, value);
  });
  app.delete("/pricing/:key", req_pricingManage, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    if (!key.startsWith("pricing_")) throw app.httpErrors.badRequest("Invalid pricing key");

    // AUDITED AFTER THE DELETE, AND IN THE SAME TRANSACTION. This wrote
    // the audit row first, on the bare client, and then deleted — so a
    // delete that threw (a key already gone, a constraint) left behind a
    // row asserting a deletion that never happened. The trail is only
    // evidence if it cannot claim more than the database did.
    await prisma.$transaction(async (tx) => {
      await tx.setting.delete({ where: { key } });
      await writeAudit(tx, AUDIT.SETTING.DELETED, uid, { key, action: "deleted" });
    });
    return { ok: true };
  });
  app.get("/payments/pending", req_moneyView_pending, async (req: any) => {
    const cutoff = await resolveCutoff(req);
    return services.payments.listPendingApprovals(
      cutoff,
      areaWhereVia(req.principal, "money.view", "occurrence"),
    );
  });
  // Outstanding payment requests — sent to a client, not yet paid back.
  app.get("/payment-requests/outstanding", req_moneyView_pending, async (req: any) => {
    const cutoff = await resolveCutoff(req);
    // This one reads JobOccurrence directly, which carries areaId itself, so
    // the fragment is top-level rather than nested through a relation.
    return services.paymentRequests.listOutstanding({
      cutoff,
      areaWhere: areaWhere(req.principal, "money.view"),
    });
  });
  app.post("/payments/:id/approve", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const overrides: {
      amountPaid?: number;
      method?: string;
      note?: string | null;
      processorFeeAmount?: number;
      paidAt?: Date;
      tip?: {
        amount: number;
        businessPercent: number;
        workerPercents: Array<{ userId: string; percent: number }>;
      } | null;
    } = {};
    if (body.amountPaid !== undefined) overrides.amountPaid = Number(body.amountPaid);
    if (body.method) overrides.method = String(body.method);
    if (body.note !== undefined) overrides.note = body.note === null ? null : String(body.note);
    if (body.processorFeeAmount !== undefined) overrides.processorFeeAmount = Number(body.processorFeeAmount);
    // paidAt — YYYY-MM-DD in ET. Anchors to ET-noon of that date so
    // cash-basis reports see the payment on the day the money actually
    // landed. Absent = fall through to `new Date()` (pre-feature default).
    if (body.paidAt) {
      const key = String(body.paidAt);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
        throw app.httpErrors.badRequest("paidAt must be YYYY-MM-DD");
      }
      overrides.paidAt = etInstantFromParts(key as EtDateKey, "12:00");
    }
    // Tip designation. Validated here rather than trusted: the percentages
    // decide how real money is divided, so a malformed body must be
    // rejected rather than silently allocated somewhere.
    if (body.tip) {
      const t = body.tip;
      const amount = Number(t.amount);
      const businessPercent = Number(t.businessPercent);
      const workerPercents = Array.isArray(t.workerPercents)
        ? (t.workerPercents as any[]).map((w: any) => ({
            userId: String(w.userId),
            percent: Number(w.percent),
          }))
        : [];
      if (!Number.isFinite(amount) || amount <= 0) {
        throw app.httpErrors.badRequest("tip.amount must be a positive number");
      }
      const pcts = [businessPercent, ...workerPercents.map((w) => w.percent)];
      if (pcts.some((p) => !Number.isFinite(p) || p < 0)) {
        throw app.httpErrors.badRequest("tip percentages must be non-negative numbers");
      }
      const total = pcts.reduce((a, b) => a + b, 0);
      // Same ±0.01 tolerance the splits editor uses — operators type
      // 33.33/33.33/33.34 and that has to be accepted.
      if (Math.abs(total - 100) > 0.01) {
        throw app.httpErrors.badRequest(
          `tip percentages must total 100 (got ${total.toFixed(2)})`,
        );
      }
      overrides.tip = { amount, businessPercent, workerPercents };
    }
    return services.payments.approvePayment(uid, String(req.params.id), overrides);
  });
  app.post("/payments/:id/reject", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    await services.payments.rejectPayment(uid, String(req.params.id), reason);
    return { ok: true };
  });
  // Write-off path: client never paid. Approves with collected=0 so
  // employees+trainees still get their promised net (business absorbs the
  // shortfall) and contractors get $0. See services/payments.ts.
  app.post("/payments/:id/write-off", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    return services.payments.writeOffPayment(uid, String(req.params.id), reason);
  });
  // Skip path — `money.approve`. "Pretend this service never happened." Every
  // money query and export filters `skippedAt: null`, so income + payroll
  // + margin + 1099 totals all treat the row as if it doesn't exist while
  // it remains visible on the payment list with a Skipped chip (audit
  // trail preserved). `money.approve` here + type-APPROVE at the UI.
  app.post("/payments/:id/skip", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    return services.payments.skipPayment(uid, String(req.params.id), reason);
  });
  // Reverse a skip. Payment returns to its approved-$0 state and reappears
  // in every aggregate. Same `money.approve` + type-APPROVE gate as skip.
  app.post("/payments/:id/unskip", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    return services.payments.unskipPayment(uid, String(req.params.id));
  });
  // Revert an already-approved payment: deletes the payment record and takes
  // the occurrence CLOSED → PENDING_PAYMENT. `money.approve`, like every
  // other payment mutation. Reuses the exact
  // revert logic in updateOccurrence (which also removes the auto-created
  // next occurrence when it's still untouched).
  app.post("/payments/:id/revert", req_moneyApprove, async (req: any) => {
    const uid = await currentUserId(req);
    const paymentId = String(req.params.id);
    const reason = req.body?.reason ? String(req.body.reason) : null;
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { occurrenceId: true, confirmed: true },
    });
    if (!payment) throw app.httpErrors.notFound("Payment not found.");
    if (!payment.confirmed) {
      throw app.httpErrors.badRequest("Only an approved payment can be reverted.");
    }
    return services.jobs.updateOccurrence(
      uid,
      payment.occurrenceId,
      { status: "PENDING_PAYMENT", paymentRevertReason: reason },
      { canManageSchedule: true },
    );
  });
  app.get("/payments/mine", approvedUser, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { from, to, asUserId } = (req.query || {}) as { from?: string; to?: string; asUserId?: string };
    // The "view as worker" override (`money.approve`) — used by Payments to
    // inspect what an individual worker sees. The param is silently
    // ignored for callers without it so there's no info leak via the
    // header presence.
    let targetUid = callerUid;
    if (asUserId && typeof asUserId === "string" && asUserId.length > 0) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid }, 
      });
      // Named for the capability, not a role. The old flag bound to
      // `people.manage` read as a tier check and is not one — a caller with `money.view`
      // starter role holds it, and an operator may grant it to anything.
      const mayActForOthers = callerCan(req, "people.manage");
      if (mayActForOthers) targetUid = asUserId;
    }
    const cutoff = await resolveCutoff(req);
    return services.payments.listMyPayments(targetUid, { from, to, cutoff });
  });
  app.get("/payments/earnings-summary", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);

    // Bucketing model branches by worker type:
    //
    //   EMPLOYEE  — paid via payroll regardless of whether the
    //     client ever pays the invoice. Every assigned job (paid or not)
    //     contributes its promised net to the bucket of its WORK DATE
    //     (completedAt ?? startAt). Paid jobs use the stored
    //     PaymentSplit.amount; unpaid jobs use the computed promised net.
    //
    //   CONTRACTOR (or unclassified) — only get paid when the client's
    //     money actually clears. Confirmed PaymentSplits land in the
    //     bucket of their PAYMENT DATE. PLUS — today only — we
    //     optimistically project the contractor's share of today's
    //     pipeline (scheduled / in-progress / pending) so the title bar
    //     shows "what I expect to earn today" the same way it does for
    //     employees. Past-day unpaid jobs do NOT project (cash hasn't
    //     cleared, and might never).
    //
    // For both: buckets are
    //   today      = your data with effective date today
    //   thisWeek   = today + past 6 days (rolling 7-day window, today inclusive)
    //   thisMonth  = today + past 29 days (rolling 30-day window)
    //   thisYear   = calendar year-to-date through today
    //   allTime    = all of it through today
    //
    // Future-dated jobs / payments never appear in any bucket.
    // Day boundaries are anchored to Eastern Time.

    const todayStr = etToday();
    // `dayStr(offsetDays)` is just etAddDays — keep the alias for the
    // local readability but route through the canonical helper so
    // there's exactly one DST-safe day-arithmetic implementation in
    // the codebase.
    const dayStr = (offsetDays: number) => etAddDays(todayStr, offsetDays);
    const startOfToday = etMidnight(todayStr);
    const startOfTomorrow = etMidnight(dayStr(1));
    const startOfWeekWindow = etMidnight(dayStr(-6));   // 7-day rolling, today inclusive
    const startOfMonthWindow = etMidnight(dayStr(-29)); // 30-day rolling
    const currentYear = parseInt(todayStr.slice(0, 4), 10);
    const startOfYear = etMidnight(`${currentYear}-01-01` as EtDateKey);
    const startOfNextYear = etMidnight(`${currentYear + 1}-01-01` as EtDateKey);

    const me = await prisma.user.findUnique({ where: { id: uid }, select: { workerType: true } });
    const isEmployee = isW2(me?.workerType);
    const settingKey = isEmployee ? "EMPLOYEE_BUSINESS_MARGIN_PERCENT" : "CONTRACTOR_PLATFORM_FEE_PERCENT";
    const setting = await prisma.setting.findUnique({ where: { key: settingKey } });
    const myRate = Number(setting?.value ?? 0);

    // Per-worker earnings math lives in the shared helper —
    // services/workerEarnings.ts → computeMyOccurrenceNet. The rule:
    // reconciled PaymentSplit.amount when the payment is confirmed +
    // healthy, else project via completionSplits[me]% (or equal-split
    // fallback). See helper header comment.

    let today = 0;
    let thisWeek = 0;   // = today + past 6 actual days
    let thisMonth = 0;  // = today + past 29 actual days
    let thisYear = 0;
    let allTime = 0;
    let jobCount = 0;
    const byMethod: Record<string, number> = {};

    // Adds an amount to whichever buckets the date falls in. Past dates
    // get included in week/month windows; today gets included everywhere.
    // Future dates (d >= startOfTomorrow) are skipped entirely.
    function addToBuckets(value: number, when: Date) {
      if (value <= 0) return;
      if (when >= startOfTomorrow) return;
      allTime += value;
      if (when >= startOfYear && when < startOfNextYear) thisYear += value;
      if (when >= startOfMonthWindow) thisMonth += value;
      if (when >= startOfWeekWindow) thisWeek += value;
      if (when >= startOfToday) today += value;
    }

    const cutoff = await resolveCutoff(req);
    if (isEmployee) {
      // ── W-2 (EMPLOYEE): bucket every assigned job by work date ───────────
      // Each job contributes the promised net (paid or unpaid).
      //
      // Business Start Date filter — pre-cutoff work-date occurrences are
      // excluded so employee earnings tiles "start fresh" on the cutoff.
      // Work date = completedAt ?? startedAt ?? startAt (the same precedence
      // used to bucket the value into a Today/Week/Month/Year window below).
      const occs = await prisma.jobOccurrence.findMany({
        where: {
          assignees: { some: { userId: uid, OR: [{ role: null }, { role: { not: "observer" } }] } },
          workflow: { in: ["STANDARD", "ONE_OFF"] },
          // CANCELED / ARCHIVED don't pay out.
          status: { notIn: ["CANCELED", "ARCHIVED"] },
          ...occurrenceWorkDateCutoff(cutoff),
        },
        select: {
          startAt: true,
          completedAt: true,
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              method: true,
              confirmed: true,
              skippedAt: true,
              splits: { where: { userId: uid }, select: { amount: true } },
            },
          },
        },
      });

      for (const occ of occs) {
        const when = occ.completedAt ?? occ.startAt;
        if (!when) continue;

        // Reconciled paycheck value when the payment landed, projection
        // otherwise. Skipped payments contribute $0 (helper enforces).
        const value = computeMyOccurrenceNet(occ, uid, myRate);
        // Attribute to a payment method ONLY when a reconciled split
        // actually drove the amount — projection has no method attached.
        if (
          value > 0 &&
          occ.payment &&
          !occ.payment.skippedAt &&
          occ.payment.confirmed &&
          occ.payment.method &&
          (occ.payment.splits?.length ?? 0) > 0
        ) {
          byMethod[occ.payment.method] = (byMethod[occ.payment.method] ?? 0) + value;
        }

        addToBuckets(value, when);
        if (value > 0) jobCount++;
      }
    } else {
      // ── Contractor / unclassified ────────────────────────────────────────
      // Two passes:
      //   (a) confirmed PaymentSplits bucketed by Payment.createdAt — the
      //       money that actually cleared.
      //   (b) optimistic projection for TODAY ONLY of unpaid pipeline
      //       jobs whose work-date is today. Past unpaid jobs don't
      //       project (cash may never clear).
      // Business Start Date filter — pre-cutoff confirmed splits (by parent
      // Payment.createdAt) are excluded so contractor earnings tiles start
      // fresh on the cutoff. See lib/businessStartCutoff.ts.
      const splits = await prisma.paymentSplit.findMany({
        where: {
          userId: uid,
          payment: { confirmed: true, skippedAt: null, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) },
        },
        include: {
          payment: {
            select: { createdAt: true, method: true },
          },
        },
      });

      for (const sp of splits) {
        addToBuckets(sp.amount, sp.payment.createdAt);
        if (sp.amount > 0) {
          byMethod[sp.payment.method] = (byMethod[sp.payment.method] ?? 0) + sp.amount;
          jobCount++;
        }
      }

      // Business Start Date filter — pre-cutoff pipeline occurrences hidden
      // (relevant only when cutoff is in the future, since today's
      // projection is naturally post-cutoff for any past cutoff).
      const todayPipelineOccs = await prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED", "COMPLETED", "PENDING_PAYMENT"] },
          workflow: { in: ["STANDARD", "ONE_OFF"] },
          assignees: { some: { userId: uid, OR: [{ role: null }, { role: { not: "observer" } }] } },
          // Composing two OR-emitting clauses (payment-state + BSD cutoff)
          // via AND. Plain spread of `occurrenceWorkDateCutoff(cutoff)` would
          // overwrite the payment-state OR when BSD is enabled — silently
          // letting fully-paid jobs into the projection.
          AND: [
            {
              OR: [
                { payment: { is: null } },
                { payment: { confirmed: false } },
              ],
            },
            ...(cutoff ? [occurrenceWorkDateCutoff(cutoff)] : []),
          ],
        },
        select: {
          id: true,
          startAt: true,
          completedAt: true,
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
        },
      });
      for (const occ of todayPipelineOccs) {
        const when = occ.completedAt ?? occ.startAt;
        if (!when) continue;
        // Today-only projection — past unpaid pipeline doesn't count.
        if (when < startOfToday || when >= startOfTomorrow) continue;
        // Payment is guaranteed null/unconfirmed by the query filter, so
        // helper takes the projection path. Passing `payment: null`
        // explicitly for type conformance.
        const myShare = computeMyOccurrenceNet(
          { ...occ, payment: null },
          uid,
          myRate,
        );
        if (myShare <= 0) continue;
        addToBuckets(myShare, when);
        jobCount++;
      }
    }

    return {
      today: Math.round(today * 100) / 100,
      thisWeek: Math.round(thisWeek * 100) / 100,
      thisMonth: Math.round(thisMonth * 100) / 100,
      thisYear: Math.round(thisYear * 100) / 100,
      allTime: Math.round(allTime * 100) / 100,
      jobCount,
      byMethod,
    };
  });
  // ──────────────────────────────────────────────────────────────────────
  // Title-bar earnings — dedicated endpoint for the rotating money chip in
  // the page header. Intentionally NOT shared with /payments/earnings-summary
  // (used by ProfileTab) or any admin Payments-tab surface — those have
  // their own aggregation rules and a change in one place must not bleed
  // into another. Per-worker math is canonical, but bucket/projection
  // logic is owned by this endpoint.
  //
  // Bucketing rules (per user spec):
  //   today      = your data with effective date today (incl. today's projection)
  //   thisWeek   = today + past 6 days actual (rolling 7-day window)
  //   thisMonth  = today + past 29 days actual (rolling 30-day window)
  //   thisYear   = calendar year-to-date through today
  //   allTime    = all of it through today
  //
  // EMPLOYEE — promised payouts for every assigned job (paid or
  //   unpaid), bucketed by work date. They're made whole via payroll
  //   regardless of whether the client paid.
  //
  // CONTRACTOR / unclassified — confirmed PaymentSplits bucketed by
  //   payment date PLUS today-only optimistic projection of unpaid pipeline.
  //   Past unpaid jobs don't project; cash may never clear.
  //
  // Future-dated jobs and payments never appear in any bucket.
  app.get("/payments/title-bar-earnings", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);

    const todayStr = etToday();
    // `dayStr(offsetDays)` is just etAddDays — keep the alias for the
    // local readability but route through the canonical helper so
    // there's exactly one DST-safe day-arithmetic implementation in
    // the codebase.
    const dayStr = (offsetDays: number) => etAddDays(todayStr, offsetDays);
    const startOfToday = etMidnight(todayStr);
    const startOfTomorrow = etMidnight(dayStr(1));
    const startOfWeekWindow = etMidnight(dayStr(-6));
    const startOfMonthWindow = etMidnight(dayStr(-29));
    const currentYear = parseInt(todayStr.slice(0, 4), 10);
    const startOfYear = etMidnight(`${currentYear}-01-01` as EtDateKey);
    const startOfNextYear = etMidnight(`${currentYear + 1}-01-01` as EtDateKey);

    const me = await prisma.user.findUnique({ where: { id: uid }, select: { workerType: true } });
    const isEmployee = isW2(me?.workerType);
    const settingKey = isEmployee ? "EMPLOYEE_BUSINESS_MARGIN_PERCENT" : "CONTRACTOR_PLATFORM_FEE_PERCENT";
    const setting = await prisma.setting.findUnique({ where: { key: settingKey } });
    const myRate = Number(setting?.value ?? 0);

    // Per-worker earnings math lives in services/workerEarnings.ts →
    // computeMyOccurrenceNet. Same rule used everywhere the worker sees
    // a dollar figure. See helper header comment.

    let today = 0;
    let thisWeek = 0;
    let thisMonth = 0;
    let thisYear = 0;
    let allTime = 0;
    let jobCount = 0;
    const byMethod: Record<string, number> = {};

    function addToBuckets(value: number, when: Date) {
      if (value <= 0) return;
      if (when >= startOfTomorrow) return;
      allTime += value;
      if (when >= startOfYear && when < startOfNextYear) thisYear += value;
      if (when >= startOfMonthWindow) thisMonth += value;
      if (when >= startOfWeekWindow) thisWeek += value;
      if (when >= startOfToday) today += value;
    }

    const cutoff = await resolveCutoff(req);
    if (isEmployee) {
      // Business Start Date filter — pre-cutoff occurrences hidden so the
      // title-bar buckets start fresh on the cutoff. See
      // lib/businessStartCutoff.ts.
      const occs = await prisma.jobOccurrence.findMany({
        where: {
          assignees: { some: { userId: uid, OR: [{ role: null }, { role: { not: "observer" } }] } },
          workflow: { in: ["STANDARD", "ONE_OFF"] },
          status: { notIn: ["CANCELED", "ARCHIVED"] },
          ...occurrenceWorkDateCutoff(cutoff),
        },
        select: {
          startAt: true,
          startedAt: true,
          completedAt: true,
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              method: true,
              confirmed: true,
              skippedAt: true,
              splits: { where: { userId: uid }, select: { amount: true } },
            },
          },
        },
      });
      for (const occ of occs) {
        // Bucket date: when the job was actually worked on, not when it
        // was scheduled. Order matters: completedAt > startedAt > startAt.
        //   - Completed job → use completedAt (done date).
        //   - In-progress / paused → use startedAt (active today even if
        //     scheduled earlier; lets a worker who pressed Start today
        //     see today's earnings in the Today bucket).
        //   - Scheduled (not started) → use startAt (planned date).
        const when = occ.completedAt ?? occ.startedAt ?? occ.startAt;
        if (!when) continue;
        // Reconciled paycheck value when the payment landed, projection
        // otherwise. Skipped payments contribute $0 (helper enforces).
        const value = computeMyOccurrenceNet(occ, uid, myRate);
        if (
          value > 0 &&
          occ.payment &&
          !occ.payment.skippedAt &&
          occ.payment.confirmed &&
          occ.payment.method &&
          (occ.payment.splits?.length ?? 0) > 0
        ) {
          byMethod[occ.payment.method] = (byMethod[occ.payment.method] ?? 0) + value;
        }
        addToBuckets(value, when);
        if (value > 0) jobCount++;
      }
    } else {
      // Business Start Date filter — contractor confirmed splits filtered via
      const splits = await prisma.paymentSplit.findMany({
        where: {
          userId: uid,
          payment: { confirmed: true, skippedAt: null, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) },
        },
        include: { payment: { select: { createdAt: true, method: true } } },
      });
      for (const sp of splits) {
        addToBuckets(sp.amount, sp.payment.createdAt);
        if (sp.amount > 0) {
          byMethod[sp.payment.method] = (byMethod[sp.payment.method] ?? 0) + sp.amount;
          jobCount++;
        }
      }
      // Pipeline projection's work-date is constrained to TODAY by the
      // in-loop check, so the Business Start cutoff is naturally satisfied
      // for any cutoff <= today. The explicit `occurrenceWorkDateCutoff`
      // below covers the cutoff-in-the-future edge case (e.g. someone with `money.view`
      // setting a future fresh-start date to stage the transition).
      const todayPipelineOccs = await prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED", "COMPLETED", "PENDING_PAYMENT"] },
          workflow: { in: ["STANDARD", "ONE_OFF"] },
          assignees: { some: { userId: uid, OR: [{ role: null }, { role: { not: "observer" } }] } },
          // Same OR-overwrite avoidance as the earlier query in this file.
          AND: [
            {
              OR: [
                { payment: { is: null } },
                { payment: { confirmed: false } },
              ],
            },
            ...(cutoff ? [occurrenceWorkDateCutoff(cutoff)] : []),
          ],
        },
        select: {
          id: true,
          startAt: true,
          startedAt: true,
          completedAt: true,
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
        },
      });
      for (const occ of todayPipelineOccs) {
        // Same bucket-date rule as the employee branch above — in-progress
        // work counts on the day it was started, not the day it was
        // originally scheduled.
        const when = occ.completedAt ?? occ.startedAt ?? occ.startAt;
        if (!when) continue;
        if (when < startOfToday || when >= startOfTomorrow) continue;
        // Payment is null/unconfirmed by query filter → helper takes
        // projection path. `payment: null` for type conformance.
        const myShare = computeMyOccurrenceNet(
          { ...occ, payment: null },
          uid,
          myRate,
        );
        if (myShare <= 0) continue;
        addToBuckets(myShare, when);
        jobCount++;
      }
    }

    return {
      today: Math.round(today * 100) / 100,
      thisWeek: Math.round(thisWeek * 100) / 100,
      thisMonth: Math.round(thisMonth * 100) / 100,
      thisYear: Math.round(thisYear * 100) / 100,
      allTime: Math.round(allTime * 100) / 100,
      jobCount,
      byMethod,
    };
  });
  app.get("/payments/equipment-charges", req_equipmentView, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { from, to, asUserId } = (req.query || {}) as { from?: string; to?: string; asUserId?: string };
    // Same "view as worker" override as /payments/mine (`money.approve`).
    // Whoever maintains the fleet sees every charge; everyone else sees
    // their own, and may name another person only with `people.manage`.
    // The deleted `/payments/equipment-charges` twin took `userId`
    // directly, on the same `equipment.view` this route already requires —
    // so the URL, not a capability, decided whose money you could read.
    const cutoff = await resolveCutoff(req);
    if (callerCan(req, "equipment.manage")) {
      const anyUser = (req.query || {}).userId as string | undefined;
      return services.equipment.listEquipmentCharges({ from, to, userId: anyUser, cutoff });
    }
    let targetUid = callerUid;
    if (asUserId && typeof asUserId === "string" && asUserId.length > 0) {
      if (callerCan(req, "people.manage")) targetUid = asUserId;
    }
    return services.equipment.listEquipmentCharges({ userId: targetUid, from, to, cutoff });
  });
  app.patch("/invoice-charges/:id", req_materialsCharge, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const input: any = {};
    if (body.cost !== undefined) input.cost = Number(body.cost);
    if (body.description !== undefined) input.description = String(body.description);
    // "in body", not "!== undefined": null is meaningful — it CLEARS the
    // field, which is how an operator removes a detail or a cost entered by
    // mistake.
    if ("detail" in body) input.detail = body.detail != null ? String(body.detail) : null;
    if ("actualCost" in body) {
      input.actualCost =
        body.actualCost != null && body.actualCost !== "" ? Number(body.actualCost) : null;
    }
    return services.invoiceCharges.updateInvoiceCharge(uid, callerCanFn(req), String(req.params.id), input);
  });
  app.delete("/invoice-charges/:id", req_materialsCharge, async (req: any) => {
    const uid = await currentUserId(req);
    return services.invoiceCharges.deleteInvoiceCharge(uid, callerCanFn(req), String(req.params.id));
  });
  // Pricing guide (read-only for workers). Mirrors /pricing's shape
  // so the same PricingTab component can render here. Mutations remain
  // `pricing.manage` on the /pricing/* routes.
  app.get("/pricing", req_pricingView, async () => {
    const rows = await prisma.setting.findMany({
      where: { key: { startsWith: "pricing_" } },
      include: { updatedBy: { select: { id: true, displayName: true } } },
      orderBy: { key: "asc" },
    });
    return rows.map((r: any) => {
      try {
        return { ...r, parsedValue: JSON.parse(r.value) };
      } catch {
        return { ...r, parsedValue: null };
      }
    });
  });
  // view-as-allow: worker's own outstanding payment requests for the
  // planning-tab nudge. Admin sees cross-worker payment state under
  // /payment-requests / /payments.
  // The caller's own outstanding payment requests — sent to a client but
  // not yet paid. Powers the Planning-tab nudge so a claimer can chase a
  // request that's gone quiet.
  app.get("/me/outstanding-payment-requests", approvedUser, async (req: any) => {
    const cutoff = await resolveCutoff(req);
    return services.paymentRequests.listOutstanding({ claimerUserId: req.user.id, cutoff });
  });

}
