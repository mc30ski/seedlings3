import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt, evaluateHoursApproval, loadHoursApprovalVarianceThreshold, loadPriorPersonMinutes } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, etTomorrow, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { InstructionScope, JobKind, JobOccurrenceStatus, JobStatus, OccurrenceWorkflow, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereVia, withArea } from "../lib/areaScope";
import { WORKER_TYPES, classify, isFeeable, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { fetchWeatherAlerts } from "../services/weatherAlerts";
import { cached } from "../lib/cache";
import { businessLatLng } from "../lib/businessLocation";
import { hourlyForecastForOccurrence } from "../services/hourlyForecast";
import { ServiceError } from "../lib/errors";
import { persistCompletionSplits } from "../services/payments";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { redactObserverFieldsForCaller, redactPeekFieldsForCaller, redactUnclearedFieldsForCaller } from "../lib/observerRedaction";
import { capabilitiesForUsers, userCan } from "../lib/userCapabilities";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate, occInEditableState } from "./_shared";

export default async function reportRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_auditView = requires("audit.view");
  const req_reportsView = requires("reports.view");
  // THE BUSINESS-WIDE ROLLUP, split from the team one on 2026-10-23.
  // `/statistics` and `/dashboard-summary/aggregate` below stay on
  // `reports.view` — an admin running a crew needs those. This endpoint
  // feeds the INSIGHTS card (money, jobs, equipment, clients across the
  // whole company), which is the owner's view.
  const req_reportsBusiness = requires("reports.business");
  const req_routesPlan = requires("routes.plan");

  app.get("/audit", req_auditView, async (req: any) => {
    const q = (req.query || {}) as {
      page?: string;
      pageSize?: string;
      actorUserId?: string;
      action?: string;
      from?: string;
      to?: string;
    };
    const page = q.page ? Number(q.page) : 1;
    const pageSize = q.pageSize ? Number(q.pageSize) : 50;

    return services.audit.list({
      actorUserId: q.actorUserId || undefined,
      action: q.action || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      cutoff: await resolveCutoff(req),
      page,
      pageSize,
    });
  });
  app.get("/activity", req_auditView, async (req: any) => {
    return services.activity.listUserActivity();
  });
  app.get("/statistics", req_reportsView, async (req: any) => {
    const from = req.query?.from as string | undefined;
    const to = req.query?.to as string | undefined;

    const dateFilter: any = {};
    if (from) dateFilter.gte = etMidnight(from as EtDateKey);
    if (to) dateFilter.lte = etEndOfDay(to as EtDateKey);
    const hasDate = from || to;

    // Business Start Date filter — pre-cutoff occurrences hidden (their work
    // date is before the cutoff). This is Pattern C: occurrence-level
    // filtering because stats iterate occurrences directly and the work-date
    // anchor is the right semantic for per-worker job counts and earnings.
    const cutoff = await resolveCutoff(req);

    // AREA-SCOPED, and it stays on `reports.view` rather than moving to
    // `reports.business`.
    //
    // Moving it was the tidier-sounding answer — this reads like a company
    // report and `/operations` lives on `reports.business`. It is wrong:
    // Admin and Bookkeeper hold `reports.view` and NOT `reports.business`,
    // so the move would have taken Statistics away from company-wide staff
    // in order to narrow it for one district lead.
    //
    // `areaWhere` already draws that line correctly. Someone holding
    // `reports.view` company-wide gets an empty fragment and the query is
    // byte-identical to before; only an area-limited holder is narrowed.
    //
    // THE NUMBERS BECOME PARTIAL WHEN IT NARROWS, and that is reported
    // rather than hidden: a worker who worked two districts appears in each
    // with only that district's hours and earnings, so neither row is their
    // real week. `areaScope` below tells the UI to say so. Never let this
    // ship as an unlabelled per-person earnings figure — it is exactly the
    // number that gets screenshotted into a pay conversation.
    const statsArea = areaWhere(req.principal, "reports.view");
    // Typed explicitly: inline, the object was contextually typed by
    // `findMany` and the status strings narrowed to the enum. Passing it
    // through `withArea` first loses that, and the error surfaces as a
    // confusing complaint about `in`.
    const statsWhere: Prisma.JobOccurrenceWhereInput = {
      status: { in: [JobOccurrenceStatus.CLOSED, JobOccurrenceStatus.PENDING_PAYMENT] },
      ...(hasDate ? { completedAt: dateFilter } : {}),
      ...occurrenceWorkDateCutoff(cutoff),
    };
    const occurrences = await prisma.jobOccurrence.findMany({
      where: withArea(statsWhere, statsArea),
      select: {
        id: true,
        status: true,
        kind: true,
        startedAt: true,
        completedAt: true,
        estimatedMinutes: true,
        price: true,
        proposalAmount: true,
        completionSplits: true,
        addons: { select: { price: true } },
        workflow: true,
        isEstimate: true,
        startAt: true,
        assignees: {
          select: {
            userId: true,
            role: true,
            user: { select: { id: true, displayName: true, email: true, workerType: true } },
          },
        },
        payment: {
          // Pattern B filter ensures pre-cutoff payments (e.g. on a
          // job that was completed post-cutoff but whose Payment row was
          // created before — rare but possible) don't sneak into stats.
          // Skipped payments (skippedAt IS NOT NULL) are also excluded —
          // "pretend it didn't happen" applies to statistics too.
          where: cutoff
            ? { createdAt: { gte: cutoff }, skippedAt: null }
            : { skippedAt: null },
          select: {
            amountPaid: true,
            method: true,
            confirmed: true,
            skippedAt: true,
            platformFeeAmount: true,
            businessMarginAmount: true,
            splits: {
              select: { userId: true, amount: true },
            },
          },
        },
        invoiceCharges: {
          where: cutoff
            ? { OR: [
                { businessExpense: { date: { gte: cutoff } } },
                { businessExpense: null, createdAt: { gte: cutoff } },
              ] }
            : undefined,
          select: { cost: true },
        },
        job: {
          select: {
            property: { select: { id: true, displayName: true, city: true } },
          },
        },
      },
      orderBy: { completedAt: "desc" },
    });

    // Get all workers
    const workers = await prisma.user.findMany({
      where: {
        isApproved: true,
        workerType: { in: ["EMPLOYEE", "CONTRACTOR"] },
      },
      select: { id: true, displayName: true, email: true, workerType: true },
    });

    // Build per-worker stats
    type WorkerStat = {
      userId: string;
      displayName: string;
      workerType: string | null;
      jobsCompleted: number;
      totalEarnings: number;
      totalExpenses: number;
      netEarnings: number;
      totalActualMinutes: number;
      totalEstimatedMinutes: number;
      jobsWithTiming: number;
      avgActualMinutes: number;
      avgEstimatedMinutes: number;
      efficiencyPercent: number | null; // estimated/actual * 100
      propertiesServiced: number;
      paymentMethods: Record<string, number>;
      jobsByDay: Record<string, number>; // YYYY-MM-DD -> count
    };

    const statsMap = new Map<string, WorkerStat>();

    for (const w of workers) {
      statsMap.set(w.id, {
        userId: w.id,
        displayName: w.displayName ?? w.email ?? w.id,
        workerType: w.workerType,
        jobsCompleted: 0,
        totalEarnings: 0,
        totalExpenses: 0,
        netEarnings: 0,
        totalActualMinutes: 0,
        totalEstimatedMinutes: 0,
        jobsWithTiming: 0,
        avgActualMinutes: 0,
        avgEstimatedMinutes: 0,
        efficiencyPercent: null,
        propertiesServiced: 0,
        paymentMethods: {},
        jobsByDay: {},
      });
    }

    // Rate lookup for computeMyOccurrenceNet projection path.
    const [_statsFeeSetting, _statsMarginSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } }),
      prisma.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } }),
    ]);
    const _statsContractorFee = Number(_statsFeeSetting?.value ?? 0);
    const _statsEmployeeMargin = Number(_statsMarginSetting?.value ?? 0);
    // A SECOND IMPLEMENTATION of the rate rule, which is the thing
    // @repo/money exists to prevent. It read `=== "CONTRACTOR" ? fee :
    // margin`, so an UNPAID helper and an untyped worker were both given the
    // 30% EMPLOYEE margin in these stats — a number with no basis.
    //
    // This is a projection, not a payout, so it cannot throw the way
    // `rateFor` does. Non-paid classes take no rate, same as rateForViewer.
    const _statsRateFor = (workerType: WorkerType | null | undefined) =>
      rateForProjection(workerType, {
        employeeMarginPercent: _statsEmployeeMargin,
        contractorFeePercent: _statsContractorFee,
      });
    const { computeMyOccurrenceNet: _statsComputeNet } = await import("../services/workerEarnings");

    const propertySetMap = new Map<string, Set<string>>();

    for (const occ of occurrences) {
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) continue;

      const actualMinutes = occ.startedAt && occ.completedAt
        ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000)
        : null;

      const expenseTotal = occ.invoiceCharges.reduce((s, e) => s + e.cost, 0);
      const dayKey = occ.completedAt ? etFormatDate(occ.completedAt) : null;
      const propId = occ.job?.property?.id;

      for (const a of occ.assignees) {
        let stat = statsMap.get(a.userId);
        if (!stat) continue;

        stat.jobsCompleted++;

        // Earnings —
        //   EMPLOYEE: use computeMyOccurrenceNet so unpaid
        //   completed jobs still credit the worker with their promised
        //   net (matches payroll — they get paid regardless of client-
        //   payment timing).
        //   CONTRACTOR / unclassified: keep the cash-basis behavior
        //   (split.amount) — contractors are only paid on confirmed
        //   splits.
        let earnings: number;
        if (isW2(a.user.workerType)) {
          const paymentForUser = occ.payment
            ? {
                ...occ.payment,
                splits: occ.payment.splits.filter((s) => s.userId === a.userId),
              }
            : null;
          earnings = _statsComputeNet(
            {
              price: occ.price,
              proposalAmount: (occ as any).proposalAmount ?? null,
              completionSplits: (occ as any).completionSplits,
              addons: (occ as any).addons ?? [],
              invoiceCharges: occ.invoiceCharges,
              assignees: occ.assignees,
              payment: paymentForUser,
            },
            a.userId,
            _statsRateFor(a.user.workerType),
          );
        } else {
          const split = occ.payment?.splits.find((s) => s.userId === a.userId);
          earnings = split?.amount ?? 0;
        }
        if (earnings > 0) {
          const splitRatio = occ.payment && occ.payment.splits.length > 0
            ? earnings / occ.payment.splits.reduce((s, sp) => s + sp.amount, 0)
            : 1;
          const expenseShare = expenseTotal * splitRatio;
          stat.totalEarnings += earnings;
          stat.totalExpenses += expenseShare;
          // NOT a deduction. Charges never come out of anyone's pay under
          // either pricing model; this docked a worker's stats for materials
          // the business billed to the client.
          stat.netEarnings += earnings;
        }

        // Timing
        if (actualMinutes != null && actualMinutes > 0) {
          stat.totalActualMinutes += actualMinutes;
          stat.jobsWithTiming++;
        }
        if (occ.estimatedMinutes) {
          stat.totalEstimatedMinutes += occ.estimatedMinutes;
        }

        // Payment method
        if (occ.payment?.method) {
          stat.paymentMethods[occ.payment.method] = (stat.paymentMethods[occ.payment.method] || 0) + 1;
        }

        // Jobs by day
        if (dayKey) {
          stat.jobsByDay[dayKey] = (stat.jobsByDay[dayKey] || 0) + 1;
        }

        // Properties
        if (propId) {
          if (!propertySetMap.has(a.userId)) propertySetMap.set(a.userId, new Set());
          propertySetMap.get(a.userId)!.add(propId);
        }
      }
    }

    // Finalize averages
    const results: WorkerStat[] = [];
    for (const stat of statsMap.values()) {
      stat.propertiesServiced = propertySetMap.get(stat.userId)?.size ?? 0;
      if (stat.jobsWithTiming > 0) {
        stat.avgActualMinutes = Math.round(stat.totalActualMinutes / stat.jobsWithTiming);
      }
      if (stat.jobsCompleted > 0 && stat.totalEstimatedMinutes > 0) {
        stat.avgEstimatedMinutes = Math.round(stat.totalEstimatedMinutes / stat.jobsCompleted);
      }
      if (stat.totalActualMinutes > 0 && stat.totalEstimatedMinutes > 0) {
        stat.efficiencyPercent = Math.round((stat.totalEstimatedMinutes / stat.totalActualMinutes) * 100);
      }
      stat.totalEarnings = Math.round(stat.totalEarnings * 100) / 100;
      stat.totalExpenses = Math.round(stat.totalExpenses * 100) / 100;
      stat.netEarnings = Math.round(stat.netEarnings * 100) / 100;
      results.push(stat);
    }

    // Sort by jobs completed desc
    results.sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    // Days with jobs for "jobs per day" calc
    const allDays = new Set<string>();
    for (const stat of results) {
      for (const d of Object.keys(stat.jobsByDay)) allDays.add(d);
    }

    // PER-WORKER MONEY NEEDS THE PAYROLL READ, NOT THE STATS READ.
    //
    // `reports.view` is held by the baseline Trainee role and inherited by
    // every other role, so this route handed each worker the whole team's
    // earnings. The OPERATIONAL numbers (jobs completed, minutes,
    // efficiency) are what the stats entitlement is for and stay for
    // everyone; the money comes out unless the caller holds `payroll.view`
    // — "See imported payroll and what each person was paid".
    //
    // A worker's OWN figures are a different route (`/me/statistics`), so
    // nothing self-service breaks. Redacting the whole column rather than
    // "everyone but me" keeps one row shape for the client.
    const maySeePay = callerCan(req, "payroll.view");
    const workersOut = maySeePay
      ? results
      : results.map((r: any) => {
          const { totalEarnings: _e, netEarnings: _n, totalExpenses: _x, ...safe } = r;
          return safe;
        });

    // NO `areaScope` IN THIS RESPONSE. It carried the area names so this
    // one page could say "Durham only", and that notice now lives once,
    // above the tab row, driven by `me.areaScope` (see AreaScopeNotice).
    // Two sources for one sentence is how they end up disagreeing — and in
    // the meantime they simply both rendered, stacking the same fact twice
    // on one screen.
    //
    // The FILTER above is untouched: these figures are still narrowed for
    // an area-limited reader. Only the announcement moved.
    return {
      workers: workersOut,
      totalOccurrences: occurrences.filter((o) => o.workflow !== "ESTIMATE" && !o.isEstimate).length,
      daysInRange: allDays.size,
    };
  });
  app.get("/operations", req_reportsBusiness, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };

    // NO AREA PARAM HERE ANY MORE. This route briefly took `?areaId=` and
    // ANDed it on, which worked but made this one panel the only place in
    // the app you could narrow by district. The lens moved to the header
    // and onto the principal (lib/areaLens.ts), so the plain
    // `areaWhere(principal, …)` calls below honour it — along with the
    // hundred other query sites, and anything written next year. One
    // control, not one per panel.
    const todayKey = etToday();
    const dateFrom = from ? etMidnight(from as EtDateKey) : etMidnight(todayKey);
    const dateTo = to ? etEndOfDay(to as EtDateKey) : etEndOfDay(todayKey);

    // Business Start Date filter — pre-cutoff occurrences are hidden entirely
    // via Pattern C (occurrence work date) on the top-level where, matching
    // the JobsTab and Statistics behavior. Pattern B is still layered on
    // payment + expenses as a defense-in-depth: catches the edge case where
    // an occurrence is post-cutoff but its Payment row was created pre-cutoff
    // (rare but possible — e.g. a payment retroactively attached). See
    // lib/businessStartCutoff.ts. the reveal resolves cutoff to null so
    // every spread becomes a no-op and behavior matches pre-feature exactly.
    const cutoff = await resolveCutoff(req);

    // Jobs summary.
    //
    // Composing the date-range OR with the BSD cutoff via AND: both helpers
    // emit { OR: [...] }, and Prisma's plain spread would silently overwrite
    // the date-range OR with the cutoff OR when BSD is enabled — making the
    // `from`/`to` filter a no-op and every count (jobsUnclaimed in
    // particular) reflect the entire post-cutoff history instead of just the
    // requested window. That's the bug that made the "N Unclaimed" chip
    // disagree with the JobsTab list. AND[] is the safe combinator.
    const occurrences = await prisma.jobOccurrence.findMany({
      // TERRITORIAL, decided 2026-10-14: a district lead's operations
      // numbers are their district's. `withArea` appends to the existing
      // AND rather than replacing it — this query already uses AND for its
      // date window, which is exactly the collision that spreading the
      // fragment at the top level would have lost.
      where: withArea<Prisma.JobOccurrenceWhereInput>({
        workflow: { notIn: [OccurrenceWorkflow.TASK] },
        AND: [
          {
            OR: [
              { startAt: { gte: dateFrom, lte: dateTo } },
              { completedAt: { gte: dateFrom, lte: dateTo } },
            ],
          },
          ...(cutoff ? [occurrenceWorkDateCutoff(cutoff)] : []),
        ],
      }, areaWhere(req.principal, "reports.business")),
      include: {
        assignees: { select: { userId: true, role: true } },
        payment: paymentIncludeWithCutoff(cutoff, { include: { splits: true } }),
        invoiceCharges: expensesIncludeWithCutoff(cutoff),
        // Add-ons contribute to the price pool the compliance check projects
        // worker net from — without these, on-the-fly wage projection
        // underestimates by the addon amount for jobs that have any.
        addons: { select: { price: true } },
        // Pulled in so the Clients section can derive "worked-with in window"
        // + "VIP among those" without a second roundtrip.
        job: { select: { property: { select: { client: { select: { id: true, isVip: true } } } } } },
      },
    });

    // ── The business-wide jobs rollup ────────────────────────────────────
    //
    // The Jobs tab's INSIGHTS card used to compute this in the browser from
    // the rows on screen, so changing a filter changed the "insight" and
    // two people looking at the same company saw different numbers.
    // INSIGHTS is business-wide everywhere, so the numbers come from here.
    //
    // ITS OWN QUERY, deliberately. The `occurrences` fetch above excludes
    // `TASK` — correct for the operational counts it feeds — but the rollup
    // reports a BY WORKFLOW breakdown in which TASK is one of the bars.
    // Reusing that result would have silently shown zero tasks forever.
    //
    // Same window, same area scoping, same cutoff as everything else on
    // this endpoint; only the workflow filter differs.
    const rollupRows = await prisma.jobOccurrence.findMany({
      where: withArea<Prisma.JobOccurrenceWhereInput>({
        AND: [
          {
            OR: [
              { startAt: { gte: dateFrom, lte: dateTo } },
              { completedAt: { gte: dateFrom, lte: dateTo } },
            ],
          },
          ...(cutoff ? [occurrenceWorkDateCutoff(cutoff)] : []),
        ],
      }, areaWhere(req.principal, "reports.business")),
      select: {
        status: true, workflow: true, isTentative: true, isClientConfirmed: true,
        isEstimate: true, jobId: true, price: true, proposalAmount: true,
        frequencyDays: true,
        assignees: { select: { userId: true, role: true } },
        job: { select: { property: { select: { client: { select: { id: true } } } } } },
      },
    });

    const rollupStatus: Record<string, number> = {
      SCHEDULED: 0, IN_PROGRESS: 0, PAUSED: 0, COMPLETED: 0,
      PENDING_PAYMENT: 0, CLOSED: 0, CANCELED: 0, ARCHIVED: 0,
    };
    const rollupWorkflow: Record<string, number> = {
      STANDARD: 0, ONE_OFF: 0, ESTIMATE: 0, TASK: 0,
      REMINDER: 0, EVENT: 0, FOLLOWUP: 0, ANNOUNCEMENT: 0,
    };
    const rollupClientIds = new Set<string>();
    const rollupAssigneeIds = new Set<string>();
    let rUnassigned = 0, rUnconfirmed = 0, rTentative = 0, rVip = 0, rRepeating = 0;
    let rFollowup = 0, rEstimate = 0, rAnnouncement = 0;
    let rClosed = 0, rPending = 0, rBooked = 0, rPricedRows = 0, rPricedSum = 0;

    const vipById = new Map<string, boolean>();
    for (const o of occurrences) {
      const c = o.job?.property?.client;
      if (c?.id) vipById.set(c.id, !!c.isVip);
    }

    for (const o of rollupRows) {
      if (rollupStatus[o.status] !== undefined) rollupStatus[o.status]++;
      const wf = o.workflow ?? "STANDARD";
      if (rollupWorkflow[wf] !== undefined) rollupWorkflow[wf]++;
      // `observer` seats are not doing the work — the same exclusion the
      // claimer invariant makes everywhere else.
      const active = o.assignees.filter((a) => a.role !== "observer");
      if (active.length === 0) rUnassigned++;
      for (const a of active) if (a.userId) rollupAssigneeIds.add(a.userId);
      if (o.status === "SCHEDULED" && o.jobId && !o.isClientConfirmed) rUnconfirmed++;
      if (o.isTentative) rTentative++;
      const clientId = o.job?.property?.client?.id;
      if (clientId) {
        rollupClientIds.add(clientId);
        if (vipById.get(clientId)) rVip++;
      }
      if (o.frequencyDays != null) rRepeating++;
      if (wf === "FOLLOWUP") rFollowup++;
      if (wf === "ESTIMATE" || o.isEstimate) rEstimate++;
      if (wf === "ANNOUNCEMENT") rAnnouncement++;
      const price = Number(o.price ?? o.proposalAmount ?? 0);
      if (price > 0) {
        rBooked += price;
        rPricedRows++;
        rPricedSum += price;
        if (o.status === "CLOSED") rClosed += price;
        if (o.status === "PENDING_PAYMENT") rPending += price;
      }
    }

    const jobsScheduled = occurrences.filter((o) => o.status === "SCHEDULED").length;
    const jobsInProgress = occurrences.filter((o) => o.status === "IN_PROGRESS").length;
    const jobsCompleted = occurrences.filter((o) => o.status === "CLOSED" || o.status === "PENDING_PAYMENT").length;
    const jobsCanceled = occurrences.filter((o) => o.status === "CANCELED").length;
    // PAUSED and PENDING_PAYMENT, counted separately as well.
    //
    // `completed` above deliberately folds PENDING_PAYMENT in — the work is
    // done — but "done and not yet paid for" is its own business question,
    // and the Jobs tab's rollup is where it gets asked. Reporting it
    // alongside `completed` double-counts those visits by design: they are
    // completed AND awaiting money, and a reader wants both numbers.
    const jobsPaused = occurrences.filter((o) => o.status === "PAUSED").length;
    const jobsPendingPayment = occurrences.filter((o) => o.status === "PENDING_PAYMENT").length;

    const todayMidnight = etMidnight(todayKey);
    const jobsOverdue = occurrences.filter((o) =>
      o.status === "SCHEDULED" && o.startAt && o.startAt < todayMidnight
    ).length;

    const nonJobWorkflows = new Set(["ESTIMATE", "TASK", "REMINDER", "EVENT", "FOLLOWUP", "ANNOUNCEMENT"]);
    const jobsUnclaimed = occurrences.filter((o) =>
      o.status === "SCHEDULED" &&
      !nonJobWorkflows.has(o.workflow ?? "") &&
      !o.isEstimate &&
      o.assignees.filter((a) => a.role !== "observer").length === 0
    ).length;

    // Financial summary
    const paidOccs = occurrences.filter((o) => o.payment);
    const totalRevenue = paidOccs.reduce((s, o) => s + (o.payment?.amountPaid ?? 0), 0);
    const totalExpenses = occurrences.reduce((s, o) => s + o.invoiceCharges.reduce((es, e) => es + e.cost, 0), 0);
    const netRevenue = totalRevenue - totalExpenses;
    const totalPlatformFees = paidOccs.reduce((s, o) => s + (o.payment?.platformFeeAmount ?? 0), 0);
    const totalBusinessMargin = paidOccs.reduce((s, o) => s + (o.payment?.businessMarginAmount ?? 0), 0);
    // W-2 make-whole spend (top-ups) + LLC owner draws on the business's
    // cut. Both are sourced from PaymentSplit rows already loaded above
    // via `payment.splits`. Surfaced here so Operations carries the
    // internal payment-flow numbers that previously lived only in the
    // Money → Reconcile "Period Summary" card (now removed).
    let totalTopUps = 0;
    let totalOwnerEarnings = 0;
    for (const o of paidOccs) {
      for (const sp of o.payment?.splits ?? []) {
        totalTopUps += sp.topUpAmount ?? 0;
        if (sp.ownerEarnings) totalOwnerEarnings += sp.amount ?? 0;
      }
    }
    const avgJobPrice = jobsCompleted > 0 ? totalRevenue / jobsCompleted : 0;

    const paymentsByMethod: Record<string, number> = {};
    for (const o of paidOccs) {
      const m = o.payment?.method ?? "OTHER";
      paymentsByMethod[m] = (paymentsByMethod[m] ?? 0) + (o.payment?.amountPaid ?? 0);
    }

    // Team summary
    const workers = await prisma.user.findMany({
      where: { isApproved: true, workerType: { in: ["EMPLOYEE", "CONTRACTOR"] } },
      select: { id: true, displayName: true, workerType: true },
    });

    // Top workers by jobs completed in range.
    //
    // Earnings use the 3-tier projection path (snapshot → per-worker
    // projection → cash-split fallback) so an employee's pending-
    // payment jobs still count toward the chip total. Previously this
    // summed splits only, understating anyone with unpaid completed
    // work — see the same projection in wageGross below.
    // Rates loaded once here rather than inline in the loop.
    const [_topFeeSetting, _topMarginSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } }),
      prisma.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } }),
    ]);
    const _topContractorFee = Number(_topFeeSetting?.value ?? 20) || 0;
    const _topEmployeeMargin = Number(_topMarginSetting?.value ?? 30) || 0;
    const _topWorkerType = new Map(workers.map((w) => [w.id, w.workerType]));
    function _topProjectedNet(o: any, userId: string): number {
      // (1) Snapshot path — set at Initiate Payment time.
      const promised = o.promisedPayouts as Array<{ userId: string; net: number }> | null | undefined;
      if (Array.isArray(promised)) {
        const me = promised.find((p) => p.userId === userId);
        if (me && typeof me.net === "number") return me.net;
      }
      // (2) On-the-fly projection — any occurrence not yet snapshotted.
      const priceTotal =
        (o.price ?? o.proposalAmount ?? 0) +
        (o.addons ?? []).reduce((s: number, a: any) => s + (a.price ?? 0), 0);
      const expTotal = (o.expenses ?? []).reduce((s: number, e: any) => s + (e.cost ?? 0), 0);
      const N = Math.max(0, priceTotal - expTotal);
      const cs = o.completionSplits as Array<{ userId: string; percent: number }> | null | undefined;
      const active = (o.assignees ?? []).filter((a: any) => a.role !== "observer");
      const csPct = Array.isArray(cs) ? Number(cs.find((sp) => sp.userId === userId)?.percent ?? 0) : 0;
      const fraction = csPct > 0
        ? csPct / 100
        : active.length > 0 && active.some((a: any) => a.userId === userId) ? 1 / active.length : 0;
      if (fraction > 0) {
        const ratePct = rateForProjection(_topWorkerType.get(userId), {
        contractorFeePercent: _topContractorFee,
        employeeMarginPercent: _topEmployeeMargin,
      });
        const projectedNet = N * fraction * (1 - ratePct / 100);
        if (projectedNet > 0) return projectedNet;
      }
      // (3) Cash-based fallback.
      const split = o.payment?.splits?.find((sp: any) => sp.userId === userId);
      return split?.amount ?? 0;
    }
    const workerJobCounts = new Map<string, { name: string; jobs: number; earnings: number }>();
    for (const o of occurrences.filter((oc) => oc.status === "CLOSED" || oc.status === "PENDING_PAYMENT")) {
      for (const a of o.assignees.filter((as_) => as_.role !== "observer")) {
        const existing = workerJobCounts.get(a.userId) ?? { name: "", jobs: 0, earnings: 0 };
        existing.jobs++;
        existing.earnings += _topProjectedNet(o, a.userId);
        workerJobCounts.set(a.userId, existing);
      }
    }
    // Fill in names
    for (const w of workers) {
      const wc = workerJobCounts.get(w.id);
      if (wc) wc.name = w.displayName ?? "Unknown";
    }
    const topWorkers = [...workerJobCounts.values()]
      .sort((a, b) => b.jobs - a.jobs)
      .slice(0, 5);

    // Window-scoped team metrics. `workersWithJobs` = the set of workers
    // that appear as a non-observer assignee on any in-window occurrence;
    // that's our definition of "active in window." Type breakdown is the
    // same restricted to that set, so the badges answer "who did real
    // work this period?" instead of "how big is the org chart right now?"
    const workersWithJobs = new Set(occurrences.flatMap((o) => o.assignees.filter((a) => a.role !== "observer").map((a) => a.userId)));
    const workersByTypeInWindow: Record<string, number> = {};
    for (const w of workers) {
      if (!workersWithJobs.has(w.id)) continue;
      const t = w.workerType ?? "UNASSIGNED";
      workersByTypeInWindow[t] = (workersByTypeInWindow[t] ?? 0) + 1;
    }

    // Equipment summary — current snapshot (state right now, not scoped to
    // the date range).
    const equipmentCounts = await prisma.equipment.groupBy({
      by: ["status"],
      where: { retiredAt: null },
      _count: true,
    });
    const eqMap: Record<string, number> = {};
    let totalEquipment = 0;
    for (const ec of equipmentCounts) {
      eqMap[ec.status] = ec._count;
      totalEquipment += ec._count;
    }

    // Equipment usage over the window — checkout-anchored. Answers "what's
    // actually earning its keep?" by aggregating checkouts whose
    // checkedOutAt falls inside the selected date range. BSD cutoff is
    // applied via Checkout.releasedAt so pre-cutoff legacy rentals drop
    // out (same anchor the QuickBooks Income export uses; see
    // project_equipment_rental_income memory). The "Now" snapshot above
    // is BSD-independent — it's about machine state, not income.
    const checkoutsInWindow = await prisma.checkout.findMany({
      where: {
        checkedOutAt: { gte: dateFrom, lte: dateTo },
        ...cutoffWhere("Checkout", cutoff),
      },
      include: {
        equipment: { select: { id: true, shortDesc: true, brand: true, model: true, type: true } },
      },
    });
    const allActiveEquipment = await prisma.equipment.findMany({
      where: { retiredAt: null },
      select: { id: true, shortDesc: true, brand: true, model: true, type: true, status: true },
    });

    type EqAgg = {
      id: string;
      shortDesc: string | null;
      brand: string | null;
      model: string | null;
      type: string | null;
      checkouts: number;
      daysOut: number;
      income: number;
      // Sum of `jobs` across every day's breakdown. Null for flat-daily
      // pieces (the model isn't job-driven). Useful in the operator
      // leaderboard for the new per-job-with-cap pieces — answers "how
      // many billed jobs did this tool see this window?"
      jobsBilled: number | null;
    };
    const byEquipment = new Map<string, EqAgg>();
    for (const c of checkoutsInWindow) {
      if (!c.equipment) continue;
      const existing = byEquipment.get(c.equipmentId) ?? {
        id: c.equipmentId,
        shortDesc: c.equipment.shortDesc,
        brand: c.equipment.brand,
        model: c.equipment.model,
        type: c.equipment.type,
        checkouts: 0,
        daysOut: 0,
        income: 0,
        jobsBilled: null,
      };
      existing.checkouts++;
      existing.daysOut += c.rentalDays ?? 0;
      existing.income += c.rentalCost ?? 0;
      // Sum jobs from rentalBreakdown when present. A breakdown line
      // with jobs=null (flat-daily mode) contributes nothing — keep the
      // aggregate null when we've only seen flat-daily rentals. The
      // first per-job breakdown promotes the running total to 0+, then
      // accumulates.
      const breakdown = (c as any).rentalBreakdown as Array<{ jobs: number | null }> | null | undefined;
      if (Array.isArray(breakdown)) {
        for (const line of breakdown) {
          if (line.jobs != null) {
            existing.jobsBilled = (existing.jobsBilled ?? 0) + line.jobs;
          }
        }
      }
      byEquipment.set(c.equipmentId, existing);
    }
    // Inclusive day count for the window; minimum 1 to avoid divide-by-zero
    // on same-day ranges. Used as the denominator for utilization %.
    // etDaysBetween is DST-safe (string math); +1 makes the count inclusive.
    const windowDays = Math.max(
      1,
      etDaysBetween(etFormatDate(dateFrom), etFormatDate(dateTo)) + 1,
    );
    const usedEquipmentIds = new Set(byEquipment.keys());
    const equipmentLeaderboard = [...byEquipment.values()]
      .map((e) => ({
        ...e,
        // Utilization is a rough metric: sum of rental-days over window-
        // days, capped at 100%. Multi-rental overlap (rare with the
        // single-active-checkout invariant) can briefly push above 100;
        // the cap keeps the chart readable.
        utilizationPct: Math.min(100, Math.round((e.daysOut / windowDays) * 100)),
      }))
      .sort((a, b) => b.daysOut - a.daysOut);
    const equipmentIdle = allActiveEquipment
      .filter((e) => !usedEquipmentIds.has(e.id))
      .map((e) => ({
        id: e.id,
        shortDesc: e.shortDesc,
        brand: e.brand,
        model: e.model,
        type: e.type,
        status: e.status,
      }));
    const equipmentWindowTotals = {
      checkouts: checkoutsInWindow.length,
      income: checkoutsInWindow.reduce((s, c) => s + (c.rentalCost ?? 0), 0),
      distinctUsed: usedEquipmentIds.size,
      days: windowDays,
    };

    // Estimates summary
    const estimates = await prisma.jobOccurrence.groupBy({
      by: ["status"],
      where: {
        workflow: "ESTIMATE",
        startAt: { gte: dateFrom, lte: dateTo },
      },
      _count: true,
    });
    const estMap: Record<string, number> = {};
    for (const e of estimates) estMap[e.status] = e._count;

    // Client summary — window-scoped. Three numbers that all answer
    // "what's happening this period?":
    //   workedWithInWindow  — distinct clients with at least one in-window
    //                         occurrence (any status), derived in-memory
    //                         from the already-fetched occurrences.
    //   vipWithWorkInWindow — subset of workedWithInWindow that are VIP.
    //   newInWindow         — clients created during the window.
    const workedClientIds = new Set<string>();
    const vipWorkedClientIds = new Set<string>();
    for (const o of occurrences) {
      const c = (o as any).job?.property?.client as { id: string; isVip: boolean } | null | undefined;
      if (!c) continue;
      workedClientIds.add(c.id);
      if (c.isVip) vipWorkedClientIds.add(c.id);
    }
    const newClientsInWindow = await prisma.client.count({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
    });

    // Recent audit events — scoped to the selected date range so the section
    // answers "what happened in this period?" instead of "what's most recent
    // overall." BSD cutoff still layered for defense-in-depth.
    const recentAudit = await prisma.auditEvent.findMany({
      where: {
        createdAt: { gte: dateFrom, lte: dateTo },
        ...cutoffWhere("AuditEvent", cutoff),
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { actor: { select: { displayName: true } } },
    });

    // Unclaimed jobs list (for inline display)
    const unclaimedList = occurrences
      .filter((o) =>
        o.status === "SCHEDULED" &&
        !nonJobWorkflows.has(o.workflow ?? "") &&
        !o.isEstimate &&
        o.assignees.filter((a) => a.role !== "observer").length === 0
      )
      .sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0));

    // Fetch property/client data for unclaimed jobs
    const unclaimedJobIds = [...new Set(unclaimedList.map((o) => o.jobId).filter(Boolean))] as string[];
    const unclaimedJobs = unclaimedJobIds.length > 0
      ? await prisma.job.findMany({
          where: { id: { in: unclaimedJobIds } },
          include: { property: { select: { displayName: true, street1: true, city: true, state: true, client: { select: { displayName: true } } } } },
        })
      : [];
    const jobMap = new Map(unclaimedJobs.map((j) => [j.id, j]));

    const unclaimedItems = unclaimedList.map((o) => {
      const job = o.jobId ? jobMap.get(o.jobId) : null;
      return {
        id: o.id,
        jobId: o.jobId,
        startAt: o.startAt?.toISOString() ?? null,
        jobType: o.jobType,
        price: o.price,
        property: job?.property?.displayName ?? null,
        client: job?.property?.client?.displayName ?? null,
        address: [job?.property?.street1, job?.property?.city, job?.property?.state].filter(Boolean).join(", "),
      };
    });

    // Count of W-2-relevant occurrences in the window whose hours haven't
    // been admin-approved. The compliance averages above STILL include
    // these occurrences (operators want the full picture, even with
    // tentative numbers), but the UI surfaces this count as a warning so
    // the operator knows the averages may shift once those hours are
    // reviewed. Same filter the Exports preview uses (see exports.ts).
    const unapprovedHoursInWindow = await prisma.jobOccurrence.count({
      where: {
        completedAt: { gte: dateFrom, lte: dateTo },
        status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
        workflow: { in: ["STANDARD", "ONE_OFF"] as any },
        hoursApprovedAt: null,
      },
    });

    // Minimum wage compliance threshold + the two rate settings the
    // projection formula uses to derive net wages on the fly when an
    // occurrence has no promisedPayouts snapshot yet. Defaults match the
    // seed values. The projection mirrors what the W-2 export does (see
    // services/exports.ts computeW2Earnings) so the compliance view shows
    // what the worker IS OWED, not just what's already been paid out.
    const [minWageSetting, marginSetting, feeSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "MIN_WAGE_PER_HOUR" } }),
      prisma.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } }),
      prisma.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } }),
    ]);
    const minWagePerHour = Number(minWageSetting?.value ?? 7.25) || 0;
    const employeeMarginPct = Number(marginSetting?.value ?? 30) || 0;
    const contractorFeePct = Number(feeSetting?.value ?? 20) || 0;
    const workerTypeById = new Map(workers.map((w) => [w.id, w.workerType]));

    // Per-worker stats for comparison
    const allWorkerStats = workers.map((w) => {
      const wJobs = occurrences.filter((o) =>
        (o.status === "CLOSED" || o.status === "PENDING_PAYMENT") &&
        o.assignees.some((a) => a.userId === w.id && a.role !== "observer")
      );
      // totalEarnings mirrors wageGross below: snapshot → projection →
      // split fallback. Previously this summed splits only, which
      // understated employees with pending-payment jobs (they get paid
      // regardless of client-payment timing). See wageGross comment
      // for the derivation.
      // Placeholder — populated after wageGross computes below.
      let totalEarnings = 0;
      const totalExpensesW = wJobs.reduce((s, o) => {
        const occExpenses = o.invoiceCharges.reduce((es, e) => es + e.cost, 0);
        const assigneeCount = o.assignees.filter((a) => a.role !== "observer").length;
        return s + (assigneeCount > 0 ? occExpenses / assigneeCount : 0);
      }, 0);
      // Actual work time — wall-clock minus pause time. Subtracting pauses
      // keeps Eff (estMin / actualMin) consistent with the $/hr column's
      // hours denominator below; otherwise a worker with frequent pauses
      // would look inefficient on Eff while showing a fair $/hr (we don't
      // pay for pauses). Both metrics must use the same "actual" definition.
      const totalActualMin = wJobs.reduce((s, o) => {
        if (!o.startedAt || !o.completedAt) return s;
        const elapsedMs = o.completedAt.getTime() - o.startedAt.getTime() - (o.totalPausedMs ?? 0);
        if (elapsedMs <= 0) return s;
        return s + elapsedMs / 60000;
      }, 0);
      const totalEstMin = wJobs.reduce((s, o) => s + (o.estimatedMinutes ?? 0), 0);
      const scheduledJobs = occurrences.filter((o) =>
        o.status === "SCHEDULED" &&
        o.assignees.some((a) => a.userId === w.id && a.role !== "observer")
      ).length;

      // Wage compliance.
      //
      // Hours: wall-clock minus pause time, per worker — every active
      // assignee on a job is paid for the full wall clock duration, not a
      // divided share (mirrors the W-2 export's wallClockHoursPerWorker).
      //
      // Gross: PROJECTED promised net. Three-tier resolution so an
      // occurrence's status doesn't matter for the compliance view —
      // an in-flight job still contributes its committed wage:
      //   (1) promisedPayouts snapshot (set at Initiate Payment time)
      //   (2) computed on the fly from price/expenses/split/rate when no
      //       snapshot yet — same formula computeBreakdown uses, so the
      //       projection matches what the snapshot WILL be when it's taken
      //   (3) actual payment.splits as a last-ditch fallback (only ever
      //       reached if both above paths fail, which shouldn't happen
      //       for current data)
      // For contractors the projection assumes the client will eventually
      // pay in full — useful as a reclassification-risk signal regardless
      // of whether the cash has cleared.
      const workerWorkerType = workerTypeById.get(w.id) ?? null;
      const ratePct = isW2(workerWorkerType)
        ? employeeMarginPct
        : contractorFeePct;

      const wageHours = wJobs.reduce((s, o) => {
        if (!o.startedAt || !o.completedAt) return s;
        const elapsedMs = o.completedAt.getTime() - o.startedAt.getTime() - (o.totalPausedMs ?? 0);
        if (elapsedMs <= 0) return s;
        return s + elapsedMs / 1000 / 3600;
      }, 0);
      const wageGross = wJobs.reduce((s, o) => {
        // (1) Snapshot path.
        const promised = (o as any).promisedPayouts as Array<{ userId: string; net: number }> | null | undefined;
        if (Array.isArray(promised)) {
          const me = promised.find((p) => p.userId === w.id);
          if (me && typeof me.net === "number") return s + me.net;
        }
        // (2) On-the-fly projection — applies for any occurrence that
        // hasn't had its snapshot stamped yet.
        // The crew's pool. This computed `price + addons − charges`, the
        // materials taken out of the crew's pool a second time — the client
        // pays the materials on top and the pool never sees them, so the
        // projection under-reported every worker by their share of the mulch.
        // crewPool branches; it is the same helper the payout engine agrees
        // with.
        const N = crewPool({
          price: (o as any).price ?? (o as any).proposalAmount ?? 0,
          addons: (o as any).addons ?? [],
        });
        const completionSplits = (o as any).completionSplits as Array<{ userId: string; percent: number }> | null | undefined;
        const splitPctById = new Map<string, number>(
          Array.isArray(completionSplits)
            ? completionSplits.map((sp: any) => [sp.userId, Number(sp.percent) || 0])
            : [],
        );
        const active = o.assignees.filter((a) => a.role !== "observer");
        const fraction = splitPctById.has(w.id)
          ? (splitPctById.get(w.id) ?? 0) / 100
          : active.length > 0 ? 1 / active.length : 0;
        if (fraction > 0) {
          const grossShare = N * fraction;
          const projectedNet = grossShare * (1 - ratePct / 100);
          if (projectedNet > 0) return s + projectedNet;
        }
        // (3) Cash-based fallback — unreachable in practice given (2)
        // always returns a number when there are active assignees, but
        // kept defensively for jobs with no assignees / weird states.
        const split = o.payment?.splits?.find((sp) => sp.userId === w.id);
        return s + (split?.amount ?? 0);
      }, 0);
      totalEarnings = wageGross;
      const avgHourlyRate = wageHours > 0 ? wageGross / wageHours : null;

      return {
        id: w.id,
        name: w.displayName ?? "Unknown",
        workerType: w.workerType,
        jobsCompleted: wJobs.length,
        scheduledJobs,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalExpenses: Math.round(totalExpensesW * 100) / 100,
        netEarnings: Math.round((totalEarnings - totalExpensesW) * 100) / 100,
        totalActualMinutes: Math.round(totalActualMin),
        totalEstimatedMinutes: Math.round(totalEstMin),
        efficiency: totalActualMin > 0 ? Math.round((totalEstMin / totalActualMin) * 100) : 0,
        wageHours: Math.round(wageHours * 100) / 100,
        wageGross: Math.round(wageGross * 100) / 100,
        avgHourlyRate: avgHourlyRate == null ? null : Math.round(avgHourlyRate * 100) / 100,
      };
    }).sort((a, b) => b.jobsCompleted - a.jobsCompleted);

    return {
      jobs: {
        scheduled: jobsScheduled,
        inProgress: jobsInProgress,
        completed: jobsCompleted,
        canceled: jobsCanceled,
        overdue: jobsOverdue,
        unclaimed: jobsUnclaimed,
        paused: jobsPaused,
        pendingPayment: jobsPendingPayment,
      },
      /** The Jobs tab's INSIGHTS body. Same shape the browser used to
       *  compute from the visible rows — now the whole company. */
      jobsRollup: {
        byStatus: rollupStatus,
        byWorkflow: rollupWorkflow,
        unassigned: rUnassigned,
        unconfirmed: rUnconfirmed,
        tentative: rTentative,
        vipCount: rVip,
        repeatingCount: rRepeating,
        followupCount: rFollowup,
        estimateCount: rEstimate,
        announcementCount: rAnnouncement,
        revenueClosed: rClosed,
        revenuePending: rPending,
        revenueBooked: rBooked,
        avgPrice: rPricedRows > 0 ? rPricedSum / rPricedRows : 0,
        uniqueClients: rollupClientIds.size,
        uniqueAssignees: rollupAssigneeIds.size,
      },
      financial: {
        totalRevenue,
        totalExpenses,
        netRevenue,
        totalPlatformFees,
        totalBusinessMargin,
        totalTopUps,
        totalOwnerEarnings,
        avgJobPrice,
        paymentsByMethod,
      },
      team: {
        // Window-scoped counts: workers that had at least one in-window
        // occurrence, broken down by type. See workersWithJobs above.
        activeInWindow: workersWithJobs.size,
        workersByTypeInWindow,
        topWorkers,
      },
      equipment: {
        total: totalEquipment,
        available: eqMap["AVAILABLE"] ?? 0,
        checkedOut: eqMap["CHECKED_OUT"] ?? 0,
        reserved: eqMap["RESERVED"] ?? 0,
        inMaintenance: eqMap["MAINTENANCE"] ?? 0,
        // Window-scoped usage: leaderboard + idle list + headline totals.
        // Driven by Checkout.checkedOutAt inside the selected date range.
        windowDays: equipmentWindowTotals.days,
        windowCheckouts: equipmentWindowTotals.checkouts,
        windowIncome: equipmentWindowTotals.income,
        windowDistinctUsed: equipmentWindowTotals.distinctUsed,
        leaderboard: equipmentLeaderboard,
        idle: equipmentIdle,
      },
      estimates: {
        pending: estMap["PROPOSAL_SUBMITTED"] ?? 0,
        accepted: estMap["ACCEPTED"] ?? 0,
        rejected: estMap["REJECTED"] ?? 0,
      },
      clients: {
        workedWithInWindow: workedClientIds.size,
        newInWindow: newClientsInWindow,
        vipWithWorkInWindow: vipWorkedClientIds.size,
      },
      unclaimedItems,
      // Same rule as `/statistics` above: the operational columns are what
      // `reports.view` buys, the pay columns need `payroll.view`. This array
      // carries `wageGross` and `avgHourlyRate` per NAMED worker, which on a
      // Trainee-held entitlement was every colleague's effective hourly rate.
      workerStats: callerCan(req, "payroll.view")
        ? allWorkerStats
        : allWorkerStats.map((w: any) => {
            const { totalEarnings: _e, netEarnings: _n, totalExpenses: _x,
                    wageGross: _g, avgHourlyRate: _r, ...safe } = w;
            return safe;
          }),
      minWagePerHour,
      unapprovedHoursInWindow,
      recentAudit: recentAudit.map((a) => ({
        id: a.id,
        scope: a.scope,
        verb: a.verb,
        action: a.action,
        actorName: a.actor?.displayName ?? "System",
        createdAt: a.createdAt,
        metadata: a.metadata,
      })),
    };
  });
  // Team travel rollup — feeds the Routes Next operations panel with
  // aggregate mileage metrics for a rolling window. `routes.plan`; not
  // view-as (the panel is inherently a cross-team surface).
  app.get("/routes/operations", req_routesPlan, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      throw app.httpErrors.badRequest("from query param required (YYYY-MM-DD).");
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw app.httpErrors.badRequest("to query param required (YYYY-MM-DD).");
    }
    const { routesOperationsSummary } = await import("../services/mileage");
    return routesOperationsSummary(from, to);
  });
  // Dashboard summary — single endpoint for all badge counts.
  // ?viewAsUserId=<id> computes the summary for another person (used by the
  // Home view to inspect what each person is seeing).
  app.get("/dashboard-summary", approvedUser, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const canManageSchedule = callerCan(req, "schedule.manage");
      if (!canManageSchedule) throw app.httpErrors.forbidden("Viewing another worker's dashboard requires schedule authority.");
      uid = viewAsUserId;
    }
    // Does the effective dashboard user (after any viewAsUserId override)
    // hold `timeline.view`? That decides whether Timeline events
    // (workflow=EVENT) appear in the Notices tile and count below.
    //
    // It resolved `schedule.manage` while the comment claimed
    // `timeline.view` — two separately grantable entitlements. Someone who
    // runs the schedule without a timeline grant was counted events they
    // cannot open, and a bookkeeper holding `timeline.view` without
    // `schedule.manage` silently lost them. Third site of this same
    // mix-up, after routes/occurrences.ts and JobsTab.
    //
    // Whose experience is being rendered? When viewing-as, the TARGET's —
    // looking at somebody's dashboard must show THEIR notices, not yours.
    // So the caller's own principal is the wrong source here, and this is
    // the one case where resolving another user's capabilities is correct.
    const effectiveCanViewTimeline =
      uid === callerUid
        ? callerCan(req, "timeline.view")
        : await userCan(prisma, uid, "timeline.view");
    const now = new Date();
    // Use Eastern Time (business TZ) for "today"/"tomorrow" — UTC-based date strings
    // would tip into the next day late evening ET and miscount.
    const todayStr = etToday();
    const todayMidnight = etMidnight(todayStr);
    const tomorrowStr = etTomorrow();
    const tomorrowMidnight = etMidnight(tomorrowStr);
    const tomorrowEnd = etEndOfDay(tomorrowStr);
    // ~1-month (30-day) rolling window for "stale" tiles. ET-anchored
    // via etAddDays so a `.setMonth()` on the UTC midnight Date doesn't
    // produce off-by-day-boundary results on month rollovers (e.g.
    // Mar 31 → Feb 31 → Mar 3 cascade). Matches the `lastMonth` date
    // preset used by the Home tile click-throughs.
    const lookbackStart = etMidnight(etAddDays(todayStr, -30));

    // 7 full days BEFORE today (today is excluded — today's in-progress
    // numbers belong to the title-bar optimistic projection, not the "last
    // 7 days" history tiles). Used as the LOWER bound for both the Hours
    // tile (`minutesThisWeek` / `thisWeekJobs`) and the Earnings tile
    // (`actualWeekEarnings`); the queries pair it with `lt: todayMidnight`
    // so the two tiles always cover the same job set.
    const sevenDaysAgo = etMidnight(etAddDays(todayStr, -7));

    // Sunday-of-this-week in Eastern Time. Used as the anchor for the
    // weekly trend chart and the "Hours this week" tile. Compute the day-
    // of-week from a UTC-noon Date for the current ET calendar day so the
    // arithmetic is DST-safe.
    const [ty, tm, td] = todayStr.split("-").map(Number);
    const dayOfWeek = new Date(Date.UTC(ty, tm - 1, td, 12)).getUTCDay();
    const startOfWeek = etMidnight(etAddDays(todayStr, -dayOfWeek));

    // 9-week window (~2 months) for the "Jobs completed" trend chart on the Home tab.
    const trendStart = etMidnight(etAddDays(todayStr, -dayOfWeek - 8 * 7));

    // Get user's assigned occurrences (SCHEDULED/IN_PROGRESS/PENDING_PAYMENT/PROPOSAL_SUBMITTED).
    // Pull role so we can carve out a working-only subset — observer assignments must NOT
    // count toward the user's Hours/Earnings tallies, since observers don't work the job
    // and don't take a payout share.
    const myAssignments = await prisma.jobOccurrenceAssignee.findMany({
      where: { userId: uid },
      select: { occurrenceId: true, role: true },
    });
    const myOccIds = myAssignments.map((a) => a.occurrenceId);
    const myWorkingOccIds = myAssignments.filter((a) => a.role !== "observer").map((a) => a.occurrenceId);
    // Observer-only assignments. Counted separately so the Home greeting can
    // call out how many of today's remaining jobs the user is just observing
    // ("You have X jobs left today (Y as observer)").
    const myObserverOccIds = myAssignments.filter((a) => a.role === "observer").map((a) => a.occurrenceId);

    // Business Start Date filter — resolved once per request (one Settings
    // lookup) and applied to every money/pending tile below. See
    // lib/businessStartCutoff.ts. Null means filter off — every helper
    // becomes a no-op so the dashboard returns its full pre-feature shape.
    const cutoff = await resolveCutoff(req);
    const workDateCutoff = occurrenceWorkDateCutoff(cutoff);

    if (myOccIds.length === 0) {
      const [equipmentCheckedOut, equipmentReserved, allRemindersPending] = await Promise.all([
        prisma.checkout.count({ where: { userId: uid, releasedAt: null, checkedOutAt: { not: null } } }),
        prisma.checkout.count({ where: { userId: uid, releasedAt: null, checkedOutAt: null } }),
        prisma.reminder.count({ where: { userId: uid, dismissedAt: null } }),
      ]);
      return {
        overdue: 0, today: 0, tomorrow: 0, pendingPayment: 0, estimatesReady: 0,
        followUps: 0, planning: 0,
        activeWork: 0, todayRemaining: 0, todayObserverRemaining: 0, todayPotentialAmount: 0, todayEarnedAmount: 0,
        tomorrowUnclaimedCount: 0, tomorrowUnclaimedPotential: 0,
        tomorrowUnconfirmedClientCount: 0,
        equipmentCheckedOut, equipmentReserved,
        remindersPending: allRemindersPending,
        notices: 0,
        noticesAnnouncements: 0,
        noticesFollowups: 0,
        noticesEvents: 0,
        tasksDue: 0,
        minutesThisWeek: 0,
        actualWeekEarnings: 0,
        weekJobCount: 0,
        weekEarningsFrom: "",
        weekEarningsTo: "",
        weeklyCompleted: [] as { weekStart: string; count: number; earnings: number }[],
      };
    }

    const [
      overdue, todayCount, tomorrowCount, pendingPayment, estimatesReady, reminders,
      activeWork, todayJobs, equipmentCheckedOut, equipmentReserved, allRemindersPending, noticesByWorkflow,
      tasksDue, thisWeekJobs, weekSplits, todayRemaining, todayObserverRemaining, todayCompletedJobs, tomorrowUnclaimedJobs, trendJobs,
      tomorrowUnconfirmedJobs,
    ] = await Promise.all([
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          startAt: { gte: lookbackStart, lt: todayMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          // All non-canceled / non-archived today (incl. completed). The tile is meant
          // to reflect "how many jobs were for today" overall, not just remaining work.
          status: { notIn: ["CANCELED", "ARCHIVED"] as any },
          // Include STANDARD/ONE_OFF/ESTIMATE to match the JobsTab feed click-through —
          // an ESTIMATE today is still "a job today" from the worker's perspective.
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: { in: ["SCHEDULED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          status: "PENDING_PAYMENT" as any,
          startAt: { gte: lookbackStart },
          // Pre-cutoff PENDING_PAYMENT jobs hidden from the Awaiting Payment
          // tile per the Business Start Date design. A `books.view` holder can toggle the
          // reveal header to see them when chasing the client.
          ...workDateCutoff,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          status: "PROPOSAL_SUBMITTED" as any,
          workflow: "ESTIMATE",
          startAt: { gte: lookbackStart },
        },
      }),
      // Reminders due — exclude reminders attached to finished occurrences (the work is
      // already done; those reminders are stale until the user dismisses them).
      prisma.reminder.count({
        where: {
          userId: uid,
          dismissedAt: null,
          remindAt: { lte: now },
          occurrence: {
            status: { notIn: ["COMPLETED", "CLOSED", "PENDING_PAYMENT", "ARCHIVED", "CANCELED"] as any },
          },
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          status: { in: ["IN_PROGRESS", "PAUSED"] as any },
          startAt: { gte: lookbackStart },
        },
      }),
      prisma.jobOccurrence.findMany({
        where: {
          // Working assignments only — observer roles don't earn a payout share.
          id: { in: myWorkingOccIds },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
        },
        select: {
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid },
                select: { amount: true },
              },
            },
          },
        },
      }),
      prisma.checkout.count({ where: { userId: uid, releasedAt: null, checkedOutAt: { not: null } } }),
      prisma.checkout.count({ where: { userId: uid, releasedAt: null, checkedOutAt: null } }),
      prisma.reminder.count({ where: { userId: uid, dismissedAt: null } }),
      prisma.jobOccurrence.groupBy({
        by: ["workflow"],
        where: {
          id: { in: myOccIds },
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          // Timeline events (workflow=EVENT) need `timeline.view` — a
          // caller without it never sees them in the Notices tile or count.
          workflow: { in: (effectiveCanViewTimeline
            ? ["ANNOUNCEMENT", "FOLLOWUP", "EVENT"]
            : ["ANNOUNCEMENT", "FOLLOWUP"]) as any },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
        },
        _count: { _all: true },
      }),
      // Tasks due — TASK-workflow occurrences scheduled today or earlier, not yet done.
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: "TASK",
          startAt: { lt: tomorrowMidnight },
        },
      }),
      // Jobs the user worked & completed in the last 7 days (today excluded).
      // Drives the Hours tile (`minutesThisWeek` — wall-clock minutes summed).
      // Window MUST match the Earnings tile's window below or the two tiles
      // can disagree on whether a job from N days ago is "in the last 7";
      // the bug that prompted this alignment was Hours showing 0m while
      // Earnings showed $X for the same job. Observer-only assignments are
      // excluded — observers don't work the job and don't earn a payout share.
      prisma.jobOccurrence.findMany({
        where: {
          id: { in: myWorkingOccIds },
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          startedAt: { not: null },
          // Cutoff is "additive" with the 7-day window — take the LATER bound.
          completedAt: { gte: cutoff && cutoff > sevenDaysAgo ? cutoff : sevenDaysAgo, lt: todayMidnight, not: null },
        },
        select: {
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid },
                select: { amount: true },
              },
            },
          },
        },
      }),
      // Placeholder — Earnings is now derived from the completed-jobs query above.
      // Kept in the destructure tuple to preserve positional indexes downstream.
      Promise.resolve([] as Array<{ amount: number }>),
      // Today's remaining work (unfinished real jobs). Used by the Begin Work Day hero
      // so the CTA only fires when there's actually work to do.
      prisma.jobOccurrence.count({
        where: {
          id: { in: myOccIds },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
        },
      }),
      // Subset of the above where the user's assignment role is observer.
      // Powers the "(Y as observer)" callout in the Home greeting so users
      // can tell at a glance how many of their remaining items they're just
      // watching vs. actually working.
      prisma.jobOccurrence.count({
        where: {
          id: { in: myObserverOccIds },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
        },
      }),
      // Today's completed real jobs — used to compute "X earned" alongside "remaining potential".
      // Working assignments only — observer roles don't earn a payout share.
      prisma.jobOccurrence.findMany({
        where: {
          id: { in: myWorkingOccIds },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
        },
        select: {
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid },
                select: { amount: true },
              },
            },
          },
        },
      }),
      // Tomorrow's unclaimed jobs — open shifts the worker could pick up. Visible to all workers,
      // not just user's assignments. Used by the "Plan tomorrow" hero to surface team-wide pickups.
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          mustBeAssigned: false,
          assignees: { none: {} },
        },
        select: {
          price: true,
          proposalAmount: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
        },
      }),
      // Weekly trend: completed real jobs in the last 13 weeks (by completedAt).
      // Also pull pricing fields so we can compute the worker's net share per week.
      // Working assignments only — observer roles don't earn a payout share.
      prisma.jobOccurrence.findMany({
        where: {
          id: { in: myWorkingOccIds },
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          // Weekly trend chart — cutoff is additive with the 13-week window;
          // take the LATER bound so the chart shows blank weeks instead of
          // pre-cutoff data padding the bars.
          completedAt: { gte: cutoff && cutoff > trendStart ? cutoff : trendStart, not: null },
        },
        select: {
          completedAt: true,
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid },
                select: { amount: true },
              },
            },
          },
        },
      }),
      // Tomorrow's unconfirmed jobs — fetch clientId so we can count UNIQUE clients
      // needing confirmation (one client may have multiple jobs tomorrow).
      prisma.jobOccurrence.findMany({
        where: {
          id: { in: myOccIds },
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          isClientConfirmed: false,
          jobId: { not: null },
        },
        select: { job: { select: { property: { select: { clientId: true } } } } },
      }),
    ]);

    // Worker earnings math — the SINGLE helper (computeMyOccurrenceNet in
    // services/workerEarnings.ts) handles every "what will this worker
    // actually be paid for this occurrence" number. It prefers the
    // reconciled PaymentSplit.amount when the payment is confirmed +
    // healthy, and falls back to a completionSplits-aware projection
    // otherwise. See the helper's file-header comment for the full rule.
    const meUser = await prisma.user.findUnique({ where: { id: uid }, select: { workerType: true } });
    const isEmp = isW2(meUser?.workerType);
    const settingKeyForPct = isEmp ? "EMPLOYEE_BUSINESS_MARGIN_PERCENT" : "CONTRACTOR_PLATFORM_FEE_PERCENT";
    const setting = await prisma.setting.findUnique({ where: { key: settingKeyForPct } });
    const pct = Number(setting?.value ?? 0);
    const todayPotentialAmount = todayJobs.reduce((sum, occ) => sum + computeMyOccurrenceNet(occ, uid, pct), 0);
    const todayEarnedAmount = todayCompletedJobs.reduce((sum, occ) => sum + computeMyOccurrenceNet(occ, uid, pct), 0);

    // Tomorrow's unconfirmed clients — unique client count for tomorrow's SCHEDULED jobs
    // that haven't been client-confirmed yet. Drives the "confirm Y clients" hint in the
    // Plan tomorrow hero.
    const tomorrowUnconfirmedClientCount = new Set(
      (tomorrowUnconfirmedJobs as any[])
        .map((o) => o.job?.property?.clientId)
        .filter((id): id is string => !!id)
    ).size;

    // Tomorrow's unclaimed potential — the current worker's net share IF
    // they solo-claimed each unclaimed job. `assumeSoloClaim` skips the
    // completionSplits + assignees lookup entirely and uses 100% share.
    const tomorrowUnclaimedCount = tomorrowUnclaimedJobs.length;
    const tomorrowUnclaimedPotential = tomorrowUnclaimedJobs.reduce((sum: number, occ: any) => {
      // The tomorrowUnclaimedJobs select doesn't include completionSplits
      // or assignees.userId — that's fine, assumeSoloClaim short-circuits
      // both. Empty arrays satisfy the input shape.
      return sum + computeMyOccurrenceNet(
        { ...occ, completionSplits: null, assignees: [], payment: null },
        uid,
        pct,
        { assumeSoloClaim: true },
      );
    }, 0);

    const planning = overdue + todayCount + tomorrowCount + pendingPayment + estimatesReady + reminders;

    // Total wall-clock minutes worked this week (jobs completed in the last 7 days).
    const minutesThisWeek = thisWeekJobs.reduce((sum: number, occ: any) => {
      if (!occ.startedAt || !occ.completedAt) return sum;
      const ms = new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime() - (occ.totalPausedMs ?? 0);
      return sum + Math.max(0, ms / 60000);
    }, 0);

    // Bucket completed jobs into weekly counts for the trend chart
    // (Sunday-start, in ET). Convert the Date to its ET calendar day, then
    // walk back to the Sunday-on-or-before via string arithmetic — keeps
    // the bucketing consistent across DST edges and server timezones.
    const weekKey = (d: Date) => {
      const dayKey = etFormatDate(d);
      const [yy, mm, dd] = dayKey.split("-").map(Number);
      const dow = new Date(Date.UTC(yy, mm - 1, dd, 12)).getUTCDay();
      return etAddDays(dayKey, -dow);
    };
    const weeklyMap: Record<string, { count: number; earnings: number }> = {};
    const startOfWeekKey = etFormatDate(startOfWeek);
    const trendStartKey = etAddDays(startOfWeekKey, -8 * 7);
    for (let i = 0; i < 9; i++) {
      weeklyMap[etAddDays(trendStartKey, i * 7)] = { count: 0, earnings: 0 };
    }
    // Same paycheck-truthful math as todayPotentialAmount / earnings-summary /
    // title-bar-earnings — see services/workerEarnings.ts. Reconciled split
    // wins when the payment is confirmed + healthy; otherwise projection
    // uses completionSplits[me]% rather than an equal split so the bars
    // reflect what THIS worker is actually paid on uneven-split crews.
    for (const occ of trendJobs) {
      if (!occ.completedAt) continue;
      const k = weekKey(new Date(occ.completedAt));
      if (!(k in weeklyMap)) continue;
      weeklyMap[k].count++;
      weeklyMap[k].earnings += computeMyOccurrenceNet(occ, uid, pct);
    }
    const weeklyCompleted = Object.entries(weeklyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([weekStart, v]) => ({ weekStart, count: v.count, earnings: Math.round(v.earnings * 100) / 100 }));

    // ── "Earnings last 7 days" tile ──────────────────────────────────────
    // Window = the 7 full days BEFORE today (today is excluded — it belongs
    // to the title-bar optimistic projection). Worker-type-split, mirroring
    // each type's payroll anchor (see docs/FINANCIAL_SYSTEM.md §"Worker
    // earnings views"):
    //   • EMPLOYEE (W-2) — WORK-anchored. Promised net for jobs they
    //     completed in the window, regardless of whether a payment exists.
    //     Their wages accrue with the work; the drill-down is the Jobs tab.
    //   • Contractor — PAYMENT-anchored. Their actual reconciled
    //     PaymentSplit.amount for payments RECORDED in the window
    //     (Payment.createdAt). Their pay tracks client payments; the
    //     drill-down is the Payments tab.
    // Decoupled from the Hours tile — that still counts jobs completed this
    // week (thisWeekJobs); earnings now has its own window + anchor.
    const earnWindowStart = etMidnight(etAddDays(todayStr, -7));
    // ET date strings (YYYY-MM-DD) for the window, returned so the tile's
    // click-through filters the Payments/Jobs tab to exactly this range.
    const weekEarningsFrom = etAddDays(todayStr, -7); // 7 days before today
    const weekEarningsTo = etAddDays(todayStr, -1);   // yesterday
    let actualWeekEarnings = 0;
    let weekJobCount = 0;
    // Business Start Date filter (`cutoff` declared at the top of this
    // handler) applied to the "Earnings last 7 days" tile so pre-cutoff
    // jobs/payments don't pad the worker's weekly tile.
    if (isEmp) {
      const empJobs = await prisma.jobOccurrence.findMany({
        where: {
          id: { in: myWorkingOccIds },
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          completedAt: { gte: cutoff && cutoff > earnWindowStart ? cutoff : earnWindowStart, lt: todayMidnight, not: null },
        },
        select: {
          price: true,
          proposalAmount: true,
          completionSplits: true,
          addons: { select: { price: true } },
          invoiceCharges: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid },
                select: { amount: true },
              },
            },
          },
        },
      });
      actualWeekEarnings = empJobs.reduce((sum, occ) => sum + computeMyOccurrenceNet(occ, uid, pct), 0);
      weekJobCount = empJobs.length;
    } else {
      // Contractor weekly earnings — PAYMENT-anchored: confirmed
      // PaymentSplits whose payment landed in the window. A contractor
      // is paid once the client pays, so the split is the whole story.
      const winLo = cutoff && cutoff > earnWindowStart ? cutoff : earnWindowStart;
      const mySplits = await prisma.paymentSplit.findMany({
        where: {
          userId: uid,
          payment: { createdAt: { gte: winLo, lt: todayMidnight }, skippedAt: null },
        },
        select: { amount: true },
      });
      actualWeekEarnings = mySplits.reduce((sum, sp) => sum + sp.amount, 0);
      weekJobCount = mySplits.length;
    }
    void weekSplits;

    return {
      overdue, today: todayCount, tomorrow: tomorrowCount, pendingPayment, estimatesReady,
      followUps: reminders, planning,
      activeWork,
      todayRemaining,
      todayObserverRemaining,
      todayPotentialAmount: Math.round(todayPotentialAmount * 100) / 100,
      todayEarnedAmount: Math.round(todayEarnedAmount * 100) / 100,
      tomorrowUnclaimedCount,
      tomorrowUnclaimedPotential: Math.round(tomorrowUnclaimedPotential * 100) / 100,
      tomorrowUnconfirmedClientCount,
      equipmentCheckedOut, equipmentReserved,
      remindersPending: allRemindersPending,
      notices: (noticesByWorkflow as any[]).reduce((sum, g) => sum + (g._count?._all ?? 0), 0),
      noticesAnnouncements: (noticesByWorkflow as any[]).find((g) => g.workflow === "ANNOUNCEMENT")?._count?._all ?? 0,
      noticesFollowups: (noticesByWorkflow as any[]).find((g) => g.workflow === "FOLLOWUP")?._count?._all ?? 0,
      noticesEvents: (noticesByWorkflow as any[]).find((g) => g.workflow === "EVENT")?._count?._all ?? 0,
      tasksDue,
      minutesThisWeek: Math.round(minutesThisWeek),
      actualWeekEarnings: Math.round(actualWeekEarnings * 100) / 100,
      weekJobCount,
      weekEarningsFrom,
      weekEarningsTo,
      weeklyCompleted,
    };
  });
  // Company-wide aggregate dashboard. Used by HomeTab when its view-as
  // picker has nobody selected.
  // Mirrors the per-worker /dashboard-summary shape (so the same Summary type works on
  // the frontend), but every value is computed across the entire team — no myOccIds
  // restriction. Money figures are total worker payouts (sum across active assignees,
  // each weighted by their workerType's fee/margin). Hours are person-hours (each
  // assignee on a multi-worker job contributes the job's full wall-clock).
  app.get("/dashboard-summary/aggregate", req_reportsView, async (req: any) => {
    const callerUid = await currentUserId(req);
    // THE GUARD IS THE WHOLE CHECK. `reports.view` is "see business
    // statistics and the operations rollup", which is exactly this page.
    //
    // There used to be a second check here requiring `schedule.manage` on
    // top, left over from when this was a single-role screen. The route
    // declared one thing and enforced another, so granting somebody stats
    // access got them a 403 with no explanation — and the route map agreed
    // with the declaration, so no gate caught it. A capability probe across
    // all 496 guarded endpoints found it: the only one that refused a caller
    // holding exactly what it asked for.

    // Optional `workerIds=id1,id2,...` parameter restricts the aggregate to a subset
    // of workers. When omitted/empty: whole-team aggregate. When populated: counts
    // include only occurrences touching at least one of those workers, and money/
    // hours sum only those workers' shares.
    const workerIdsParam = (req.query?.workerIds as string | undefined) ?? "";
    const subsetIds = workerIdsParam
      ? workerIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const isSubset = subsetIds.length > 0;

    // TERRITORY, ON EVERY COUNT BELOW.
    //
    // `reports.view` is "see the team rollup — YOUR CREW'S hours, pay and
    // jobs", and it is a threaded, settled-scopable capability. This route
    // counted the whole company regardless, so a district lead whose Jobs,
    // Clients and Properties lists were correctly narrowed got one panel
    // quietly totalling every district — which reads as a wrong number, not
    // as a wider view. G10 never flagged it because its matcher stopped at
    // ~1800 characters and this handler is 24,000.
    //
    // The business-wide rollup is a DIFFERENT surface: `/operations`, on
    // `reports.business`, whose copy says "across the company" and which
    // stays global on purpose.
    const areaFilter = areaWhere(req.principal, "reports.view");
    const subsetSet = new Set(subsetIds);

    // Business Start Date filter — resolved once for the entire aggregate.
    // See lib/businessStartCutoff.ts.
    const cutoff = await resolveCutoff(req);
    const workDateCutoff = occurrenceWorkDateCutoff(cutoff);

    const todayStr = etToday();
    const todayMidnight = etMidnight(todayStr);
    const tomorrowStr = etTomorrow();
    const tomorrowMidnight = etMidnight(tomorrowStr);
    const tomorrowEnd = etEndOfDay(tomorrowStr);
    // ~1-month (30-day) rolling window for "stale" tiles, ET-anchored.
    // See twin block at top of this file for rationale.
    const lookbackStart = etMidnight(etAddDays(todayStr, -30));
    // 7 full days BEFORE today (today excluded) — same window the per-worker
    // path uses for the Hours and Earnings tiles. See the matching block at
    // the top of the per-worker route for the rationale.
    // Mirror the worker-Home handler above: ET-anchored "7 days ago" + "this
    // week's Sunday" + "9 weeks back". String arithmetic via etAddDays keeps
    // these stable across DST + server timezone.
    const sevenDaysAgo = etMidnight(etAddDays(todayStr, -7));
    const [ty2, tm2, td2] = todayStr.split("-").map(Number);
    const dayOfWeek = new Date(Date.UTC(ty2, tm2 - 1, td2, 12)).getUTCDay();
    const startOfWeek = etMidnight(etAddDays(todayStr, -dayOfWeek));
    const trendStart = etMidnight(etAddDays(todayStr, -dayOfWeek - 8 * 7));

    // Pull margin/fee settings — used when summing total worker payouts per occurrence.
    const empSetting = await prisma.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } });
    const conSetting = await prisma.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } });
    const empPct = Number(empSetting?.value ?? 0);
    const conPct = Number(conSetting?.value ?? 0);
    const workerPct = (type: WorkerType | null | undefined) =>
      rateForProjection(type, { employeeMarginPercent: empPct, contractorFeePercent: conPct });

    // Sum of all workers' payouts for one occurrence — accounts for each assignee's
    // worker type (employee margin vs contractor fee). Returns 0 if no active workers.
    type AggOcc = {
      price: number | null;
      proposalAmount: number | null;
      addons: { price: number | null }[];
      invoiceCharges: { cost: number }[];
      assignees: { role: string | null; userId: string; user: { workerType: WorkerType | null } | null }[];
    };
    // In subset mode, only sum payouts for workers in the selected set. The share-per-
    // worker math still uses the FULL active count (so e.g. a 3-person job with 1
    // selected worker contributes one share, not the entire pool).
    function totalWorkerPayouts(occ: AggOcc): number {
      const base = occ.price ?? occ.proposalAmount ?? 0;
      const addonsTotal = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
      const displayPrice = base + addonsTotal;
      if (displayPrice <= 0) return 0;
      // NOTHING IS SUBTRACTED HERE. Material charges are billed to the client
      // ON TOP and never come out of the crew's pool. This once subtracted
      // them, which under-reported every worker's projected pay by their share
      // of the mulch.
      const net = displayPrice;
      const active = (occ.assignees ?? []).filter((a) => a.role !== "observer");
      if (active.length === 0) return 0;
      const sharePer = net / active.length;
      let total = 0;
      for (const a of active) {
        if (isSubset && !subsetSet.has(a.userId)) continue;
        const pct = workerPct(a.user?.workerType);
        const deduction = Math.round(sharePer * pct) / 100;
        total += Math.max(0, sharePer - deduction);
      }
      return total;
    }
    // In subset mode, count only selected active assignees on a job (so person-hours
    // for a 60-min job with 1 selected worker out of 3 = 60 min, not 180).
    function activeAssigneeCount(occ: { assignees?: { role: string | null; userId?: string }[] }): number {
      return (occ.assignees ?? []).filter((a) =>
        a.role !== "observer" && (!isSubset || (!!a.userId && subsetSet.has(a.userId)))
      ).length;
    }

    const moneySelect = Prisma.validator<Prisma.JobOccurrenceSelect>()({
      price: true,
      proposalAmount: true,
      addons: { select: { price: true } },
      invoiceCharges: { select: { cost: true } },
      assignees: { select: { role: true, userId: true, user: { select: { workerType: true } } } },
    });

    // Reused for every "occurrences touching the subset" query. Empty in whole-team mode.
    const assigneeSubsetFilter = isSubset
      ? { assignees: { some: { userId: { in: subsetIds } } } }
      : {};
    const userSubsetFilter = isSubset
      ? { userId: { in: subsetIds } }
      : {};

    const [
      todayCount, tomorrowCount, pendingPayment, estimatesReady,
      noticesByWorkflow, tasksDue, activeWork, todayRemaining,
      todayJobs, todayCompletedJobs, tomorrowUnclaimedJobs,
      thisWeekJobs, trendJobs, tomorrowUnconfirmedJobs,
      remindersDueOccs, allRemindersPending,
      equipmentCheckedOut, equipmentReserved,
      inProgressList,
      completedTodayList,
      workdaysInProgressList,
    ] = await Promise.all([
      prisma.jobOccurrence.count({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { notIn: ["CANCELED", "ARCHIVED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: "PENDING_PAYMENT" as any,
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
          ...areaFilter,
          // Pre-cutoff Awaiting Payment hidden per Business Start Date design.
          ...workDateCutoff,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: "PROPOSAL_SUBMITTED" as any,
          workflow: "ESTIMATE",
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
      }),
      prisma.jobOccurrence.groupBy({
        by: ["workflow"],
        where: {
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: { in: ["ANNOUNCEMENT", "FOLLOWUP", "EVENT"] as any },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        _count: { _all: true },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: "TASK",
          startAt: { lt: tomorrowMidnight },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: { in: ["IN_PROGRESS", "PAUSED"] as any },
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: moneySelect,
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: moneySelect,
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          mustBeAssigned: false,
          assignees: { none: {} },
        },
        select: { price: true, proposalAmount: true, addons: { select: { price: true } }, invoiceCharges: { select: { cost: true } } },
      }),
      prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          startedAt: { not: null },
          // Today excluded — see the per-worker route's matching query for
          // the rationale (Hours/Earnings tiles must cover the same window).
          // Cutoff is additive — take the LATER bound.
          completedAt: { gte: cutoff && cutoff > sevenDaysAgo ? cutoff : sevenDaysAgo, lt: todayMidnight, not: null },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: {
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          ...moneySelect,
        },
      }),
      prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          // Cutoff is additive with the 13-week window.
          completedAt: { gte: cutoff && cutoff > trendStart ? cutoff : trendStart, not: null },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: { completedAt: true, ...moneySelect },
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          isClientConfirmed: false,
          jobId: { not: null },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: { job: { select: { property: { select: { clientId: true } } } } },
      }),
      // Distinct occurrences with at least one actionable, non-dismissed reminder due.
      // Use groupBy on occurrenceId to dedupe across users.
      prisma.reminder.groupBy({
        by: ["occurrenceId"],
        where: {
          ...userSubsetFilter,
          dismissedAt: null,
          remindAt: { lte: new Date() },
          occurrence: {
            status: { notIn: ["COMPLETED", "CLOSED", "PENDING_PAYMENT", "ARCHIVED", "CANCELED"] as any },
          },
        },
      }),
      prisma.reminder.count({ where: { dismissedAt: null, ...userSubsetFilter } }),
      prisma.checkout.count({ where: { releasedAt: null, checkedOutAt: { not: null }, ...userSubsetFilter } }),
      prisma.checkout.count({ where: { releasedAt: null, checkedOutAt: null, ...userSubsetFilter } }),
      // In-progress / paused job list with active assignees — feeds the
      // "jobs in progress and by who" panel on the Home Team Overview.
      // Same status set as the activeWork count above; lookback bound matches
      // so we don't return stale never-completed rows from the deep past.
      prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["IN_PROGRESS", "PAUSED"] as any },
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: {
          id: true,
          startAt: true,
          status: true,
          title: true,
          // Actual start / paused-since / accumulated-pause fields feed the
          // live "how long has this been running" duration on each row.
          startedAt: true,
          pausedAt: true,
          totalPausedMs: true,
          job: {
            select: {
              property: {
                select: {
                  displayName: true,
                  client: { select: { displayName: true } },
                },
              },
            },
          },
          assignees: {
            // Exclude observers, but KEEP workers/claimers. role is nullable
            // (null = worker, "observer" = observer); SQL `role != 'observer'`
            // is null/falsy when role IS NULL, which would silently drop every
            // real worker and make the panel render "(unassigned)".
            where: { OR: [{ role: null }, { role: { not: "observer" } }] },
            select: {
              userId: true,
              role: true,
              assignedById: true,
              user: { select: { displayName: true, email: true } },
            },
          },
        },
        orderBy: { startAt: "asc" },
        take: 25, // safety cap; team-overview panel is a snapshot, not a list
      }),
      // Completed-today list: any occurrence whose `completedAt` lands in
      // today, regardless of post-completion state (CLOSED already-paid,
      // PENDING_PAYMENT awaiting collection, or COMPLETED — the brief
      // worker-finished-but-not-yet-priced state). Feeds the "Completed
      // today" panel under "In progress now" on the Home Team
      // Overview. Same shape as inProgressList so the UI can render both
      // with the same row component.
      prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["COMPLETED", "PENDING_PAYMENT", "CLOSED"] as any },
          completedAt: { gte: todayMidnight, lt: tomorrowMidnight },
          ...assigneeSubsetFilter,
          ...areaFilter,
        },
        select: {
          id: true,
          startAt: true,
          completedAt: true,
          status: true,
          title: true,
          // Actual start + accumulated-pause fields let the UI compute
          // a "took Xh Ym" duration on each row.
          startedAt: true,
          totalPausedMs: true,
          job: {
            select: {
              property: {
                select: {
                  displayName: true,
                  client: { select: { displayName: true } },
                },
              },
            },
          },
          assignees: {
            where: { OR: [{ role: null }, { role: { not: "observer" } }] },
            select: {
              userId: true,
              role: true,
              assignedById: true,
              user: { select: { displayName: true, email: true } },
            },
          },
        },
        orderBy: { completedAt: "desc" }, // most recent completion first
        take: 25,
      }),
      // Workdays currently on the clock — IN_PROGRESS (endedAt null,
      // pausedAt null) or PAUSED (endedAt null, pausedAt set) for
      // today's ET date. Feeds the "Workdays in progress" panel under
      // the Team Overview banner so someone with `routes.plan` can see at a glance which
      // workers are still on the clock without opening the per-worker
      // Today's-hourly-pay panel. In subset mode, restricted to the
      // selected workers.
      prisma.workerWorkday.findMany({
        where: {
          workdayDate: todayStr,
          endedAt: null,
          ...(isSubset ? { userId: { in: subsetIds } } : {}),
        },
        select: {
          id: true,
          userId: true,
          startedAt: true,
          pausedAt: true,
          totalPausedMs: true,
          user: { select: { displayName: true, email: true } },
        },
        orderBy: { startedAt: "asc" },
        take: 25,
      }),
    ]);

    const todayPotentialAmount = (todayJobs as any[]).reduce((s, o) => s + totalWorkerPayouts(o), 0);
    const todayEarnedAmount = (todayCompletedJobs as any[]).reduce((s, o) => s + totalWorkerPayouts(o), 0);
    const tomorrowUnclaimedCount = tomorrowUnclaimedJobs.length;
    const tomorrowUnclaimedPotential = (tomorrowUnclaimedJobs as any[]).reduce((s: number, o: any) => {
      // Solo claim assumption: net × (1 − contractor pct).
      const base = o.price ?? o.proposalAmount ?? 0;
      const addonsTotal = (o.addons ?? []).reduce((sum: number, a: any) => sum + (a.price ?? 0), 0);
      const displayPrice = base + addonsTotal;
      if (displayPrice <= 0) return s;
      // Branches — see workerEarnings.ts. `o.expenses` also survived the
      // rename here only because `o` is any-typed.
      const chargesTot = (o.invoiceCharges ?? []).reduce((sum: number, e: any) => sum + (e.cost ?? 0), 0);
      const net =
        displayPrice;
      const deduction = Math.round(net * conPct) / 100;
      return s + Math.max(0, net - deduction);
    }, 0);

    const tomorrowUnconfirmedClientCount = new Set(
      (tomorrowUnconfirmedJobs as any[]).map((o) => o.job?.property?.clientId).filter((id): id is string => !!id)
    ).size;

    // Person-hours: each active assignee on a completed job contributes the full wall-clock.
    let minutesThisWeek = 0;
    for (const occ of thisWeekJobs as any[]) {
      if (!occ.startedAt || !occ.completedAt) continue;
      const ms = new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime() - (occ.totalPausedMs ?? 0);
      const wall = Math.max(0, ms / 60000);
      minutesThisWeek += wall * activeAssigneeCount(occ);
    }
    const actualWeekEarnings = (thisWeekJobs as any[]).reduce((s, o) => s + totalWorkerPayouts(o), 0);
    const weekJobCount = (thisWeekJobs as any[]).length;

    // Weekly trend (13 weeks) — distinct job count + total worker payouts
    // per week. Bucketing is Sunday-start in ET. Convert each Date to ET
    // calendar day then walk back to the Sunday-on-or-before via string
    // arithmetic so DST/server-tz doesn't shift bucket boundaries.
    const weekKey = (d: Date) => {
      const dayKey = etFormatDate(d);
      const [yy, mm, dd] = dayKey.split("-").map(Number);
      const dow = new Date(Date.UTC(yy, mm - 1, dd, 12)).getUTCDay();
      return etAddDays(dayKey, -dow);
    };
    const weeklyMap: Record<string, { count: number; earnings: number }> = {};
    const startOfWeekKey2 = etFormatDate(startOfWeek);
    const trendStartKey2 = etAddDays(startOfWeekKey2, -8 * 7);
    for (let i = 0; i < 9; i++) {
      weeklyMap[etAddDays(trendStartKey2, i * 7)] = { count: 0, earnings: 0 };
    }
    for (const occ of trendJobs as any[]) {
      if (!occ.completedAt) continue;
      const k = weekKey(new Date(occ.completedAt));
      if (!(k in weeklyMap)) continue;
      weeklyMap[k].count++;
      weeklyMap[k].earnings += totalWorkerPayouts(occ);
    }
    const weeklyCompleted = Object.entries(weeklyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([weekStart, v]) => ({ weekStart, count: v.count, earnings: Math.round(v.earnings * 100) / 100 }));

    return {
      overdue: 0, // not used in aggregate UI
      today: todayCount,
      tomorrow: tomorrowCount,
      pendingPayment,
      estimatesReady,
      followUps: remindersDueOccs.length,
      activeWork,
      todayRemaining,
      // Observer count is per-worker semantic; aggregate view doesn't expose it.
      todayObserverRemaining: 0,
      todayPotentialAmount: Math.round(todayPotentialAmount * 100) / 100,
      todayEarnedAmount: Math.round(todayEarnedAmount * 100) / 100,
      tomorrowUnclaimedCount,
      tomorrowUnclaimedPotential: Math.round(tomorrowUnclaimedPotential * 100) / 100,
      tomorrowUnconfirmedClientCount,
      equipmentCheckedOut,
      equipmentReserved,
      remindersPending: allRemindersPending,
      notices: (noticesByWorkflow as any[]).reduce((sum, g) => sum + (g._count?._all ?? 0), 0),
      noticesAnnouncements: (noticesByWorkflow as any[]).find((g) => g.workflow === "ANNOUNCEMENT")?._count?._all ?? 0,
      noticesFollowups: (noticesByWorkflow as any[]).find((g) => g.workflow === "FOLLOWUP")?._count?._all ?? 0,
      noticesEvents: (noticesByWorkflow as any[]).find((g) => g.workflow === "EVENT")?._count?._all ?? 0,
      tasksDue,
      minutesThisWeek: Math.round(minutesThisWeek),
      actualWeekEarnings: Math.round(actualWeekEarnings * 100) / 100,
      weekJobCount,
      weeklyCompleted,
      // Per-row breakdown of currently in-progress / paused work so the
      // Team Overview banner can list "X is doing job Y". Each row carries
      // just the names + ids the UI needs to render and link.
      inProgressJobs: (inProgressList as any[]).map((occ) => ({
        id: occ.id,
        startAt: occ.startAt ? occ.startAt.toISOString() : null,
        status: occ.status,
        title: occ.title ?? null,
        propertyName: occ.job?.property?.displayName ?? null,
        clientName: occ.job?.property?.client?.displayName ?? null,
        // Time-tracking fields for the row's live "elapsed" text. Null
        // startedAt means the row was manually created without a real
        // start (rare) — the UI hides the duration in that case.
        startedAt: occ.startedAt ? occ.startedAt.toISOString() : null,
        pausedAt: occ.pausedAt ? occ.pausedAt.toISOString() : null,
        totalPausedMs: occ.totalPausedMs ?? 0,
        assignees: (occ.assignees ?? []).map((a: any) => ({
          userId: a.userId,
          displayName: a.user?.displayName ?? a.user?.email ?? a.userId,
          isClaimer: a.assignedById === a.userId,
        })),
      })),
      // Per-row breakdown of work finished today (across PENDING_PAYMENT /
      // CLOSED / COMPLETED). Same shape as inProgressJobs so the UI renders
      // both panels with the same row component.
      completedTodayJobs: (completedTodayList as any[]).map((occ) => ({
        id: occ.id,
        startAt: occ.startAt ? occ.startAt.toISOString() : null,
        completedAt: occ.completedAt ? occ.completedAt.toISOString() : null,
        status: occ.status,
        title: occ.title ?? null,
        propertyName: occ.job?.property?.displayName ?? null,
        clientName: occ.job?.property?.client?.displayName ?? null,
        // Time fields for the "took Xm" duration on each row. Null
        // startedAt means we can't compute a duration — UI hides it.
        startedAt: occ.startedAt ? occ.startedAt.toISOString() : null,
        totalPausedMs: occ.totalPausedMs ?? 0,
        assignees: (occ.assignees ?? []).map((a: any) => ({
          userId: a.userId,
          displayName: a.user?.displayName ?? a.user?.email ?? a.userId,
          isClaimer: a.assignedById === a.userId,
        })),
      })),
      // Currently-on-the-clock workdays. Each row carries the fields the
      // Team Overview panel needs to compute a live-ticking active
      // duration + render a "who's on the clock" list. State is derived
      // by the UI: pausedAt set → PAUSED, else IN_PROGRESS.
      workdaysInProgress: (workdaysInProgressList as any[]).map((wd) => ({
        id: wd.id,
        userId: wd.userId,
        displayName: wd.user?.displayName ?? wd.user?.email ?? wd.userId,
        startedAt: wd.startedAt.toISOString(),
        pausedAt: wd.pausedAt ? wd.pausedAt.toISOString() : null,
        totalPausedMs: wd.totalPausedMs,
      })),
    };
  });
}
