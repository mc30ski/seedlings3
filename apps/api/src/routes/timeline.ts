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
import { areaWhere, areaWhereVia } from "../lib/areaScope";
import { WORKER_TYPES, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate } from "./_shared";

export default async function timelineRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_timelineManage = requires("timeline.manage");
  const req_timelineView = requires("timeline.view");

  // ── Company timeline ─────────────────────────────────────────────────
  //
  // Same consolidation as documents, and the leak here was wider: both twins
  // sat on `schedule.view`, which the Trainee role holds, so any approved
  // worker could call the `super`-prefixed twin and read hidden events.
  app.get("/timeline", req_timelineView, async (req: any) => {
    const { archived } = (req.query || {}) as Record<string, string>;
    return services.timelineEvents.list({
      restrictedVisible: callerCan(req, "timeline.manage"),
      archived: archived === "1" || archived === "true",
    });
  });
  app.get("/timeline/upcoming", req_timelineView, async (req: any) => {
    const { includeDocs, includePast, archived, completed, completedSinceDays } =
      (req.query || {}) as Record<string, string>;
    return services.timelineEvents.listUpcoming({
      restrictedVisible: callerCan(req, "timeline.manage"),
      includeDocs: includeDocs !== "0" && includeDocs !== "false",
      includePast: includePast === "1" || includePast === "true",
      archived: archived === "1" || archived === "true",
      completed: completed === "1" || completed === "true",
      completedSinceDays: completedSinceDays ? Number(completedSinceDays) : undefined,
    });
  });
  app.get("/timeline/upcoming-counts", req_timelineView, async (req: any) => {
    return services.timelineEvents.upcomingCounts({ restrictedVisible: callerCan(req, "timeline.manage") });
  });
  app.get("/timeline/:id", req_timelineView, async (req: any) => {
    return services.timelineEvents.get(String(req.params.id), {
      restrictedVisible: callerCan(req, "timeline.manage"),
    });
  });
  app.post("/timeline", req_timelineManage, async (req: any) => {
    return services.timelineEvents.create(
      await currentUserId(req),
      req.body || {},
    );
  });
  app.patch("/timeline/:id", req_timelineManage, async (req: any) => {
    return services.timelineEvents.update(
      await currentUserId(req),
      String(req.params.id),
      req.body || {},
    );
  });
  app.post("/timeline/:id/complete", req_timelineManage, async (req: any) => {
    return services.timelineEvents.markComplete(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  app.post("/timeline/:id/archive", req_timelineManage, async (req: any) => {
    return services.timelineEvents.archive(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  app.post("/timeline/:id/unarchive", req_timelineManage, async (req: any) => {
    return services.timelineEvents.unarchive(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  app.delete("/timeline/:id", req_timelineManage, async (req: any) => {
    return services.timelineEvents.hardDelete(
      await currentUserId(req),
      String(req.params.id),
    );
  });
}
