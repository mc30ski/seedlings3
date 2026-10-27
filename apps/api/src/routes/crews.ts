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

export default async function crewRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_crewsManage = requires("crews.manage");
  const req_crewsView = requires("crews.view");

  app.get("/groups", req_crewsView, async (req: any) => {
    const q = (req.query || {}) as { includeArchived?: string };
    return services.groups.list({ includeArchived: q.includeArchived === "true" });
  });
  app.get("/groups/:id", req_crewsView, async (req: any) => {
    return services.groups.getById(String(req.params.id));
  });
  app.post("/groups", req_crewsManage, async (req: any) => {
    const b = req.body || {};
    return services.groups.create(await currentUserId(req), {
      name: String(b.name ?? ""),
      description: b.description != null ? String(b.description) : null,
      claimerUserId: String(b.claimerUserId ?? ""),
      members: Array.isArray(b.members)
        ? b.members.map((m: any) => ({
            userId: String(m.userId ?? ""),
            role: m.role != null ? String(m.role) : "worker",
            equipmentCostPercent: m.equipmentCostPercent != null ? Number(m.equipmentCostPercent) : null,
          }))
        : [],
    });
  });
  app.patch("/groups/:id", req_crewsManage, async (req: any) => {
    const b = req.body || {};
    const input: any = {};
    if ("name" in b) input.name = String(b.name ?? "");
    if ("description" in b) input.description = b.description != null ? String(b.description) : null;
    if ("claimerUserId" in b) input.claimerUserId = String(b.claimerUserId);
    return services.groups.update(await currentUserId(req), String(req.params.id), input);
  });
  app.post("/groups/:id/archive", req_crewsManage, async (req: any) => {
    return services.groups.archive(await currentUserId(req), String(req.params.id));
  });
  app.post("/groups/:id/unarchive", req_crewsManage, async (req: any) => {
    return services.groups.unarchive(await currentUserId(req), String(req.params.id));
  });
  // Member management
  app.post("/groups/:id/members", req_crewsManage, async (req: any) => {
    const b = req.body || {};
    return services.groups.addMember(await currentUserId(req), String(req.params.id), {
      userId: String(b.userId ?? ""),
      role: b.role != null ? String(b.role) : "worker",
      equipmentCostPercent: b.equipmentCostPercent != null ? Number(b.equipmentCostPercent) : null,
    });
  });
  app.patch("/groups/:id/members/:userId", req_crewsManage, async (req: any) => {
    const b = req.body || {};
    const patch: any = {};
    if ("role" in b) patch.role = String(b.role);
    if ("equipmentCostPercent" in b) {
      patch.equipmentCostPercent = b.equipmentCostPercent == null ? null : Number(b.equipmentCostPercent);
    }
    return services.groups.updateMember(
      await currentUserId(req),
      String(req.params.id),
      String(req.params.userId),
      patch,
    );
  });
  app.delete("/groups/:id/members/:userId", req_crewsManage, async (req: any) => {
    return services.groups.removeMember(await currentUserId(req), String(req.params.id), String(req.params.userId));
  });
  // Preferred equipment
  app.post("/groups/:id/preferred-equipment", req_crewsManage, async (req: any) => {
    const b = req.body || {};
    return services.groups.addPreferred(await currentUserId(req), String(req.params.id), {
      equipmentId: b.equipmentId != null ? String(b.equipmentId) : null,
      equipmentCollectionId: b.equipmentCollectionId != null ? String(b.equipmentCollectionId) : null,
    });
  });
  app.delete("/groups/preferred-equipment/:preferredId", req_crewsManage, async (req: any) => {
    return services.groups.removePreferred(await currentUserId(req), String(req.params.preferredId));
  });
  // Groups the caller can claim on behalf of (i.e. they are the claimer).
  // Used by the JobsTab Claim chooser.
  // view-as-allow: the "as-claimer" scope is inherently caller-only —
  // returns groups where the CALLER is the current claimer. A
  // `crews.view` holder hits /groups for cross-person visibility instead.
  app.get("/me/groups-as-claimer", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    return services.groups.listForClaimer(uid);
  });
  // Crews the caller is a member of (claimer OR member — worker or
  // observer). Powers the Worker "My Crews" tab, which surfaces a
  // read-only view of the caller's own crews so they can see who
  // they're teamed with. Sensitive fields (email, wage, roles,
  // equipmentCostPercent) are stripped server-side; the client
  // filters again defense-in-depth.
  // view-as-allow: "my crews" is inherently caller-scoped — cross-person
  // crew visibility comes from /groups on `crews.view`.
  app.get("/me/groups", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const groups = await services.groups.listForUser(uid);
    return groups.map((g) => {
      const claimerRow = {
        userId: g.claimerUserId,
        displayName: g.claimer?.displayName ?? null,
        role: "claimer" as const,
      };
      const memberRows = g.members.map((m) => ({
        userId: m.userId,
        displayName: m.user?.displayName ?? null,
        role: m.role === "observer" ? "observer" : "worker",
      }));
      return {
        id: g.id,
        name: g.name,
        claimerId: g.claimerUserId,
        myRole: g.claimerUserId === uid ? "claimer" : "worker",
        members: [claimerRow, ...memberRows],
      };
    });
  });

}
