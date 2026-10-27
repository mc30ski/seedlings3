import { ServiceError } from "../lib/errors";
import { PERSPECTIVE_HEADER } from "../lib/impersonation";
import { isFeeable } from "@repo/money";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { WORKER_TYPES, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate } from "./_shared";

export default async function timeRoutes(app: FastifyInstance) {
  const workdays = await import("../services/workdays");
  async function resolveWorkdayTarget(
    req: any,
    opts: { allowImpersonationFor: "read" | "mutate" },
  ): Promise<{ targetUserId: string; isImpersonating: boolean }> {
    const raw = req.query?.viewAsUserId;
    const target = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    if (!target || target === req.user.id) {
      return { targetUserId: req.user.id, isImpersonating: false };
    }
    const caller = await prisma.user.findUnique({
      where: { id: req.user.id },
      
    });
    // Reads need the schedule; acting on a worker's day needs the timesheet
    // Two separate questions, two entitlements. Reading somebody else's
    // time needs either; writing it needs `time.manage` alone.
    const canManageTime = callerCan(req, "time.manage");
    const canReadOthersTime = canManageTime || callerCan(req, "schedule.manage");
    if (opts.allowImpersonationFor === "read" && !canReadOthersTime) {
      throw new ServiceError("FORBIDDEN", "Admin or Super role required to view another worker's workday.", 403);
    }
    if (opts.allowImpersonationFor === "mutate" && !canManageTime) {
      throw new ServiceError("FORBIDDEN", "`time.manage` is required to act on another person's workday.", 403);
    }
    return { targetUserId: target, isImpersonating: true };
  }
  function workdayAuditContext(
    req: any,
    impersonatedUserId: string | null = null,
  ): { actorId: string; impersonatedUserId: string | null } {
    if (impersonatedUserId) {
      // viewAsUserId path — actor stays as the real authenticated user,
      // detail flags the target so the audit trail is unambiguous.
      return { actorId: req.user.id, impersonatedUserId };
    }
    // No view-as: fall back to the legacy "X-Impersonate-As" header flag
    // (the "view as role" feature). Same actorId; flag matches when set.
    const impersonationHeader = req.headers?.[PERSPECTIVE_HEADER];
    const impersonating = typeof impersonationHeader === "string" && impersonationHeader.trim().length > 0;
    return {
      actorId: req.user.id,
      impersonatedUserId: impersonating ? req.user.id : null,
    };
  }
  const workdaySvc = await import("../services/workdays");
  const { PERSPECTIVE_HEADER: WORKDAY_PERSPECTIVE_HEADER } = await import("../lib/impersonation");
  function workdayAudit(req: any): { actorId: string; impersonatedUserId: string | null } {
    const v = req.headers?.[WORKDAY_PERSPECTIVE_HEADER];
    const impersonating = typeof v === "string" && v.trim().length > 0;
    return {
      actorId: req.user.id,
      impersonatedUserId: impersonating ? req.user.id : null,
    };
  }
  const { requires, approvedUser } = makeGuards(app);
  const req_timeManage = requires("time.manage");
  const req_timeView = requires("time.view");

  // Pending-approvals summary — drives the alert badge + the
  // in-tab "pending by day" chip row. Counts only rows that are
  // actually approvable RIGHT NOW (workdayDate in the past, ended,
  // not yet approved). NEEDS_ENDING rows excluded.
  app.get("/workdays/pending-summary", req_timeView, async () => {
    return workdaySvc.pendingApprovalsSummary();
  });
  // List every worker's row for a single ET calendar day, plus the
  // "DIDN'T WORK" set. Query: ?date=YYYY-MM-DD (required).
  app.get("/workdays/by-date", req_timeView, async (req: any) => {
    const date = String(req.query?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw app.httpErrors.badRequest("date query param required (YYYY-MM-DD).");
    }
    return workdaySvc.listWorkdaysForDate(date);
  });
  // Edit a workday's recorded times (works for open, pending, and
  // approved rows — see editWorkdayTimesForReview for the per-state policy).
  // `allowSameDay` mirrors the approve route — when true, lets the edit
  // through even on a workday whose approval window hasn't opened yet
  // (so the operator can correct same-day times in the Review dialog
  // before clicking Approve).
  app.patch("/workdays/:id", req_timeManage, async (req: any) => {
    const body = (req.body || {}) as {
      startedAt?: string | null;
      endedAt?: string | null;
      totalPausedMs?: number | null;
      allowSameDay?: boolean;
    };
    return workdaySvc.editWorkdayTimesForReview(
      String(req.params.id),
      {
        startedAt: body.startedAt ?? null,
        endedAt: body.endedAt ?? null,
        totalPausedMs: body.totalPausedMs ?? null,
        allowSameDay: !!body.allowSameDay,
      },
      workdayAudit(req),
    );
  });
  // Approve (with optional edits in the same call). Refuses if row is
  // still open — must include an endedAt in the body or call PATCH first.
  // `allowSameDay: true` bypasses the 4 AM ET cutoff so an operator can
  // approve a workday on the same calendar day the worker finished it.
  // The UI prompts a double-confirm (typed-input ConfirmDialog) before
  // sending; the bypass is audited via `sameDayBypass: true` in the
  // WORKDAY.APPROVED audit row.
  app.post("/workdays/:id/approve", req_timeManage, async (req: any) => {
    const body = (req.body || {}) as {
      startedAt?: string | null;
      endedAt?: string | null;
      totalPausedMs?: number | null;
      allowSameDay?: boolean;
    };
    return workdaySvc.approveWorkday(
      String(req.params.id),
      {
        startedAt: body.startedAt ?? null,
        endedAt: body.endedAt ?? null,
        totalPausedMs: body.totalPausedMs ?? null,
        allowSameDay: !!body.allowSameDay,
      },
      workdayAudit(req),
    );
  });
  app.post("/workdays/:id/unapprove", req_timeManage, async (req: any) => {
    return workdaySvc.unapproveWorkday(
      String(req.params.id),
      workdayAudit(req),
    );
  });
  // Bulk approve — per-row results. Body: { workdayIds, allowSameDay? }
  app.post("/workdays/bulk-approve", req_timeManage, async (req: any) => {
    const body = (req.body || {}) as { workdayIds?: string[]; allowSameDay?: boolean };
    const ids = Array.isArray(body.workdayIds) ? body.workdayIds : [];
    if (ids.length === 0) {
      throw app.httpErrors.badRequest("workdayIds array required.");
    }
    return workdaySvc.bulkApprove(ids, workdayAudit(req), {
      allowSameDay: !!body.allowSameDay,
    });
  });
  // Backfill workday — Workdays "Didn't work" section calls
  // this when a worker forgot to clock in for a past date. Required
  // body: userId, workdayDate (YYYY-MM-DD ET), startedAt; optional
  // endedAt, totalPausedMs. See createWorkdayFor.
  app.post("/workdays/create", req_timeManage, async (req: any) => {
    const body = (req.body || {}) as {
      userId?: string;
      workdayDate?: string;
      startedAt?: string | null;
      endedAt?: string | null;
      totalPausedMs?: number | null;
    };
    const userId = String(body.userId ?? "");
    const workdayDate = String(body.workdayDate ?? "");
    if (!userId) throw app.httpErrors.badRequest("userId required.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workdayDate)) {
      throw app.httpErrors.badRequest("workdayDate must be YYYY-MM-DD.");
    }
    return workdaySvc.createWorkdayFor(
      userId,
      workdayDate,
      {
        startedAt: body.startedAt ?? null,
        endedAt: body.endedAt ?? null,
        totalPausedMs: body.totalPausedMs ?? null,
      },
      workdayAudit(req),
    );
  });
  // Mileage-entry admin edit + approval endpoints.
  app.patch("/mileage/:id", req_timeManage, async (req: any) => {
    const { editEntryAsManager } = await import("../services/mileage");
    const b = req.body ?? {};
    const actorUserId = await currentUserId(req);
    return editEntryAsManager(req.params.id, {
      startOdometer: b.startOdometer != null ? Number(b.startOdometer) : undefined,
      endOdometer: b.endOdometer != null ? Number(b.endOdometer) : undefined,
      notes: b.notes,
      startedAt: b.startedAt ? new Date(b.startedAt) : undefined,
      endedAt: b.endedAt === null ? null : b.endedAt ? new Date(b.endedAt) : undefined,
    }, actorUserId);
  });
  app.post("/mileage/:id/approve", req_timeManage, async (req: any) => {
    const { approveEntry } = await import("../services/mileage");
    const approverId = await currentUserId(req);
    return approveEntry(req.params.id, approverId);
  });
  app.post("/mileage/:id/unapprove", req_timeManage, async (req: any) => {
    const { unapproveEntry } = await import("../services/mileage");
    // Unapproving CLEARS approvedById — without the actor here, the only
    // record of who undid an approval would be lost too.
    return unapproveEntry(req.params.id, await currentUserId(req));
  });
  // Reject / discard a pending mileage entry. Hard-deletes the row.
  // `time.manage`; refuses already-approved entries (unapprove first).
  // Feeds the Review dialog's Reject button for "this session shouldn't
  // count" — wrong vehicle left open, tester noise, etc.
  app.post("/mileage/:id/reject", req_timeManage, async (req: any) => {
    const { rejectEntry } = await import("../services/mileage");
    // Hard-deletes the worker's recorded miles — name the actor.
    return rejectEntry(req.params.id, await currentUserId(req));
  });
  // Pending-mileage summary — parallel to /workdays/pending-summary.
  // Consumed by the title-bar combined count and by the "expand this
  // date" fan-out on the Tasks page.
  app.get("/mileage/pending-summary", req_timeView, async () => {
    const { pendingMileageSummary } = await import("../services/mileage");
    return pendingMileageSummary();
  });
  // Per-user mileage entries for one ET calendar date. Renders inline
  // on each worker × day row in WorkdaysTab / PendingWorkdaysSection
  // so the operator sees hours + mileage side-by-side.
  app.get("/mileage/by-date", req_timeView, async (req: any) => {
    const date = String(req.query?.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw app.httpErrors.badRequest("date query param required (YYYY-MM-DD).");
    }
    const { listMileageForDate } = await import("../services/mileage");
    return listMileageForDate(date);
  });
  // Unified daily approval — approves every closed unapproved entry
  // for one worker on one ET date. Called by the daily-approval UX
  // alongside the workday-hours approval.
  app.post("/mileage/approve-day", req_timeManage, async (req: any) => {
    const { approveWorkerDay } = await import("../services/mileage");
    const approverId = await currentUserId(req);
    const b = req.body ?? {};
    const userId = String(b.userId ?? "");
    const entryDate = String(b.entryDate ?? "");
    if (!userId) throw app.httpErrors.badRequest("userId is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      throw app.httpErrors.badRequest("entryDate must be YYYY-MM-DD");
    }
    return approveWorkerDay(userId, entryDate, approverId);
  });
  // view-as-allow: approximate-hourly-pay rollup for the Worker Home
  // "Approximate pay per hour" card.
  //
  // Math (deliberately simple — this is a labeled ESTIMATE, not payroll):
  //
  //   For every completed STANDARD / ONE_OFF job in the window where
  //   the caller was on the crew as a non-observer:
  //     projected  =  (price - expenses) × my_crew_share × (1 - rate%)
  //     dollars   +=  projected
  //     jobs      +=  1
  //   hours = sum(workday active-minutes in the window)
  //   $/hr  = dollars / hours   (0 when no hours logged)
  //
  //   my_crew_share:
  //     • use completionSplits[userId].percent if set at completion, else
  //     • even split among non-observer assignees on the occurrence.
  //   rate%:
  //     • CONTRACTOR      → CONTRACTOR_PLATFORM_FEE_PERCENT
  //     • all other types → EMPLOYEE_BUSINESS_MARGIN_PERCENT
  //
  // NOT special-cased for owners (User.isOwner) — an owner tagging
  // along as observer shouldn't have that job count, and an owner on a
  // 4-person crew should see their 25% share, not 100%. Prior versions
  // of this endpoint force-injected `assumeSoloClaim: true` for owners,
  // which inflated crew-job earnings 2-4x — don't reintroduce it.
  //
  // Excluded jobs:
  //   • workflows other than STANDARD / ONE_OFF (estimates, tasks,
  //     reminders, events, followups, announcements)
  //   • status CANCELED / ARCHIVED
  //   • completedAt outside the window (or null)
  //   • jobs where the caller isn't a non-observer assignee
  //   • jobs whose Payment is `skippedAt != null` (marked them
  //     "pretended never happened" — they don't exist for reporting)
  //
  // View-as: `?viewAsUserId=<id>` lets a `people.manage` holder see any
  // person's card as they see it (used by the Home "View as" picker). The
  // check is in the handler below — this route is `approvedUser`.
  app.get("/me/hourly-pay", approvedUser, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid },
        
      });
      const canManagePeople = callerCan(req, "people.manage");
      if (!canManagePeople) throw app.httpErrors.forbidden("Viewing another worker's pay requires people authority.");
      uid = viewAsUserId;
    }

    // Two ways to specify the window:
    //   • preset=today       → ET midnight today → now (partial day)
    //   • preset=yesterday   → yesterday's full ET calendar day (midnight to
    //                          midnight, exclusive of today)
    //   • days=N             → rolling N × 24h window ending "now"
    // The rolling-window flow is unchanged; the presets are calendar-day
    // anchored so the labels match what the operator sees on their
    // physical calendar (which is what they mean when they say
    // "yesterday" or "today"). Without the presets, days=1 was labeled
    // "yesterday" but actually spanned "now - 24h → now", which
    // includes today's jobs — hence the mislabel.
    const preset = String(req.query?.preset ?? "").toLowerCase();
    const now = new Date();
    let start: Date;
    let end: Date = now;
    if (preset === "today") {
      start = etMidnight(etToday());
      // end stays "now" — today is inherently a partial window.
    } else if (preset === "yesterday") {
      const y = etAddDays(etToday(), -1);
      start = etMidnight(y);
      end = etMidnight(etToday()); // strict boundary: excludes today
    } else {
      const daysParam = req.query?.days ? Number(req.query.days) : 30;
      const days = daysParam > 0 ? Math.min(3650, Math.max(1, Math.floor(daysParam))) : 0;
      // ANCHORED ON ET MIDNIGHT, not `now - N×24h`.
      //
      // The numerator and denominator are filtered on different columns —
      // jobs on `completedAt`, workdays on `startedAt` — and for the same
      // day's work the clock-in is hours EARLIER than the completion. An
      // hour-rolling boundary sweeps mid-afternoon, so it passes the
      // workday first and the job second. In the gap between the two the
      // window holds a day's earnings WITHOUT the hours that earned
      // them, and the rate spikes before crashing back:
      //
      //   12:10  3 jobs $155.75 17.00h  $9.16/hr   ← hours aged out
      //   14:10  2 jobs  $96.25 17.00h  $5.66/hr   ← job aged out
      //
      // A midnight boundary lands where neither a clock-in nor a
      // completion sits, so the pair ages out together and the figure
      // steps once, cleanly, at the start of the day:
      //
      //   00:00  2 jobs  $96.25 17.00h  $5.66/hr   ← both aged out
      //
      // This also makes `days=N` consistent with the `today` /
      // `yesterday` presets above, which were already ET-midnight
      // anchored for the same reason: a window that disagrees with the
      // operator's calendar reads as a bug.
      //
      // The window is [midnight N days back, now] — N whole calendar
      // days plus today so far, rather than N×24h ending mid-afternoon.
      start = days > 0 ? etMidnight(etAddDays(etToday(), -(days - 1))) : new Date(0);
    }

    const cutoff = await resolveCutoff(req);
    const effectiveStart = cutoff && cutoff > start ? cutoff : start;
    const effectiveEnd = end;

    const me = await prisma.user.findUnique({
      where: { id: uid },
      select: { workerType: true },
    });
    const isContractor = isFeeable(me?.workerType);

    const [marginSetting, feeSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } }),
      prisma.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } }),
    ]);
    const employeeMarginPct = Number(marginSetting?.value ?? 0);
    const contractorFeePct = Number(feeSetting?.value ?? 0);
    const projectionRatePct = rateForProjection(me?.workerType, {
      contractorFeePercent: contractorFeePct,
      employeeMarginPercent: employeeMarginPct,
    });

    // Hours — active minutes from workdays in the window.
    //
    // Deliberately workday-only (not augmented by job times) — workers
    // legitimately do drive time, prep, admin, restock etc. that isn't
    // on any single job. Payroll pays them for the clocked window. If a
    // worker's workday is shorter than their jobs (they started/edited
    // jobs outside the workday), the Workday Review flow is where that
    // gets fixed — either the workday gets extended, or the job times
    // get corrected.
    //
    // IN-PROGRESS WORKDAYS COUNT (changed 2026-08-27). This used to
    // require `endedAt != null`, which meant a worker four hours into a
    // shift contributed zero hours — so a "today" window showed no rate
    // at all until they clocked out. `/workers/earnings-today`
    // already counted them, and the two endpoints powered two panels
    // sitting on the same page showing different numbers for the same
    // worker. That disagreement was the bug; this is the side that was
    // wrong.
    //
    // Window membership is by START, matching `workdayDate` semantics on
    // the other endpoint: a workday belongs to the day it began.
    const workdays = await prisma.workerWorkday.findMany({
      where: {
        userId: uid,
        startedAt: { gte: effectiveStart, lte: effectiveEnd },
      },
      select: { startedAt: true, endedAt: true, pausedAt: true, totalPausedMs: true },
    });
    const nowMs = Date.now();
    let activeMs = 0;
    for (const w of workdays) {
      // Endpoint for the interval — identical rule to earnings-today:
      //   • ended            → endedAt (day is closed)
      //   • open, not paused → now (still ticking)
      //   • open, paused     → pausedAt (frozen; the open pause segment
      //     isn't in totalPausedMs yet, so clip rather than double-count)
      const rawEnd = w.endedAt
        ? w.endedAt.getTime()
        : w.pausedAt
          ? w.pausedAt.getTime()
          : nowMs;
      // Never let an open workday run past the requested window.
      const endMs = Math.min(rawEnd, effectiveEnd.getTime());
      const active = Math.max(0, endMs - w.startedAt.getTime() - w.totalPausedMs);
      activeMs += active;
    }
    const hours = activeMs / 3_600_000;

    // Optional per-item breakdown for the card's "how was this
    // calculated?" expander. Off by default to keep the initial load
    // small — expensive fields (property include, per-workday rows)
    // only get selected when the client asks.
    const wantDetails = (req.query?.details as string | undefined) === "1";

    // Dollars — projected across every qualifying job.
    const occs = await prisma.jobOccurrence.findMany({
      where: {
        assignees: {
          some: { userId: uid, OR: [{ role: null }, { role: { not: "observer" } }] },
        },
        workflow: { in: ["STANDARD", "ONE_OFF"] as any },
        status: { notIn: ["CANCELED", "ARCHIVED"] as any },
        completedAt: { gte: effectiveStart, lte: effectiveEnd },
        // Exclude Skipped payments — they don't count anywhere.
        OR: [{ payment: null }, { payment: { skippedAt: null } }],
      },
      select: {
        id: true,
        completedAt: true,
        title: true,
        price: true,
        proposalAmount: true,
        completionSplits: true,
        addons: { select: { price: true } },
        invoiceCharges: { select: { cost: true } },
        assignees: { select: { userId: true, role: true } },
        // Always selected — the extra columns are cheap and keeping the
        // select shape static makes Prisma's generic typing tractable.
        // Only surfaced in the response when `?details=1`.
        jobTags: true,
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
      },
      orderBy: { completedAt: "desc" },
    });
    const { computeMyOccurrenceNet } = await import("../services/workerEarnings");
    let dollars = 0;

    // Per-job breakdown rows (only populated when details=1). Mirrors
    // the exact math computeMyOccurrenceNet runs so the card can show
    // the user how each number was derived.
    const breakdownJobs: Array<{
      id: string;
      completedAt: string | null;
      label: string;
      clientName: string | null;
      tags: string[];
      basePrice: number;
      addonsTotal: number;
      invoiceChargesTotal: number;
      net: number;
      myPercent: number;
      shareSource: "completionSplits" | "even-split" | "none";
      grossShare: number;
      feeAmount: number;
      projected: number;
    }> = [];

    for (const occ of occs) {
      const value = computeMyOccurrenceNet(
        {
          price: occ.price,
          proposalAmount: occ.proposalAmount,
          completionSplits: occ.completionSplits,
          addons: occ.addons,
          invoiceCharges: occ.invoiceCharges,
          assignees: occ.assignees,
          payment: null, // force projection path — this is an ESTIMATE
        },
        uid,
        projectionRatePct,
      );
      dollars += value;

      if (wantDetails) {
        const basePrice = (occ.price ?? occ.proposalAmount ?? 0);
        const addonsTotal = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
        const displayPrice = basePrice + addonsTotal;
        // Materials are billed on top and never enter the pool — see
        // workerEarnings.ts.
        const chargesTotal2 = (occ.invoiceCharges ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
        const net = displayPrice;

        // Re-derive myPercent so we can show the user which source we
        // used and what number was applied — mirrors the helper's
        // branch order.
        let myPercent = 0;
        let shareSource: "completionSplits" | "even-split" | "none" = "none";
        const cs = occ.completionSplits as Array<{ userId: string; percent: number }> | null | undefined;
        if (Array.isArray(cs) && cs.length > 0) {
          const mine = cs.find((s) => s.userId === uid);
          myPercent = Number(mine?.percent ?? 0);
          shareSource = "completionSplits";
        } else {
          const active = (occ.assignees ?? []).filter((a) => a.role !== "observer");
          if (active.some((a) => a.userId === uid) && active.length > 0) {
            myPercent = 100 / active.length;
            shareSource = "even-split";
          }
        }
        const grossShare = net * (myPercent / 100);
        const feeAmount = grossShare * (projectionRatePct / 100);

        const propertyName = (occ as any).job?.property?.displayName ?? null;
        const clientName = (occ as any).job?.property?.client?.displayName ?? null;
        const label = propertyName ?? occ.title ?? "(untitled)";

        // jobTags is a JSON-string array on the occurrence, e.g.
        // '["MOW","TRIM","BLOW"]'. Parse defensively — anything malformed
        // becomes an empty list rather than a render crash.
        let tags: string[] = [];
        const rawTags = (occ as any).jobTags;
        if (typeof rawTags === "string" && rawTags.trim().length > 0) {
          try {
            const parsed = JSON.parse(rawTags);
            if (Array.isArray(parsed)) {
              tags = parsed.filter((t): t is string => typeof t === "string");
            }
          } catch { /* ignore malformed tag payloads */ }
        }

        breakdownJobs.push({
          id: occ.id,
          completedAt: occ.completedAt ? occ.completedAt.toISOString() : null,
          label,
          clientName,
          tags,
          basePrice,
          addonsTotal,
          invoiceChargesTotal: chargesTotal2,
          net,
          myPercent,
          shareSource,
          grossShare,
          feeAmount,
          projected: value,
        });
      }
    }
    const jobs = occs.length;

    // Per-workday breakdown rows (only populated when details=1).
    const breakdownWorkdays: Array<{
      startedAt: string;
      endedAt: string;
      pausedMs: number;
      activeMs: number;
    }> = [];
    if (wantDetails) {
      for (const w of workdays) {
        const wallClock = w.endedAt!.getTime() - w.startedAt.getTime();
        const active = Math.max(0, wallClock - w.totalPausedMs);
        breakdownWorkdays.push({
          startedAt: w.startedAt.toISOString(),
          endedAt: w.endedAt!.toISOString(),
          pausedMs: w.totalPausedMs,
          activeMs: active,
        });
      }
      // Newest first for display parity with the jobs list.
      breakdownWorkdays.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    }

    const ratePerHour = hours > 0 ? dollars / hours : 0;
    // Report the effective window in days (rounded up) so legacy
    // consumers of the `days` field still get a sensible number.
    // Preset presets → 1 day (they're calendar-day-scoped).
    const effectiveDays = preset === "today" || preset === "yesterday"
      ? 1
      // date-handling-allow: elapsed-time — coarse day count for a
      // display field; DST-shift precision doesn't matter.
      : Math.max(1, Math.ceil((effectiveEnd.getTime() - effectiveStart.getTime()) / (24 * 60 * 60 * 1000)));
    return {
      dollars: Math.round(dollars * 100) / 100,
      hours: Math.round(hours * 100) / 100,
      jobs,
      ratePerHour: Math.round(ratePerHour * 100) / 100,
      days: effectiveDays,
      ...(wantDetails
        ? {
            details: {
              ratePct: projectionRatePct,
              rateLabel: isContractor
                ? "Contractor platform fee"
                : "Employee business margin",
              jobs: breakdownJobs,
              workdays: breakdownWorkdays,
              // The window this figure covers, as ET date keys. Surfaced
              // because "last month" is ambiguous until you can see the
              // boundary — and the boundary is what makes the number
              // move on a day with no work at all, as things age out of
              // it. Both the jobs and the hours above use exactly this
              // range; that they share one boundary is the whole reason
              // the rate no longer spikes mid-afternoon.
              windowStart: etFormatDate(effectiveStart),
              windowEnd: etFormatDate(effectiveEnd),
            },
          }
        : {}),
    };
  });
  // Today's workday + the per-day blocking checks the UI needs to render
  // the Hero strip and the End dialog. Single endpoint so the Hero only
  // pays one round-trip.
  app.get("/me/workday/today", approvedUser, async (req: any) => {
    const { targetUserId } = await resolveWorkdayTarget(req, { allowImpersonationFor: "read" });
    const { listOpenEntriesForUser } = await import("../services/mileage");
    const [state, activeJobs, activeCheckouts, openPrior, todayJobs, openMileage] = await Promise.all([
      workdays.getTodayWorkday(targetUserId),
      workdays.checkBlockingActiveJobs(targetUserId),
      workdays.checkActiveEquipmentCheckouts(targetUserId),
      workdays.listMyOpenWorkdays(targetUserId),
      workdays.getTodayJobCounts(targetUserId),
      listOpenEntriesForUser(targetUserId),
    ]);
    // Shape open mileage entries into a compact summary — enough for
    // the End Workday dialog's inline "record ending odometer for
    // each vehicle you're still driving" section.
    const openMileageEntries = openMileage.map((e) => ({
      id: e.id,
      vehicleId: e.vehicleId,
      vehicleName: e.vehicle.displayName,
      startedAt: e.startedAt.toISOString(),
      startOdometer: e.startOdometer,
    }));
    return {
      today: state,
      activeJobs,
      activeCheckouts,
      openPrior,
      todayJobs,
      openMileageEntries,
    };
  });
  // Standalone open-prior list — used when the UI just needs to know
  // whether to surface the "you forgot to end yesterday" prompt without
  // re-pulling today's state.
  app.get("/me/workday/open-prior", approvedUser, async (req: any) => {
    const { targetUserId } = await resolveWorkdayTarget(req, { allowImpersonationFor: "read" });
    return { openPrior: await workdays.listMyOpenWorkdays(targetUserId) };
  });
  app.post("/me/workday/start", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    const body = (req.body || {}) as { startedAt?: string };
    return workdays.startWorkday(
      targetUserId,
      { startedAt: body.startedAt ?? null },
      workdayAuditContext(req, isImpersonating ? targetUserId : null),
    );
  });
  app.post("/me/workday/pause", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.pauseWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });
  app.post("/me/workday/resume", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.resumeWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });
  // Re-open today's workday after it was ended (typically by mistake).
  // The gap between the bad endedAt and now is added to totalPausedMs
  // so payable hours don't include the off-the-clock interval. Refused
  // once the same-day edit window has closed or if the row has been
  // approved — see services/workdays.ts reopenWorkday.
  app.post("/me/workday/reopen", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.reopenWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });
  // Cancel today's workday — hard-deletes the row. Used when the worker
  // tapped Start by accident. Refused if the row is already COMPLETED.
  // POST (not DELETE) so the action stays consistent with the other
  // workday verb endpoints and so the body can carry an optional reason
  // later if we want to capture one.
  app.post("/me/workday/cancel", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.cancelWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });
  // End today's workday OR a prior open workday (forgot-yesterday flow).
  // Optional `workdayId` selects the prior row; without it, the service
  // defaults to today's row.
  app.post("/me/workday/end", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    const body = (req.body || {}) as {
      workdayId?: string;
      startedAt?: string;
      endedAt?: string;
      totalPausedMs?: number;
    };
    return workdays.endWorkday(
      targetUserId,
      {
        workdayId: body.workdayId ?? null,
        startedAt: body.startedAt ?? null,
        endedAt: body.endedAt ?? null,
        totalPausedMs: body.totalPausedMs ?? null,
      },
      workdayAuditContext(req, isImpersonating ? targetUserId : null),
    );
  });
  // Same-day post-end edit. Service validates the workdayDate still
  // matches today (per the same-day correction window).
  app.patch("/me/workday/:id", approvedUser, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    const body = (req.body || {}) as {
      startedAt?: string;
      endedAt?: string;
      totalPausedMs?: number;
    };
    return workdays.editOwnWorkdayTimes(
      targetUserId,
      String(req.params.id),
      {
        startedAt: body.startedAt ?? null,
        endedAt: body.endedAt ?? null,
        totalPausedMs: body.totalPausedMs ?? null,
      },
      workdayAuditContext(req, isImpersonating ? targetUserId : null),
    );
  });
  // view-as-allow: caller's own currently-open mileage sessions. Feeds
  // the MileageStrip and the End-workday dialog's "close open sessions"
  // prompt — both self-service surfaces.
  app.get("/me/mileage/open", approvedUser, async (req: any) => {
    const { listOpenEntriesForUser } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    return listOpenEntriesForUser(uid);
  });
  // view-as-allow: caller's own mileage-entry list. Admin's cross-worker
  // mileage view uses /mileage instead.
  app.get("/me/mileage", approvedUser, async (req: any) => {
    const { listEntriesForUser } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    const fromDate = req.query?.from ? String(req.query.from) : undefined;
    const toDate = req.query?.to ? String(req.query.to) : undefined;
    return listEntriesForUser(uid, { fromDate, toDate });
  });
  app.post("/me/mileage/start", approvedUser, async (req: any) => {
    const { startEntry } = await import("../services/mileage");
    const { userCanLogAgainstVehicle } = await import("../services/vehicles");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    const b = req.body ?? {};
    const vehicleId = String(b.vehicleId ?? "");
    if (!vehicleId) throw app.httpErrors.badRequest("vehicleId is required");
    const allowed = await userCanLogAgainstVehicle(uid, vehicleId);
    if (!allowed) throw app.httpErrors.forbidden("You're not assigned to this vehicle.");
    return startEntry({
      vehicleId,
      driverUserId: uid,
      startOdometer: Number(b.startOdometer),
      startedAt: b.startedAt ? new Date(b.startedAt) : undefined,
    });
  });
  app.post("/me/mileage/:id/stop", approvedUser, async (req: any) => {
    const { finalizeEntry } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    const entry = await prisma.mileageEntry.findUnique({
      where: { id: req.params.id },
      select: { driverUserId: true },
    });
    if (!entry) throw app.httpErrors.notFound("Mileage entry not found.");
    if (entry.driverUserId !== uid) {
      throw app.httpErrors.forbidden("Not your mileage entry.");
    }
    const b = req.body ?? {};
    return finalizeEntry({
      entryId: req.params.id,
      endOdometer: Number(b.endOdometer),
      endedAt: b.endedAt ? new Date(b.endedAt) : undefined,
      notes: b.notes ?? null,
    });
  });
  app.post("/me/mileage/:id/cancel", approvedUser, async (req: any) => {
    const { cancelEntry } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    const entry = await prisma.mileageEntry.findUnique({
      where: { id: req.params.id },
      select: { driverUserId: true },
    });
    if (!entry) throw app.httpErrors.notFound("Mileage entry not found.");
    if (entry.driverUserId !== uid) {
      throw app.httpErrors.forbidden("Not your mileage entry.");
    }
    return cancelEntry(req.params.id);
  });
  app.patch("/me/mileage/:id", approvedUser, async (req: any) => {
    const { editEntryByDriver } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    const b = req.body ?? {};
    return editEntryByDriver(req.params.id, uid, {
      startOdometer: b.startOdometer != null ? Number(b.startOdometer) : undefined,
      endOdometer: b.endOdometer != null ? Number(b.endOdometer) : undefined,
      notes: b.notes,
    });
  });

}
