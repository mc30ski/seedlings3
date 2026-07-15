import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { getUploadUrl, getDownloadUrl, deleteObject } from "../lib/r2";
import { etMidnight, etEndOfDay, etToday, etTomorrow, etAddDays, etFormatDate, etDaysBetween } from "../lib/dates";
import { Role as RoleVal, JobOccurrenceStatus } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { persistCompletionSplits, wasUserInGuaranteedPayoutAt } from "../services/payments";
import { evaluateHoursApproval, loadHoursApprovalVarianceThreshold } from "../services/jobs";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { loadGpWorkAnchoredItems } from "../services/exports";
import {
  resolveCutoff,
  cutoffWhere,
  paymentSplitCutoffWhere,
  paymentIncludeWithCutoff,
  expensesIncludeWithCutoff,
  occurrenceWorkDateCutoff,
} from "../lib/businessStartCutoff";
import { redactObserverFieldsForCaller, redactTraineeFieldsForCaller, redactPeekFieldsForCaller } from "../lib/observerRedaction";

async function currentUserId(req: any) {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

// Whether a claimer can still edit a job's billables (expenses, add-on
// services). Editable through completion and while the occurrence sits in
// PENDING_PAYMENT *before* payment is committed — claimers reconcile the
// evening before sending the client their payment request. Locks once a
// payment request was sent (paymentRequestSentAt) or a payment was
// recorded/accepted (a Payment row exists). CLOSED/terminal are frozen.
function occInEditableState(occ: {
  status: string;
  payment?: { id: string } | null;
  paymentRequestSentAt?: Date | null;
}): boolean {
  switch (occ.status) {
    case "SCHEDULED":
    case "IN_PROGRESS":
    case "PAUSED":
    case "COMPLETED":
      return true;
    case "PENDING_PAYMENT":
      return !occ.payment && !occ.paymentRequestSentAt;
    default:
      return false;
  }
}

export default async function workerRoutes(app: FastifyInstance) {
  const workerGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.WORKER),
  };

  // Dashboard summary — single endpoint for all badge counts.
  // Admins can pass ?viewAsUserId=<id> to compute the summary for another worker
  // (used by the Admin Home view to inspect what each worker is seeing).
  app.get("/dashboard-summary", workerGuard, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({ where: { id: callerUid }, include: { roles: true } });
      const isAdmin = caller?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only admins can view another worker's dashboard.");
      uid = viewAsUserId;
    }
    // Determine whether the effective dashboard user (after viewAsUserId
    // override) has the ADMIN or SUPER role. Drives whether Timeline
    // events (workflow=EVENT) appear in the Notices tile + count below.
    // Events are an admin-only concept; non-admin workers must never see
    // them in their dashboard or feed. An admin viewing-as a non-admin
    // gets the non-admin's experience, including no event count.
    const effectiveUserRoles = uid === callerUid
      ? (await prisma.user.findUnique({ where: { id: uid }, select: { roles: { select: { role: true } } } }))?.roles ?? []
      : (await prisma.userRole.findMany({ where: { userId: uid }, select: { role: true } }));
    const effectiveIsAdmin = effectiveUserRoles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
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
          // tile per the Business Start Date design. Super can toggle the
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid, guaranteedPayoutPaidAt: null },
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
          // Timeline events (workflow=EVENT) are admin-only — non-admins
          // never see them in the Notices tile or count. Admins still get
          // the full set including events.
          workflow: { in: (effectiveIsAdmin
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid, guaranteedPayoutPaidAt: null },
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid, guaranteedPayoutPaidAt: null },
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
          isAdminOnly: false,
          assignees: { none: {} },
        },
        select: {
          price: true,
          proposalAmount: true,
          addons: { select: { price: true } },
          expenses: { select: { cost: true } },
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid, guaranteedPayoutPaidAt: null },
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
    const isEmp = meUser?.workerType === "EMPLOYEE" || meUser?.workerType === "TRAINEE";
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
    //   • Employee / trainee — WORK-anchored. Promised net for jobs they
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
          payment: {
            select: {
              confirmed: true,
              writtenOff: true,
              skippedAt: true,
              splits: {
                where: { userId: uid, guaranteedPayoutPaidAt: null },
                select: { amount: true },
              },
            },
          },
        },
      });
      actualWeekEarnings = empJobs.reduce((sum, occ) => sum + computeMyOccurrenceNet(occ, uid, pct), 0);
      weekJobCount = empJobs.length;
    } else {
      // Contractor weekly earnings = post-GP splits + GP-period
      // work-anchored items, both in window. Post-GP path: confirmed
      // PaymentSplits in window, skipping those flagged as paid via
      // the wage path. GP path: pure-read computation from completed
      // occurrences during the contractor's GP window — same source
      // the Gusto Contractors CSV uses for its work-anchored half.
      const winLo = cutoff && cutoff > earnWindowStart ? cutoff : earnWindowStart;
      const mySplits = await prisma.paymentSplit.findMany({
        where: {
          userId: uid,
          guaranteedPayoutPaidAt: null,
          payment: { createdAt: { gte: winLo, lt: todayMidnight }, skippedAt: null },
        },
        select: { amount: true },
      });
      const myGpItems = await loadGpWorkAnchoredItems(winLo, todayMidnight, { userId: uid });
      actualWeekEarnings =
        mySplits.reduce((sum, sp) => sum + sp.amount, 0) +
        myGpItems.reduce((sum, i) => sum + i.amount, 0);
      weekJobCount = mySplits.length + myGpItems.length;
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

  // Company-wide aggregate dashboard. Used by AdminHomeTab when no worker is selected.
  // Mirrors the per-worker /dashboard-summary shape (so the same Summary type works on
  // the frontend), but every value is computed across the entire team — no myOccIds
  // restriction. Money figures are total worker payouts (sum across active assignees,
  // each weighted by their workerType's fee/margin). Hours are person-hours (each
  // assignee on a multi-worker job contributes the job's full wall-clock).
  app.get("/dashboard-summary/aggregate", workerGuard, async (req: any) => {
    const callerUid = await currentUserId(req);
    const caller = await prisma.user.findUnique({ where: { id: callerUid }, include: { roles: true } });
    const isAdmin = caller?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isAdmin) throw app.httpErrors.forbidden("Only admins can view the aggregate dashboard.");

    // Optional `workerIds=id1,id2,...` parameter restricts the aggregate to a subset
    // of workers. When omitted/empty: whole-team aggregate. When populated: counts
    // include only occurrences touching at least one of those workers, and money/
    // hours sum only those workers' shares.
    const workerIdsParam = (req.query?.workerIds as string | undefined) ?? "";
    const subsetIds = workerIdsParam
      ? workerIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const isSubset = subsetIds.length > 0;
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
    const workerPct = (type: string | null | undefined) =>
      type === "EMPLOYEE" || type === "TRAINEE" ? empPct : conPct;

    // Sum of all workers' payouts for one occurrence — accounts for each assignee's
    // worker type (employee margin vs contractor fee). Returns 0 if no active workers.
    type AggOcc = {
      price: number | null;
      proposalAmount: number | null;
      addons: { price: number | null }[];
      expenses: { cost: number }[];
      assignees: { role: string | null; userId: string; user: { workerType: string | null } | null }[];
    };
    // In subset mode, only sum payouts for workers in the selected set. The share-per-
    // worker math still uses the FULL active count (so e.g. a 3-person job with 1
    // selected worker contributes one share, not the entire pool).
    function totalWorkerPayouts(occ: AggOcc): number {
      const base = occ.price ?? occ.proposalAmount ?? 0;
      const addonsTotal = (occ.addons ?? []).reduce((s, a) => s + (a.price ?? 0), 0);
      const displayPrice = base + addonsTotal;
      if (displayPrice <= 0) return 0;
      const expTotal = (occ.expenses ?? []).reduce((s, e) => s + (e.cost ?? 0), 0);
      const net = Math.max(0, displayPrice - expTotal);
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

    const moneySelect = {
      price: true,
      proposalAmount: true,
      addons: { select: { price: true } },
      expenses: { select: { cost: true } },
      assignees: { select: { role: true, userId: true, user: { select: { workerType: true } } } },
    } as const;

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
    ] = await Promise.all([
      prisma.jobOccurrence.count({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { notIn: ["CANCELED", "ARCHIVED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: "PENDING_PAYMENT" as any,
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
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
        },
      }),
      prisma.jobOccurrence.groupBy({
        by: ["workflow"],
        where: {
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: { in: ["ANNOUNCEMENT", "FOLLOWUP", "EVENT"] as any },
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          ...assigneeSubsetFilter,
        },
        _count: { _all: true },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: "TASK",
          startAt: { lt: tomorrowMidnight },
          ...assigneeSubsetFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          status: { in: ["IN_PROGRESS", "PAUSED"] as any },
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
        },
      }),
      prisma.jobOccurrence.count({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS", "PAUSED"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
        },
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["SCHEDULED", "IN_PROGRESS"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
        },
        select: moneySelect,
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: todayMidnight, lt: tomorrowMidnight },
          status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
          workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] as any },
          ...assigneeSubsetFilter,
        },
        select: moneySelect,
      }),
      prisma.jobOccurrence.findMany({
        where: {
          startAt: { gte: tomorrowMidnight, lte: tomorrowEnd },
          status: "SCHEDULED" as any,
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          isAdminOnly: false,
          assignees: { none: {} },
        },
        select: { price: true, proposalAmount: true, addons: { select: { price: true } }, expenses: { select: { cost: true } } },
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
      // "jobs in progress and by who" panel on the Admin Home Team Overview.
      // Same status set as the activeWork count above; lookback bound matches
      // so we don't return stale never-completed rows from the deep past.
      prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["IN_PROGRESS", "PAUSED"] as any },
          startAt: { gte: lookbackStart },
          ...assigneeSubsetFilter,
        },
        select: {
          id: true,
          startAt: true,
          status: true,
          title: true,
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
      // today" panel under "In progress now" on the Admin Home Team
      // Overview. Same shape as inProgressList so the UI can render both
      // with the same row component.
      prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["COMPLETED", "PENDING_PAYMENT", "CLOSED"] as any },
          completedAt: { gte: todayMidnight, lt: tomorrowMidnight },
          ...assigneeSubsetFilter,
        },
        select: {
          id: true,
          startAt: true,
          completedAt: true,
          status: true,
          title: true,
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
      const expTotal = (o.expenses ?? []).reduce((sum: number, e: any) => sum + (e.cost ?? 0), 0);
      const net = Math.max(0, displayPrice - expTotal);
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
        assignees: (occ.assignees ?? []).map((a: any) => ({
          userId: a.userId,
          displayName: a.user?.displayName ?? a.user?.email ?? a.userId,
          isClaimer: a.assignedById === a.userId,
        })),
      })),
    };
  });

  app.get("/equipment/all", workerGuard, async () => {
    return services.equipment.listAllAdmin();
  });

  // Workers can see all non-retired (includes MAINTENANCE / CHECKED_OUT)
  app.get("/equipment", workerGuard, async () => {
    return services.equipment.listForWorkers();
  });

  // Workers can see what THEY currently have checked out
  app.get("/equipment/mine", workerGuard, async (req: any) => {
    return services.equipment.listMine(req.user.id);
  });

  // Equipment-usage dashboard — scoped to the requesting worker's own checkouts.
  app.get("/equipment-usage", workerGuard, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };
    const cutoff = await resolveCutoff(req);
    return services.equipment.listUsage({ from, to, userId: req.user.id, cutoff });
  });

  app.post("/equipment/:id/reserve", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    const body = (req.body || {}) as { groupId?: string | null };
    return services.equipment.reserve(
      await currentUserId(req),
      id,
      req.user.id,
      { groupId: body.groupId ?? null },
    );
  });

  app.post("/equipment/:id/reserve/cancel", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    return services.equipment.cancelReservation(
      await currentUserId(req),
      id,
      req.user.id
    );
  });

  // Enforce QR slug verification before finishing checkout
  app.post("/equipment/:id/checkout/verify", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    const slug = String(req.body?.slug ?? "").trim();
    return services.equipment.checkoutWithQr(
      await currentUserId(req),
      id,
      req.user.id,
      slug
    );
  });

  // Legacy “available” list (still fine to keep)
  app.get("/equipment/available", workerGuard, async () => {
    return services.equipment.listAvailable();
  });

  // Unavailable equipment (maintenance / reserved / checked out)
  app.get("/equipment/unavailable", workerGuard, async () =>
    services.equipment.listUnavailableWithHolder()
  );

  app.post("/equipment/:id/return/verify", workerGuard, async (req: any) => {
    const id = req.params.id as string;
    const slug = String(req.body?.slug ?? "").trim();
    return services.equipment.returnWithQr(
      await currentUserId(req),
      id,
      req.user.id,
      slug
    );
  });

  app.get("/clients", workerGuard, async (req: any) => {
    const { q, status, limit } = (req.query || {}) as {
      q?: string;
      status?: "ACTIVE" | "ARCHIVED" | "ALL";
      limit?: string;
    };
    const list = await services.clients.list({
      q,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
    });
    // Strip admin-only fields
    for (const c of list) (c as any).adminTags = undefined;
    return list;
  });

  app.get("/clients/:id", workerGuard, async (req: any) => {
    const id = String(req.params.id);
    const client = await services.clients.get(id);
    if (client) (client as any).adminTags = undefined;
    return client;
  });

  app.get("/properties", workerGuard, async (req: any) => {
    const { q, clientId, status, kind, limit } = (req.query || {}) as {
      q?: string;
      clientId?: string;
      status?: "ACTIVE" | "ARCHIVED" | "ALL";
      kind?: string | "ALL";
      limit?: string;
    };
    const props = await services.properties.list({
      q,
      clientId,
      status: status as any,
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
    });
    // Attach last 3 photos from most recent occurrence for each property
    const propIds = (Array.isArray(props) ? props : []).map((p: any) => p.id);
    if (propIds.length > 0) {
      const photos = await prisma.jobOccurrencePhoto.findMany({
        where: {
          occurrence: { job: { propertyId: { in: propIds } } },
        },
        select: {
          id: true, r2Key: true, contentType: true, createdAt: true,
          occurrence: { select: { job: { select: { propertyId: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      // Group by property, take last 3 per property. Reminders + tasks
      // can have a null `job` (no parent property), so skip those —
      // they aren't relevant to property-level photo grouping.
      const byProperty = new Map<string, any[]>();
      for (const p of photos) {
        const pid = p.occurrence.job?.propertyId;
        if (!pid) continue;
        if (!byProperty.has(pid)) byProperty.set(pid, []);
        const arr = byProperty.get(pid)!;
        if (arr.length < 3) arr.push(p);
      }
      // Generate URLs and attach
      for (const prop of (Array.isArray(props) ? props : []) as any[]) {
        const propPhotos = byProperty.get(prop.id) ?? [];
        prop.lastPhotos = await Promise.all(
          propPhotos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
    }
    return props;
  });

  app.get("/properties/:id", workerGuard, async (req: any) => {
    const id = String(req.params.id);
    return services.properties.get(id);
  });

  // Jobs (lightweight list for task association — only jobs the worker is assigned to)
  app.get("/jobs", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (isAdmin) {
      // Admins see all jobs
      return services.jobs.list({ limit: 200 });
    }
    // Workers see only jobs they are assigned to (via occurrence assignees)
    const myOccurrences = await prisma.jobOccurrence.findMany({
      where: { assignees: { some: { userId: uid } } },
      select: { jobId: true },
      distinct: ["jobId"],
    });
    const myJobIds = myOccurrences.map((o) => o.jobId).filter(Boolean) as string[];
    if (myJobIds.length === 0) return [];
    const jobs = await prisma.job.findMany({
      where: { id: { in: myJobIds } },
      include: { property: { select: { id: true, displayName: true, client: { select: { displayName: true } } } } },
      take: 200,
    });
    return jobs;
  });

  // Worker occurrence routes
  app.get("/occurrences", workerGuard, async (req: any) => {
    const { from, to, includeOccId, viewAsUserId, workerView } = (req.query || {}) as { from?: string; to?: string; includeOccId?: string; viewAsUserId?: string; workerView?: string };
    // Worker Jobs tab signals `?workerView=1` so peek redaction runs
    // even when the caller is admin/super. Admin Jobs tab omits it →
    // admins keep the unredacted view.
    const isWorkerViewRequest = workerView === "1";
    // Business Start Date cutoff is operator-only — applies to the worker /
    // admin JobsTab. Client-facing /client/jobs deliberately does not pass
    // this through (a client should always see their own service history
    // regardless of the operator's internal accounting cutoff).
    const cutoff = await resolveCutoff(req);
    const occs = await services.jobs.listAllOccurrences({ from, to, cutoff });

    // Merge pinned occurrences that fall outside the date range (not reminders — those get ghost cards)
    const callerUid = await currentUserId(req);
    // Admin override: when an admin requests jobs filtered to a specific worker (e.g.
    // from AdminHomeTab → AdminJobsTab impersonation), load that worker's pins/likes/
    // reminders/observerships instead of the admin's. Otherwise reminder ghosts and
    // attached-reminder badges would belong to the admin and miss what the worker sees.
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({ where: { id: callerUid }, include: { roles: true } });
      const isAdmin = caller?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only admins can view another worker's occurrences.");
      uid = viewAsUserId;
    }
    // Determine whether the effective user (after viewAsUserId override)
    // has admin/super privileges. Drives whether Timeline events
    // (workflow=EVENT) are included in the returned feed. Non-admins
    // never see events in their Jobs feed regardless of assignment.
    // An admin viewing-as a non-admin gets the non-admin's feed.
    const effectiveUserRoles = uid === callerUid
      ? (await prisma.user.findUnique({ where: { id: uid }, select: { roles: { select: { role: true } } } }))?.roles ?? []
      : (await prisma.userRole.findMany({ where: { userId: uid }, select: { role: true } }));
    const effectiveIsAdmin = effectiveUserRoles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    // Look up the effective user's worker classification — drives the
    // Trainee feed scope + payment-split redaction below. Trainees may
    // ONLY see occurrences they're assigned to (server-side scoping;
    // the frontend already filters, but a malicious trainee inspecting
    // network responses could see jobs they're not on without this
    // server-side guard).
    const effectiveUser = await prisma.user.findUnique({
      where: { id: uid },
      select: { workerType: true },
    });
    const effectiveIsTrainee = effectiveUser?.workerType === "TRAINEE";
    const [pins, likes, reminders, observedAssignments] = await Promise.all([
      prisma.pinnedOccurrence.findMany({ where: { userId: uid }, select: { occurrenceId: true } }),
      prisma.likedOccurrence.findMany({ where: { userId: uid }, select: { occurrenceId: true } }),
      prisma.reminder.findMany({ where: { userId: uid, dismissedAt: null }, select: { occurrenceId: true, remindAt: true, note: true } }),
      prisma.jobOccurrenceAssignee.findMany({ where: { userId: uid, role: "observer" }, select: { occurrenceId: true } }),
    ]);

    const loadedIds = new Set(occs.map((o: any) => o.id));

    // Merge pinned + liked + observed occurrences that fall outside the date range
    const extraIds = new Set<string>();
    for (const p of pins) if (!loadedIds.has(p.occurrenceId)) extraIds.add(p.occurrenceId);
    for (const l of likes) if (!loadedIds.has(l.occurrenceId)) extraIds.add(l.occurrenceId);
    for (const o of observedAssignments) if (!loadedIds.has(o.occurrenceId)) extraIds.add(o.occurrenceId);
    // Include a specific occurrence by ID (for deep links / share links)
    if (includeOccId && !loadedIds.has(includeOccId)) extraIds.add(includeOccId);

    if (extraIds.size > 0) {
      const extraOccs = await services.jobs.getOccurrencesByIds([...extraIds], cutoff);
      occs.push(...(extraOccs as any[]));
      for (const eo of extraOccs) loadedIds.add((eo as any).id);
    }

    // Attach reminder data to occurrences already in the list
    const reminderMap = new Map(reminders.map((r) => [r.occurrenceId, { remindAt: r.remindAt, note: r.note }]));
    for (const occ of occs) {
      const rem = reminderMap.get((occ as any).id);
      if (rem) (occ as any).reminder = rem;
    }

    // Build reminder ghosts: reminders whose occurrence is NOT in the loaded list
    // These will appear as ghost cards on the reminder's date
    const ghostReminderIds = reminders
      .map((r) => r.occurrenceId)
      .filter((id) => !loadedIds.has(id));

    let reminderGhosts: any[] = [];
    if (ghostReminderIds.length > 0) {
      const ghostOccs = await services.jobs.getOccurrencesByIds(ghostReminderIds, cutoff);
      reminderGhosts = ghostOccs.map((go: any) => {
        const rem = reminderMap.get(go.id);
        return { ...go, reminder: rem, _isReminderGhost: true, _ghostDate: rem?.remindAt };
      });
    }

    // Add ghost reminders to the list
    const allOccs = [...occs, ...reminderGhosts];

    // Generate download URLs for preview photos
    for (const occ of allOccs) {
      if ((occ as any).photos?.length) {
        (occ as any).photos = await Promise.all(
          (occ as any).photos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
      // Generate download URLs for property photo instructions
      if ((occ as any).propertyPhotos?.length) {
        for (const pp of (occ as any).propertyPhotos) {
          if (pp.propertyPhoto?.r2Key) {
            pp.propertyPhoto.url = await getDownloadUrl(pp.propertyPhoto.r2Key, 86400, "property-photos");
          }
        }
      }
      // Strip admin-only fields from client data
      const client = (occ as any).job?.property?.client;
      if (client) delete client.adminTags;
    }
    // Final gate: Timeline events (workflow=EVENT) are an admin-only
    // concept. Non-admin effective users never see them in the feed,
    // even if they were previously assigned/pinned/observed. The
    // dashboard-summary endpoint applies the same rule to the Notices
    // count; both must stay in sync.
    const eventFiltered = effectiveIsAdmin
      ? allOccs
      : allOccs.filter((o: any) => o.workflow !== "EVENT");

    // Trainee scope clamp: trainees see ONLY occurrences they're
    // assigned to (no unassigned/claimable, no team-feed visibility).
    // The frontend already enforces this; the server-side filter
    // protects against DevTools/network inspection.
    const filtered = effectiveIsTrainee
      ? eventFiltered.filter((o: any) => (o.assignees ?? []).some((a: any) => a.userId === uid))
      : eventFiltered;

    // Observer redaction: for occurrences where the effective user is
    // assigned as `role = "observer"`, strip payment/expense/price
    // fields. Observers see the basic job (where, when, who) so they
    // know where to show up, but never the financial detail. Admins
    // viewing as themselves see everything; an admin viewing-as a
    // non-admin observer (via viewAsUserId) gets the same redaction
    // their target would see.
    redactObserverFieldsForCaller(filtered as any[], uid, effectiveIsAdmin);
    // Trainee redaction: for non-observer Trainee callers, strip OTHER
    // workers' payment splits / completion splits / promised payouts
    // (the trainee sees only their own), plus processor fees and
    // expense costs (business-internal financial data). Order matters
    // — observer redaction is heavier and runs first; trainee
    // redaction skips occurrences already observer-redacted.
    redactTraineeFieldsForCaller(
      filtered as any[],
      uid,
      effectiveUser?.workerType,
      effectiveIsAdmin,
    );
    // Peek redaction: for the Worker Jobs "Team" toggle. Any occ that
    // has assignees but the caller isn't one of them gets financials
    // stripped (price, splits, payouts, expense costs, admin-only
    // client context). Admins are bypassed by default (Admin Jobs tab
    // needs full financials), BUT when the request comes from the
    // Worker Jobs tab (`?workerView=1`), the bypass is disabled so
    // admins-using-worker-view see the same redacted teammate data
    // any worker would.
    const peekAdminBypass = effectiveIsAdmin && !isWorkerViewRequest;
    redactPeekFieldsForCaller(filtered as any[], uid, peekAdminBypass);

    return filtered;
  });

  app.get("/occurrences/mine", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    // Admin/super users see Timeline events (workflow=EVENT) in their
    // own assigned list; non-admin workers don't. Mirrors the same gate
    // applied by /occurrences and dashboard-summary.
    const caller = await prisma.user.findUnique({
      where: { id: uid },
      include: { roles: true },
    });
    const isAdmin = !!caller?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    const occs = await services.jobs.listMyOccurrences(uid, { isAdmin });
    // Per-occurrence observer redaction — same gate as /occurrences.
    redactObserverFieldsForCaller(occs as any[], uid, isAdmin);
    // Per-occurrence trainee redaction — strip other workers' splits,
    // completion percentages, promised payouts, processor fees, and
    // expense costs. Keeps the caller's own split visible.
    redactTraineeFieldsForCaller(
      occs as any[],
      uid,
      caller?.workerType,
      isAdmin,
    );
    return occs;
  });

  app.get("/occurrences/available", workerGuard, async () => {
    return services.jobs.listAvailableOccurrences();
  });

  app.post("/occurrences/:id/claim", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = (req.body || {}) as { groupId?: string | null };
    return services.jobs.claimOccurrence(uid, String(req.params.id), {
      groupId: body.groupId ?? null,
    });
  });

  // Groups the caller can claim on behalf of (i.e. they are the claimer).
  // Used by the JobsTab Claim chooser.
  // view-as-allow: the "as-claimer" scope is inherently caller-only —
  // returns groups where the CALLER is the current claimer. Admin/Super
  // hits /admin/groups for cross-worker visibility instead.
  app.get("/me/groups-as-claimer", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.groups.listForClaimer(uid);
  });

  // view-as-allow: worker's own outstanding payment requests for the
  // planning-tab nudge. Admin sees cross-worker payment state under
  // /admin/payment-requests / /admin/payments.
  // The caller's own outstanding payment requests — sent to a client but
  // not yet paid. Powers the Planning-tab nudge so a claimer can chase a
  // request that's gone quiet.
  app.get("/me/outstanding-payment-requests", workerGuard, async (req: any) => {
    const cutoff = await resolveCutoff(req);
    return services.paymentRequests.listOutstanding({ claimerUserId: req.user.id, cutoff });
  });

  // Pre-flight check for the team-workday gate. Returns the list of
  // non-observer assignees on this occurrence (excluding the caller)
  // who don't currently have an active workday. The Start flow calls
  // this BEFORE opening the time-of-day picker so it can surface the
  // team-not-ready dialog up front — the user shouldn't have to type
  // a start time only to be rejected after submitting.
  //
  // "Active" matches the gate definition in services/jobs.ts: today's
  // WorkerWorkday exists, endedAt IS NULL, and pausedAt IS NULL.
  // Mirrors the server-side gate so the client + server agree on
  // who counts as ready.
  app.get("/occurrences/:id/team-workday-check", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const assignees = await prisma.jobOccurrenceAssignee.findMany({
      where: {
        occurrenceId,
        // NULL-role rows are canonical "regular worker"; observers
        // are excluded since they don't do the work.
        OR: [{ role: null }, { role: { not: "observer" } }],
      },
      select: {
        userId: true,
        user: { select: { displayName: true, email: true } },
      },
    });
    // Exclude the caller themselves — their own workday is gated
    // separately by `assertWorkdayActiveOrPrompt` on the client side
    // and again on /start. This check is specifically for teammates.
    const others = assignees.filter((a) => a.userId !== uid);
    if (others.length === 0) return { notReady: [] };

    const todayKey = etFormatDate(new Date());
    const workdays = await prisma.workerWorkday.findMany({
      where: {
        userId: { in: others.map((a) => a.userId) },
        workdayDate: todayKey,
      },
      select: { userId: true, endedAt: true, pausedAt: true },
    });
    const wdByUser = new Map(workdays.map((w) => [w.userId, w]));

    const notReady = others
      .filter((a) => {
        const wd = wdByUser.get(a.userId);
        // Not ready = no row OR ended OR paused.
        return !wd || wd.endedAt != null || wd.pausedAt != null;
      })
      .map((a) => ({
        userId: a.userId,
        name: a.user?.displayName ?? a.user?.email ?? "(unnamed)",
      }));

    return { notReady };
  });

  app.post("/occurrences/:id/start", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};

    // Block starting unconfirmed job occurrences (applies to STANDARD, ONE_OFF, ESTIMATE workflows)
    const occCheck = await prisma.jobOccurrence.findUnique({ where: { id: String(req.params.id) } });
    if (occCheck) {
      const needsConfirmation = !occCheck.isClientConfirmed && occCheck.jobId &&
        (occCheck.workflow === "STANDARD" || occCheck.workflow === "ONE_OFF" || occCheck.workflow === "ESTIMATE" || !occCheck.workflow);
      if (needsConfirmation) {
        throw app.httpErrors.badRequest("Client confirmation required before starting this job");
      }
    }

    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;

    // Optionally update startAt to now when starting early
    if (body.updateStartAt) {
      const now = new Date();
      const occ = await prisma.jobOccurrence.findUnique({ where: { id: String(req.params.id) } });
      if (occ) {
        // Preserve the duration: shift endAt by the same delta
        const newStart = now;
        let newEnd: Date | undefined;
        if (occ.startAt && occ.endAt) {
          const duration = occ.endAt.getTime() - occ.startAt.getTime();
          newEnd = new Date(newStart.getTime() + duration);
        }
        await prisma.jobOccurrence.update({
          where: { id: occ.id },
          data: { startAt: newStart, ...(newEnd ? { endAt: newEnd } : {}) },
        });
      }
    }

    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.IN_PROGRESS,
      undefined,
      location,
      body.startedAt ? { startedAt: String(body.startedAt) } : undefined
    );
  });

  app.post("/occurrences/:id/complete", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const notes = body.notes != null ? String(body.notes) : undefined;
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    const timestamps: { startedAt?: string; completedAt?: string; totalPausedMs?: number } = {};
    if (body.completedAt) timestamps.completedAt = String(body.completedAt);
    if (body.startedAt) timestamps.startedAt = String(body.startedAt);
    if (body.totalPausedMs != null) timestamps.totalPausedMs = Math.max(0, Math.round(Number(body.totalPausedMs)));
    // Per-worker percentage allocation. Validation is permissive — the caller
    // owns the math; we just persist what comes in. The downstream
    // approvePayment normalizes to 100% before applying.
    const completionSplits: Array<{ userId: string; percent: number }> | undefined =
      Array.isArray(body.completionSplits)
        ? body.completionSplits
            .map((s: any) => ({ userId: String(s.userId), percent: Number(s.percent) }))
            .filter((s: any) => s.userId && Number.isFinite(s.percent))
        : undefined;

    // Gate: real jobs (not tasks/announcements/etc.) cannot transition into
    // PENDING_PAYMENT unless the client's primary contact is reachable —
    // invoice routing only ever targets the primary, so an unreachable or
    // missing primary blocks the payment request. The gate is silent for
    // non-job workflows since those don't accept payment.
    const occForGate = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        workflow: true,
        job: {
          select: {
            property: {
              select: {
                client: {
                  select: {
                    contacts: {
                      // Pull all primaries regardless of status so we
                      // can differentiate "no primary" vs "primary is
                      // paused/archived" in the error message. Filtering
                      // ACTIVE at the query silently masks paused
                      // primaries and misleads the operator.
                      where: { isPrimary: true },
                      select: {
                        firstName: true, status: true,
                        phone: true, normalizedPhone: true, email: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const isJobWorkflow = !occForGate?.workflow
      || occForGate.workflow === "STANDARD"
      || occForGate.workflow === "ONE_OFF"
      || occForGate.workflow === "ESTIMATE";
    if (isJobWorkflow) {
      const primaries = occForGate?.job?.property?.client?.contacts ?? [];
      const activePrimaries = primaries.filter((c) => c.status === "ACTIVE");
      if (activePrimaries.length === 0) {
        const inactive = primaries[0]; // any primary in a non-ACTIVE state
        if (inactive) {
          throw app.httpErrors.badRequest(
            `Can't complete — the primary contact (${inactive.firstName ?? "unnamed"}) is ${inactive.status.toLowerCase()}. Unpause them or promote a different contact to primary first.`,
          );
        }
        throw app.httpErrors.badRequest(
          "Can't complete — this client has no primary contact set. Open the client's contacts and mark one as Primary first.",
        );
      }
      const reachable = activePrimaries.some((c) => c.phone || c.normalizedPhone || c.email);
      if (!reachable) {
        throw app.httpErrors.badRequest(
          "Can't complete — the primary contact has no phone or email on file. Update their contact info first.",
        );
      }
    }

    const updated = await services.jobs.updateOccurrenceStatus(
      uid,
      occurrenceId,
      JobOccurrenceStatus.PENDING_PAYMENT,
      notes,
      location,
      Object.keys(timestamps).length ? timestamps : undefined,
      completionSplits ? { completionSplits } : undefined,
    );

    // Resolve effective comms mode for this occurrence.
    //   - Look up the claimer (first non-observer assignee, or null).
    //   - Their per-profile override wins; otherwise the org-wide setting.
    //   - When SERVER: best-effort Twilio/Resend send in the background.
    //   - When CLAIMER: mint the token synchronously so the JobsTab card can
    //     immediately render the Text/Email icons. No outbound send — the
    //     claimer dispatches from their own device.
    if (isJobWorkflow) {
      const claimerAssignee = await prisma.jobOccurrenceAssignee.findFirst({
        // SQL NULL-safety on role (see services/equipment.ts comment).
        where: { occurrenceId, OR: [{ role: null }, { role: { not: "observer" } }] },
        orderBy: { assignedAt: "asc" },
        select: { userId: true },
      });
      const claimerUserId = claimerAssignee?.userId ?? null;
      const mode = await services.paymentRequests.resolveCommsMode(claimerUserId);

      if (mode === "SERVER") {
        services.paymentRequests
          .sendForOccurrence(uid, occurrenceId)
          .catch((err) => {
            console.warn(`Payment request send failed for ${occurrenceId}:`, err?.message);
          });
      } else {
        try {
          await services.paymentRequests.generateTokenForOccurrence(occurrenceId);
        } catch (err: any) {
          console.warn(`Payment token generation failed for ${occurrenceId}:`, err?.message);
        }
      }
    }

    return updated;
  });

  // Comms-handoff: returns the prepared payment-request payload the JobsTab
  // uses to render Text/Email shortcut icons in CLAIMER mode. Mints the token
  // on-demand if it doesn't exist yet (defensive — should already be there
  // from /complete). Auth: any worker — the JobsTab decides visibility based
  // on assignment / role.
  app.get("/occurrences/:id/comms-handoff", workerGuard, async (req: any) => {
    const occurrenceId = String(req.params.id);
    const claimerAssignee = await prisma.jobOccurrenceAssignee.findFirst({
      // NULL-role rows are the canonical "regular worker." `NOT:
      // { role: 'observer' }` would silently exclude them via SQL
      // three-valued logic — use the OR pattern.
      where: {
        occurrenceId,
        OR: [{ role: null }, { role: { not: "observer" } }],
      },
      orderBy: { assignedAt: "asc" },
      select: { userId: true },
    });
    const mode = await services.paymentRequests.resolveCommsMode(claimerAssignee?.userId ?? null);
    const prepared = await services.paymentRequests.generateTokenForOccurrence(occurrenceId);
    // Strip down the contacts to what the icons actually need. The service
    // layer already filtered to the primary contact only — anything that
    // shows up here is the primary.
    const handoffContacts = prepared.contacts.map((c) => ({
      id: c.id,
      firstName: c.firstName,
      phone: c.normalizedPhone ?? c.phone ?? null,
      email: c.email ?? null,
    }));
    // Explicit data-invariant flag so the frontend can render a clear
    // "no primary contact set" error rather than silently showing
    // disabled icons.
    const missingPrimaryContact = handoffContacts.length === 0;
    return {
      mode,
      token: prepared.token,
      url: prepared.url,
      amountDue: prepared.amountDue,
      propertyLabel: prepared.propertyLabel,
      smsBody: prepared.smsBody,
      emailSubject: prepared.emailSubject,
      emailBody: prepared.emailBody,
      contacts: handoffContacts,
      missingPrimaryContact,
    };
  });

  // Record that the claimer tapped the SMS or Email shortcut. We can't
  // observe whether the device actually sent the message — this captures
  // intent for the audit log.
  app.post("/occurrences/:id/comms-handoff", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = (req.body || {}) as { channel?: string; completionSplits?: Array<{ userId: string; percent: number }> };
    const channel = body.channel;
    if (channel !== "sms" && channel !== "email") {
      throw app.httpErrors.badRequest('channel must be "sms" or "email"');
    }
    const splits = Array.isArray(body.completionSplits) ? body.completionSplits : undefined;
    await services.paymentRequests.recordClaimerHandoff(uid, occurrenceId, channel, splits);
    return { ok: true };
  });

  // Persist per-worker percent splits onto the occurrence + re-snapshot
  // promisedPayouts. Used by Take Payment in SERVER mode (where the comms
  // already fired automatically at completion, so we just need to save the
  // splits the claimer set in the dialog). Guarded server-side: rejects
  // when the occurrence isn't PENDING_PAYMENT or a confirmed Payment
  // already exists.
  app.post("/occurrences/:id/completion-splits", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = (req.body || {}) as { completionSplits?: Array<{ userId: string; percent: number }> };
    const splits = Array.isArray(body.completionSplits) ? body.completionSplits : [];
    // Auth: claimer or admin only
    const actUser = await prisma.user.findUniqueOrThrow({ where: { id: uid }, include: { roles: true } });
    const isAdmin = actUser.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isAdmin) {
      const assignee = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid },
      });
      if (!assignee) throw app.httpErrors.forbidden("You are not assigned to this job.");
      const isClaimer = assignee.assignedById === uid && assignee.role !== "observer";
      if (!isClaimer) throw app.httpErrors.forbidden("Only the claimer can set splits.");
    }
    await prisma.$transaction(async (tx: any) => {
      await persistCompletionSplits(tx, occurrenceId, splits);
    });
    return { ok: true };
  });

  // Cancel an in-flight payment request. Regenerates the token (so the
  // client's old SMS/email link starts returning "Payment link not
  // valid") and clears paymentRequestSentAt so the worker can pick a
  // different path. Refuses if a Payment row already exists.
  app.post("/occurrences/:id/cancel-payment-request", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    // Gate mirrors /accept-payment (~1880). Only the claimer (or an
    // admin) can cancel an in-flight payment request, and Trainees are
    // explicitly blocked even if they somehow ended up as the claimer.
    // Without this check, any worker on the team could invalidate the
    // client's payment link out from under the claimer.
    const actUser = await prisma.user.findUniqueOrThrow({
      where: { id: uid },
      include: { roles: true },
    });
    const isAdmin = actUser.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isAdmin) {
      const assignee = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid },
      });
      if (!assignee) throw app.httpErrors.forbidden("You are not assigned to this job.");
      const isClaimer = assignee.assignedById === uid && assignee.role !== "observer";
      if (!isClaimer) {
        throw app.httpErrors.forbidden("Only the claimer can cancel payment requests.");
      }
      if (actUser.workerType === "TRAINEE") {
        throw app.httpErrors.forbidden("Trainees cannot cancel payment requests.");
      }
    }
    try {
      await services.paymentRequests.cancelPaymentRequest(uid, occurrenceId);
    } catch (err: any) {
      if (err?.code === "PAYMENT_EXISTS") {
        throw app.httpErrors.conflict(err.message);
      }
      throw err;
    }
    return { ok: true };
  });

  // Pause job
  app.post("/occurrences/:id/pause", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.PAUSED,
      undefined,
      location
    );
  });

  // Resume job
  app.post("/occurrences/:id/resume", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.IN_PROGRESS,
      undefined,
      location
    );
  });

  // Edit time tracking: start/end timestamps and off-the-clock (paused) ms.
  app.patch("/occurrences/:id/time", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occId = String(req.params.id);
    const body = req.body || {};

    // Verify claimer or admin
    const occ = await prisma.jobOccurrence.findUniqueOrThrow({ where: { id: occId }, include: { assignees: true } });
    const isClaimer = occ.assignees?.some((a: any) => a.userId === uid && a.role === "CLAIMER");
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isClaimer && !isAdmin) throw new ServiceError("FORBIDDEN", "Only the claimer or an admin can edit time.", 403);

    const data: any = {};
    if ("startedAt" in body) data.startedAt = body.startedAt ? new Date(String(body.startedAt)) : null;
    if ("completedAt" in body) data.completedAt = body.completedAt ? new Date(String(body.completedAt)) : null;
    if ("totalPausedMs" in body) data.totalPausedMs = body.totalPausedMs != null ? Math.max(0, Math.round(Number(body.totalPausedMs))) : 0;

    // Validate that duration stays non-negative when both timestamps present
    const newStart = data.startedAt ?? occ.startedAt;
    const newEnd = data.completedAt ?? occ.completedAt;
    const newPaused = "totalPausedMs" in data ? data.totalPausedMs : (occ.totalPausedMs ?? 0);
    if (newStart && newEnd) {
      const span = new Date(newEnd).getTime() - new Date(newStart).getTime();
      if (span < 0) throw new ServiceError("INVALID_RANGE", "End time cannot be before start time.", 400);
      if (newPaused > span) throw new ServiceError("INVALID_RANGE", "Off-the-clock time cannot exceed total span.", 400);
    }

    // Re-evaluate payroll hours approval against the new time values. If the
    // updated span is within the variance threshold of the estimate, stamp
    // it as approved automatically. Otherwise clear any prior approval so
    // it surfaces in the unapproved-hours queue. Only applies when the
    // occurrence has a completedAt (otherwise approval isn't meaningful yet).
    if (newEnd) {
      const activeAssignees = (occ.assignees ?? []).filter((a: any) => a.role !== "observer").length;
      const varianceThreshold = await loadHoursApprovalVarianceThreshold();
      const approval = evaluateHoursApproval({
        workflow: occ.workflow ?? "STANDARD",
        estimatedMinutes: occ.estimatedMinutes,
        startedAt: newStart ?? null,
        completedAt: new Date(newEnd),
        totalPausedMs: newPaused,
        workerCount: Math.max(1, activeAssignees),
        currentUserId: uid,
        varianceThreshold,
      });
      data.hoursApprovedAt = approval.hoursApprovedAt;
      data.hoursApprovedById = approval.hoursApprovedById;
    }

    return prisma.jobOccurrence.update({ where: { id: occId }, data });
  });

  // Estimate workflow: submit proposal
  app.post("/occurrences/:id/submit-proposal", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const notes = body.notes != null ? String(body.notes) : undefined;
    const location = (body.lat != null && body.lng != null)
      ? { lat: Number(body.lat), lng: Number(body.lng) }
      : undefined;

    // First update the proposal fields
    if (body.proposalAmount != null || body.proposalNotes != null) {
      await prisma.jobOccurrence.update({
        where: { id: String(req.params.id) },
        data: {
          ...(body.proposalAmount != null ? { proposalAmount: Number(body.proposalAmount) } : {}),
          ...(body.proposalNotes != null ? { proposalNotes: String(body.proposalNotes) } : {}),
        },
      });
    }

    // Then transition to PROPOSAL_SUBMITTED
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.PROPOSAL_SUBMITTED,
      notes,
      location
    );
  });

  // Accept/reject estimate (assigned workers)
  app.post("/occurrences/:id/accept-estimate", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { assignees: true, job: { select: { id: true } } },
    });

    // Must be assigned or admin
    const acceptUser = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const acceptIsAdmin = acceptUser?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!occ.assignees.some((a) => a.userId === uid) && !acceptIsAdmin) {
      throw app.httpErrors.forbidden("You are not assigned to this estimate.");
    }
    if ((occ as any).workflow !== "ESTIMATE" && !(occ as any).isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be accepted.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be accepted after completion.");
    }

    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "ACCEPTED",
        notes: body.comment ? `${occ.notes ? occ.notes + "\n" : ""}Accepted: ${String(body.comment)}` : occ.notes,
      },
    });

    return {
      accepted: true,
      jobId: occ.jobId,
      occurrence: {
        kind: occ.kind,
        startAt: occ.startAt?.toISOString() ?? null,
        endAt: occ.endAt?.toISOString() ?? null,
        notes: (occ as any).proposalNotes ?? occ.notes ?? null,
        price: (occ as any).proposalAmount ?? occ.price ?? null,
        estimatedMinutes: occ.estimatedMinutes ?? null,
        jobTags: (occ as any).jobTags ?? null,
        jobType: (occ as any).jobType ?? null,
        assignees: occ.assignees.map((a) => ({ userId: a.userId })),
      },
    };
  });

  app.post("/occurrences/:id/reject-estimate", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    const occ = await prisma.jobOccurrence.findUniqueOrThrow({
      where: { id: occurrenceId },
      include: { assignees: true },
    });

    const rejectUser = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const rejectIsAdmin = rejectUser?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!occ.assignees.some((a) => a.userId === uid) && !rejectIsAdmin) {
      throw app.httpErrors.forbidden("You are not assigned to this estimate.");
    }
    if ((occ as any).workflow !== "ESTIMATE" && !(occ as any).isEstimate) {
      throw app.httpErrors.badRequest("Only estimate occurrences can be rejected.");
    }
    if (occ.status !== "PROPOSAL_SUBMITTED") {
      throw app.httpErrors.badRequest("Estimates can only be rejected after completion.");
    }

    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: "REJECTED",
        rejectionReason: body.reason ? String(body.reason) : null,
      },
    });

    return { rejected: true };
  });

  app.post("/occurrences/create-next", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const jobId = String(body.jobId || "");
    if (!jobId) throw app.httpErrors.badRequest("jobId is required");

    const input: any = {};
    if (body.isOneOff != null) input.isOneOff = !!body.isOneOff;
    if (body.startAt != null) input.startAt = body.startAt;
    if (body.endAt != null) input.endAt = body.endAt;
    if (body.notes != null) input.notes = body.notes;
    if (body.price != null) input.price = Number(body.price);

    return services.jobs.createOccurrence(uid, jobId, input);
  });

  app.post("/occurrences/:id/accept-payment", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);

    // Only the claimer or an admin can accept payment
    const actUser = await prisma.user.findUniqueOrThrow({ where: { id: uid }, include: { roles: true } });
    const isAdmin = actUser.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");

    if (!isAdmin) {
      const assignee = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid },
      });
      if (!assignee) throw app.httpErrors.forbidden("You are not assigned to this job.");
      const isClaimer = assignee.assignedById === uid && assignee.role !== "observer";
      if (!isClaimer) throw app.httpErrors.forbidden("Only the claimer can accept payments.");
      if (actUser.workerType === "TRAINEE") throw app.httpErrors.forbidden("Trainees cannot accept payments.");
    }
    const body = req.body || {};
    return services.payments.createPayment(uid, {
      occurrenceId,
      amountPaid: Number(body.amountPaid),
      method: String(body.method || "CASH"),
      note: body.note ? String(body.note) : null,
      completionSplits: Array.isArray(body.completionSplits) ? body.completionSplits : [],
      context: isAdmin ? "ADMIN" : "ON_SITE",
    } as any);
  });

  app.get("/payments/mine", workerGuard, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { from, to, asUserId } = (req.query || {}) as { from?: string; to?: string; asUserId?: string };
    // Super-only "view as worker" — used by the Super Payments tab to
    // inspect what an individual worker sees. The param is silently
    // ignored for non-Super callers so there's no info leak via the
    // header presence.
    let targetUid = callerUid;
    if (asUserId && typeof asUserId === "string" && asUserId.length > 0) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid }, include: { roles: true },
      });
      const isSuper = !!caller?.roles.some((r: any) => r.role === "SUPER");
      if (isSuper) targetUid = asUserId;
    }
    const cutoff = await resolveCutoff(req);
    return services.payments.listMyPayments(targetUid, { from, to, cutoff });
  });

  app.get("/payments/earnings-summary", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);

    // Bucketing model branches by worker type:
    //
    //   EMPLOYEE / TRAINEE  — paid via payroll regardless of whether the
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
    const startOfYear = etMidnight(`${currentYear}-01-01`);
    const startOfNextYear = etMidnight(`${currentYear + 1}-01-01`);

    const me = await prisma.user.findUnique({ where: { id: uid }, select: { workerType: true } });
    const isEmployee = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
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
      // ── Employee/trainee: bucket every assigned job by work date ─────────
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
          expenses: { select: { cost: true } },
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
      // Skip flagged splits (guaranteedPayoutPaidAt set) — those splits'
      // cash was already disbursed via a GP advance row and is counted in
      // the advance loop below.
      const splits = await prisma.paymentSplit.findMany({
        where: {
          userId: uid,
          guaranteedPayoutPaidAt: null,
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

      // GP wage-path earnings — bucketed at occurrence.completedAt. Same
      // source the Gusto Contractors CSV uses for its work-anchored half,
      // ensuring this dashboard and the CSV stay in lockstep.
      const gpWindowStart = cutoff ?? new Date(0);
      const gpWindowEnd = new Date(); // up to now
      const gpItems = await loadGpWorkAnchoredItems(gpWindowStart, gpWindowEnd, { userId: uid });
      for (const item of gpItems) {
        addToBuckets(item.amount, item.completedAt);
        if (item.amount > 0) jobCount++;
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
        },
      });
      // Skip occurrences already counted on the wage path above
      // (contractor was in GP at the occurrence's completion — the
      // gpItems loader emitted a row for it, so the projection would
      // double-count if we added it again).
      const advancedOccIds2 = new Set(gpItems.map((i) => i.occurrenceId));
      for (const occ of todayPipelineOccs) {
        if (advancedOccIds2.has(occ.id)) continue;
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
  // EMPLOYEE / TRAINEE — promised payouts for every assigned job (paid or
  //   unpaid), bucketed by work date. They're made whole via payroll
  //   regardless of whether the client paid.
  //
  // CONTRACTOR / unclassified — confirmed PaymentSplits bucketed by
  //   payment date PLUS today-only optimistic projection of unpaid pipeline.
  //   Past unpaid jobs don't project; cash may never clear.
  //
  // Future-dated jobs and payments never appear in any bucket.
  app.get("/payments/title-bar-earnings", workerGuard, async (req: any) => {
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
    const startOfYear = etMidnight(`${currentYear}-01-01`);
    const startOfNextYear = etMidnight(`${currentYear + 1}-01-01`);

    const me = await prisma.user.findUnique({ where: { id: uid }, select: { workerType: true } });
    const isEmployee = me?.workerType === "EMPLOYEE" || me?.workerType === "TRAINEE";
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
          expenses: { select: { cost: true } },
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
      // parent Payment.createdAt. Skip splits flagged with guaranteedPayoutPaidAt
      // — those splits' cash was already disbursed via a GP advance row and
      // including the split too would double-count the contractor's earnings.
      const splits = await prisma.paymentSplit.findMany({
        where: {
          userId: uid,
          guaranteedPayoutPaidAt: null,
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
      // GP wage-path earnings: bucketed at occurrence.completedAt. Same
      // source the Gusto Contractors CSV's work-anchored half uses, so
      // this dashboard and the CSV agree. Reconciliation guarantees the
      // eventual PaymentSplit (when client pays) carries the wage-path
      // flag and is excluded above.
      const gpWindowStart2 = cutoff ?? new Date(0);
      const gpItems2 = await loadGpWorkAnchoredItems(gpWindowStart2, new Date(), { userId: uid });
      for (const item of gpItems2) {
        addToBuckets(item.amount, item.completedAt);
        if (item.amount > 0) jobCount++;
      }
      // Pipeline projection's work-date is constrained to TODAY by the
      // in-loop check, so the Business Start cutoff is naturally satisfied
      // for any cutoff <= today. The explicit `occurrenceWorkDateCutoff`
      // below covers the cutoff-in-the-future edge case (e.g. an admin
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
          expenses: { select: { cost: true } },
          assignees: { select: { userId: true, role: true } },
        },
      });
      // Skip occurrences already counted on the wage path above
      // (gpItems2). The pipeline projection only covers work NOT yet
      // counted — adding a GP-period occurrence here would double-count.
      const advancedOccIds = new Set(gpItems2.map((i) => i.occurrenceId));
      for (const occ of todayPipelineOccs) {
        if (advancedOccIds.has(occ.id)) continue;
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

  app.get("/payments/equipment-charges", workerGuard, async (req: any) => {
    const callerUid = await currentUserId(req);
    const { from, to, asUserId } = (req.query || {}) as { from?: string; to?: string; asUserId?: string };
    // Same Super-only "view as worker" override as /payments/mine.
    let targetUid = callerUid;
    if (asUserId && typeof asUserId === "string" && asUserId.length > 0) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid }, include: { roles: true },
      });
      const isSuper = !!caller?.roles.some((r: any) => r.role === "SUPER");
      if (isSuper) targetUid = asUserId;
    }
    const cutoff = await resolveCutoff(req);
    return services.equipment.listEquipmentCharges({ userId: targetUid, from, to, cutoff });
  });

  app.post("/occurrences/:id/add-assignee", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const targetUserId = String(body.userId ?? "");
    if (!targetUserId) throw app.httpErrors.badRequest("userId is required");
    const role = body.role ? String(body.role) : null;
    return services.jobs.addOccurrenceAssignee(uid, String(req.params.id), targetUserId, role);
  });

  app.delete("/occurrences/:id/assignees/:userId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.removeOccurrenceAssignee(uid, String(req.params.id), String(req.params.userId));
  });

  // Claimer can reassign claimer role
  app.post("/occurrences/:id/reassign-claimer", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { userId } = req.body || {};
    if (!userId) throw app.httpErrors.badRequest("userId is required");
    // Verify current user is the claimer
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid && a.role !== "observer");
    if (!isClaimer) throw app.httpErrors.forbidden("Only the claimer can reassign this role");
    return services.jobs.reassignClaimer(uid, occurrenceId, String(userId));
  });

  // Claimer can toggle observer/worker role
  app.patch("/occurrences/:id/assignees/:userId/role", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const targetUserId = String(req.params.userId);
    const { role } = req.body || {};
    // Verify current user is the claimer
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid && a.role !== "observer");
    if (!isClaimer) throw app.httpErrors.forbidden("Only the claimer can change roles");
    return services.jobs.changeAssigneeRole(uid, occurrenceId, targetUserId, role === "observer" ? "observer" : null);
  });

  app.post("/occurrences/:id/unclaim", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.unclaimOccurrence(uid, String(req.params.id));
  });

  // ── Pin / Unpin occurrences ──

  app.get("/occurrences/pinned", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const pins = await prisma.pinnedOccurrence.findMany({
      where: { userId: uid },
      select: { occurrenceId: true },
    });
    return pins.map((p: any) => p.occurrenceId);
  });

  app.post("/occurrences/:id/pin", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.pinnedOccurrence.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/occurrences/:id/unpin", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.pinnedOccurrence.deleteMany({
      where: { userId: uid, occurrenceId },
    });
    return { ok: true };
  });

  // ── Likes ──

  app.get("/occurrences/liked", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const likes = await prisma.likedOccurrence.findMany({
      where: { userId: uid },
      select: { occurrenceId: true },
    });
    return likes.map((l: any) => l.occurrenceId);
  });

  app.post("/occurrences/:id/like", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.likedOccurrence.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/occurrences/:id/unlike", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.likedOccurrence.deleteMany({
      where: { userId: uid, occurrenceId },
    });
    return { ok: true };
  });

  // ── Pin / Unpin equipment ──

  app.get("/equipment/pinned", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const pins = await prisma.pinnedEquipment.findMany({
      where: { userId: uid },
      select: { equipmentId: true },
    });
    return pins.map((p: any) => p.equipmentId);
  });

  app.post("/equipment/:id/pin", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.pinnedEquipment.upsert({
      where: { userId_equipmentId: { userId: uid, equipmentId } },
      create: { userId: uid, equipmentId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/equipment/:id/unpin", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.pinnedEquipment.deleteMany({
      where: { userId: uid, equipmentId },
    });
    return { ok: true };
  });

  // ── Like / Unlike equipment ──

  app.get("/equipment/liked", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const likes = await prisma.likedEquipment.findMany({
      where: { userId: uid },
      select: { equipmentId: true },
    });
    return likes.map((l: any) => l.equipmentId);
  });

  app.post("/equipment/:id/like", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.likedEquipment.upsert({
      where: { userId_equipmentId: { userId: uid, equipmentId } },
      create: { userId: uid, equipmentId },
      update: {},
    });
    return { ok: true };
  });

  app.post("/equipment/:id/unlike", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const equipmentId = String(req.params.id);
    await prisma.likedEquipment.deleteMany({
      where: { userId: uid, equipmentId },
    });
    return { ok: true };
  });

  // ── Tasks ──

  app.post("/tasks", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createTask(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      linkedOccurrenceId: body.linkedOccurrenceId ? String(body.linkedOccurrenceId) : undefined,
    });
  });

  app.post("/tasks/:id/close", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.CLOSED,
    );
  });

  app.post("/tasks/:id/reopen", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(
      uid,
      String(req.params.id),
      JobOccurrenceStatus.SCHEDULED,
    );
  });

  app.patch("/tasks/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Task not found");
    if (occ.workflow !== "TASK") throw app.httpErrors.badRequest("Only tasks can be edited this way");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
      const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only the task creator or an admin can edit this task");
    }
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.linkedOccurrenceId !== undefined) data.linkedOccurrenceId = body.linkedOccurrenceId || null;
    return prisma.jobOccurrence.update({ where: { id }, data });
  });

  app.delete("/tasks/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Task not found");
    if (occ.workflow !== "TASK") throw app.httpErrors.badRequest("Only tasks can be deleted this way");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
      const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only the task creator or an admin can delete this task");
    }
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  // ── Standalone Reminders (workflow: REMINDER) ──

  app.post("/standalone-reminders", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    if (!body.title?.trim()) throw app.httpErrors.badRequest("title is required");
    if (!body.startAt) throw app.httpErrors.badRequest("startAt is required");
    return services.jobs.createStandaloneReminder(uid, {
      title: String(body.title).trim(),
      notes: body.notes ? String(body.notes) : undefined,
      startAt: String(body.startAt),
      linkedOccurrenceId: body.linkedOccurrenceId ? String(body.linkedOccurrenceId) : undefined,
      isHighPriority: !!body.isHighPriority,
    });
  });

  app.post("/standalone-reminders/:id/dismiss", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(uid, String(req.params.id), JobOccurrenceStatus.CLOSED);
  });

  app.post("/standalone-reminders/:id/reopen", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.jobs.updateOccurrenceStatus(uid, String(req.params.id), JobOccurrenceStatus.SCHEDULED);
  });

  app.patch("/standalone-reminders/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Reminder not found");
    if (occ.workflow !== "REMINDER") throw app.httpErrors.badRequest("Not a standalone reminder");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
      const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only the creator or an admin can edit this reminder");
    }
    const body = req.body || {};
    const data: any = {};
    if (body.title !== undefined) data.title = String(body.title).trim();
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;
    if (body.startAt !== undefined) data.startAt = new Date(body.startAt);
    if (body.linkedOccurrenceId !== undefined) data.linkedOccurrenceId = body.linkedOccurrenceId || null;
    if (body.isHighPriority !== undefined) data.isHighPriority = !!body.isHighPriority;
    return prisma.jobOccurrence.update({ where: { id }, data });
  });

  app.delete("/standalone-reminders/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Reminder not found");
    if (occ.workflow !== "REMINDER") throw app.httpErrors.badRequest("Not a standalone reminder");
    const isCreator = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isCreator) {
      const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
      const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only the creator or an admin can delete this reminder");
    }
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  // ── Light Estimate delete (claimer or admin) ──

  app.delete("/light-estimates/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({ where: { id }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Estimate not found");
    if (occ.workflow !== "ESTIMATE" || occ.jobId) throw app.httpErrors.badRequest("Not a stand-alone estimate");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isClaimer) {
      const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
      const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) throw app.httpErrors.forbidden("Only the claimer or an admin can delete this estimate");
    }
    await prisma.jobOccurrence.delete({ where: { id } });
    return { deleted: true };
  });

  // ── Reminders ──

  app.get("/reminders", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return prisma.reminder.findMany({
      where: { userId: uid, dismissedAt: null },
      orderBy: { remindAt: "asc" },
    });
  });

  app.post("/occurrences/:id/reminder", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const remindAt = new Date(body.remindAt);
    if (isNaN(remindAt.getTime())) throw app.httpErrors.badRequest("Invalid remindAt date");
    const note = body.note ? String(body.note) : null;

    await prisma.reminder.upsert({
      where: { userId_occurrenceId: { userId: uid, occurrenceId } },
      create: { userId: uid, occurrenceId, remindAt, note },
      update: { remindAt, note, dismissedAt: null },
    });
    return { ok: true };
  });

  app.post("/occurrences/:id/reminder/clear", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    await prisma.reminder.updateMany({
      where: { userId: uid, occurrenceId },
      data: { dismissedAt: new Date() },
    });
    return { ok: true };
  });

  app.post("/occurrences/:id/reminder/snooze", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};
    const remindAt = new Date(body.remindAt);
    if (isNaN(remindAt.getTime())) throw app.httpErrors.badRequest("Invalid remindAt date");

    await prisma.reminder.updateMany({
      where: { userId: uid, occurrenceId },
      data: { remindAt, dismissedAt: null },
    });
    return { ok: true };
  });

  // ── Expenses (claimer only) ──

  app.get("/occurrences/:id/expenses", workerGuard, async (req: any) => {
    return services.expenses.listExpensesByOccurrence(String(req.params.id));
  });

  app.post("/occurrences/:id/expenses", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    return services.expenses.addExpense(uid, String(req.params.id), {
      cost: Number(body.cost),
      description: String(body.description ?? ""),
      category: body.category != null ? String(body.category) : null,
      vendor: body.vendor != null ? String(body.vendor) : null,
      date: body.date != null ? String(body.date) : null,
    });
  });

  app.patch("/expenses/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const input: any = {};
    if (body.cost !== undefined) input.cost = Number(body.cost);
    if (body.description !== undefined) input.description = String(body.description);
    if ("category" in body) input.category = body.category != null ? String(body.category) : null;
    if ("vendor" in body) input.vendor = body.vendor != null ? String(body.vendor) : null;
    if ("date" in body) input.date = body.date != null ? String(body.date) : null;
    return services.expenses.updateExpense(uid, String(req.params.id), input);
  });

  app.delete("/expenses/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.expenses.deleteExpense(uid, String(req.params.id));
  });

  // ── Job-expense receipts ──
  //
  // Receipt routes for one-off job expenses, keyed on the job Expense id
  // (what the Manage Expenses dialog has). The receipt itself lives on the
  // paired BusinessExpense. Open to the occurrence's claimer as well as any
  // admin/super — so a claimer who paid a company-account expense can attach
  // the receipt themselves. Guarded by requireApproved (not workerGuard) so
  // an admin without the WORKER role still passes; the per-expense claimer/
  // admin check happens in resolveExpenseBe.
  const approvedGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireApproved(req, reply),
  };

  async function resolveExpenseBe(uid: string, expenseId: string): Promise<string> {
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      select: {
        businessExpenseId: true,
        occurrence: {
          select: { assignees: { select: { userId: true, assignedById: true } } },
        },
      },
    });
    if (!expense) throw app.httpErrors.notFound("Expense not found.");
    if (!expense.businessExpenseId) {
      throw app.httpErrors.conflict(
        "This expense has no business-expense ledger row to hold a receipt.",
      );
    }
    const me = await prisma.user.findUnique({
      where: { id: uid },
      include: { roles: true },
    });
    const isAdminOrSuper = !!me?.roles?.some(
      (r) => r.role === "ADMIN" || r.role === "SUPER",
    );
    const isClaimer = expense.occurrence.assignees.some(
      (a) => a.userId === uid && a.assignedById === uid,
    );
    if (!isAdminOrSuper && !isClaimer) {
      throw app.httpErrors.forbidden(
        "Only the claimer or an admin can manage this expense's receipt.",
      );
    }
    return expense.businessExpenseId;
  }

  app.post("/expenses/:expenseId/receipt/upload-url", approvedGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const beId = await resolveExpenseBe(uid, String(req.params.expenseId));
    const b = req.body || {};
    const fileName = String(b.fileName ?? "receipt").trim();
    const contentType = String(b.contentType ?? "image/jpeg");
    if (!/^image\/|^application\/pdf$/.test(contentType)) {
      throw app.httpErrors.badRequest("Receipt must be an image or PDF.");
    }
    const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const key = `receipts/${beId}/${Date.now()}-${safeName}`;
    const uploadUrl = await getUploadUrl(key, contentType, 300, "receipts");
    return { uploadUrl, key, contentType, fileName: safeName };
  });

  app.post("/expenses/:expenseId/receipt", approvedGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const beId = await resolveExpenseBe(uid, String(req.params.expenseId));
    const b = req.body || {};
    const key = String(b.key ?? "");
    const fileName = String(b.fileName ?? "");
    const contentType = String(b.contentType ?? "");
    if (!key.startsWith(`receipts/${beId}/`)) {
      throw app.httpErrors.badRequest("Receipt key does not belong to this expense.");
    }
    const prev = await prisma.businessExpense.findUnique({
      where: { id: beId },
      select: { receiptR2Key: true },
    });
    if (prev?.receiptR2Key && prev.receiptR2Key !== key) {
      await deleteObject(prev.receiptR2Key, "receipts").catch(() => {});
    }
    return prisma.businessExpense.update({
      where: { id: beId },
      data: {
        receiptR2Key: key,
        receiptFileName: fileName || null,
        receiptContentType: contentType || null,
        receiptUploadedAt: new Date(),
      },
      select: {
        id: true,
        receiptR2Key: true,
        receiptFileName: true,
        receiptContentType: true,
        receiptUploadedAt: true,
      },
    });
  });

  app.get("/expenses/:expenseId/receipt-url", approvedGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const beId = await resolveExpenseBe(uid, String(req.params.expenseId));
    const be = await prisma.businessExpense.findUnique({
      where: { id: beId },
      select: { receiptR2Key: true, receiptContentType: true, receiptFileName: true },
    });
    if (!be?.receiptR2Key) throw app.httpErrors.notFound("No receipt uploaded.");
    const url = await getDownloadUrl(be.receiptR2Key, 3600, "receipts");
    return { url, contentType: be.receiptContentType, fileName: be.receiptFileName };
  });

  app.delete("/expenses/:expenseId/receipt", approvedGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const beId = await resolveExpenseBe(uid, String(req.params.expenseId));
    const be = await prisma.businessExpense.findUnique({
      where: { id: beId },
      select: { receiptR2Key: true },
    });
    if (be?.receiptR2Key) await deleteObject(be.receiptR2Key, "receipts").catch(() => {});
    await prisma.businessExpense.update({
      where: { id: beId },
      data: {
        receiptR2Key: null,
        receiptFileName: null,
        receiptContentType: null,
        receiptUploadedAt: null,
      },
    });
    return { deleted: true };
  });

  // ── Supplies (claimer / admin) ──
  //
  // Catalog read-only for workers (so the inventory picker can show available
  // qty). Adding/removing holds creates/removes the paired Expense row that
  // drives payout deduction; the lifecycle hooks on occurrence completion
  // convert ACTIVE→CONSUMED and decrement onHand.

  app.get("/supplies", workerGuard, async (req: any) => {
    const q = (req.query || {}) as { q?: string };
    return services.supplies.list({ q: q.q });
  });

  // Read-only history for workers/admins (Inventory tab). Same shape as the
  // super route, but exposed under workerGuard since the data is operational
  // (purchases / holds / adjustments per supply) — no tax-action surface.
  app.get("/supplies/:id/history", workerGuard, async (req: any) => {
    return services.supplies.listHistory(String(req.params.id));
  });

  // Worker-managed add-on services. Claimer of an active occurrence (or
  // admin/super) can add and remove. Tasks/reminders/events don't carry
  // add-ons; the workflow check happens in the create path. Removed
  // add-ons are deleted outright — there's no carry-forward to next
  // occurrence so no audit-trail consideration here.
  app.post("/occurrences/:id/addons", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { tag, customLabel, price } = (req.body || {}) as { tag?: string; customLabel?: string; price: number };
    if (price == null || price <= 0) throw app.httpErrors.badRequest("price is required and must be positive");
    if (!tag && !customLabel) throw app.httpErrors.badRequest("Either tag or customLabel is required");

    // Authorization: claimer of this occurrence OR admin/super.
    const me = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdminOrSuper = !!me?.roles?.some((r) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isAdminOrSuper) {
      const claimer = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid, assignedById: uid },
      });
      if (!claimer) throw app.httpErrors.forbidden("Only the claimer or an admin can add services.");
    }

    // Add-ons stay editable through completion and unfinalized
    // PENDING_PAYMENT — frozen once payment is requested/accepted.
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        status: true,
        workflow: true,
        paymentRequestSentAt: true,
        payment: { select: { id: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occInEditableState(occ)) {
      throw app.httpErrors.conflict("Services can't be changed once payment has been requested or accepted.");
    }
    const w = occ.workflow ?? "STANDARD";
    if (w === "TASK" || w === "REMINDER" || w === "EVENT" || w === "FOLLOWUP" || w === "ANNOUNCEMENT") {
      throw app.httpErrors.badRequest("This workflow doesn't carry add-on services.");
    }

    return prisma.occurrenceAddon.create({
      data: {
        occurrenceId,
        tag: tag || null,
        customLabel: customLabel?.trim() || null,
        price: Number(price),
        createdById: uid,
      },
    });
  });

  app.delete("/occurrences/:id/addons/:addonId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const addonId = String(req.params.addonId);

    const me = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdminOrSuper = !!me?.roles?.some((r) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isAdminOrSuper) {
      const claimer = await prisma.jobOccurrenceAssignee.findFirst({
        where: { occurrenceId, userId: uid, assignedById: uid },
      });
      if (!claimer) throw app.httpErrors.forbidden("Only the claimer or an admin can remove services.");
    }

    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        status: true,
        paymentRequestSentAt: true,
        payment: { select: { id: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (!occInEditableState(occ)) {
      throw app.httpErrors.conflict("Services can't be changed once payment has been requested or accepted.");
    }

    await prisma.occurrenceAddon.delete({ where: { id: addonId } });
    return { deleted: true };
  });

  app.post("/occurrences/:id/supply-holds", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.addHold(uid, String(req.params.id), {
      supplyId: String(b.supplyId ?? ""),
      quantity: Number(b.quantity),
    });
  });

  app.delete("/supply-holds/:holdId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    return services.supplies.removeHold(uid, String(req.params.holdId));
  });

  app.patch("/supply-holds/:holdId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    return services.supplies.adjustHold(uid, String(req.params.holdId), Number(b.quantity));
  });

  // ── Photos ──

  app.post("/occurrences/:id/photos/upload-url", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);

    // Per-job cap is configurable via the MAX_PHOTOS_PER_JOB setting. Falls
    // back to 10 (the historical default) when the setting is missing or
    // unparseable. Existing photos above a lowered cap are preserved — the
    // check is only on new uploads.
    const setting = await prisma.setting.findUnique({ where: { key: "MAX_PHOTOS_PER_JOB" } });
    const parsed = Number(setting?.value);
    const max = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10;
    const count = await prisma.jobOccurrencePhoto.count({ where: { occurrenceId } });
    if (count >= max) throw app.httpErrors.badRequest(`Maximum ${max} photos per occurrence`);

    const body = req.body || {};
    const fileName = String(body.fileName ?? "photo.jpg");
    const contentType = String(body.contentType ?? "image/jpeg");

    const key = `photos/${occurrenceId}/${uid}-${Date.now()}-${fileName}`;
    const uploadUrl = await getUploadUrl(key, contentType);

    return { uploadUrl, key, contentType };
  });

  app.post("/occurrences/:id/photos/confirm", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = req.body || {};

    if (!body.key) throw app.httpErrors.badRequest("key is required");
    const r2Key = String(body.key);

    // Idempotent: if a row already exists for this (occurrence, r2Key) pair,
    // return it instead of creating a duplicate. Retries from the offline
    // executor, page reloads mid-confirm, or network blips can fire confirm
    // multiple times for the same uploaded object — without this guard,
    // every retry creates another DB row pointing at the same R2 object,
    // inflating the visible photo count while the underlying image is one.
    const existing = await prisma.jobOccurrencePhoto.findFirst({
      where: { occurrenceId, r2Key },
    });
    if (existing) return existing;

    const photo = await prisma.jobOccurrencePhoto.create({
      data: {
        occurrenceId,
        r2Key,
        fileName: body.fileName ? String(body.fileName) : null,
        contentType: body.contentType ? String(body.contentType) : null,
        uploadedById: uid,
      },
    });

    return photo;
  });

  app.get("/occurrences/:id/photos", workerGuard, async (req: any) => {
    const occurrenceId = String(req.params.id);

    const photos = await prisma.jobOccurrencePhoto.findMany({
      where: { occurrenceId },
      orderBy: { createdAt: "asc" },
      include: { uploadedBy: { select: { id: true, displayName: true } } },
    });

    const result = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        contentType: p.contentType,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        url: await getDownloadUrl(p.r2Key),
      }))
    );

    return result;
  });

  app.delete("/occurrences/:id/photos/:photoId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.photoId);

    const photo = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    if (photo.uploadedById !== uid) throw app.httpErrors.forbidden("You can only delete your own photos");

    await deleteObject(photo.r2Key);
    await prisma.jobOccurrencePhoto.delete({ where: { id: photoId } });

    return { ok: true };
  });

  // ── Property Photos (worker read) ──
  app.get("/properties/:id/photos", workerGuard, async (req: any) => {
    const propertyId = String(req.params.id);
    const photos = await prisma.propertyPhoto.findMany({
      where: { propertyId },
      orderBy: { sortOrder: "asc" },
    });
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        url: await getDownloadUrl(p.r2Key, 86400, "property-photos"),
        fileName: p.fileName,
        description: p.description,
        sortOrder: p.sortOrder,
      }))
    );
    return withUrls;
  });

  // ── Equipment Photos (worker read) ──
  app.get("/equipment/:id/photos", workerGuard, async (req: any) => {
    const equipmentId = String(req.params.id);
    const photos = await prisma.equipmentPhoto.findMany({
      where: { equipmentId },
      orderBy: { sortOrder: "asc" },
    });
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        url: await getDownloadUrl(p.r2Key, 86400, "equipment-photos"),
        fileName: p.fileName,
        description: p.description,
        sortOrder: p.sortOrder,
      }))
    );
    return withUrls;
  });

  // ── Occurrence Property Photos (worker read) ──
  app.get("/occurrences/:id/property-photos", workerGuard, async (req: any) => {
    const occurrenceId = String(req.params.id);
    const links = await prisma.occurrencePropertyPhoto.findMany({
      where: { occurrenceId },
      include: { propertyPhoto: true },
      orderBy: { propertyPhoto: { sortOrder: "asc" } },
    });
    const withUrls = await Promise.all(
      links.map(async (l) => ({
        id: l.propertyPhoto.id,
        url: await getDownloadUrl(l.propertyPhoto.r2Key, 86400, "property-photos"),
        fileName: l.propertyPhoto.fileName,
        description: l.propertyPhoto.description,
        sortOrder: l.propertyPhoto.sortOrder,
      }))
    );
    return withUrls;
  });

  // ── Compliance policies (Slice 2) ──
  //
  // Worker-facing endpoints for the PolicyDocument / PolicyDocumentVersion /
  // PolicySignature system. Replaces the old insurance / W-9 / contractor-
  // agreement worker routes with a unified sign / acknowledge / upload
  // flow driven by services/policies.ts.

  app.get("/me/policies", workerGuard, async (req: any) => {
    // Admin/Super can pass ?viewAsUserId=<id> to read another worker's
    // compliance view — used by the Admin Home "View as" flow to render the
    // target's ComplianceBanner correctly. Mutations on /me/policies/*
    // (sign, acknowledge, upload) intentionally do NOT accept viewAsUserId:
    // those are self-service by design (worker must acknowledge / sign
    // in-person). Admins act on someone else's compliance via
    // /admin/policies/... routes.
    const callerUid = await currentUserId(req);
    const { viewAsUserId } = (req.query || {}) as { viewAsUserId?: string };
    let targetUid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid },
        include: { roles: true },
      });
      const isAdmin = caller?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
      if (!isAdmin) {
        throw app.httpErrors.forbidden("Admin or Super role required to view another worker's compliance.");
      }
      targetUid = viewAsUserId;
    }
    return services.policies.getWorkerPoliciesView(targetUid);
  });

  // view-as-allow: drives the caller's own alerts-dropdown badge (their
  // own notifications feed). The view-as flow does not consume this — the
  // banner uses /me/policies with viewAsUserId instead.
  //
  // Cheap count for the alerts dropdown badge — same required list as
  // /me/policies but without loading the full history, description text,
  // or version content. Returned as { pendingCount } for symmetry with
  // the other alert endpoints.
  app.get("/me/policies/count", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const view = await services.policies.getWorkerPoliciesView(uid);
    return { pendingCount: view.required.length };
  });

  app.post("/me/policies/versions/:id/upload-url", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    const fileName = String(b.fileName ?? "artifact.pdf");
    const contentType = String(b.contentType ?? "application/pdf");
    return services.policies.getWorkerUploadUrl(uid, String(req.params.id), fileName, contentType);
  });

  app.post("/me/policies/versions/:id/page-view", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (typeof b.pageNumber !== "number") {
      throw app.httpErrors.badRequest("pageNumber is required");
    }
    await services.policies.recordPageView(
      uid,
      String(req.params.id),
      Number(b.pageNumber),
      (req.ip as string) ?? null,
      (req.headers["user-agent"] as string) ?? null,
    );
    return { ok: true };
  });

  app.post("/me/policies/versions/:id/sign", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.typedName) throw app.httpErrors.badRequest("typedName is required");
    const created = await services.policies.signPolicy(uid, String(req.params.id), {
      typedName: String(b.typedName),
      uploadR2Key: b.uploadR2Key ? String(b.uploadR2Key) : undefined,
      uploadFileName: b.uploadFileName ? String(b.uploadFileName) : undefined,
      uploadContentType: b.uploadContentType ? String(b.uploadContentType) : undefined,
      uploadDigest: b.uploadDigest ? String(b.uploadDigest) : undefined,
      // Worker's cert-expiry picker is `<input type="date">` sending
      // "YYYY-MM-DD". Route through etEndOfDay so an insurance cert
      // expiring 2027-12-31 lasts through end of 12/31 ET rather than
      // silently expiring at 8pm ET on 12/30 due to UTC-midnight parsing.
      // Same fix as admin.ts's adminUploadOnBehalf.
      uploadExpiresAt: b.uploadExpiresAt ? etEndOfDay(String(b.uploadExpiresAt)) : null,
      clientIp: (req.ip as string) ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
    });
    return { signatureId: created.id };
  });

  app.post("/me/policies/versions/:id/acknowledge", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const created = await services.policies.acknowledgePolicy(uid, String(req.params.id), {
      clientIp: (req.ip as string) ?? null,
      userAgent: (req.headers["user-agent"] as string) ?? null,
    });
    return { signatureId: created.id };
  });

  // Worker cancels their own PENDING_REVIEW signature. Soft-revokes the
  // row; audit trail preserved. Only usable while the upload is still
  // awaiting admin review — once approved or rejected, only an admin can
  // touch the record.
  app.post("/me/policies/signatures/:id/cancel", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    await services.policies.cancelPendingSignatureAsWorker(uid, String(req.params.id));
    return { ok: true };
  });

  // view-as-allow: presigned download URL for the CALLER's own signature
  // artifact / policy body. Admin equivalents live under
  // /admin/policies/signatures/... for downloading someone else's upload.
  //
  // View-content presigned GET — worker downloads either the version's
  // published content (e.g., PDF policy body) or their own signature's
  // uploaded artifact for review.
  app.get("/me/policies/download", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const q = (req.query || {}) as { r2Key?: string };
    if (!q.r2Key) throw app.httpErrors.badRequest("r2Key query param required");
    const url = await services.policies.getWorkerContentDownloadUrl(uid, String(q.r2Key));
    return { url };
  });

  // Settings (read-only for workers)
  app.get("/settings", workerGuard, async () => {
    return services.settings.getAll();
  });

  // Pricing guide (read-only for workers). Mirrors /admin/pricing's shape
  // so the same PricingTab component can render here. Mutations remain
  // super-only on the /admin/pricing/* routes.
  app.get("/pricing", workerGuard, async () => {
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

  // view-as-allow: worker's own statistics (Home / Statistics tab).
  // Admin's cross-worker Statistics view hits /admin/statistics with a
  // workerIds filter instead — the view-as pattern isn't used here.
  //
  // Worker statistics (proxies to admin statistics endpoint logic, scoped to self)
  app.get("/me/statistics", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    // Redirect internally to the admin statistics logic but we'll inline it here
    const from = req.query?.from as string | undefined;
    const to = req.query?.to as string | undefined;

    const dateFilter: any = {};
    if (from) dateFilter.gte = etMidnight(from);
    if (to) dateFilter.lte = etEndOfDay(to);
    const hasDate = from || to;

    // Business Start Date filter — mirror /admin/statistics so the BSD
    // toggle behaves identically regardless of whether the StatisticsTab
    // hits the admin or personal endpoint. Same Pattern C (occurrence work
    // date) + Pattern B (nested payment/expenses) layering. Super reveal
    // header is honored via resolveCutoff.
    const cutoff = await resolveCutoff(req);

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        assignees: { some: { userId: uid } },
        ...(hasDate ? { completedAt: dateFilter } : {}),
        ...occurrenceWorkDateCutoff(cutoff),
      },
      select: {
        id: true, status: true, kind: true, startedAt: true, completedAt: true,
        estimatedMinutes: true, price: true, proposalAmount: true, completionSplits: true,
        addons: { select: { price: true } },
        workflow: true, isEstimate: true, startAt: true,
        assignees: { select: { userId: true, role: true, user: { select: { id: true, displayName: true, email: true, workerType: true } } } },
        payment: {
          where: cutoff ? { createdAt: { gte: cutoff } } : undefined,
          select: { amountPaid: true, method: true, confirmed: true, skippedAt: true, platformFeeAmount: true, businessMarginAmount: true, splits: { where: { guaranteedPayoutPaidAt: null }, select: { userId: true, amount: true } } },
        },
        expenses: {
          where: cutoff
            ? { OR: [
                { businessExpense: { date: { gte: cutoff } } },
                { businessExpense: null, createdAt: { gte: cutoff } },
              ] }
            : undefined,
          select: { cost: true },
        },
        job: { select: { property: { select: { id: true, displayName: true, city: true } } } },
      },
      orderBy: { completedAt: "desc" },
    });

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: {
        id: true,
        displayName: true,
        email: true,
        workerType: true,
        guaranteedPayoutUntil: true,
        guaranteedPayoutStartedAt: true,
        guaranteedPayoutHistory: true,
      },
    });
    if (!user) return { workers: [], totalOccurrences: 0, daysInRange: 0 };

    // For GP-period work, the contractor was paid the wage-path amount
    // on the Gusto run covering the work week. Use the same compute the
    // CSV uses (loadGpWorkAnchoredItems) so stats and payroll stay in
    // sync. For post-GP work, the split amount remains authoritative.
    const occIdsForGp = occurrences.map((o) => o.id);
    const gpItemsList = occIdsForGp.length > 0
      ? await loadGpWorkAnchoredItems(
          new Date(Math.min(...occurrences.map((o) => (o.completedAt ?? new Date()).getTime()))),
          new Date(Math.max(...occurrences.map((o) => (o.completedAt ?? new Date()).getTime()))),
          { userId: uid },
        )
      : [];
    const advanceByOccId = new Map(gpItemsList.map((i) => [i.occurrenceId, i.amount]));

    // Build stats for just this user
    let jobsCompleted = 0, totalEarnings = 0, totalExpenses = 0, totalActualMinutes = 0,
      totalEstimatedMinutes = 0, jobsWithTiming = 0;
    const paymentMethods: Record<string, number> = {};
    const jobsByDay: Record<string, number> = {};
    const propertySet = new Set<string>();

    // Rate + helper for the employee projection path.
    const _isEmployeeSelf = user.workerType === "EMPLOYEE" || user.workerType === "TRAINEE";
    const _statsSettingKey = _isEmployeeSelf ? "EMPLOYEE_BUSINESS_MARGIN_PERCENT" : "CONTRACTOR_PLATFORM_FEE_PERCENT";
    const _statsSetting = await prisma.setting.findUnique({ where: { key: _statsSettingKey } });
    const _statsRate = Number(_statsSetting?.value ?? 0);
    const { computeMyOccurrenceNet: _statsComputeNet } = await import("../services/workerEarnings");

    for (const occ of occurrences) {
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) continue;
      jobsCompleted++;
      const actualMinutes = occ.startedAt && occ.completedAt
        ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000) : null;
      const expenseTotal = occ.expenses.reduce((s, e) => s + e.cost, 0);
      // Skipped payments: pretend it never happened — earnings for
      // this occurrence contribute $0 to worker statistics.
      let earnings: number;
      if (_isEmployeeSelf) {
        // Employees: project the promised net so pending-payment jobs
        // still contribute to earnings. Skipped payments → helper
        // returns 0 automatically.
        const paymentForMe = occ.payment
          ? {
              ...occ.payment,
              splits: occ.payment.splits.filter((s) => s.userId === uid),
            }
          : null;
        earnings = _statsComputeNet(
          {
            price: occ.price,
            proposalAmount: (occ as any).proposalAmount ?? null,
            completionSplits: (occ as any).completionSplits,
            addons: (occ as any).addons ?? [],
            expenses: occ.expenses,
            assignees: occ.assignees,
            payment: paymentForMe,
          },
          uid,
          _statsRate,
        );
      } else {
        const split = occ.payment?.skippedAt
          ? undefined
          : occ.payment?.splits.find((s) => s.userId === uid);
        const gpAdvance = advanceByOccId.get(occ.id);
        earnings = gpAdvance ?? split?.amount ?? 0;
      }
      if (earnings > 0) {
        const splitRatio = occ.payment && occ.payment.splits.length > 0
          ? earnings / occ.payment.splits.reduce((s, sp) => s + sp.amount, 0) : 1;
        totalEarnings += earnings;
        totalExpenses += expenseTotal * splitRatio;
      }
      if (actualMinutes != null && actualMinutes > 0) { totalActualMinutes += actualMinutes; jobsWithTiming++; }
      if (occ.estimatedMinutes) totalEstimatedMinutes += occ.estimatedMinutes;
      if (occ.payment?.method) paymentMethods[occ.payment.method] = (paymentMethods[occ.payment.method] || 0) + 1;
      const dayKey = occ.completedAt ? etFormatDate(occ.completedAt) : null;
      if (dayKey) jobsByDay[dayKey] = (jobsByDay[dayKey] || 0) + 1;
      if (occ.job?.property?.id) propertySet.add(occ.job.property.id);
    }

    const netEarnings = totalEarnings - totalExpenses;
    const allDays = new Set(Object.keys(jobsByDay));

    return {
      workers: [{
        userId: user.id,
        displayName: user.displayName ?? user.email ?? user.id,
        workerType: user.workerType,
        jobsCompleted,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalExpenses: Math.round(totalExpenses * 100) / 100,
        netEarnings: Math.round(netEarnings * 100) / 100,
        totalActualMinutes,
        totalEstimatedMinutes,
        jobsWithTiming,
        avgActualMinutes: jobsWithTiming > 0 ? Math.round(totalActualMinutes / jobsWithTiming) : 0,
        avgEstimatedMinutes: jobsCompleted > 0 && totalEstimatedMinutes > 0 ? Math.round(totalEstimatedMinutes / jobsCompleted) : 0,
        efficiencyPercent: totalActualMinutes > 0 && totalEstimatedMinutes > 0 ? Math.round((totalEstimatedMinutes / totalActualMinutes) * 100) : null,
        propertiesServiced: propertySet.size,
        paymentMethods,
        jobsByDay,
      }],
      totalOccurrences: jobsCompleted,
      daysInRange: allDays.size,
    };
  });

  // Set own home base address
  app.patch("/me/home-base", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    await prisma.user.update({
      where: { id: uid },
      data: { homeBaseAddress: body.address != null ? String(body.address).trim() || null : null },
    });
    return { ok: true };
  });

  // Update own profile (availability)
  app.patch("/me/profile", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const data: any = {};
    if (body.homeBaseAddress !== undefined) data.homeBaseAddress = body.homeBaseAddress ? String(body.homeBaseAddress).trim() : null;
    if (body.availableDays !== undefined) data.availableDays = Array.isArray(body.availableDays) ? JSON.stringify(body.availableDays) : null;
    if (body.availableHoursPerDay !== undefined) data.availableHoursPerDay = body.availableHoursPerDay != null ? Number(body.availableHoursPerDay) : null;
    if (body.phone !== undefined) {
      if (!body.phone || !String(body.phone).trim()) {
        data.phone = null;
      } else {
        const normalized = normalizePhone(String(body.phone));
        if (!normalized) throw app.httpErrors.badRequest("Enter a valid 10-digit US phone number.");
        data.phone = normalized;
      }
    }
    if (body.firstName !== undefined) data.firstName = body.firstName ? String(body.firstName).trim() : null;
    if (body.lastName !== undefined) data.lastName = body.lastName ? String(body.lastName).trim() : null;
    if (body.displayName !== undefined) data.displayName = body.displayName ? String(body.displayName).trim() : null;
    await prisma.user.update({ where: { id: uid }, data });
    return { ok: true };
  });

  // List of approved workers (for co-worker selection)
  // IP-based location fallback for weather
  app.get("/weather/location", workerGuard, async (req: any) => {
    try {
      // Use ip-api.com (free, no key needed, 45 req/min)
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
      const res = await fetch(`http://ip-api.com/json/${ip === "127.0.0.1" || ip === "::1" ? "" : ip}?fields=lat,lon`);
      const data = await res.json();
      if (data.lat && data.lon) return { lat: data.lat, lng: data.lon };
      throw new Error("No location data");
    } catch {
      throw app.httpErrors.serviceUnavailable("Could not determine location");
    }
  });

  // Weather proxy — uses OpenWeatherMap forecast, returns 3 days
  app.get("/weather", workerGuard, async (req: any) => {
    const { lat, lng } = (req.query || {}) as { lat?: string; lng?: string };
    if (!lat || !lng) throw app.httpErrors.badRequest("lat and lng are required");

    // Read API key from Setting table, fall back to env var
    const apiKeySetting = await prisma.setting.findUnique({ where: { key: "WEATHER_API_KEY" } });
    const apiKey = apiKeySetting?.value || process.env.OPENWEATHER_API_KEY;
    if (!apiKey) throw app.httpErrors.serviceUnavailable("Weather API key not configured");

    try {
      // Fetch both current weather and 5-day forecast
      const [currentRes, forecastRes] = await Promise.all([
        fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&units=imperial&appid=${apiKey}`),
        fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lng}&units=imperial&appid=${apiKey}`),
      ]);
      if (!currentRes.ok) throw new Error(`Weather API returned ${currentRes.status}`);
      if (!forecastRes.ok) throw new Error(`Forecast API returned ${forecastRes.status}`);
      const current = await currentRes.json();
      const forecast = await forecastRes.json();

      // Group forecast by day and pick midday (12:00) or closest entry
      const days: Record<string, any[]> = {};
      for (const entry of (forecast.list ?? [])) {
        const date = entry.dt_txt?.split(" ")[0];
        if (!date) continue;
        if (!days[date]) days[date] = [];
        days[date].push(entry);
      }

      // ET calendar day for the "today" weather key.
      const todayKey = etToday();

      // Always include today using current weather, then next 2 forecast days
      const todayForecastEntries = days[todayKey] ?? [];
      const todayRainChances = todayForecastEntries.map((e) => Math.round((e.pop ?? 0) * 100));
      const todayEntry = {
        date: todayKey,
        label: "Today",
        high: Math.round(current.main?.temp_max ?? current.main?.temp ?? 0),
        low: Math.round(current.main?.temp_min ?? current.main?.temp ?? 0),
        description: current.weather?.[0]?.description ?? "",
        icon: current.weather?.[0]?.icon ?? "",
        rainChance: todayRainChances.length > 0 ? Math.max(...todayRainChances) : 0,
        windSpeed: Math.round(current.wind?.speed ?? 0),
        humidity: current.main?.humidity ?? 0,
      };

      // Get next days (skip today since we built it from current weather)
      const futureDays = Object.entries(days)
        .filter(([date]) => date > todayKey)
        .slice(0, 3)
        .map(([date, entries]) => {
          const midday = entries.find((e) => e.dt_txt?.includes("12:00")) ?? entries[Math.floor(entries.length / 2)];
          const temps = entries.map((e) => e.main?.temp ?? 0);
          const rainChances = entries.map((e) => Math.round((e.pop ?? 0) * 100));
          return {
            date,
            high: Math.round(Math.max(...temps)),
            low: Math.round(Math.min(...temps)),
            description: midday.weather?.[0]?.description ?? "",
            icon: midday.weather?.[0]?.icon ?? "",
            rainChance: Math.max(...rainChances),
            windSpeed: Math.round(midday.wind?.speed ?? 0),
            humidity: midday.main?.humidity ?? 0,
          };
        });

      const dailyForecasts = [todayEntry, ...futureDays];

      return {
        current: {
          temp: Math.round(current.main?.temp ?? 0),
          feelsLike: Math.round(current.main?.feels_like ?? 0),
          description: current.weather?.[0]?.description ?? "",
          icon: current.weather?.[0]?.icon ?? "",
          humidity: current.main?.humidity ?? 0,
          windSpeed: Math.round(current.wind?.speed ?? 0),
        },
        forecast: dailyForecasts,
        lat: Number(lat),
        lng: Number(lng),
      };
    } catch (err: any) {
      throw app.httpErrors.serviceUnavailable(err.message || "Weather unavailable");
    }
  });

  app.get("/workers", workerGuard, async () => {
    const list = await services.users.list({ approved: true, role: "WORKER" });
    return list.map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, workerType: u.workerType }));
  });

  // ── Worker Reschedule ──

  app.patch("/occurrences/:id/pinned-note", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    // Only claimer or admin can set pinned note
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isClaimer && !isAdmin) throw app.httpErrors.forbidden("Only the claimer or an admin can set instructions");
    const body = req.body || {};
    const pinnedNote = body.pinnedNote != null ? String(body.pinnedNote).trim() || null : null;
    const data: any = { pinnedNote };
    if (body.pinnedNoteRepeats !== undefined) data.pinnedNoteRepeats = !!body.pinnedNoteRepeats;
    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data,
    });
    return { ok: true, pinnedNote, pinnedNoteRepeats: data.pinnedNoteRepeats };
  });

  // ── Occurrence Instructions (multiple) ──
  app.post("/occurrences/:id/instructions", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { text, isPreset, repeats } = (req.body || {}) as { text: string; isPreset?: boolean; repeats?: boolean };
    if (!text?.trim()) throw app.httpErrors.badRequest("text is required");
    // Permission: claimer or admin
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isClaimer && !isAdmin) throw app.httpErrors.forbidden("Only the claimer or an admin can manage instructions");
    const count = await prisma.occurrenceInstruction.count({ where: { occurrenceId } });
    return prisma.occurrenceInstruction.create({
      data: { occurrenceId, text: text.trim(), isPreset: !!isPreset, repeats: repeats ?? true, sortOrder: count },
    });
  });

  app.patch("/occurrences/:id/instructions/:instructionId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const instructionId = String(req.params.instructionId);
    const body = req.body || {};
    // Permission: claimer or admin
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isClaimer && !isAdmin) throw app.httpErrors.forbidden("Only the claimer or an admin can manage instructions");
    const data: any = {};
    if ("text" in body) data.text = String(body.text).trim();
    if ("repeats" in body) data.repeats = !!body.repeats;
    return prisma.occurrenceInstruction.update({ where: { id: instructionId }, data });
  });

  app.delete("/occurrences/:id/instructions/:instructionId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const instructionId = String(req.params.instructionId);
    // Permission: claimer or admin
    const occ = await prisma.jobOccurrence.findUnique({ where: { id: occurrenceId }, include: { assignees: true } });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isClaimer && !isAdmin) throw app.httpErrors.forbidden("Only the claimer or an admin can manage instructions");
    await prisma.occurrenceInstruction.delete({ where: { id: instructionId } });
    return { deleted: true };
  });

  app.post("/occurrences/:id/confirm", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: true },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (occ.status !== "SCHEDULED") throw app.httpErrors.badRequest("Only scheduled occurrences can be confirmed");
    // Only claimer or admin can confirm
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const isAdmin = user?.roles.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    if (!isClaimer && !isAdmin) throw app.httpErrors.forbidden("Only the claimer or an admin can confirm");
    await prisma.jobOccurrence.update({
      where: { id: occurrenceId },
      data: { isClientConfirmed: true },
    });
    return { confirmed: true };
  });

  app.post("/occurrences/:id/reschedule", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const { startAt, endAt, comment, source } = (req.body || {}) as { startAt?: string; endAt?: string; comment?: string; source?: string };

    if (!startAt) throw app.httpErrors.badRequest("startAt is required");

    // Comment is required unless triggered by the route planner
    const isRoutePlanner = source === "route-planner";
    const reason = (comment ?? "").trim();
    if (!isRoutePlanner && !reason) {
      throw app.httpErrors.badRequest("A comment explaining the reschedule is required");
    }

    // Verify occurrence exists and is SCHEDULED, not a task/reminder
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      include: { assignees: { select: { userId: true, assignedById: true } } },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found");
    if (occ.status !== JobOccurrenceStatus.SCHEDULED) {
      throw app.httpErrors.badRequest("Only scheduled jobs can be rescheduled");
    }
    if ((occ as any).workflow === "TASK" || (occ as any).workflow === "REMINDER") {
      throw app.httpErrors.badRequest("Tasks and reminders cannot be rescheduled");
    }

    // Only the claimer or admin can reschedule
    const reschedUser = await prisma.user.findUnique({ where: { id: uid }, include: { roles: true } });
    const reschedIsAdmin = reschedUser?.roles?.some((r: any) => r.role === "ADMIN" || r.role === "SUPER");
    const isClaimer = occ.assignees.some((a: any) => a.userId === uid && a.assignedById === uid);
    if (!isClaimer && !reschedIsAdmin) {
      throw app.httpErrors.forbidden("Only the claimer or an admin can reschedule this job");
    }

    // Enforce 2-day window for non-admins (ET calendar days, DST-safe).
    if (!reschedIsAdmin) {
      const diffDays = Math.abs(etDaysBetween(etToday(), startAt.slice(0, 10)));
      if (diffDays > 2) {
        throw app.httpErrors.badRequest("Workers can only reschedule within 2 days of today");
      }
    }

    // Update occurrence dates
    const patch: any = { startAt };
    if (endAt) patch.endAt = endAt;
    else if (occ.startAt && occ.endAt) {
      const duration = occ.endAt.getTime() - occ.startAt.getTime();
      const newStart = new Date(startAt);
      patch.endAt = new Date(newStart.getTime() + duration).toISOString();
    }

    const updated = await services.jobs.updateOccurrence(uid, occurrenceId, patch);

    // Post comment
    const commentBody = isRoutePlanner
      ? "Rescheduled via route planner"
      : `Rescheduled: ${reason}`;
    await prisma.occurrenceComment.create({
      data: { occurrenceId, authorId: uid, body: commentBody },
    });

    return updated;
  });

  // ── Occurrence Comments ──

  app.get("/occurrences/:id/comments", workerGuard, async (req: any) => {
    const occurrenceId = String(req.params.id);
    const comments = await prisma.occurrenceComment.findMany({
      where: { occurrenceId },
      include: { author: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return comments;
  });

  app.post("/occurrences/:id/comments", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const occurrenceId = String(req.params.id);
    const body = (req.body?.body ?? "").trim();
    if (!body) throw app.httpErrors.badRequest("Comment body is required");

    const comment = await prisma.occurrenceComment.create({
      data: { occurrenceId, authorId: uid, body },
      include: { author: { select: { id: true, displayName: true, email: true } } },
    });
    return comment;
  });

  app.patch("/occurrences/comments/:commentId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const commentId = String(req.params.commentId);
    const body = (req.body?.body ?? "").trim();
    if (!body) throw app.httpErrors.badRequest("Comment body is required");

    const comment = await prisma.occurrenceComment.findUnique({ where: { id: commentId } });
    if (!comment) throw app.httpErrors.notFound("Comment not found");
    if (comment.authorId !== uid) throw app.httpErrors.forbidden("Only the author can edit a comment");

    const updated = await prisma.occurrenceComment.update({
      where: { id: commentId },
      data: { body },
      include: { author: { select: { id: true, displayName: true, email: true } } },
    });
    return updated;
  });

  app.delete("/occurrences/comments/:commentId", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const commentId = String(req.params.commentId);

    const comment = await prisma.occurrenceComment.findUnique({
      where: { id: commentId },
      include: { occurrence: { include: { assignees: { select: { userId: true, role: true, assignedById: true } } } } },
    });
    if (!comment) throw app.httpErrors.notFound("Comment not found");

    // Can delete if: author, claimer of the job, or admin
    const isAuthor = comment.authorId === uid;
    const assignees = comment.occurrence.assignees ?? [];
    const isClaimer = assignees.some((a) => a.userId === uid && a.role !== "observer" && a.assignedById === uid);
    const userRoles = await prisma.userRole.findMany({ where: { userId: uid }, select: { role: true } });
    const isAdmin = userRoles.some((r) => r.role === "ADMIN");

    if (!isAuthor && !isClaimer && !isAdmin) {
      throw app.httpErrors.forbidden("You cannot delete this comment");
    }

    await prisma.occurrenceComment.delete({ where: { id: commentId } });
    return { ok: true };
  });

  // ── Calendar Feed Tokens ──

  const MAX_FEED_TOKENS = 5;
  const STALE_TOKEN_DAYS = 90;

  app.get("/calendar-feeds", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const tokens = await prisma.calendarFeedToken.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, token: true, filters: true, createdAt: true, lastAccessedAt: true },
    });
    return tokens;
  });

  app.post("/calendar-feeds", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const filters = body.filters || {};
    const label = body.label?.trim() || null;

    // Auto-cleanup: remove tokens not accessed in 90 days.
    // date-handling-allow: elapsed-time — ~90 days of inactivity for token
    // expiry, ≤1-hour DST drift is irrelevant for this threshold.
    const staleDate = new Date(Date.now() - STALE_TOKEN_DAYS * 86400000);
    await prisma.calendarFeedToken.deleteMany({
      where: {
        userId: uid,
        OR: [
          { lastAccessedAt: { lt: staleDate } },
          { lastAccessedAt: null, createdAt: { lt: staleDate } },
        ],
      },
    });

    // Enforce max tokens — remove oldest if at limit
    const existing = await prisma.calendarFeedToken.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (existing.length >= MAX_FEED_TOKENS) {
      const toDelete = existing.slice(0, existing.length - MAX_FEED_TOKENS + 1);
      await prisma.calendarFeedToken.deleteMany({
        where: { id: { in: toDelete.map((t) => t.id) } },
      });
    }

    // Generate secure random token
    const crypto = require("crypto");
    const token = crypto.randomBytes(32).toString("hex");

    const record = await prisma.calendarFeedToken.create({
      data: { userId: uid, token, label, filters },
    });

    return { id: record.id, token: record.token, label: record.label, filters: record.filters, createdAt: record.createdAt };
  });

  app.delete("/calendar-feeds/:id", workerGuard, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    await prisma.calendarFeedToken.deleteMany({
      where: { id, userId: uid },
    });
    return { ok: true };
  });

  // ── Home banners ──────────────────────────────────────────────────────────
  // Pending banners for the current user (stacked at the top of Worker Home).
  app.get("/banners", workerGuard, async (req: any) => {
    return services.banners.listForUser(await currentUserId(req));
  });

  // Per-user dismissal — only affects the caller.
  app.post("/banners/:id/dismiss", workerGuard, async (req: any) => {
    return services.banners.dismiss(
      await currentUserId(req),
      String(req.params.id),
    );
  });

  // ── Workday tracking ──────────────────────────────────────────────────
  // Per-worker daily clock-in/out, used for payroll. Decoupled from
  // JobOccurrence time — see services/workdays.ts for the long doc + the
  // schema model comment for the design rationale.
  //
  // All routes operate on the authenticated user (req.user.id). The
  // impersonation header is surfaced into audit context only — the
  // existing impersonation feature is "view as role," not "act as another
  // userId," so the worker whose row is mutated is always the caller.
  // The audit detail records the impersonation flag for traceability.
  const workdays = await import("../services/workdays");
  const { IMPERSONATE_HEADER } = await import("../lib/impersonation");

  // Resolve the effective target user for a workday request — either
  // req.user.id (self-service) or the ?viewAsUserId= query param (admin
  // / super viewing-as another worker on the Worker Home tab). Returns
  // BOTH so the audit context can record actor + target correctly.
  //
  // Permission model when viewAsUserId is set:
  //   • Reads (GET) — caller must have ADMIN or SUPER role.
  //   • Mutations (POST / PATCH) — caller MUST have SUPER role. Admin
  //     can browse a worker's day for review, but only Super can
  //     start / pause / end / cancel / edit on the worker's behalf.
  //
  // Routes that allow the impersonation get the helper; self-service-only
  // paths skip it.
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
      include: { roles: true },
    });
    const hasSuper = caller?.roles?.some((r: any) => r.role === "SUPER") ?? false;
    const hasAdmin = hasSuper || (caller?.roles?.some((r: any) => r.role === "ADMIN") ?? false);
    if (opts.allowImpersonationFor === "read" && !hasAdmin) {
      throw new ServiceError("FORBIDDEN", "Admin or Super role required to view another worker's workday.", 403);
    }
    if (opts.allowImpersonationFor === "mutate" && !hasSuper) {
      throw new ServiceError("FORBIDDEN", "Super role required to act on another worker's workday.", 403);
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
    const impersonationHeader = req.headers?.[IMPERSONATE_HEADER];
    const impersonating = typeof impersonationHeader === "string" && impersonationHeader.trim().length > 0;
    return {
      actorId: req.user.id,
      impersonatedUserId: impersonating ? req.user.id : null,
    };
  }

  // Today's workday + the per-day blocking checks the UI needs to render
  // the Hero strip and the End dialog. Single endpoint so the Hero only
  // pays one round-trip.
  app.get("/me/workday/today", workerGuard, async (req: any) => {
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
  app.get("/me/workday/open-prior", workerGuard, async (req: any) => {
    const { targetUserId } = await resolveWorkdayTarget(req, { allowImpersonationFor: "read" });
    return { openPrior: await workdays.listMyOpenWorkdays(targetUserId) };
  });

  app.post("/me/workday/start", workerGuard, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    const body = (req.body || {}) as { startedAt?: string };
    return workdays.startWorkday(
      targetUserId,
      { startedAt: body.startedAt ?? null },
      workdayAuditContext(req, isImpersonating ? targetUserId : null),
    );
  });

  app.post("/me/workday/pause", workerGuard, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.pauseWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });

  app.post("/me/workday/resume", workerGuard, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.resumeWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });

  // Re-open today's workday after it was ended (typically by mistake).
  // The gap between the bad endedAt and now is added to totalPausedMs
  // so payable hours don't include the off-the-clock interval. Refused
  // once the same-day edit window has closed or if the row has been
  // approved — see services/workdays.ts reopenWorkday.
  app.post("/me/workday/reopen", workerGuard, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.reopenWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });

  // Cancel today's workday — hard-deletes the row. Used when the worker
  // tapped Start by accident. Refused if the row is already COMPLETED.
  // POST (not DELETE) so the action stays consistent with the other
  // workday verb endpoints and so the body can carry an optional reason
  // later if we want to capture one.
  app.post("/me/workday/cancel", workerGuard, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    return workdays.cancelWorkday(targetUserId, workdayAuditContext(req, isImpersonating ? targetUserId : null));
  });

  // End today's workday OR a prior open workday (forgot-yesterday flow).
  // Optional `workdayId` selects the prior row; without it, the service
  // defaults to today's row.
  app.post("/me/workday/end", workerGuard, async (req: any) => {
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
  app.patch("/me/workday/:id", workerGuard, async (req: any) => {
    const { targetUserId, isImpersonating } = await resolveWorkdayTarget(req, { allowImpersonationFor: "mutate" });
    const body = (req.body || {}) as {
      startedAt?: string;
      endedAt?: string;
      totalPausedMs?: number;
    };
    return workdays.editWorkdayTimes(
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

  // ── Vehicles + business-mileage tracking (worker) ─────────────────────
  //
  // Worker sees only the vehicles they've been assigned to and only
  // their own mileage entries. Every mutation goes through
  // userCanLogAgainstVehicle so an unassigned worker can't slip a
  // mileage entry in.

  // view-as-allow: vehicles the CALLER is assigned to — feeds the
  // MileageStrip, which is only rendered in self-service mode
  // (HomeTab.tsx suppresses MileageStrip when isViewingOther is true).
  app.get("/me/vehicles", workerGuard, async (req: any) => {
    const { listAssignedVehiclesForUser } = await import("../services/vehicles");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    return listAssignedVehiclesForUser(uid);
  });

  // view-as-allow: caller's own currently-open mileage sessions. Feeds
  // the MileageStrip and the End-workday dialog's "close open sessions"
  // prompt — both self-service surfaces.
  app.get("/me/mileage/open", workerGuard, async (req: any) => {
    const { listOpenEntriesForUser } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    return listOpenEntriesForUser(uid);
  });

  // view-as-allow: caller's own mileage-entry list. Admin's cross-worker
  // mileage view uses /admin/mileage instead.
  app.get("/me/mileage", workerGuard, async (req: any) => {
    const { listEntriesForUser } = await import("../services/mileage");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    const fromDate = req.query?.from ? String(req.query.from) : undefined;
    const toDate = req.query?.to ? String(req.query.to) : undefined;
    return listEntriesForUser(uid, { fromDate, toDate });
  });

  app.post("/me/mileage/start", workerGuard, async (req: any) => {
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

  app.post("/me/mileage/:id/stop", workerGuard, async (req: any) => {
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

  app.post("/me/mileage/:id/cancel", workerGuard, async (req: any) => {
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

  app.patch("/me/mileage/:id", workerGuard, async (req: any) => {
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
