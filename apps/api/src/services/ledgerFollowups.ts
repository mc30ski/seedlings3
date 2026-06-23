// ─────────────────────────────────────────────────────────────────────────────
// Ledger Followup service — Super-only "flag this row for follow-up" affordance
// for the Money → Ledger view. Lets a Super attach an open-ended reminder to
// any Payment, BusinessExpense, or Checkout (equipment rental income) row when
// something needs attention (e.g. waiting on an ACH posting, vendor dispute,
// month-end reconciliation note).
//
// Polymorphic by design: `entityType` is a free-form string (lowercase model
// name) + `entityId` is the row's primary key. Adding a new ledger row type
// later means just registering a new entityType string in the validator —
// no schema migration.
//
// One open flag per (entityType, entityId) — enforced by validating in the
// service rather than via a unique partial index (Postgres supports them but
// Prisma migrations don't introspect partial uniques cleanly). The composite
// `(entityType, entityId, resolvedAt)` index in the schema makes the "is this
// row already flagged?" lookup O(log n).
//
// Routes live at `/api/super/ledger-followups/*` and all require Super. The
// route layer is responsible for setting `actorId` from the authenticated
// user; this service trusts the value it receives.
// ─────────────────────────────────────────────────────────────────────────────

import type { LedgerFollowup } from "@prisma/client";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";

// Allowed entity types — must match the lowercase model name used elsewhere
// in the codebase. Add new types here as the Ledger view grows.
export const LEDGER_FOLLOWUP_ENTITY_TYPES = ["payment", "businessExpense", "checkout"] as const;
export type LedgerFollowupEntityType = (typeof LEDGER_FOLLOWUP_ENTITY_TYPES)[number];

function assertEntityType(entityType: string): asserts entityType is LedgerFollowupEntityType {
  if (!LEDGER_FOLLOWUP_ENTITY_TYPES.includes(entityType as LedgerFollowupEntityType)) {
    throw new ServiceError(
      "INVALID_ENTITY_TYPE",
      `Unknown entityType "${entityType}". Allowed: ${LEDGER_FOLLOWUP_ENTITY_TYPES.join(", ")}.`,
      400,
    );
  }
}

/**
 * Verify the target row actually exists before persisting the flag. Saves a
 * confused operator from flagging a typo'd id and seeing it stuck in the
 * count forever. Throws NOT_FOUND otherwise.
 */
async function assertEntityExists(entityType: LedgerFollowupEntityType, entityId: string): Promise<void> {
  let exists: { id: string } | null = null;
  switch (entityType) {
    case "payment":
      exists = await prisma.payment.findUnique({ where: { id: entityId }, select: { id: true } });
      break;
    case "businessExpense":
      exists = await prisma.businessExpense.findUnique({ where: { id: entityId }, select: { id: true } });
      break;
    case "checkout":
      exists = await prisma.checkout.findUnique({ where: { id: entityId }, select: { id: true } });
      break;
  }
  if (!exists) {
    throw new ServiceError(
      "ENTITY_NOT_FOUND",
      `No ${entityType} row exists with id ${entityId}.`,
      404,
    );
  }
}

export type LedgerFollowupRow = {
  id: string;
  entityType: LedgerFollowupEntityType;
  entityId: string;
  note: string | null;
  createdAt: string;
  createdBy: { id: string; displayName: string | null; email: string | null };
  resolvedAt: string | null;
  resolvedBy: { id: string; displayName: string | null; email: string | null } | null;
};

function summarize(row: LedgerFollowup & {
  createdBy: { id: string; displayName: string | null; email: string | null };
  resolvedBy: { id: string; displayName: string | null; email: string | null } | null;
}): LedgerFollowupRow {
  return {
    id: row.id,
    entityType: row.entityType as LedgerFollowupEntityType,
    entityId: row.entityId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedBy: row.resolvedBy,
  };
}

/** Drives the alerts-dropdown count. Open = `resolvedAt IS NULL`. */
export async function countOpenFollowups(): Promise<number> {
  return prisma.ledgerFollowup.count({ where: { resolvedAt: null } });
}

/**
 * List followups. Default: only open ones (the only useful view for the
 * filter chip + alerts navigation). Pass `includeResolved: true` for the
 * "show history too" case.
 */
export async function listFollowups(opts?: {
  includeResolved?: boolean;
}): Promise<LedgerFollowupRow[]> {
  const rows = await prisma.ledgerFollowup.findMany({
    where: opts?.includeResolved ? {} : { resolvedAt: null },
    include: {
      createdBy: { select: { id: true, displayName: true, email: true } },
      resolvedBy: { select: { id: true, displayName: true, email: true } },
    },
    orderBy: [{ resolvedAt: { sort: "asc", nulls: "first" } }, { createdAt: "desc" }],
  });
  return rows.map(summarize);
}

/**
 * Map of `${entityType}:${entityId}` → open followup row for fast in-render
 * "is this row flagged?" lookups. The Ledger tab fetches this once on mount
 * (along with the entity list) and renders the flag icon per-row from the
 * map without N+1 lookups.
 */
export async function openFollowupMap(): Promise<Record<string, LedgerFollowupRow>> {
  const list = await listFollowups({ includeResolved: false });
  const map: Record<string, LedgerFollowupRow> = {};
  for (const r of list) map[`${r.entityType}:${r.entityId}`] = r;
  return map;
}

/**
 * Flag a ledger row for follow-up. Throws CONFLICT if the row already has
 * an open flag (Super resolved it via Edit instead). Note is optional but
 * highly encouraged — the operator a month from now will thank past-them.
 */
export async function createFollowup(input: {
  entityType: string;
  entityId: string;
  note?: string | null;
  actorId: string;
}): Promise<LedgerFollowupRow> {
  assertEntityType(input.entityType);
  await assertEntityExists(input.entityType, input.entityId);

  const existingOpen = await prisma.ledgerFollowup.findFirst({
    where: { entityType: input.entityType, entityId: input.entityId, resolvedAt: null },
    select: { id: true },
  });
  if (existingOpen) {
    throw new ServiceError(
      "ALREADY_FLAGGED",
      "This row already has an open followup. Resolve or edit the existing one instead.",
      409,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.ledgerFollowup.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        note: input.note?.trim() || null,
        createdById: input.actorId,
      },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        resolvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.LEDGER_FOLLOWUP.CREATED, input.actorId, {
      followupId: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      note: row.note,
    });
    return row;
  });
  return summarize(created);
}

/** Edit the note on an OPEN followup. Cannot edit a resolved one — that's history. */
export async function updateFollowupNote(input: {
  id: string;
  note: string | null;
  actorId: string;
}): Promise<LedgerFollowupRow> {
  const existing = await prisma.ledgerFollowup.findUnique({ where: { id: input.id } });
  if (!existing) throw new ServiceError("NOT_FOUND", "Followup not found.", 404);
  if (existing.resolvedAt) {
    throw new ServiceError(
      "ALREADY_RESOLVED",
      "Can't edit a resolved followup — the note is part of the audit record.",
      409,
    );
  }
  const newNote = input.note?.trim() || null;
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.ledgerFollowup.update({
      where: { id: input.id },
      data: { note: newNote },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        resolvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.LEDGER_FOLLOWUP.UPDATED, input.actorId, {
      followupId: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      previousNote: existing.note,
      newNote,
    });
    return row;
  });
  return summarize(updated);
}

/**
 * Mark a followup resolved. Stamps `resolvedAt` + `resolvedById` (which may
 * differ from `createdById` — one Super flags, another resolves). The
 * optional `resolutionNote` is appended to the original note for context;
 * we do NOT overwrite the original because that's the historical record of
 * "why was this flagged."
 */
export async function resolveFollowup(input: {
  id: string;
  resolutionNote?: string | null;
  actorId: string;
}): Promise<LedgerFollowupRow> {
  const existing = await prisma.ledgerFollowup.findUnique({ where: { id: input.id } });
  if (!existing) throw new ServiceError("NOT_FOUND", "Followup not found.", 404);
  if (existing.resolvedAt) {
    throw new ServiceError("ALREADY_RESOLVED", "Already resolved.", 409);
  }
  const cleanResolution = input.resolutionNote?.trim() || null;
  const updated = await prisma.$transaction(async (tx) => {
    const mergedNote = cleanResolution
      ? [existing.note, `Resolved: ${cleanResolution}`].filter(Boolean).join("\n\n")
      : existing.note;
    const row = await tx.ledgerFollowup.update({
      where: { id: input.id },
      data: {
        note: mergedNote,
        resolvedAt: new Date(),
        resolvedById: input.actorId,
      },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        resolvedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    await writeAudit(tx, AUDIT.LEDGER_FOLLOWUP.RESOLVED, input.actorId, {
      followupId: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      resolutionNote: cleanResolution,
    });
    return row;
  });
  return summarize(updated);
}

/**
 * Hard-delete a followup. Use only for "I flagged the wrong row" recoveries
 * — the normal "I'm done with this" path is resolveFollowup, which keeps
 * the row for history. Allowed for both open and resolved rows.
 */
export async function deleteFollowup(input: { id: string; actorId: string }): Promise<void> {
  const existing = await prisma.ledgerFollowup.findUnique({ where: { id: input.id } });
  if (!existing) throw new ServiceError("NOT_FOUND", "Followup not found.", 404);
  await prisma.$transaction(async (tx) => {
    await tx.ledgerFollowup.delete({ where: { id: input.id } });
    await writeAudit(tx, AUDIT.LEDGER_FOLLOWUP.DELETED, input.actorId, {
      followupId: existing.id,
      entityType: existing.entityType,
      entityId: existing.entityId,
      wasResolved: !!existing.resolvedAt,
    });
  });
}
