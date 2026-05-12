import { Prisma } from "@prisma/client";
import { RRule } from "rrule";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";

// Urgency thresholds — exposed here so the routes + the title-bar pill stay
// in sync if they ever drift.
export const URGENT_DAYS = 7;
export const SOON_DAYS = 30;

function msIn(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Returns the next occurrence of an event from `now` forward (inclusive).
 * - One-time events (rrule empty/null): returns anchorDate if it's >= now,
 *   else null (rolled off).
 * - Recurring events: parses the RRULE, anchored on anchorDate, and returns
 *   the first instance >= now. Returns null when RRULE has finite end and
 *   no more future instances.
 */
export function nextOccurrence(
  event: { rrule: string | null; anchorDate: Date },
  from: Date = new Date(),
): Date | null {
  const anchor = event.anchorDate;
  if (!event.rrule) {
    return anchor.getTime() >= from.getTime() ? anchor : null;
  }
  try {
    // Parse the RRULE; ensure DTSTART is the anchor so BY* fields resolve
    // relative to it. We pass dtstart explicitly rather than relying on the
    // string format so anchorDate is the single source of truth.
    const rule = RRule.fromString(`DTSTART:${formatDtStart(anchor)}\n${event.rrule.startsWith("RRULE:") ? event.rrule : `RRULE:${event.rrule}`}`);
    const next = rule.after(from, true); // `inc=true` includes `from` exactly
    return next ?? null;
  } catch {
    // Malformed rule — degrade gracefully to anchor-as-one-time.
    return anchor.getTime() >= from.getTime() ? anchor : null;
  }
}

function formatDtStart(d: Date): string {
  // RRULE wants YYYYMMDDTHHMMSSZ. Use UTC so dates don't shift by timezone.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// Service ----------------------------------------------------------------

export type UpcomingRow =
  | {
      kind: "event";
      id: string;
      title: string;
      description: string | null;
      rrule: string | null;
      anchorDate: Date;
      adminHidden: boolean;
      nextDate: Date;
    }
  | {
      kind: "document_expiration";
      documentId: string;
      title: string;
      type: string;
      adminHidden: boolean;
      nextDate: Date;
    };

function urgencyOf(d: Date, from: Date = new Date()): "past" | "urgent" | "soon" | "future" {
  const diff = d.getTime() - from.getTime();
  if (diff < 0) return "past";
  if (diff <= msIn(URGENT_DAYS)) return "urgent";
  if (diff <= msIn(SOON_DAYS)) return "soon";
  return "future";
}

export const timelineEvents = {
  async list(params: { adminHiddenVisible: boolean; archived?: boolean }) {
    const where: Prisma.TimelineEventWhereInput = {
      ...(params.adminHiddenVisible ? {} : { adminHidden: false }),
      ...(params.archived ? { archivedAt: { not: null } } : { archivedAt: null }),
    };
    const rows = await prisma.timelineEvent.findMany({
      where,
      orderBy: [{ anchorDate: "asc" }],
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return rows.map((r) => ({
      ...r,
      nextDate: nextOccurrence(r),
    }));
  },

  async get(id: string, opts: { adminHiddenVisible: boolean }) {
    const ev = await prisma.timelineEvent.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    if (!ev) throw new ServiceError("NOT_FOUND", "Event not found.", 404);
    if (!opts.adminHiddenVisible && ev.adminHidden) {
      throw new ServiceError("NOT_FOUND", "Event not found.", 404);
    }
    return { ...ev, nextDate: nextOccurrence(ev) };
  },

  /**
   * Unified upcoming list — events (with computed next dates) merged with
   * non-archived document expirations, sorted ascending by next date.
   * Past one-time events and past doc expirations are excluded.
   */
  async listUpcoming(params: {
    adminHiddenVisible: boolean;
    includeDocs?: boolean;
    includePast?: boolean;
  }): Promise<UpcomingRow[]> {
    const now = new Date();
    const events = await prisma.timelineEvent.findMany({
      where: {
        archivedAt: null,
        ...(params.adminHiddenVisible ? {} : { adminHidden: false }),
      },
    });
    const eventRows: UpcomingRow[] = [];
    for (const ev of events) {
      const next = nextOccurrence(ev, params.includePast ? new Date(0) : now);
      if (!next) continue;
      eventRows.push({
        kind: "event",
        id: ev.id,
        title: ev.title,
        description: ev.description,
        rrule: ev.rrule,
        anchorDate: ev.anchorDate,
        adminHidden: ev.adminHidden,
        nextDate: next,
      });
    }

    let docRows: UpcomingRow[] = [];
    if (params.includeDocs !== false) {
      const docs = await prisma.companyDocument.findMany({
        where: {
          archivedAt: null,
          expiresAt: params.includePast ? { not: null } : { gte: now },
          ...(params.adminHiddenVisible ? {} : { adminHidden: false }),
        },
        select: {
          id: true,
          title: true,
          type: true,
          adminHidden: true,
          expiresAt: true,
        },
      });
      docRows = docs
        .filter((d) => !!d.expiresAt)
        .map((d) => ({
          kind: "document_expiration" as const,
          documentId: d.id,
          title: d.title,
          type: d.type,
          adminHidden: d.adminHidden,
          nextDate: d.expiresAt!,
        }));
    }

    return [...eventRows, ...docRows].sort(
      (a, b) => a.nextDate.getTime() - b.nextDate.getTime(),
    );
  },

  async upcomingCounts(params: { adminHiddenVisible: boolean }) {
    const rows = await this.listUpcoming({
      adminHiddenVisible: params.adminHiddenVisible,
      includeDocs: true,
    });
    const now = new Date();
    let urgent = 0;
    let soon = 0;
    for (const r of rows) {
      const u = urgencyOf(r.nextDate, now);
      if (u === "urgent" || u === "past") urgent++;
      else if (u === "soon") soon++;
    }
    return { urgent, soon };
  },

  async create(
    currentUserId: string,
    payload: {
      title: string;
      description?: string | null;
      rrule?: string | null;
      anchorDate: string;
      adminHidden?: boolean;
    },
  ) {
    if (!payload.title?.trim()) throw new ServiceError("INVALID", "title is required.", 400);
    if (!payload.anchorDate) throw new ServiceError("INVALID", "anchorDate is required.", 400);
    // Surface RRULE parse errors before persisting.
    if (payload.rrule) {
      try {
        RRule.fromString(`DTSTART:${formatDtStart(new Date(payload.anchorDate))}\nRRULE:${payload.rrule}`);
      } catch (err: any) {
        throw new ServiceError("INVALID_RRULE", `Invalid RRULE: ${err?.message ?? "parse error"}`, 400);
      }
    }
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const ev = await tx.timelineEvent.create({
        data: {
          title: payload.title.trim(),
          description: payload.description?.trim() || null,
          rrule: payload.rrule?.trim() || null,
          anchorDate: new Date(payload.anchorDate),
          adminHidden: !!payload.adminHidden,
          createdById: currentUserId,
        },
      });
      await writeAudit(tx, AUDIT.TIMELINE.CREATED, currentUserId, {
        eventId: ev.id, title: ev.title,
      });
      return ev;
    });
  },

  async update(
    currentUserId: string,
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      rrule?: string | null;
      anchorDate?: string;
      adminHidden?: boolean;
    },
  ) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.timelineEvent.findUnique({ where: { id } });
      if (!existing) throw new ServiceError("NOT_FOUND", "Event not found.", 404);

      const data: Prisma.TimelineEventUpdateInput = {};
      if (patch.title !== undefined) data.title = patch.title.trim();
      if (patch.description !== undefined) data.description = patch.description?.trim() || null;
      if (patch.rrule !== undefined) data.rrule = patch.rrule?.trim() || null;
      if (patch.anchorDate !== undefined) data.anchorDate = new Date(patch.anchorDate);
      if (patch.adminHidden !== undefined) data.adminHidden = !!patch.adminHidden;

      // Validate RRULE against the new (or existing) anchor.
      const finalAnchor = data.anchorDate instanceof Date ? data.anchorDate : existing.anchorDate;
      const finalRule = (data.rrule as string | null | undefined) === undefined ? existing.rrule : (data.rrule as string | null);
      if (finalRule) {
        try {
          RRule.fromString(`DTSTART:${formatDtStart(finalAnchor)}\nRRULE:${finalRule}`);
        } catch (err: any) {
          throw new ServiceError("INVALID_RRULE", `Invalid RRULE: ${err?.message ?? "parse error"}`, 400);
        }
      }

      const updated = await tx.timelineEvent.update({ where: { id }, data });
      await writeAudit(tx, AUDIT.TIMELINE.UPDATED, currentUserId, {
        eventId: id, changed: Object.keys(data),
      });
      return updated;
    });
  },

  async archive(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const ev = await tx.timelineEvent.findUnique({ where: { id } });
      if (!ev) throw new ServiceError("NOT_FOUND", "Event not found.", 404);
      if (ev.archivedAt) throw new ServiceError("ALREADY_ARCHIVED", "Already archived.", 409);
      const updated = await tx.timelineEvent.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await writeAudit(tx, AUDIT.TIMELINE.ARCHIVED, currentUserId, { eventId: id });
      return updated;
    });
  },

  async unarchive(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const ev = await tx.timelineEvent.findUnique({ where: { id } });
      if (!ev) throw new ServiceError("NOT_FOUND", "Event not found.", 404);
      if (!ev.archivedAt) throw new ServiceError("NOT_ARCHIVED", "Not archived.", 409);
      const updated = await tx.timelineEvent.update({
        where: { id },
        data: { archivedAt: null },
      });
      await writeAudit(tx, AUDIT.TIMELINE.UNARCHIVED, currentUserId, { eventId: id });
      return updated;
    });
  },

  async hardDelete(currentUserId: string, id: string) {
    const ev = await prisma.timelineEvent.findUnique({ where: { id } });
    if (!ev) throw new ServiceError("NOT_FOUND", "Event not found.", 404);
    if (!ev.archivedAt) {
      throw new ServiceError(
        "MUST_ARCHIVE_FIRST",
        "Archive the event before permanently deleting it.",
        409,
      );
    }
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.timelineEvent.delete({ where: { id } });
      await writeAudit(tx, AUDIT.TIMELINE.DELETED, currentUserId, {
        eventId: id, title: ev.title,
      });
    });
    return { ok: true };
  },
};
