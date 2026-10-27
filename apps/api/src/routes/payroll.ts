import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "crypto";
import { prisma } from "../db/prisma";
import { services } from "../services";
import { ServiceError } from "../lib/errors";
import { putObjectText } from "../lib/r2";
import { etToday } from "../lib/dates";
import {
  importPayrollCsv,
  listPeriods,
  listEntries,
  getMyLatest,
  getPendingMatchNotice,
  listUnmatchedNames,
  linkIdentity,
  unlinkIdentity,
  archivePeriod,
  employerTotalsFor,
  PayrollConservationError,
  type PayrollViewer,
} from "../services/payroll";
import { PayrollParseError } from "../services/payrollImport";
import { makeGuards } from "../lib/routeGuards";
import { callerCan } from "../lib/callerCan";
import { capabilitiesForUsers } from "../lib/userCapabilities";

// ─────────────────────────────────────────────────────────────────────────────
// Payroll routes. Canonical spec: docs/features/payroll.md.
//
// THE VISIBILITY MATRIX IS ENFORCED HERE AND IN services/payroll.ts, never
// in the client:
//   worker -> own rows, full detail        (GET /me/payroll*)
//   admin  -> any worker, hours/gross/net  (GET /payroll/*)
//   super  -> any worker, full detail      (GET /payroll/*, + mutations)
//
// The `viewer` passed into the service decides which columns are SERIALIZED.
// Someone with `payroll.manage`'s response must not contain tax fields at all — hiding them in
// the UI would leave them in the payload.
// ─────────────────────────────────────────────────────────────────────────────

async function currentUserId(req: any): Promise<string> {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

/**
 * Payroll visibility is three-tier: your own row, an operator's read-only
 * view, and the person who may rewrite it. That is `payroll.view` vs `payroll.manage`;
 * it is now the two payroll capabilities, which is what those roles were
 * standing in for — and means the operator can hand payroll to a bookkeeper
 * without handing over the rest of the business.
 */
/**
 * READ OFF THE PRINCIPAL, NOT THE DATABASE.
 *
 * This resolved the CALLER with `capabilitiesForUsers(prisma, [userId])` — a
 * fresh read by id, which returns the person's REAL grants and ignores any
 * active perspective. Someone with `payroll.manage` looking through the Trainee perspective kept full
 * payroll authority, which is the view-as bypass this repo has shipped three
 * times. `callerCan` reads `req.principal`, already narrowed, and needs no
 * query at all.
 */
function callerPayrollAccess(req: any): { canView: boolean; canManage: boolean } {
  const canManage = callerCan(req, "payroll.manage");
  return { canView: canManage || callerCan(req, "payroll.view"), canManage };
}

/**
 * Viewer for the operator surfaces. `payroll.manage` outranks `payroll.view`,
 * so a manager gets the full projection rather than the reduced one.
 */
async function operatorViewer(req: any): Promise<PayrollViewer> {
  return callerPayrollAccess(req).canManage ? { kind: "manager" } : { kind: "operator" };
}

/**
 * Resolve whose payroll a `/me/payroll*` request is for.
 *
 * Mirrors resolveWorkdayTarget in routes/time.ts. Reading somebody else's
 * payroll requires `payroll.view`; there are no view-as MUTATIONS on payroll
 * at all, since every mutation needs `payroll.manage` and operates on a
 * period rather than on a person.
 *
 * IMPORTANT: somebody viewing a worker through this path still receives the
 * `self` projection (full detail), because they are explicitly standing in
 * that worker's shoes — that is what view-as means, and it is the same
 * data the worker sees on their own screen. The hours/gross/net restriction
 * applies to the operator surfaces under /payroll/*, where someone with `payroll.manage` is looking
 * at the team as someone with `payroll.manage`.
 */
async function resolvePayrollTarget(req: any): Promise<{ targetUserId: string }> {
  const raw = req.query?.viewAsUserId;
  const target = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  const me = await currentUserId(req);

  if (!target || target === me) return { targetUserId: me };

  if (!callerPayrollAccess(req).canView) {
    throw new ServiceError(
      "FORBIDDEN",
      "Admin or Super role required to view another worker's payroll.",
      403,
    );
  }
  return { targetUserId: target };
}

export default async function payrollRoutes(app: FastifyInstance) {
  // `/me/payroll*` is OWNERSHIP — "my own payroll" is never an entitlement —
  // so those four keep the plain role check.
  //
  // The rest split by verb.
  const { requires, approvedUser } = makeGuards(app);
  const payrollView = requires("payroll.view");
  const payrollManage = requires("payroll.manage");

  // THE IDENTITY QUEUE IS payroll.manage, NOT payroll.view.
  //
  // An earlier pass put it on `payroll.view` and justified the widening in a
  // comment — "reading unmatched names is not an owner-only act". That was my
  // call to make and it was not mine: docs/features/payroll.md says the queue
  // "surfaces in three places, all `payroll.manage`", and a spec asserts a caller without it
  // gets 403 from it.
  //
  // The doc is right on the merits too. An unmatched row is a Gusto name the
  // system could not attach to a person, so the queue is a list of real
  // people's pay attached to nobody — and matching one is the act that
  // decides whose wages those were. That is payroll administration, not
  // reading.
  // Spelled out rather than aliased to `payrollManage`: the route-map gate
  // reads `requires("...")` literals, so an alias makes a route invisible to
  // it — the guard would be right and nothing would be checking.
  const payrollIdentities = requires("payroll.manage");

  // ── Worker surfaces ────────────────────────────────────────────────────
  // All three are view-as-aware: ?viewAsUserId=<id> behind a `payroll.view` holder
  // gate, per docs/VIEW_AS_ENDPOINTS.md.

  /** Periods this worker actually appears in, newest pay day first. */
  app.get("/me/payroll", approvedUser, async (req: any) => {
    void req.query?.viewAsUserId; // documented in resolvePayrollTarget
    const { targetUserId } = await resolvePayrollTarget(req);
    return listPeriods({ kind: "self", userId: targetUserId });
  });

  /**
   * Home-tab summary — most recent row only. Returns null when the worker
   * has no payroll on record (every contractor today), which the client
   * renders as an empty state rather than an error.
   */
  app.get("/me/payroll/latest", approvedUser, async (req: any) => {
    void req.query?.viewAsUserId;
    const { targetUserId } = await resolvePayrollTarget(req);
    return getMyLatest(targetUserId);
  });

  /**
   * "Is a pay period of mine sitting unmatched?" — see
   * getPendingMatchNotice for why this is targeted rather than broadcast.
   * Returns a flag and a date only; never a name or an amount.
   */
  app.get("/me/payroll/pending-match", approvedUser, async (req: any) => {
    void req.query?.viewAsUserId;
    const { targetUserId } = await resolvePayrollTarget(req);
    return getPendingMatchNotice(targetUserId);
  });

  /** One period's detail, scoped server-side to this worker's own row. */
  app.get("/me/payroll/:periodId", approvedUser, async (req: any) => {
    void req.query?.viewAsUserId;
    const { targetUserId } = await resolvePayrollTarget(req);
    const period = await prisma.payrollPeriod.findFirst({
      where: { id: req.params.periodId, archivedAt: null },
    });
    if (!period) throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);

    const entries = await listEntries(period.id, { kind: "self", userId: targetUserId });
    // A worker with no row in this period gets a 404, not an empty period —
    // otherwise the endpoint confirms the existence of periods they have no
    // business enumerating.
    if (entries.length === 0) {
      throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);
    }
    return {
      id: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDay: period.payDay,
      label: period.label,
      entries,
    };
  });

  // ── Operator surfaces (Admin sees a reduced projection) ────────────────

  app.get("/payroll/periods", payrollView, async (req: any) => {
    return listPeriods(await operatorViewer(req));
  });

  /**
   * Entries for a period. `?userId=` narrows to one worker — the "combined
   * unless you select a worker" behaviour. Without it, someone with `payroll.manage` gets every
   * matched worker's hours/gross/net.
   */
  app.get("/payroll/periods/:id/entries", payrollView, async (req: any) => {
    const viewer = await operatorViewer(req);
    const forUserId =
      typeof req.query?.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : null;

    const period = await prisma.payrollPeriod.findUnique({ where: { id: req.params.id } });
    if (!period) throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);
    if (period.archivedAt && viewer.kind !== "manager") {
      throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);
    }

    return {
      id: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDay: period.payDay,
      label: period.label,
      archivedAt: viewer.kind === "manager" ? period.archivedAt : undefined,
      // The employer's side for the whole run, from Gusto's own "Payroll
      // Totals" row rather than summed client-side. The import's
      // conservation check already proved the entries sum to it, so the two
      // agree — but the stored row is the figure Gusto reported, and that
      // is what an operator reconciles against.
      employerTotals: employerTotalsFor(period, viewer),
      entries: await listEntries(period.id, viewer, forUserId),
    };
  });

  // ── Mutations — `payroll.manage` ─────────────────────────────────────────────

  /**
   * Import a Gusto payroll journal.
   *
   * The client POSTs the raw CSV text (these files are a few KB), so there
   * is no presigned two-step. The original is written to R2 BEFORE parsing
   * so a file that fails validation is still recoverable for diagnosis —
   * the operator should not have to re-export to find out what was wrong.
   */
  app.post("/payroll/import", payrollManage, async (req: any, reply: any) => {
    const csvText = typeof req.body?.csvText === "string" ? req.body.csvText : "";
    const filename = typeof req.body?.filename === "string" ? req.body.filename : "payroll.csv";
    if (!csvText.trim()) {
      throw new ServiceError("BAD_REQUEST", "No CSV content supplied.", 400);
    }

    const actorUserId = await currentUserId(req);
    // ET date-key prefix so the R2 listing sorts chronologically. Uses the
    // canonical helper — a bare `new Date()` here would resolve in the
    // server's zone and file a late-evening upload under the next day.
    const sourceR2Key = `payroll/${etToday()}/${randomUUID()}-${filename.replace(/[^\w.\-]/g, "_")}`;
    await putObjectText(sourceR2Key, csvText, "text/csv", "docs");

    try {
      const results = await importPayrollCsv({ csvText, sourceR2Key, actorUserId });
      return { ok: true, periods: results };
    } catch (err) {
      if (err instanceof PayrollConservationError) {
        return reply.code(422).send({
          ok: false,
          error: "PAYROLL_DOES_NOT_BALANCE",
          message: err.message,
          mismatches: err.mismatches,
        });
      }
      if (err instanceof PayrollParseError) {
        return reply.code(422).send({
          ok: false,
          error: "PAYROLL_UNREADABLE",
          message: err.message,
        });
      }
      throw err;
    }
  });

  /** Names with no confirmed identity — the review queue. */
  app.get("/payroll/identities/unmatched", payrollIdentities, async () => {
    return listUnmatchedNames();
  });

  /** Confirm a payroll name belongs to an app user, back-filling history. */
  app.post("/payroll/identities", payrollManage, async (req: any) => {
    const { lastName, firstName, userId } = req.body ?? {};
    if (!lastName || !firstName || !userId) {
      throw new ServiceError("BAD_REQUEST", "lastName, firstName and userId are required.", 400);
    }
    const actorUserId = await currentUserId(req);
    return linkIdentity({
      lastName: String(lastName),
      firstName: String(firstName),
      userId: String(userId),
      actorUserId,
    });
  });

  /** Undo a mapping — a wrong link means someone saw another person's pay. */
  app.delete("/payroll/identities", payrollManage, async (req: any) => {
    const { lastName, firstName } = req.body ?? {};
    if (!lastName || !firstName) {
      throw new ServiceError("BAD_REQUEST", "lastName and firstName are required.", 400);
    }
    const actorUserId = await currentUserId(req);
    return unlinkIdentity({
      lastName: String(lastName),
      firstName: String(firstName),
      actorUserId,
    });
  });

  /** Soft-delete a period (archivedAt). Snapshots what it hides. */
  app.post("/payroll/periods/:id/archive", payrollManage, async (req: any) => {
    const actorUserId = await currentUserId(req);
    await archivePeriod({ periodId: req.params.id, actorUserId });
    return { ok: true };
  });
}
