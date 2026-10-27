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

export default async function settingRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_marketingManage = requires("marketing.manage");
  const req_marketingView = requires("marketing.view");
  const req_settingsManage = requires("settings.manage");

  app.patch("/settings/:key", req_settingsManage, async (req: any) => {
    const uid = await currentUserId(req);
    const key = String(req.params.key);
    const body = req.body || {};
    if (body.value === undefined) throw app.httpErrors.badRequest("value is required");
    const value = String(body.value);
    // Reject writes to protected settings via the generic PATCH. These
    // have dedicated mutation endpoints in their feature (e.g.
    // PROMOTION_HMAC_SECRET → /promotions/rotate-hmac-secret)
    // that carry the right audit + user-warning flow. The Settings tab
    // renders these with a specialized card + dedicated action button
    // — no free-text input to misclick.
    const { PROTECTED_SETTING_KEYS } = await import("../services/settings");
    if (PROTECTED_SETTING_KEYS.has(key)) {
      throw app.httpErrors.forbidden(
        `${key} is auto-managed and can't be edited through this endpoint. Use its dedicated action button in the Settings tab.`,
      );
    }
    // Cross-check setting-driven taxonomies before persisting. Today we only
    // guard DOCUMENT_TYPES (singleton flips with conflicting active docs);
    // other settings have no such cross-table constraint.
    if (key === "DOCUMENT_TYPES") {
      const { validateDocumentTypesUpdate } = await import("../services/companyDocuments");
      await validateDocumentTypesUpdate(value);
    }
    if (key === "PAYROLL_PERIOD_CADENCE" && value !== "WEEKLY" && value !== "BIWEEKLY" && value !== "MONTHLY") {
      throw app.httpErrors.badRequest("PAYROLL_PERIOD_CADENCE must be WEEKLY, BIWEEKLY, or MONTHLY.");
    }
    if (key === "EXPENSE_CATEGORIES") {
      const { validateExpenseCategoriesJson } = await import("../services/expenseCategories");
      try {
        validateExpenseCategoriesJson(value);
      } catch (err: any) {
        throw app.httpErrors.badRequest(err?.message || "Invalid EXPENSE_CATEGORIES JSON.");
      }
    }
    if (key === "REPEATING_JOB_OCCURRENCE_PAUSE_REASONS") {
      const { validatePauseReasonsJson } = await import("../services/pauseReasons");
      try {
        validatePauseReasonsJson(value);
      } catch (err: any) {
        throw app.httpErrors.badRequest(err?.message || "Invalid REPEATING_JOB_OCCURRENCE_PAUSE_REASONS JSON.");
      }
    }
    if (key === "PAYMENT_FROM_OPTIONS") {
      const { validatePaymentFromOptionsJson } = await import("../services/paymentFromOptions");
      try {
        validatePaymentFromOptionsJson(value);
      } catch (err: any) {
        throw app.httpErrors.badRequest(err?.message || "Invalid PAYMENT_FROM_OPTIONS JSON.");
      }
    }
    if (key === "PAYROLL_TAX_ESTIMATES") {
      const { validatePayrollTaxEstimatesJson } = await import(
        "../services/payrollTaxEstimates"
      );
      try {
        validatePayrollTaxEstimatesJson(value);
      } catch (err: any) {
        throw app.httpErrors.badRequest(
          err?.message || "Invalid PAYROLL_TAX_ESTIMATES JSON.",
        );
      }
    }
    if (key === "SOCIAL_LINKS") {
      const { validateSocialLinksJson } = await import("../services/socialLinks");
      try {
        validateSocialLinksJson(value);
      } catch (err: any) {
        throw app.httpErrors.badRequest(err?.message || "Invalid SOCIAL_LINKS JSON.");
      }
    }
    if (key === "PAYMENT_METHODS") {
      const { validatePaymentMethodsJson } = await import("../services/paymentMethods");
      try {
        validatePaymentMethodsJson(value);
      } catch (err: any) {
        throw app.httpErrors.badRequest(err?.message || "Invalid PAYMENT_METHODS JSON.");
      }
      // Audit the taxonomy edit separately from the generic SETTING.UPDATED
      // verb — payment-method changes are sensitive enough to flag in their
      // own bucket for review.
      const previous = await prisma.setting.findUnique({ where: { key } });
      await prisma.auditEvent.create({
        data: {
          scope: AUDIT.SETTING.PAYMENT_METHOD_UPDATED[0],
          verb: AUDIT.SETTING.PAYMENT_METHOD_UPDATED[1],
          action: `${AUDIT.SETTING.PAYMENT_METHOD_UPDATED[0]}_${AUDIT.SETTING.PAYMENT_METHOD_UPDATED[1]}`,
          actorUserId: uid,
          metadata: { previousValue: previous?.value ?? null, newValue: value } as any,
        },
      });
    }
    return services.settings.set(uid, key, value);
  });
  app.post("/banners", req_marketingManage, async (req: any) => {
    return services.banners.post(
      await currentUserId(req),
      req.body || {},
    );
  });
  app.delete("/banners/:id", req_marketingManage, async (req: any) => {
    return services.banners.delete(
      await currentUserId(req),
      String(req.params.id),
    );
  });
  // Settings (read-only for workers)
  app.get("/settings", approvedUser, async () => {
    return services.settings.getAll();
  });
  // ── Home banners ──────────────────────────────────────────────────────────
  // Pending banners for the current user (stacked at the top of Worker Home).
  app.get("/banners", req_marketingView, async (req: any) => {
    // ONE ROUTE, TWO ANSWERS, DECIDED BY CAPABILITY.
    //
    // There used to be a second registration at `/banners` calling
    // `listUnscoped()` behind `marketing.manage`. Same resource, different
    // breadth — and the client chose which by picking a URL.
    return callerCan(req, "marketing.manage")
      ? services.banners.listUnscoped()
      : services.banners.listForUser(await currentUserId(req));
  });
  // Per-user dismissal — only affects the caller.
  app.post("/banners/:id/dismiss", approvedUser, async (req: any) => {
    return services.banners.dismiss(
      await currentUserId(req),
      String(req.params.id),
    );
  });
}
