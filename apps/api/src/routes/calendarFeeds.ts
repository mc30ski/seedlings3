import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { services } from "../services";
import { fetchWeatherAlerts } from "../services/weatherAlerts";
import { cached } from "../lib/cache";
import { businessLatLng } from "../lib/businessLocation";
import { prisma } from "../db/prisma";
import { hourlyForecastForOccurrence } from "../services/hourlyForecast";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etMidnight, etToday, etTomorrow, type EtDateKey } from "../lib/dates";
import { InstructionScope, JobOccurrenceStatus, Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import { normalizePhone } from "../lib/phone";
import { persistCompletionSplits } from "../services/payments";
import { evaluateHoursApproval, loadHoursApprovalVarianceThreshold, loadPriorPersonMinutes } from "../services/jobs";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { redactObserverFieldsForCaller, redactPeekFieldsForCaller, redactUnclearedFieldsForCaller } from "../lib/observerRedaction";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { makeGuards } from "../lib/routeGuards";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { capabilitiesForUsers, userCan } from "../lib/userCapabilities";
import { classify, isFeeable, isW2, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, occInEditableState } from "./_shared";

export default async function calendarFeedRoutes(app: FastifyInstance) {
  const MAX_FEED_TOKENS = 5;
  const STALE_TOKEN_DAYS = 90;

  const { requires, approvedUser } = makeGuards(app);

  app.get("/calendar-feeds", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const tokens = await prisma.calendarFeedToken.findMany({
      where: { userId: uid },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, token: true, filters: true, createdAt: true, lastAccessedAt: true },
    });
    return tokens;
  });
  app.post("/calendar-feeds", approvedUser, async (req: any) => {
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

    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.calendarFeedToken.create({
        data: { userId: uid, token, label, filters },
      });
      // Records minting a bearer token that grants UNAUTHENTICATED read access
      // to this worker's schedule. The token value itself is deliberately not logged.
      await writeAudit(tx, AUDIT.CALENDAR_FEED.CREATED, uid, {
        calendarFeedTokenId: created.id,
        userId: uid,
        label: created.label,
        filterSummary: JSON.stringify(created.filters ?? {}),
        createdAt: created.createdAt.toISOString(),
      });
      return created;
    });

    return { id: record.id, token: record.token, label: record.label, filters: record.filters, createdAt: record.createdAt };
  });
  app.delete("/calendar-feeds/:id", approvedUser, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const doomedFeed = await prisma.calendarFeedToken.findFirst({
      where: { id, userId: uid },
      select: { id: true, label: true, filters: true, createdAt: true, lastAccessedAt: true },
    });
    await prisma.$transaction(async (tx) => {
      if (doomedFeed) {
        // Records revoking a calendar bearer token, ending unauthenticated read
        // access to this worker's schedule. The token value is never logged.
        await writeAudit(tx, AUDIT.CALENDAR_FEED.DELETED, uid, {
          calendarFeedTokenId: doomedFeed.id,
          userId: uid,
          label: doomedFeed.label,
          filterSummary: JSON.stringify(doomedFeed.filters ?? {}),
          createdAt: doomedFeed.createdAt.toISOString(),
          lastAccessedAt: doomedFeed.lastAccessedAt?.toISOString() ?? null,
        });
      }
      await tx.calendarFeedToken.deleteMany({
        where: { id, userId: uid },
      });
    });
    return { ok: true };
  });
}
