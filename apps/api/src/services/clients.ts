import { prisma } from "../db/prisma";
import {
  Prisma,
  ClientStatus,
  ContactRole,
  ContactStatus,
  PropertyStatus,
  JobStatus,
} from "@prisma/client";
import type { ServicesClients } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { action } from "../lib/services";
import { ServiceError } from "../lib/errors";
import { randomBytes } from "crypto";
import {
  applyJobPauseSideEffectsInTx,
  applyJobResumeSideEffectsInTx,
} from "./jobs";

function normalizePhone(raw?: string | null): string | null {
  const s = (raw ?? "").replace(/[^\d+]/g, "");
  if (!s) return null;
  if (s.startsWith("+")) return s;
  return "+1" + s;
}

/**
 * Primary-contact invariant guard. Blocks pause/archive/delete when the target
 * is the client's only ACTIVE primary contact — invoice routing depends on a
 * primary existing, so the admin must promote another contact first.
 */
async function assertNotSoleActivePrimary(
  contactId: string,
  verb: "pause" | "archive" | "delete",
): Promise<void> {
  const target = await prisma.clientContact.findUnique({
    where: { id: contactId },
    select: { clientId: true, isPrimary: true, status: true },
  });
  if (!target) return;
  if (!target.isPrimary) return;
  if (target.status !== "ACTIVE") return;
  const otherActivePrimaries = await prisma.clientContact.count({
    where: {
      clientId: target.clientId,
      status: "ACTIVE",
      isPrimary: true,
      NOT: { id: contactId },
    },
  });
  if (otherActivePrimaries === 0) {
    throw new ServiceError(
      "PRIMARY_REQUIRED",
      `Can't ${verb} this contact — it's the client's only primary contact. Set another contact as Primary first.`,
      409,
    );
  }
}

// Accept either { firstName,lastName } or a single { name } and split it.
function normalizeContactPayload(payload: any): {
  status: ContactStatus;
  firstName: string;
  lastName: string;
  nickname: string | null;
  email: string | null;
  phone: string | null;
  normalizedPhone: string | null;
  role: ContactRole | null;
  isPrimary: boolean;
} {
  let first = (payload.firstName ?? "").trim();
  let last = (payload.lastName ?? "").trim();

  if (!first && !last && payload.name) {
    const n = String(payload.name).trim();
    const parts = n.split(/\s+/);
    first = (parts.shift() ?? "").trim();
    last = (parts.join(" ") ?? "").trim();
  }

  const phone = payload.phone ?? null;
  const normalizedPhone = normalizePhone(phone);

  // role → enum or null
  let role: ContactRole | null = null;
  if (payload.role) {
    const r = String(payload.role);
    const key = r in ContactRole ? r : r.toUpperCase();
    if (key in ContactRole) role = (ContactRole as any)[key] as ContactRole;
  }

  return {
    status: payload.status ?? "ACTIVE",
    firstName: first,
    lastName: last,
    nickname: (payload.nickname ?? "").trim() || null,
    email: (payload.email ?? "").trim() || null,
    phone: (payload.phone ?? "").trim() || null,
    normalizedPhone,
    role,
    isPrimary: !!payload.isPrimary,
  };
}

export const clients: ServicesClients = {
  async list(params?: {
    q?: string;
    status?: ClientStatus | "ALL";
    limit?: number;
  }) {
    const q = (params?.q ?? "").trim();
    const status =
      params?.status && params.status !== "ALL" ? params.status : undefined;
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);

    const where: Prisma.ClientWhereInput = {};
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { displayName: { contains: q, mode: "insensitive" } },
        {
          contacts: {
            some: {
              OR: [
                { firstName: { contains: q, mode: "insensitive" } },
                { lastName: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
                { phone: { contains: q, mode: "insensitive" } },
              ],
            },
          },
        },
      ];
    }

    const rows = await prisma.client.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        _count: { select: { contacts: true, properties: true } },

        contacts: {
          select: {
            id: true,
            status: true,
            firstName: true,
            lastName: true,
            nickname: true,
            role: true,
            email: true,
            phone: true,
            normalizedPhone: true,
            isPrimary: true,
            clerkUserId: true,
          },
          orderBy: [
            { isPrimary: "desc" }, // primary first
            { status: "desc" }, // then status
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        },

        // lightweight properties preview (cap the list)
        properties: {
          select: {
            id: true,
            kind: true,
            displayName: true,
            street1: true,
            street2: true,
            city: true,
            state: true,
            postalCode: true,
            country: true,
            status: true,
          },
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
          take: 3,
        },
      },
    });

    return rows.map((c) => {
      const { _count, ...client } = c;
      const primaryContact =
        c.contacts.find((ct) => ct.isPrimary) ?? c.contacts[0] ?? null;

      return {
        ...client,

        // explicit additions for the UI
        contacts: c.contacts,
        properties: c.properties,

        contactCount: _count.contacts,
        propertyCount: _count.properties,
        primaryContact,
      };
    });
  },

  async get(id: string) {
    return prisma.client.findUniqueOrThrow({
      where: { id },
      include: {
        contacts: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        },
      },
    });
  },

  async create(currentUserId: string, payload: any) {
    return prisma.$transaction(async (tx) => {
      const data = {
        type: payload.type,
        displayName: payload.displayName,
        status: payload.status ?? "ACTIVE",
        notesInternal: payload.notesInternal,
        isVip: payload.isVip ?? false,
        vipReason: payload.vipReason ?? null,
      };
      const record = await tx.client.create({
        data: data,
      });
      await writeAudit(tx, AUDIT.CLIENT.CREATED, currentUserId, {
        id: record.id,
        record: record,
      });
      return record;
    });
  },

  async update(currentUserId: string, id: string, payload: any) {
    return prisma.$transaction(async (tx) => {
      const data: any = {
        type: payload.type,
        displayName: payload.displayName,
        status: payload.status,
        notesInternal: payload.notesInternal,
      };
      if (payload.isVip !== undefined) data.isVip = !!payload.isVip;
      if (payload.vipReason !== undefined) data.vipReason = payload.isVip ? (payload.vipReason || null) : null;
      if (payload.adminTags !== undefined) data.adminTags = Array.isArray(payload.adminTags) ? JSON.stringify(payload.adminTags) : null;
      const record = await tx.client.update({
        where: { id },
        data: data,
      });
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, currentUserId, {
        id: id,
        record: record,
      });
      return record;
    });
  },

  async pause(currentUserId: string, id: string) {
    return action<ClientStatus>(
      currentUserId,
      id,
      "client",
      ClientStatus.PAUSED,
      AUDIT.CLIENT.PAUSED
    );
  },

  async unpause(currentUserId: string, id: string) {
    return action<ClientStatus>(
      currentUserId,
      id,
      "client",
      ClientStatus.ACTIVE,
      AUDIT.CLIENT.UNPAUSED
    );
  },

  // Archive the Client AND cascade to every non-archived Property + every
  // non-archived Job under those Properties. Populates the previously-
  // unused `Client.archivedAt` timestamp so downstream queries (e.g. the
  // duplicate-clients audit at admin.ts) stop treating archived rows as
  // active. Cascade is transactional — either the whole tree archives
  // or nothing does. Every audited row shares a `cascadeGroupId` so
  // "show me every row affected by this cascade" is a single query.
  //
  // Historical work is preserved: PENDING_PAYMENT occurrences remain
  // payable, exports still surface the data, /pay/[token] still resolves.
  // Nothing downstream filters on `Client.status = ARCHIVED` — the
  // cascade is purely a "hide from active view" state.
  async archive(currentUserId: string, id: string) {
    const cascadeGroupId = `cg_${randomBytes(9).toString("hex")}`;
    return prisma.$transaction(async (tx) => {
      const client = await tx.client.findUnique({ where: { id } });
      if (!client) throw new ServiceError("NOT_FOUND", "Client not found.", 404);
      if (client.status === ClientStatus.ARCHIVED && client.archivedAt) {
        // Fully idempotent — status archived AND archivedAt populated.
        return { archived: true, propertiesArchived: 0, jobsArchived: 0, cascadeGroupId };
      }
      // Update Client. Sets status AND archivedAt — the historical bug
      // was populating only `status` while leaving `archivedAt` null.
      await tx.client.update({
        where: { id },
        data: { status: ClientStatus.ARCHIVED, archivedAt: new Date() },
      });
      // Cascade to Properties (each of which cascades further to Jobs).
      const properties = await tx.property.findMany({
        where: { clientId: id, status: { not: PropertyStatus.ARCHIVED } },
        select: { id: true },
      });
      let propertiesArchived = 0;
      let jobsArchived = 0;
      for (const p of properties) {
        await tx.property.update({
          where: { id: p.id },
          data: { status: PropertyStatus.ARCHIVED, archivedAt: new Date() },
        });
        const jobs = await tx.job.findMany({
          where: { propertyId: p.id, status: { not: JobStatus.ARCHIVED } },
          select: { id: true },
        });
        for (const j of jobs) {
          await tx.job.update({
            where: { id: j.id },
            data: { status: JobStatus.ARCHIVED },
          });
          await writeAudit(tx, AUDIT.JOB.ARCHIVED, currentUserId, {
            jobId: j.id,
            cascadeGroupId,
            triggeredBy: "client_archive",
            clientId: id,
            propertyId: p.id,
          });
          jobsArchived++;
        }
        await writeAudit(tx, AUDIT.PROPERTY.ARCHIVED, currentUserId, {
          propertyId: p.id,
          cascadeGroupId,
          triggeredBy: "client_archive",
          clientId: id,
          jobsArchived: jobs.length,
        });
        propertiesArchived++;
      }
      // Top-level trigger event carries the roll-up counts.
      await writeAudit(tx, AUDIT.CLIENT.ARCHIVED, currentUserId, {
        clientId: id,
        cascadeGroupId,
        propertiesArchived,
        jobsArchived,
      });
      return { archived: true, propertiesArchived, jobsArchived, cascadeGroupId };
    });
  },

  // Symmetric unarchive — mirrors archive shape. Idempotent per row so
  // the cascade doesn't blow up on Properties/Jobs already returned to
  // active. Historical PROPOSED / PAUSED Jobs come back as ACCEPTED
  // (the safest "resumed service" state).
  async unarchive(currentUserId: string, id: string) {
    const cascadeGroupId = `cg_${randomBytes(9).toString("hex")}`;
    return prisma.$transaction(async (tx) => {
      const client = await tx.client.findUnique({ where: { id } });
      if (!client) throw new ServiceError("NOT_FOUND", "Client not found.", 404);
      if (client.status !== ClientStatus.ARCHIVED && !client.archivedAt) {
        return { unarchived: true, propertiesUnarchived: 0, jobsUnarchived: 0, cascadeGroupId };
      }
      await tx.client.update({
        where: { id },
        data: { status: ClientStatus.ACTIVE, archivedAt: null },
      });
      const properties = await tx.property.findMany({
        where: { clientId: id, status: PropertyStatus.ARCHIVED },
        select: { id: true },
      });
      let propertiesUnarchived = 0;
      let jobsUnarchived = 0;
      for (const p of properties) {
        await tx.property.update({
          where: { id: p.id },
          data: { status: PropertyStatus.ACTIVE, archivedAt: null },
        });
        const jobs = await tx.job.findMany({
          where: { propertyId: p.id, status: JobStatus.ARCHIVED },
          select: { id: true },
        });
        for (const j of jobs) {
          await tx.job.update({
            where: { id: j.id },
            data: { status: JobStatus.ACCEPTED },
          });
          await writeAudit(tx, AUDIT.JOB.UNARCHIVED, currentUserId, {
            jobId: j.id,
            cascadeGroupId,
            triggeredBy: "client_unarchive",
            clientId: id,
            propertyId: p.id,
          });
          jobsUnarchived++;
        }
        await writeAudit(tx, AUDIT.PROPERTY.UNARCHIVED, currentUserId, {
          propertyId: p.id,
          cascadeGroupId,
          triggeredBy: "client_unarchive",
          clientId: id,
          jobsUnarchived: jobs.length,
        });
        propertiesUnarchived++;
      }
      await writeAudit(tx, AUDIT.CLIENT.UNARCHIVED, currentUserId, {
        clientId: id,
        cascadeGroupId,
        propertiesUnarchived,
        jobsUnarchived,
      });
      return { unarchived: true, propertiesUnarchived, jobsUnarchived, cascadeGroupId };
    });
  },

  async delete(currentUserId: string, id: string) {
    // Properties still block client deletion — they own jobs, occurrences,
    // payments, and other heavy state that should never be wiped via a
    // client delete. Contacts, however, cascade. Without that cascade, a
    // client with a sole primary contact is permanently un-deletable
    // because the primary-contact invariant refuses to drop the only
    // primary and the client refuses to drop with any contacts. The
    // confirm dialog surfaces the contact list so it's never a surprise.
    const propertyCount = await prisma.property.count({ where: { clientId: id } });
    if (propertyCount > 0) {
      throw new ServiceError(
        "HAS_DEPENDENCIES",
        `Cannot delete this client because it has ${propertyCount} associated ${propertyCount === 1 ? "property" : "properties"}. Please delete the ${propertyCount === 1 ? "property" : "properties"} first.`,
        409
      );
    }

    const contactCount = await prisma.clientContact.count({ where: { clientId: id } });

    await prisma.$transaction(async (tx) => {
      if (contactCount > 0) {
        // With no properties on the client there are no Jobs and therefore
        // no JobContact rows referencing these contacts — the deleteMany
        // is safe against the JobContact onDelete: Restrict FK.
        await tx.clientContact.deleteMany({ where: { clientId: id } });
      }
      await tx.client.delete({ where: { id } });
      await writeAudit(tx, AUDIT.CLIENT.DELETED, currentUserId, {
        id,
        cascadedContactCount: contactCount,
      });
    });
    return { deleted: true as const };
  },

  // ─────────────────────────────────────────────────────────────────────
  // Bulk pause / resume services for a Client.
  //
  // The operator's mental model: "Client X is going on vacation for 3
  // months — stop all their services." Instead of walking each Job on
  // each Property manually, this fans out one gesture across every
  // ACCEPTED Job on the Client.
  //
  // Bookkeeping via Job.clientBulkPausedAt/ById so bulk-resume can
  // find its own targets without touching Jobs that were independently
  // paused before the bulk op. Same cascadeGroupId pattern as Step 1's
  // archive cascade — every audited row carries the shared correlation
  // id so "show me every Job affected by this bulk pause" is one query.
  //
  // Idempotent per-Job:
  //   - Already-paused (independent or bulk) → skipped, not double-counted
  //   - PROPOSED / ARCHIVED Jobs → not touched (paused-services concept
  //     only applies to ACCEPTED recurring services)
  //
  // Side effects (per Job) come from the shared helpers in jobs.ts, so
  // the observable behavior matches a manual per-Job pause exactly.
  // ─────────────────────────────────────────────────────────────────────
  async bulkPauseServices(currentUserId: string, clientId: string) {
    const cascadeGroupId = `cg_${randomBytes(9).toString("hex")}`;
    return prisma.$transaction(async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) throw new ServiceError("NOT_FOUND", "Client not found.", 404);
      const jobs = await tx.job.findMany({
        where: {
          property: { clientId },
          status: JobStatus.ACCEPTED,
        },
        select: { id: true },
      });
      const now = new Date();
      let jobsPaused = 0;
      for (const j of jobs) {
        await tx.job.update({
          where: { id: j.id },
          data: {
            status: JobStatus.PAUSED,
            clientBulkPausedAt: now,
            clientBulkPausedById: currentUserId,
          },
        });
        await applyJobPauseSideEffectsInTx(tx, currentUserId, j.id, {
          cascadeGroupId,
          triggeredBy: "client_bulk_pause",
          clientId,
        });
        await writeAudit(tx, AUDIT.JOB.UPDATED, currentUserId, {
          jobId: j.id,
          action: "CLIENT_BULK_PAUSED",
          cascadeGroupId,
          clientId,
        });
        jobsPaused++;
      }
      // Top-level trigger event — carries the roll-up count so operators
      // can find "the pause I did last Tuesday" in one row.
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, currentUserId, {
        clientId,
        action: "BULK_PAUSED_SERVICES",
        cascadeGroupId,
        jobsPaused,
      });
      return { jobsPaused, cascadeGroupId };
    });
  },

  async bulkResumeServices(currentUserId: string, clientId: string) {
    const cascadeGroupId = `cg_${randomBytes(9).toString("hex")}`;
    return prisma.$transaction(async (tx) => {
      const client = await tx.client.findUnique({ where: { id: clientId } });
      if (!client) throw new ServiceError("NOT_FOUND", "Client not found.", 404);
      // Only touch Jobs that were paused as part of a bulk pause. Any
      // Job the operator individually paused (clientBulkPausedAt IS NULL
      // but status = PAUSED) stays paused — resume must not overwrite
      // that intent.
      const jobs = await tx.job.findMany({
        where: {
          property: { clientId },
          status: JobStatus.PAUSED,
          clientBulkPausedAt: { not: null },
        },
        select: { id: true },
      });
      let jobsResumed = 0;
      for (const j of jobs) {
        await tx.job.update({
          where: { id: j.id },
          data: {
            status: JobStatus.ACCEPTED,
            clientBulkPausedAt: null,
            clientBulkPausedById: null,
          },
        });
        await applyJobResumeSideEffectsInTx(tx, currentUserId, j.id, {
          cascadeGroupId,
          triggeredBy: "client_bulk_resume",
          clientId,
        });
        await writeAudit(tx, AUDIT.JOB.UPDATED, currentUserId, {
          jobId: j.id,
          action: "CLIENT_BULK_RESUMED",
          cascadeGroupId,
          clientId,
        });
        jobsResumed++;
      }
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, currentUserId, {
        clientId,
        action: "BULK_RESUMED_SERVICES",
        cascadeGroupId,
        jobsResumed,
      });
      return { jobsResumed, cascadeGroupId };
    });
  },

  async addContact(currentUserId: string, clientId: string, payload: any) {
    const cp = normalizeContactPayload(payload);
    return prisma.$transaction(async (tx) => {
      // Primary-contact invariant: every client must have exactly one
      // primary contact. If this is the first ACTIVE contact on the
      // client, force isPrimary=true regardless of what the caller passed.
      const existingActive = await tx.clientContact.count({
        where: { clientId, status: "ACTIVE" },
      });
      const willBeOnlyActive = existingActive === 0 && (cp.status ?? "ACTIVE") === "ACTIVE";
      const isPrimary = willBeOnlyActive ? true : cp.isPrimary;

      // Propagate clerkUserId from any existing ClientContact rows
      // that share this person's email or normalized phone. This is
      // the multi-client identity glue: when the admin adds an
      // existing person as a contact on a new Client, the new row
      // gets bound to the same Clerk identity the person already
      // has, so a single sign-in surfaces every client they belong
      // to. The admin-side dialog runs a separate pre-flight check
      // and shows the operator a confirmation — if they get here,
      // they've explicitly opted into this. See /admin/contacts/lookup.
      let inheritedClerkUserId: string | null = null;
      if (cp.email || cp.normalizedPhone) {
        const identityMatch = await tx.clientContact.findFirst({
          where: {
            clerkUserId: { not: null },
            OR: [
              ...(cp.email ? [{ email: { equals: cp.email, mode: "insensitive" as const } }] : []),
              ...(cp.normalizedPhone ? [{ normalizedPhone: cp.normalizedPhone }] : []),
            ],
          },
          select: { clerkUserId: true },
        });
        inheritedClerkUserId = identityMatch?.clerkUserId ?? null;
      }

      const data = {
        clientId,
        status: cp.status ?? "ACTIVE",
        firstName: cp.firstName,
        lastName: cp.lastName,
        nickname: cp.nickname,
        email: cp.email,
        phone: cp.phone,
        normalizedPhone: cp.normalizedPhone,
        role: cp.role,
        isPrimary,
        ...(inheritedClerkUserId ? { clerkUserId: inheritedClerkUserId } : {}),
      };
      const contact = await tx.clientContact.create({ data });
      if (isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId, NOT: { id: contact.id } },
          data: { isPrimary: false },
        });
      }
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_CREATED, currentUserId, {
        contactRecord: { ...contact },
      });
      return contact;
    });
  },

  async updateContact(
    currentUserId: string,
    clientId: string,
    contactId: string,
    payload: any
  ) {
    const cp = normalizeContactPayload(payload);
    return prisma.$transaction(async (tx) => {
      const before = await tx.clientContact.findUniqueOrThrow({
        where: { id: contactId },
        select: { isPrimary: true, status: true },
      });

      // Primary-contact invariant: refuse to demote the sole primary, and
      // refuse to archive/pause the sole primary. The admin must promote a
      // different contact first.
      const isBecomingNonPrimary = before.isPrimary && !cp.isPrimary;
      const isLeavingActive = before.status === "ACTIVE" && cp.status !== "ACTIVE";
      if (isBecomingNonPrimary || isLeavingActive) {
        const otherActivePrimaries = await tx.clientContact.count({
          where: {
            clientId,
            status: "ACTIVE",
            isPrimary: true,
            NOT: { id: contactId },
          },
        });
        if (before.isPrimary && otherActivePrimaries === 0) {
          if (isBecomingNonPrimary) {
            throw new ServiceError(
              "PRIMARY_REQUIRED",
              "Every client must have a primary contact. Set another contact as Primary before unchecking this one.",
              409,
            );
          }
          if (isLeavingActive) {
            throw new ServiceError(
              "PRIMARY_REQUIRED",
              "Every client must have an active primary contact. Set another contact as Primary before pausing or archiving this one.",
              409,
            );
          }
        }
      }

      const data = {
        status: cp.status,
        firstName: cp.firstName,
        lastName: cp.lastName,
        nickname: cp.nickname,
        email: cp.email,
        phone: cp.phone,
        normalizedPhone: cp.normalizedPhone,
        role: cp.role,
        isPrimary: cp.isPrimary,
      };
      const updated = await tx.clientContact.update({
        where: { id: contactId },
        data,
      });
      if (cp.isPrimary) {
        await tx.clientContact.updateMany({
          where: { clientId, NOT: { id: contactId } },
          data: { isPrimary: false },
        });
      }

      // Multi-client identity propagation. When the operator
      // explicitly opts in (`applyToLinked: true`), apply the
      // identity-side fields to every other ClientContact bound
      // to the same Clerk identity. The relationship-side fields
      // (status, role, isPrimary, clientId) STAY per-row — those
      // describe the person's role within a specific client and
      // should never propagate. Edited contact has no clerkUserId?
      // Nothing to propagate; updateMany is a no-op.
      const applyToLinked = payload?.applyToLinked === true;
      if (applyToLinked && updated.clerkUserId) {
        const linkedFields = {
          firstName: cp.firstName,
          lastName: cp.lastName,
          nickname: cp.nickname,
          email: cp.email,
          phone: cp.phone,
          normalizedPhone: cp.normalizedPhone,
        };
        const linkedResult = await tx.clientContact.updateMany({
          where: {
            clerkUserId: updated.clerkUserId,
            NOT: { id: contactId },
          },
          data: linkedFields,
        });
        await writeAudit(tx, AUDIT.CLIENT.CONTACT_UPDATED, currentUserId, {
          clientId,
          contactId,
          contactRecord: { ...updated },
          identityPropagatedToCount: linkedResult.count,
        });
        return updated;
      }

      await writeAudit(tx, AUDIT.CLIENT.CONTACT_UPDATED, currentUserId, {
        clientId,
        contactId,
        contactRecord: { ...updated },
      });

      return updated;
    });
  },

  //TODO: DO CREATE, UPDATE, DELETE TOO?

  async pauseContact(currentUserId: string, id: string) {
    await assertNotSoleActivePrimary(id, "pause");
    return action<ContactStatus>(
      currentUserId,
      id,
      "clientContact",
      ContactStatus.PAUSED,
      AUDIT.CLIENT.CONTACT_PAUSED
    );
  },

  async unpauseContact(currentUserId: string, id: string) {
    return action<ContactStatus>(
      currentUserId,
      id,
      "clientContact",
      ContactStatus.ACTIVE,
      AUDIT.CLIENT.CONTACT_UNPAUSED
    );
  },

  async archiveContact(currentUserId: string, id: string) {
    await assertNotSoleActivePrimary(id, "archive");
    return action<ContactStatus>(
      currentUserId,
      id,
      "clientContact",
      ContactStatus.ARCHIVED,
      AUDIT.CLIENT.CONTACT_ARCHIVED
    );
  },

  async unarchiveContact(currentUserId: string, id: string) {
    return action<ContactStatus>(
      currentUserId,
      id,
      "clientContact",
      ContactStatus.ACTIVE,
      AUDIT.CLIENT.CONTACT_UNARCHIVED
    );
  },

  async deleteContact(
    currentUserId: string,
    clientId: string,
    contactId: string
  ) {
    await assertNotSoleActivePrimary(contactId, "delete");
    await prisma.$transaction(async (tx) => {
      await tx.clientContact.delete({ where: { id: contactId } });
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_DELETED, currentUserId, {
        clientId,
        contactId,
      });
    });
    return { deleted: true as const };
  },

  async setPrimaryContact(
    currentUserId: string,
    clientId: string,
    contactId: string
  ) {
    await prisma.$transaction(async (tx) => {
      // Refuse to promote a non-ACTIVE contact — invoice routing filters
      // on { status: "ACTIVE", isPrimary: true }, so a paused/archived
      // primary would silently break sending.
      const target = await tx.clientContact.findUniqueOrThrow({
        where: { id: contactId },
        select: { status: true, clientId: true },
      });
      if (target.clientId !== clientId) {
        throw new ServiceError(
          "WRONG_CLIENT",
          "Contact does not belong to this client.",
          400,
        );
      }
      if (target.status !== "ACTIVE") {
        throw new ServiceError(
          "INACTIVE_PRIMARY",
          "Only an active contact can be set as primary. Unarchive or unpause this contact first.",
          409,
        );
      }
      await tx.clientContact.updateMany({
        where: { clientId },
        data: { isPrimary: false },
      });
      await tx.clientContact.update({
        where: { id: contactId },
        data: { isPrimary: true },
      });
      await writeAudit(tx, AUDIT.CLIENT.UPDATED, currentUserId, {
        clientId,
        contactId,
        primary: true,
      });
    });
    return { primarySet: true as const };
  },
};
