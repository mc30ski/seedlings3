import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Role as RoleVal } from "@prisma/client";
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
// An admin's response must not contain tax fields at all — hiding them in
// the UI would leave them in the payload.
// ─────────────────────────────────────────────────────────────────────────────

async function currentUserId(req: any): Promise<string> {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

async function callerRoles(userId: string): Promise<{ isAdmin: boolean; isSuper: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { roles: true } });
  const isSuper = user?.roles?.some((r) => r.role === "SUPER") ?? false;
  const isAdmin = isSuper || (user?.roles?.some((r) => r.role === "ADMIN") ?? false);
  return { isAdmin, isSuper };
}

/**
 * Viewer for the admin/super surfaces. SUPER outranks ADMIN, so a Super
 * gets the full projection rather than the reduced one.
 */
async function operatorViewer(req: any): Promise<PayrollViewer> {
  const me = await currentUserId(req);
  const { isSuper } = await callerRoles(me);
  return isSuper ? { kind: "super" } : { kind: "admin" };
}

/**
 * Resolve whose payroll a `/me/payroll*` request is for.
 *
 * Mirrors resolveWorkdayTarget in routes/worker.ts. Reading another
 * worker's payroll requires ADMIN or SUPER; there are no view-as MUTATIONS
 * on payroll at all, since every mutation is Super-only and operates on a
 * period rather than on a person.
 *
 * IMPORTANT: an admin viewing a worker through this path still receives the
 * WORKER projection (full detail), because they are explicitly standing in
 * that worker's shoes — that is what view-as means, and it is the same
 * data the worker sees on their own screen. The hours/gross/net restriction
 * applies to the ADMIN surfaces under /payroll/*, where an admin is looking
 * at the team as an admin.
 */
async function resolvePayrollTarget(req: any): Promise<{ targetUserId: string }> {
  const raw = req.query?.viewAsUserId;
  const target = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  const me = await currentUserId(req);

  if (!target || target === me) return { targetUserId: me };

  const { isAdmin } = await callerRoles(me);
  if (!isAdmin) {
    throw new ServiceError(
      "FORBIDDEN",
      "Admin or Super role required to view another worker's payroll.",
      403,
    );
  }
  return { targetUserId: target };
}

export default async function payrollRoutes(app: FastifyInstance) {
  const workerGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.WORKER),
  };
  const adminGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.ADMIN),
  };
  const superGuard = {
    preHandler: (req: FastifyRequest, reply: FastifyReply) =>
      app.requireRole(req, reply, RoleVal.SUPER),
  };

  // ── Worker surfaces ────────────────────────────────────────────────────
  // All three are view-as-aware: ?viewAsUserId=<id> behind an ADMIN/SUPER
  // gate, per docs/VIEW_AS_ENDPOINTS.md.

  /** Periods this worker actually appears in, newest pay day first. */
  app.get("/me/payroll", workerGuard, async (req: any) => {
    void req.query?.viewAsUserId; // documented in resolvePayrollTarget
    const { targetUserId } = await resolvePayrollTarget(req);
    return listPeriods({ kind: "worker", userId: targetUserId });
  });

  /**
   * Home-tab summary — most recent row only. Returns null when the worker
   * has no payroll on record (every contractor today), which the client
   * renders as an empty state rather than an error.
   */
  app.get("/me/payroll/latest", workerGuard, async (req: any) => {
    void req.query?.viewAsUserId;
    const { targetUserId } = await resolvePayrollTarget(req);
    return getMyLatest(targetUserId);
  });

  /**
   * "Is a pay period of mine sitting unmatched?" — see
   * getPendingMatchNotice for why this is targeted rather than broadcast.
   * Returns a flag and a date only; never a name or an amount.
   */
  app.get("/me/payroll/pending-match", workerGuard, async (req: any) => {
    void req.query?.viewAsUserId;
    const { targetUserId } = await resolvePayrollTarget(req);
    return getPendingMatchNotice(targetUserId);
  });

  /** One period's detail, scoped server-side to this worker's own row. */
  app.get("/me/payroll/:periodId", workerGuard, async (req: any) => {
    void req.query?.viewAsUserId;
    const { targetUserId } = await resolvePayrollTarget(req);
    const period = await prisma.payrollPeriod.findFirst({
      where: { id: req.params.periodId, archivedAt: null },
    });
    if (!period) throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);

    const entries = await listEntries(period.id, { kind: "worker", userId: targetUserId });
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

  app.get("/payroll/periods", adminGuard, async (req: any) => {
    return listPeriods(await operatorViewer(req));
  });

  /**
   * Entries for a period. `?userId=` narrows to one worker — the "combined
   * unless you select a worker" behaviour. Without it, an admin gets every
   * matched worker's hours/gross/net.
   */
  app.get("/payroll/periods/:id/entries", adminGuard, async (req: any) => {
    const viewer = await operatorViewer(req);
    const forUserId =
      typeof req.query?.userId === "string" && req.query.userId.trim()
        ? req.query.userId.trim()
        : null;

    const period = await prisma.payrollPeriod.findUnique({ where: { id: req.params.id } });
    if (!period) throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);
    if (period.archivedAt && viewer.kind !== "super") {
      throw new ServiceError("NOT_FOUND", "Payroll period not found.", 404);
    }

    return {
      id: period.id,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      payDay: period.payDay,
      label: period.label,
      archivedAt: viewer.kind === "super" ? period.archivedAt : undefined,
      // The employer's side for the whole run, from Gusto's own "Payroll
      // Totals" row rather than summed client-side. The import's
      // conservation check already proved the entries sum to it, so the two
      // agree — but the stored row is the figure Gusto reported, and that
      // is what an operator reconciles against.
      employerTotals: employerTotalsFor(period, viewer),
      entries: await listEntries(period.id, viewer, forUserId),
    };
  });

  // ── Mutations — Super only ─────────────────────────────────────────────

  /**
   * Import a Gusto payroll journal.
   *
   * The client POSTs the raw CSV text (these files are a few KB), so there
   * is no presigned two-step. The original is written to R2 BEFORE parsing
   * so a file that fails validation is still recoverable for diagnosis —
   * the operator should not have to re-export to find out what was wrong.
   */
  app.post("/payroll/import", superGuard, async (req: any, reply: any) => {
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
  app.get("/payroll/identities/unmatched", superGuard, async () => {
    return listUnmatchedNames();
  });

  /** Confirm a payroll name belongs to an app user, back-filling history. */
  app.post("/payroll/identities", superGuard, async (req: any) => {
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
  app.delete("/payroll/identities", superGuard, async (req: any) => {
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
  app.post("/payroll/periods/:id/archive", superGuard, async (req: any) => {
    const actorUserId = await currentUserId(req);
    await archivePeriod({ periodId: req.params.id, actorUserId });
    return { ok: true };
  });
}
