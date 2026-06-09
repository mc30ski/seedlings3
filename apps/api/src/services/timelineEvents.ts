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
  // date-handling-allow: elapsed-time — millisecond conversion used for
  // bucketing audit events into "urgent / soon / future" relative to
  // nextDueDate. The buckets are coarse (7-day / 30-day), so the ≤1-hour
  // DST drift is invisible.
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Returns the next-rrule occurrence STRICTLY AFTER the given date, anchored
 * on anchorDate. Used by `markComplete` to advance `nextDueDate`. Returns
 * null when there's no rrule (one-time) or the rule has finite end with no
 * more instances.
 */
export function computeNextAfter(
  event: { rrule: string | null; anchorDate: Date },
  after: Date,
): Date | null {
  if (!event.rrule) return null;
  try {
    const rule = RRule.fromString(
      `DTSTART:${formatDtStart(event.anchorDate)}\n${event.rrule.startsWith("RRULE:") ? event.rrule : `RRULE:${event.rrule}`}`,
    );
    return rule.after(after, false) ?? null;
  } catch {
    return null;
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
      category: string | null;
      rrule: string | null;
      anchorDate: Date;
      lastCompletedAt: Date | null;
      archivedAt: Date | null;
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
      orderBy: [{ nextDueDate: "asc" }],
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return rows.map((r) => ({ ...r, nextDate: r.nextDueDate ?? null }));
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
    return { ...ev, nextDate: ev.nextDueDate ?? null };
  },

  /**
   * Unified upcoming list — events (with computed next dates) merged with
   * non-archived document expirations, sorted ascending by next date.
   * Past one-time events and past doc expirations are excluded.
   *
   * Three mutually-exclusive view modes via the `archived` and `completed`
   * params:
   *   • `archived = true` — only archived events (no docs)
   *   • `completed = true` — only events whose `lastCompletedAt` falls
   *     within the past `completedSinceDays` (default 30). Includes
   *     one-time events whose `nextDueDate` is now null AND recurring
   *     events that have at least one completion in window. Sorted by
   *     lastCompletedAt DESC (most recent first) — opposite of the
   *     default upcoming sort.
   *   • Neither — the default upcoming view (current behavior).
   */
  async listUpcoming(params: {
    adminHiddenVisible: boolean;
    includeDocs?: boolean;
    includePast?: boolean;
    archived?: boolean;
    completed?: boolean;
    completedSinceDays?: number;
  }): Promise<UpcomingRow[]> {
    if (params.completed) {
      const sinceDays = Math.max(
        1,
        Math.min(3650, Number(params.completedSinceDays ?? 30) || 30),
      );
      const since = new Date(Date.now() - sinceDays * msIn(1));
      const completed = await prisma.timelineEvent.findMany({
        where: {
          archivedAt: null,
          lastCompletedAt: { not: null, gte: since },
          ...(params.adminHiddenVisible ? {} : { adminHidden: false }),
        },
        orderBy: { lastCompletedAt: "desc" },
      });
      return completed.map((ev) => ({
        kind: "event" as const,
        id: ev.id,
        title: ev.title,
        description: ev.description,
        category: ev.category,
        rrule: ev.rrule,
        anchorDate: ev.anchorDate,
        lastCompletedAt: ev.lastCompletedAt,
        archivedAt: ev.archivedAt,
        adminHidden: ev.adminHidden,
        // Render under the lastCompletedAt date in the UI — that's the
        // anchor the operator is reviewing for this view. Mirrors the
        // existing nextDate typing (Date in code, ISO string on the wire
        // after JSON serialization — the frontend's fmtDate handles both).
        nextDate: (ev.lastCompletedAt ?? ev.anchorDate) as unknown as Date,
      }));
    }
    const events = await prisma.timelineEvent.findMany({
      where: {
        ...(params.archived
          ? { archivedAt: { not: null } }
          : { archivedAt: null, nextDueDate: { not: null } }),
        ...(params.adminHiddenVisible ? {} : { adminHidden: false }),
      },
    });
    const eventRows: UpcomingRow[] = [];
    for (const ev of events) {
      // For active rows nextDueDate must be present (filter enforces this).
      // For archived rows it may be null — fall back to the anchor so the
      // archived view still has a date to sort/display.
      const next = ev.nextDueDate ?? (params.archived ? ev.anchorDate : null);
      if (!next) continue;
      eventRows.push({
        kind: "event",
        id: ev.id,
        title: ev.title,
        description: ev.description,
        category: ev.category,
        rrule: ev.rrule,
        anchorDate: ev.anchorDate,
        lastCompletedAt: ev.lastCompletedAt,
        archivedAt: ev.archivedAt,
        adminHidden: ev.adminHidden,
        nextDate: next,
      });
    }

    let docRows: UpcomingRow[] = [];
    // Doc expirations are never archived — the archived view is timeline-only.
    if (params.includeDocs !== false && !params.archived) {
      const docs = await prisma.companyDocument.findMany({
        where: {
          archivedAt: null,
          expiresAt: params.includePast ? { not: null } : { not: null },
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
      // `urgent` here drives the title-bar Timeline alert badge. Operator
      // preference: the badge fires for OVERDUE rows only ("past"), not for
      // upcoming-within-7-days rows. The 7-day window is still useful as a
      // visual urgency tier inside the Timeline list itself, but it should
      // not pull attention from the header. `soon` keeps its existing 8–30
      // day meaning in case any caller wants the upcoming-soon count.
      if (u === "past") urgent++;
      else if (u === "urgent" || u === "soon") soon++;
    }
    return { urgent, soon };
  },

  async create(
    currentUserId: string,
    payload: {
      title: string;
      description?: string | null;
      category?: string | null;
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
      const anchor = new Date(payload.anchorDate);
      const ev = await tx.timelineEvent.create({
        data: {
          title: payload.title.trim(),
          description: payload.description?.trim() || null,
          category: payload.category?.trim() || null,
          rrule: payload.rrule?.trim() || null,
          anchorDate: anchor,
          // Start the active due date at the anchor. If the user picked a past
          // date the event renders as overdue immediately — that's intended;
          // they explicitly chose that date.
          nextDueDate: anchor,
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
      category?: string | null;
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
      if (patch.category !== undefined) data.category = patch.category?.trim() || null;
      if (patch.rrule !== undefined) data.rrule = patch.rrule?.trim() || null;
      if (patch.anchorDate !== undefined) {
        const newAnchor = new Date(patch.anchorDate);
        data.anchorDate = newAnchor;
        // If the event has never been completed (nextDueDate still equals the
        // old anchor), follow the anchor edit through to the active due date.
        // Once a user has completed at least once, leave nextDueDate alone so
        // we don't undo their progress.
        if (existing.lastCompletedAt == null &&
            existing.nextDueDate?.getTime() === existing.anchorDate.getTime()) {
          data.nextDueDate = newAnchor;
        }
      }
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

  /**
   * Mark the current occurrence as complete. For recurring events this
   * advances `nextDueDate` to the next rrule instance strictly after the
   * current due date. For one-time events (or recurring rules that have
   * run out), `nextDueDate` is set to null and the event is archived —
   * there's nothing left to surface.
   */
  async markComplete(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const ev = await tx.timelineEvent.findUnique({ where: { id } });
      if (!ev) throw new ServiceError("NOT_FOUND", "Event not found.", 404);
      if (ev.archivedAt) throw new ServiceError("ARCHIVED", "Event is archived.", 409);
      if (!ev.nextDueDate) {
        throw new ServiceError("NO_PENDING", "Nothing to mark complete — already done.", 409);
      }
      const completedDate = ev.nextDueDate;
      const next = computeNextAfter(ev, completedDate);
      const now = new Date();
      const updated = await tx.timelineEvent.update({
        where: { id },
        data: {
          nextDueDate: next, // null if one-time or rule exhausted
          lastCompletedAt: now,
          // Auto-archive when there's nothing more coming up — keeps the
          // active list focused on actionable items.
          archivedAt: next ? null : now,
        },
      });
      await writeAudit(tx, AUDIT.TIMELINE.COMPLETED, currentUserId, {
        eventId: id,
        completedDate,
        nextDueDate: next,
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

      // Smart restore: for recurring events, set nextDueDate to the next
      // future instance computed from the rrule (anchored on anchorDate,
      // advanced past lastCompletedAt if we have one — otherwise past now).
      // For one-time events with no rule, restore to the anchor (which may
      // be in the past, surfacing as overdue — user can edit if needed).
      let restoredNext: Date | null = ev.nextDueDate;
      if (ev.rrule) {
        const cursor = ev.lastCompletedAt ?? new Date();
        restoredNext = computeNextAfter(ev, cursor);
        // Fall back to anchor if the rule somehow produces nothing — keeps
        // the event visible so the user can see + edit it.
        if (!restoredNext) restoredNext = ev.anchorDate;
      } else if (!restoredNext) {
        restoredNext = ev.anchorDate;
      }

      const updated = await tx.timelineEvent.update({
        where: { id },
        data: { archivedAt: null, nextDueDate: restoredNext },
      });
      await writeAudit(tx, AUDIT.TIMELINE.UNARCHIVED, currentUserId, {
        eventId: id,
        restoredNextDueDate: restoredNext,
      });
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
