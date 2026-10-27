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

export default async function peopleRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_auditView = requires("audit.view");
  const req_peopleApprove = requires("people.approve");
  const req_peopleManage = requires("people.manage");
  const req_peopleView = requires("people.view");
  // `payroll.view` — "See imported payroll and what each person was paid".
  // The two cross-worker earnings reads below used to sit on `people.view`,
  // which is a ROSTER entitlement the baseline Trainee role holds and every
  // other role inherits: the least-privileged account in the system could
  // read every colleague's take-home and effective hourly rate. The
  // self-service equivalents (`/me/statistics`,
  // `/payments/earnings-summary`) are separate routes on `approvedUser`, so
  // nothing a worker needs went behind this.
  const req_payrollView = requires("payroll.view");
  const req_settingsManage = requires("settings.manage");

  app.get("/users", req_peopleView, async (req: any) => {
    const q = (req.query || {}) as {
      approved?: string; // "true" | "false"
      roleKey?: string;
      hasWorkerType?: string; // "true" — excludes customer-only logins
      role?: string; // DEAD. See below.
    };
    const approved =
      q.approved === "true" ? true : q.approved === "false" ? false : undefined;

    // A FILTER THIS ROUTE DOES NOT UNDERSTAND IS A BUG, NOT A NO-OP.
    //
    // `role=WORKER` named the deleted `Role` enum. This route quietly
    // ignored it, so six callers believed they were asking for staff and
    // were handed every customer login as well — including the pay-per-hour
    // cards, which rendered customers as team members. Silence is what made
    // it survive: the response was still a plausible list of people.
    if (q.role !== undefined) {
      throw app.httpErrors.badRequest(
        "`role` is not a filter on this route — the Role enum is deleted. " +
          "Use `hasWorkerType=true` to exclude customer logins, `roleKey=<key>` " +
          "for holders of one role, or GET /workers for who can be given work.",
      );
    }

    const rows = await services.users.list({
      approved,
      roleKey: q.roleKey,
      hasWorkerType: q.hasWorkerType === "true",
    });

    // SAME RULE AS `GET /users/:id`, AND A WORSE LEAK TO BEGIN WITH.
    //
    // `users.list` queries with `include` and no `select`, so EVERY User
    // scalar ships — `hourlyWage`, `email`, `phone`, `homeBaseAddress` — plus
    // the resolved role labels and capability list. On `people.view`, held by
    // the baseline Trainee role, that is the whole team's pay and contact
    // details plus a map of who can do what.
    //
    // Redacted here rather than in the service because the service is also
    // used where the full row is correct (exports, the `people.manage` directory).
    if (!callerCan(req, "people.manage")) {
      return rows.map((u: any) => {
        const { hourlyWage: _w, email: _e, phone: _p, homeBaseAddress: _a,
                roleGrants: _r, capabilities: _c, ...safe } = u;
        return safe;
      });
    }
    return rows;
  });
  // Approve a pending sign-up. Optional `linkContactId` in the body folds
  // the link-to-ClientContact step into the same transaction so the
  // operator can't accidentally leave the new user as a phantom — see
  // services/users.ts approve() for the full rationale.
  //
  // `people.approve` at the boundary. The UsersTab mutation surface was
  // already gated client-side, but the route once accepted anyone who
  // could reach the directory — this locks the policy at the route too.
  app.post("/users/:id/approve", req_peopleApprove, async (req: any) => {
    const body = (req.body || {}) as { linkContactId?: string | null };
    return services.users.approve(await currentUserId(req), req.params.id, {
      linkContactId: body.linkContactId ?? null,
    });
  });
  app.delete("/users/:id", req_peopleManage, async (req: any) => {
    // Hard delete a user (DB + Clerk)
    const targetId = String(req.params.id);
    const actorId = String(req.user?.id || "");
    return services.users.remove(await currentUserId(req), targetId, actorId);
  });
  app.get("/users/pendingCount", req_peopleView, async () => {
    return services.users.pendingApprovalCount();
  });
  // Per-user activity feed for the Users "Sign-ins & activity"
  // section. Returns AuditEvent rows where this user is the actor,
  // newest-first, cursor-paged (cursor = createdAt ISO string of the
  // oldest row in the previous page; pass nothing to get the first
  // page). `audit.view` — exposes other users' raw audit history, which
  // is broader access than the shell should grant.
  app.get("/users/:userId/activity", req_auditView, async (req: any) => {
    const userId = String(req.params.userId);
    const { cursor, limit } = (req.query || {}) as {
      cursor?: string;
      limit?: string;
    };
    // Clamp to keep payloads predictable. The UI's "Load more" button
    // pages at this size; larger requests need a bigger UI surface that
    // doesn't yet exist.
    const take = Math.min(50, Math.max(1, Number(limit) || 20));
    const where: any = { actorUserId: userId };
    if (cursor) {
      const d = new Date(cursor);
      if (!Number.isNaN(d.getTime())) where.createdAt = { lt: d };
    }
    // Pull `take + 1` so we can detect whether there's another page
    // without a second roundtrip. The extra row is dropped before
    // returning; its createdAt becomes the next cursor.
    const rows = await prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: take + 1,
      select: {
        id: true,
        scope: true,
        verb: true,
        action: true,
        metadata: true,
        createdAt: true,
      },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? items[items.length - 1].createdAt.toISOString() : null;
    return { items, nextCursor, hasMore };
  });
  app.get("/users/:id", req_peopleView, async (req: any) => {
    const userId = String(req.params.id);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, email: true, phone: true, firstName: true, lastName: true, displayName: true, workerType: true, homeBaseAddress: true, availableDays: true, availableHoursPerDay: true,
        hourlyWage: true,
        isApproved: true,
        // Compliance-policy status is served separately in Slice 4 admin
        // Compliance tab — no longer inlined on the user profile.
        paymentCommsMode: true,
      },
    });

    // A ROSTER IS NOT A PAY RECORD.
    //
    // `people.view` is "See the team and who is working" and the baseline
    // Trainee role holds it, so every role inherits it. This handler
    // nevertheless returned `hourlyWage`, `email`, `phone` and
    // `homeBaseAddress` with no redaction — which is the project rule on
    // worker-facing data broken outright: a worker must never be able to read
    // a colleague's wage, email or roles.
    //
    // The guard stays on `people.view`, because seeing WHO is on the team is
    // genuinely roster information. The sensitive columns require
    // `people.manage`. `callerCan` reads the principal, so someone with `people.manage` looking
    // through a narrowed perspective loses these fields too — which is the
    // point of a perspective.
    if (!callerCan(req, "people.manage")) {
      const { hourlyWage: _w, email: _e, phone: _p, homeBaseAddress: _a, ...safe } = user;
      return safe;
    }
    return user;
  });
  /**
   * Why can this person do that, and is it everywhere or only here.
   *
   * `people.manage` rather than `people.view`: this is the shape of
   * somebody's authority, which is not roster information. `people.view`
   * is held by the baseline Trainee role.
   */
  app.get("/users/:id/effective-permissions", req_peopleManage, async (req: any) =>
    services.customRoles.effectivePermissionsFor(String(req.params.id)),
  );
  app.patch("/users/:id/worker-type", req_peopleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    // worker-class-allow: normalising absent input, not deciding a pay class.
    if (body.workerType === null || body.workerType === "") {
      await services.users.setWorkerType(uid, userId, null);
      return { ok: true };
    }
    // Validated against the canonical vocabulary rather than a hand-written
    // list, which is how this route came to accept a worker type that had
    // been REMOVED while rejecting the one that replaced it — making the
    // current type unsettable through the UI, and still passing every type
    // check, because the list was prose rather than the enum.
    const wt = String(body.workerType).toUpperCase();
    if (!isWorkerType(wt)) {
      throw app.httpErrors.badRequest(
        `workerType must be one of ${WORKER_TYPES.join(", ")}`,
      );
    }
    await services.users.setWorkerType(uid, userId, wt);
    return { ok: true };
  });
  // Set/unset the LLC-owner flag on a user. `settings.manage` — it is a
  // fact about the business, not about the person, and nobody below that should be
  // able to self-assign this. Singleton enforcement lives in the service.
  // The LLC owner flag is a statement about the BUSINESS, not about a
  // person's job — it drives who the company is for tax purposes. It belongs
  // with the other business-identity settings, not with editing a profile.
  app.patch("/users/:id/owner", req_settingsManage, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    if (typeof body.isOwner !== "boolean") {
      throw app.httpErrors.badRequest("isOwner must be true or false");
    }
    await services.users.setIsOwner(uid, userId, body.isOwner);
    return { ok: true };
  });
  app.patch("/users/:id/home-base", req_peopleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    const nextAddress = body.address != null ? String(body.address).trim() || null : null;
    await prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id: userId },
        select: { homeBaseAddress: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: { homeBaseAddress: nextAddress },
      });
      // Records the home-base move — it's the origin point for deductible
      // mileage, so it feeds the worker's reimbursements.
      await writeAudit(tx, AUDIT.USER.PRIVILEGES_UPDATED, uid, {
        userId,
        action: "home_base_updated",
        homeBaseAddressBefore: before?.homeBaseAddress ?? null,
        homeBaseAddressAfter: nextAddress,
      });
    });
    return { ok: true };
  });
  // Per-worker "current hourly pay" panel data — Admin Jobs Home tab.
  //
  //   - Hours: WorkerWorkday rows for today, BOTH ended AND in-progress.
  //     For ended rows: active-ms = endedAt - startedAt - totalPausedMs.
  //     For in-progress rows: active-ms is computed against now (or
  //     against pausedAt if the worker is currently paused, since the
  //     open pause segment isn't yet folded into totalPausedMs). This
  //     surfaces "on the clock right now" workers immediately — before
  //     they had this we showed 0h all day for anyone still clocked in,
  //     which contradicted the "start your workday when you start your
  //     first job" prompt.
  //
  //   Workday-only is intentional. Workers do drive time, prep,
  //   admin, restock, etc. that isn't on any single job — payroll
  //   pays them for their clocked window, not just on-task minutes.
  //   When a worker's clocked window ends up shorter than their job
  //   times (they started/edited jobs outside the workday), the
  //   Workday Review flow is where that gets fixed — either the
  //   workday gets extended, or the job times get corrected. This
  //   panel deliberately reflects the current record so the mismatch
  //   is visible enough to prompt a review.
  //   - Net pay: sum of PaymentSplit.amount for occurrences whose
  //     completedAt lands today.
  //   - $/hr = netPaid / hoursActive (0 when no hours logged yet).
  //
  // Query: `?workerIds=id1,id2` filters to a subset; omit for all
  // approved workers. `people.view`.
  app.get("/workers/earnings-today", req_payrollView, async (req: any) => {
    const q = (req.query || {}) as { workerIds?: string };
    const requestedIds = q.workerIds
      ? String(q.workerIds).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const today = etToday();
    const dayStart = etMidnight(today);
    const dayEnd = etEndOfDay(today);

    const workers = await prisma.user.findMany({
      where: {
        workerType: { not: null },
        isApproved: true,
        ...(requestedIds && requestedIds.length > 0
          ? { id: { in: requestedIds } }
          : {}),
      },
      select: {
        id: true,
        displayName: true,
        email: true,
        workerType: true,
      },
      orderBy: { displayName: "asc" },
    });
    const userIds = workers.map((w) => w.id);
    if (userIds.length === 0) return [];

    // Hours from today's workdays — includes in-progress ones so
    // workers currently on the clock get credit for the hours they've
    // put in so far (previously showed 0h all day for those workers).
    const workdays = await prisma.workerWorkday.findMany({
      where: {
        workdayDate: today,
        userId: { in: userIds },
      },
      select: {
        userId: true,
        startedAt: true,
        endedAt: true,
        pausedAt: true,
        totalPausedMs: true,
      },
    });
    const nowMs = Date.now();
    const hoursByUser = new Map<string, number>();
    for (const w of workdays) {
      // Endpoint for the interval:
      //   - ended workday → endedAt (day is closed).
      //   - in-progress + not currently paused → now (still ticking).
      //   - in-progress + currently paused → pausedAt (interval is
      //     frozen at pause; the open pause segment isn't yet in
      //     totalPausedMs, so we clip the interval instead of trying
      //     to double-count it).
      const endMs = w.endedAt
        ? w.endedAt.getTime()
        : w.pausedAt
          ? w.pausedAt.getTime()
          : nowMs;
      const rawMs = endMs - w.startedAt.getTime();
      const activeMs = Math.max(0, rawMs - w.totalPausedMs);
      hoursByUser.set(w.userId, (hoursByUser.get(w.userId) ?? 0) + activeMs / 3_600_000);
    }

    // Jobs completed today with every field computeMyOccurrenceNet
    // needs to project each worker's promised net (before the
    // client's payment lands). This is the same source-of-truth path
    // reconcileWorkers + payroll exports use — snapshot when
    // present, projection otherwise, PaymentSplit only when confirmed.
    // Observers excluded from job count + earnings (they watched;
    // didn't earn).
    const completedOccs = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] as any },
        completedAt: { gte: dayStart, lte: dayEnd },
        assignees: {
          some: {
            userId: { in: userIds },
            OR: [{ role: null }, { role: { not: "observer" } }],
          },
        },
      },
      select: {
        id: true,
        price: true,
        proposalAmount: true,
        completionSplits: true,
        assignees: { select: { userId: true, role: true } },
        addons: { select: { price: true } },
        invoiceCharges: { select: { cost: true } },
        payment: {
          select: {
            confirmed: true,
            skippedAt: true,
            writtenOff: true,
            splits: {
              select: { userId: true, amount: true },
            },
          },
        },
      },
    });

    // Fetch worker rates once — computeMyOccurrenceNet needs the
    // per-worker fee/margin percent for the projection path.
    const { contractorFeePercent, employeeMarginPercent } = await (async () => {
      const { loadRates } = await import("../services/payments");
      return loadRates(prisma);
    })();
    const workerType = new Map(workers.map((w) => [w.id, w.workerType]));
    const rateFor = (userId: string) => {
      const t = workerType.get(userId);
      return rateForProjection(t, { contractorFeePercent, employeeMarginPercent });
    };

    const { computeMyOccurrenceNet } = await import("../services/workerEarnings");
    const jobIdsByUser = new Map<string, Set<string>>();
    const netByUser = new Map<string, number>();
    for (const occ of completedOccs) {
      for (const a of occ.assignees) {
        if (!userIds.includes(a.userId)) continue;
        if (a.role === "observer") continue;
        // Count the job.
        const set = jobIdsByUser.get(a.userId) ?? new Set<string>();
        set.add(occ.id);
        jobIdsByUser.set(a.userId, set);
        // Project this worker's earnings for this occurrence.
        // Scope payment.splits to this user before handing to the
        // helper — its contract says the sub-array must already be
        // filtered to the single caller.
        const paymentForUser = occ.payment
          ? {
              ...occ.payment,
              splits: occ.payment.splits.filter((s) => s.userId === a.userId),
            }
          : null;
        const net = computeMyOccurrenceNet(
          {
            price: occ.price,
            proposalAmount: occ.proposalAmount,
            completionSplits: occ.completionSplits,
            addons: occ.addons,
            invoiceCharges: occ.invoiceCharges,
            assignees: occ.assignees,
            payment: paymentForUser,
          },
          a.userId,
          rateFor(a.userId),
        );
        netByUser.set(a.userId, (netByUser.get(a.userId) ?? 0) + net);
      }
    }

    const userSet = new Set(userIds);

    // Workers with a currently-open job — status IN_PROGRESS or PAUSED,
    // that they're a non-observer assignee on. Drives the "in progress"
    // indicator on each row so the reader knows the Earned/$/hr number
    // is still trailing (will bump once they complete the job).
    const openJobs = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["IN_PROGRESS", "PAUSED"] as any },
        assignees: {
          some: {
            userId: { in: userIds },
            OR: [{ role: null }, { role: { not: "observer" } }],
          },
        },
      },
      select: {
        assignees: { select: { userId: true, role: true } },
      },
    });
    const inProgressUsers = new Set<string>();
    for (const occ of openJobs) {
      for (const a of occ.assignees) {
        if (a.role === "observer") continue;
        if (userSet.has(a.userId)) inProgressUsers.add(a.userId);
      }
    }

    // Only surface workers who've completed at least one job today.
    // Workers still on their first job of the day (or nothing yet) are
    // filtered out so the panel isn't a wall of "0 jobs · 0.00h · $0"
    // rows — they'll appear the moment their first completion lands.
    return workers
      .map((w) => {
        const hoursToday = hoursByUser.get(w.id) ?? 0;
        const netPaidToday = netByUser.get(w.id) ?? 0;
        const jobsCompleted = jobIdsByUser.get(w.id)?.size ?? 0;
        const equivalentHourlyRate = hoursToday > 0 ? netPaidToday / hoursToday : 0;
        return {
          userId: w.id,
          displayName: w.displayName ?? w.email ?? "Unknown",
          workerType: w.workerType,
          hoursToday: Math.round(hoursToday * 100) / 100,
          netPaidToday: Math.round(netPaidToday * 100) / 100,
          jobsCompleted,
          equivalentHourlyRate: Math.round(equivalentHourlyRate * 100) / 100,
          hasInProgressJob: inProgressUsers.has(w.id),
        };
      })
      .filter((r) => r.jobsCompleted > 0);
  });
  app.get("/users/:id/earnings-summary", req_payrollView, async (req: any) => {
    const userId = String(req.params.id);
    // ET-anchored period starts. On Vercel (UTC server), naive Date getters
    // would compute UTC week/month/year boundaries — wrong for an operator
    // working off the ET calendar. See lib/dates.ts for why we never
    // hand-roll this. Sunday-start to match the original behavior
    // (`now.getDay() === 0` → walks back to Sunday).
    const startOfWeek = etMidnight(etSundayOnOrBefore());
    const startOfMonth = etMidnight(etStartOfMonth());
    const startOfYear = etMidnight(etStartOfYear());

    // Business Start Date filter — see lib/businessStartCutoff.ts.
    const cutoff = await resolveCutoff(req);

    // Branch by target-worker type so this drilldown mirrors what the
    // person themselves sees on their own Profile → Payments.
    // EMPLOYEE: bucket each assigned job by work date at its
    // promised net (paid or unpaid) via computeMyOccurrenceNet.
    // CONTRACTOR / unclassified: cash-basis on confirmed splits —
    // matches the contractor branch of the self endpoint.
    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { workerType: true },
    });
    const isEmployeeTarget = isW2(target?.workerType);
    const settingKey = isEmployeeTarget ? "EMPLOYEE_BUSINESS_MARGIN_PERCENT" : "CONTRACTOR_PLATFORM_FEE_PERCENT";
    const setting = await prisma.setting.findUnique({ where: { key: settingKey } });
    const targetRate = Number(setting?.value ?? 0);

    let thisWeek = 0, thisMonth = 0, thisYear = 0, allTime = 0;
    const byMethod: Record<string, number> = {};
    let jobCount = 0;

    if (isEmployeeTarget) {
      const { computeMyOccurrenceNet } = await import("../services/workerEarnings");
      const occs = await prisma.jobOccurrence.findMany({
        where: {
          assignees: { some: { userId, OR: [{ role: null }, { role: { not: "observer" } }] } },
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          status: { notIn: ["CANCELED", "ARCHIVED"] as any },
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
              splits: { where: { userId }, select: { amount: true } },
            },
          },
        },
      });
      for (const occ of occs) {
        const when = occ.completedAt ?? occ.startAt;
        if (!when) continue;
        const value = computeMyOccurrenceNet(occ, userId, targetRate);
        if (value <= 0) continue;
        allTime += value;
        if (when >= startOfWeek) thisWeek += value;
        if (when >= startOfMonth) thisMonth += value;
        if (when >= startOfYear) thisYear += value;
        if (
          occ.payment &&
          !occ.payment.skippedAt &&
          occ.payment.confirmed &&
          occ.payment.method &&
          (occ.payment.splits?.length ?? 0) > 0
        ) {
          byMethod[occ.payment.method] = (byMethod[occ.payment.method] ?? 0) + value;
        }
        jobCount++;
      }
    } else {
      const splits = await prisma.paymentSplit.findMany({
        where: {
          userId,
          // Skipped payments' splits are excluded from every earnings tile.
          payment: {
            skippedAt: null,
            ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
          },
        },
        include: { payment: { select: { createdAt: true, method: true } } },
      });
      for (const sp of splits) {
        allTime += sp.amount;
        const d = sp.payment.createdAt;
        if (d >= startOfWeek) thisWeek += sp.amount;
        if (d >= startOfMonth) thisMonth += sp.amount;
        if (d >= startOfYear) thisYear += sp.amount;
        byMethod[sp.payment.method] = (byMethod[sp.payment.method] ?? 0) + sp.amount;
        jobCount++;
      }
    }

    return {
      thisWeek: Math.round(thisWeek * 100) / 100,
      thisMonth: Math.round(thisMonth * 100) / 100,
      thisYear: Math.round(thisYear * 100) / 100,
      allTime: Math.round(allTime * 100) / 100,
      jobCount,
      byMethod,
    };
  });
  app.patch("/users/:id/profile", req_peopleManage, async (req: any) => {
    const uid = await currentUserId(req);
    const userId = String(req.params.id);
    const body = req.body || {};
    const data: any = {};
    if (body.homeBaseAddress !== undefined) data.homeBaseAddress = body.homeBaseAddress ? String(body.homeBaseAddress).trim() : null;
    if (body.availableDays !== undefined) data.availableDays = Array.isArray(body.availableDays) ? JSON.stringify(body.availableDays) : null;
    if (body.availableHoursPerDay !== undefined) data.availableHoursPerDay = body.availableHoursPerDay != null ? Number(body.availableHoursPerDay) : null;
    // Wage is PAYROLL AUTHORITY, not seniority. Holders of `people.manage` hold `people.manage`
    // and can VIEW the field on any profile; writing it needs
    // `payroll.manage`, which the starter ladder grants at the top tier — so
    // the behaviour is unchanged, while an operator can now hand wage
    // editing to a bookkeeper without making them someone with `people.approve`.
    //
    // This read a role off the request.
    // `req.user.roles` no longer exists, so the array was always `[]` and
    // the gate refused EVERYONE — someone with `people.approve` included. Nobody could set a wage
    // through this endpoint, and nothing failed to compile to say so,
    // because the any-cast hid the removed field. `callerCan` is typed
    // against the entitlement union, so the next removal is a build error.
    if (body.hourlyWage !== undefined) {
      if (!callerCan(req, "payroll.manage")) {
        throw app.httpErrors.forbidden("Updating a wage requires payroll authority.");
      }
      const n = body.hourlyWage == null ? 0 : Number(body.hourlyWage);
      if (!Number.isFinite(n) || n < 0) throw app.httpErrors.badRequest("hourlyWage must be a non-negative number.");
      data.hourlyWage = Math.round(n * 100) / 100;
    }
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
    await prisma.$transaction(async (tx) => {
      const before = await tx.user.findUnique({
        where: { id: userId },
        select: {
          hourlyWage: true,
          homeBaseAddress: true,
          availableDays: true,
          availableHoursPerDay: true,
          phone: true,
          firstName: true,
          lastName: true,
          displayName: true,
        },
      });
      await tx.user.update({ where: { id: userId }, data });
      const wageChanged = "hourlyWage" in data && data.hourlyWage !== (before?.hourlyWage ?? null);
      const detail = {
        userId,
        action: wageChanged ? "wage_updated" : "profile_updated",
        changedFields: Object.keys(data),
        // Money: hourlyWage drives payroll, so it always carries before/after
        // even when the edit also touched non-money profile fields.
        hourlyWageBefore: before?.hourlyWage ?? null,
        hourlyWageAfter: "hourlyWage" in data ? data.hourlyWage : (before?.hourlyWage ?? null),
        homeBaseAddressBefore: before?.homeBaseAddress ?? null,
        homeBaseAddressAfter: "homeBaseAddress" in data ? data.homeBaseAddress : (before?.homeBaseAddress ?? null),
        availableDaysBefore: before?.availableDays ?? null,
        availableDaysAfter: "availableDays" in data ? data.availableDays : (before?.availableDays ?? null),
        availableHoursPerDayBefore: before?.availableHoursPerDay ?? null,
        availableHoursPerDayAfter:
          "availableHoursPerDay" in data ? data.availableHoursPerDay : (before?.availableHoursPerDay ?? null),
        phoneBefore: before?.phone ?? null,
        phoneAfter: "phone" in data ? data.phone : (before?.phone ?? null),
        firstNameBefore: before?.firstName ?? null,
        firstNameAfter: "firstName" in data ? data.firstName : (before?.firstName ?? null),
        lastNameBefore: before?.lastName ?? null,
        lastNameAfter: "lastName" in data ? data.lastName : (before?.lastName ?? null),
        displayNameBefore: before?.displayName ?? null,
        displayNameAfter: "displayName" in data ? data.displayName : (before?.displayName ?? null),
      };
      // A wage change is payroll-affecting and gets its own verb; everything
      // else on this endpoint is ordinary profile bookkeeping.
      await writeAudit(
        tx,
        wageChanged ? AUDIT.USER.WAGE_UPDATED : AUDIT.USER.PRIVILEGES_UPDATED,
        uid,
        detail,
      );
    });
    return { ok: true };
  });
  // Cascade preview for archiving a user — shows which groups they're in
  // so the UI can ask a caller with `people.manage` to resolve claimer-of relationships
  // before allowing the user soft-delete.
  app.get("/users/:id/group-archive-cascade", req_peopleView, async (req: any) => {
    return services.groups.previewUserArchiveCascade(String(req.params.id));
  });
  app.get("/workers", req_peopleView, async () => {
    // WHO IS A WORKER IS A CAPABILITY QUESTION, NOT A ROLE NAME.
    //
    // This filtered on `roleKey: "seedlings.worker"`. `seedlings.worker`
    // is a CustomRole the starter script installs — an operator may rename
    // it, delete it, or build their own structure that never contains it,
    // and this list would then be wrong or empty with nothing to explain
    // why. It also silently excluded anyone holding the equivalent access
    // through an area assignment, since the role filter reads company-wide
    // grants only.
    //
    // `work.claim` is the thing actually meant: clearance to pick work up.
    // The per-row `fieldCleared` below was ALREADY computed from it, so the
    // route was filtering by one rule and reporting by another.
    const list = await services.users.list({ approved: true });
    // `fieldCleared` is included because view-as needs it and CANNOT derive
    // it. It used to be read off workerType — a pay-class comparison —
    // which conflated payroll with permission. Clearance is a capability,
    // so the only honest source is the server resolving it; a client guessing
    // from worker type renders the wrong perspective for the person being viewed.
    // One query for the whole roster rather than one per person.
    const caps = await capabilitiesForUsers(prisma, list.map((u) => u.id));
    return list
      .filter((u) => caps.get(u.id)?.has("work.claim"))
      .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      email: u.email,
      workerType: u.workerType,
      // `work.claim`, not `inventory.pull` — the two are only coupled in
      // the starter ladder, and the grantable "May pull inventory" role
      // separates them deliberately. Clearance to do field work is the
      // authority to pick work up. The web's `isFieldCleared` asks the
      // same thing; when these two disagreed, view-as rendered a claim
      // control the claim route would refuse.
        // Always true now that it is the filter, kept because the shape is
        // part of this endpoint's contract and view-as reads it.
        fieldCleared: true,
      }));
  });
  // Sanitized team roster for worker-facing directory views.
  // Returns approved workers with ONLY displayName + workerType (no
  // email, phone, wage, role labels, privilege flags). Sibling of
  // /workers which returns richer data for admin callers.
  // view-as-allow: identical output for every caller — no viewer-specific
  // scoping needed.
  app.get("/me/team", approvedUser, async () => {
    // Same rule as /workers above, and for the same reason: the roster is
    // "people cleared to do field work", which is `work.claim`, not
    // whoever happens to hold a role named Worker.
    const list = await services.users.list({ approved: true });
    const caps = await capabilitiesForUsers(prisma, list.map((u) => u.id));
    return list
      .filter((u) => caps.get(u.id)?.has("work.claim"))
      .map((u) => ({
        id: u.id,
        displayName: u.displayName,
        workerType: u.workerType,
      }));
  });
  // view-as-allow: worker's own statistics (Home / Statistics tab).
  // Admin's cross-worker Statistics view hits /statistics with a
  // workerIds filter instead — the view-as pattern isn't used here.
  //
  // Self-scoped statistics — the same logic as the full statistics endpoint,
  // narrowed to the caller.
  app.get("/me/statistics", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    // Could delegate to the full statistics logic; inlined here instead.
    const from = req.query?.from as string | undefined;
    const to = req.query?.to as string | undefined;

    const dateFilter: any = {};
    if (from) dateFilter.gte = etMidnight(from as EtDateKey);
    if (to) dateFilter.lte = etEndOfDay(to as EtDateKey);
    const hasDate = from || to;

    // Business Start Date filter — mirror /statistics so the BSD
    // toggle behaves identically regardless of whether the StatisticsTab
    // hits a caller with `people.manage` or personal endpoint. Same Pattern C (occurrence work
    // date) + Pattern B (nested payment/expenses) layering. the reveal
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
          select: { amountPaid: true, method: true, confirmed: true, skippedAt: true, platformFeeAmount: true, businessMarginAmount: true, splits: { select: { userId: true, amount: true } } },
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
      },
    });
    if (!user) return { workers: [], totalOccurrences: 0, daysInRange: 0 };

    // Build stats for just this user
    let jobsCompleted = 0, totalEarnings = 0, totalExpenses = 0, totalActualMinutes = 0,
      totalEstimatedMinutes = 0, jobsWithTiming = 0;
    const paymentMethods: Record<string, number> = {};
    const jobsByDay: Record<string, number> = {};
    const propertySet = new Set<string>();

    // Rate + helper for the employee projection path.
    const _isEmployeeSelf = isW2(user.workerType);
    const _statsSettingKey = _isEmployeeSelf ? "EMPLOYEE_BUSINESS_MARGIN_PERCENT" : "CONTRACTOR_PLATFORM_FEE_PERCENT";
    const _statsSetting = await prisma.setting.findUnique({ where: { key: _statsSettingKey } });
    const _statsRate = Number(_statsSetting?.value ?? 0);
    const { computeMyOccurrenceNet: _statsComputeNet } = await import("../services/workerEarnings");

    for (const occ of occurrences) {
      if (occ.workflow === "ESTIMATE" || occ.isEstimate) continue;
      jobsCompleted++;
      const actualMinutes = occ.startedAt && occ.completedAt
        ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000) : null;
      const expenseTotal = occ.invoiceCharges.reduce((s, e) => s + e.cost, 0);
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
            invoiceCharges: occ.invoiceCharges,
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
        earnings = split?.amount ?? 0;
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

      // CHARGES NEVER COME OUT OF A WORKER'S PAY. This subtracted the
      // worker's pro-rata share of the job's invoice charges from what they
      // earned — the OLD model, where a job "expense" reduced the pool the
      // crew split. The client pays the charges on top and the pool never
      // sees them, so the worker's productivity stats were docked for
      // materials they never paid for.
      //
      // `totalExpenses` is kept as context — what was billed on the jobs they
      // worked — but it is not a deduction and no longer behaves like one.
    const netEarnings = totalEarnings;
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
  app.patch("/me/home-base", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const body = req.body || {};
    const priorHomeBase = await prisma.user.findUnique({
      where: { id: uid },
      select: { homeBaseAddress: true },
    });
    const nextHomeBase = body.address != null ? String(body.address).trim() || null : null;
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: uid },
        data: { homeBaseAddress: nextHomeBase },
      });
      // Records the worker changing their own home base, which moves the origin
      // every route/mileage calculation is measured from.
      await writeAudit(tx, AUDIT.USER.PRIVILEGES_UPDATED, uid, {
        userId: uid,
        action: "home_base_updated",
        beforeHomeBaseAddress: priorHomeBase?.homeBaseAddress ?? null,
        afterHomeBaseAddress: nextHomeBase,
      });
    });
    return { ok: true };
  });
  // Update own profile (availability)
  app.patch("/me/profile", approvedUser, async (req: any) => {
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
    const priorProfile = await prisma.user.findUnique({
      where: { id: uid },
      select: {
        homeBaseAddress: true,
        availableDays: true,
        availableHoursPerDay: true,
        phone: true,
        firstName: true,
        lastName: true,
        displayName: true,
      },
    });
    const profileBefore: Record<string, unknown> = {};
    const profileAfter: Record<string, unknown> = {};
    for (const k of Object.keys(data)) {
      profileBefore[`before_${k}`] = (priorProfile as any)?.[k] ?? null;
      profileAfter[`after_${k}`] = data[k] ?? null;
    }
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: uid }, data });
      // Records the worker editing their own profile — name, phone, and the
      // availability window that scheduling assigns work against.
      await writeAudit(tx, AUDIT.USER.PRIVILEGES_UPDATED, uid, {
        userId: uid,
        action: "profile_updated",
        changedFields: Object.keys(data).join(","),
        ...profileBefore,
        ...profileAfter,
      });
    });
    return { ok: true };
  });

}
