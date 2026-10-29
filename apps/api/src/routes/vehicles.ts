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
import { portfolioWhere, portfolioWhereVia } from "../lib/portfolioScope";
import { WORKER_TYPES, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate } from "./_shared";

export default async function vehicleRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_equipmentCapital = requires("equipment.capital");
  const req_equipmentManage = requires("equipment.manage");
  const req_equipmentView = requires("equipment.view");
  const req_timeManage = requires("time.manage");
  const req_timeView = requires("time.view");

  // Vehicle list — the read-only feed powers the blended Vehicles
  // tab across all roles (staff). Mutations and the
  // per-vehicle mileage log remain super-guarded below.
  app.get("/vehicles", req_equipmentView, async (req: any) => {
    const { listVehicles } = await import("../services/vehicles");
    const includeArchived = req.query?.includeArchived === "true";
    return listVehicles({ includeArchived });
  });
  app.post("/vehicles", req_equipmentCapital, async (req: any) => {
    const { createVehicle } = await import("../services/vehicles");
    return createVehicle(await currentUserId(req), req.body ?? {});
  });
  app.patch("/vehicles/:id", req_equipmentCapital, async (req: any) => {
    const { updateVehicle } = await import("../services/vehicles");
    return updateVehicle(await currentUserId(req), req.params.id, req.body ?? {});
  });
  app.post("/vehicles/:id/archive", req_equipmentCapital, async (req: any) => {
    const { archiveVehicle } = await import("../services/vehicles");
    return archiveVehicle(await currentUserId(req), req.params.id);
  });
  app.post("/vehicles/:id/unarchive", req_equipmentCapital, async (req: any) => {
    const { unarchiveVehicle } = await import("../services/vehicles");
    return unarchiveVehicle(await currentUserId(req), req.params.id);
  });
  // Assign / unassign — the body carries the userId; the URL carries
  // the vehicleId.
  app.post("/vehicles/:id/assign", req_equipmentCapital, async (req: any) => {
    const { assignUserToVehicle } = await import("../services/vehicles");
    const userId = String(req.body?.userId ?? "");
    if (!userId) throw app.httpErrors.badRequest("userId is required");
    return assignUserToVehicle(await currentUserId(req), req.params.id, userId);
  });
  app.post("/vehicles/:id/unassign", req_equipmentCapital, async (req: any) => {
    const { unassignUserFromVehicle } = await import("../services/vehicles");
    const userId = String(req.body?.userId ?? "");
    if (!userId) throw app.httpErrors.badRequest("userId is required");
    return unassignUserFromVehicle(await currentUserId(req), req.params.id, userId);
  });
  // Backfill a mileage entry — `time.manage` override for the case where a
  // worker forgot to log a session in the moment. Body:
  //   { driverUserId, startedAt, endedAt, startOdometer, endOdometer, notes? }
  // Row is created closed (not open) with approvedAt: null so it
  // flows through the standard daily-approval queue.
  app.post("/vehicles/:id/mileage", req_timeManage, async (req: any) => {
    const { createMileageEntryFor } = await import("../services/mileage");
    const b = req.body ?? {};
    if (!b.driverUserId) throw app.httpErrors.badRequest("driverUserId is required");
    if (!b.startedAt) throw app.httpErrors.badRequest("startedAt is required");
    if (!b.endedAt) throw app.httpErrors.badRequest("endedAt is required");
    if (b.startOdometer == null) throw app.httpErrors.badRequest("startOdometer is required");
    if (b.endOdometer == null) throw app.httpErrors.badRequest("endOdometer is required");
    try {
      return await createMileageEntryFor({
        // Someone is backfilling on someone else's behalf — the audit row
        // has to name who did it, not just whose miles they are.
        actorUserId: await currentUserId(req),
        vehicleId: req.params.id,
        driverUserId: String(b.driverUserId),
        startedAt: new Date(b.startedAt),
        endedAt: new Date(b.endedAt),
        startOdometer: Number(b.startOdometer),
        endOdometer: Number(b.endOdometer),
        notes: b.notes ?? null,
      });
    } catch (err: any) {
      throw app.httpErrors.badRequest(err?.message || "Invalid mileage entry.");
    }
  });
  // Per-vehicle mileage log + totals for a date range.
  app.get("/vehicles/:id/mileage", req_timeView, async (req: any) => {
    const { listEntriesForVehicle, vehicleTotalsForRange } = await import("../services/mileage");
    const fromDate = req.query?.from ? String(req.query.from) : undefined;
    const toDate = req.query?.to ? String(req.query.to) : undefined;
    const [entries, totals] = await Promise.all([
      listEntriesForVehicle(req.params.id, { fromDate, toDate }),
      fromDate && toDate
        ? vehicleTotalsForRange(req.params.id, fromDate, toDate)
        : Promise.resolve(null),
    ]);
    return { entries, totals };
  });
  // view-as-allow: vehicles the CALLER is assigned to — feeds the
  // MileageStrip, which is only rendered in self-service mode
  // (HomeTab.tsx suppresses MileageStrip when isViewingOther is true).
  app.get("/me/vehicles", approvedUser, async (req: any) => {
    const { listAssignedVehiclesForUser } = await import("../services/vehicles");
    const uid = await services.currentUser.me(req.auth?.clerkUserId).then((u) => u.id);
    return listAssignedVehiclesForUser(uid);
  });
  // Per-vehicle driving summary for Home → MY VEHICLES. View-as aware:
  // someone using the Home worker picker on ONE person sees that person's
  // vehicles and their miles, which is the whole point of the picker.
  // Without the override this would render the CALLER's own vehicles under
  // the worker's name — the exact bug class docs/VIEW_AS_ENDPOINTS.md
  // exists to prevent.
  app.get("/me/vehicle-summary", approvedUser, async (req: any) => {
    const { assignedVehicleSummaryForUser } = await import("../services/mileage");
    const callerUid = await currentUserId(req);
    const { viewAsUserId, from, to } = (req.query || {}) as {
      viewAsUserId?: string;
      from?: string;
      to?: string;
    };
    let uid = callerUid;
    if (viewAsUserId && viewAsUserId !== callerUid) {
      const caller = await prisma.user.findUnique({
        where: { id: callerUid },
        
      });
      const canManagePeople = callerCan(req, "people.manage");
      if (!canManagePeople) throw app.httpErrors.forbidden("Viewing another worker's vehicles requires people authority.");
      uid = viewAsUserId;
    }
    return assignedVehicleSummaryForUser(uid, {
      fromDate: from ? String(from) : undefined,
      toDate: to ? String(to) : undefined,
    });
  });

}
