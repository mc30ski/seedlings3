import { prisma } from "../db/prisma";
import { Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

type Tx = Prisma.TransactionClient;
// Either the base client or an interactive-transaction client. Percent
// validation has to run on both: inside a transaction it must see the
// uncommitted member rows written moments earlier.
type AnyClient = Tx | typeof prisma;

const groupInclude = {
  claimer: { select: { id: true, displayName: true, email: true, workerType: true } },
  members: {
    include: {
      user: { select: { id: true, displayName: true, email: true, workerType: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
  preferredEquipment: {
    include: {
      equipment: { select: { id: true, shortDesc: true, brand: true, model: true, type: true, status: true, retiredAt: true } },
      equipmentCollection: { select: { id: true, name: true, description: true } },
    },
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

const IN_FLIGHT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "PAUSED"] as const;

// A group is "locked" while it has any in-flight occurrence (group-assigned
// or via an outstanding group rental). Locked groups cannot be edited in
// ways that would shift identity or cost math: claimer change, member
// add/remove/role change, equipmentCostPercent change, or archive. The
// snapshot model means in-flight work doesn't react to group changes;
// the lock keeps admins from making changes that would only confuse them.
async function isGroupLocked(groupId: string): Promise<boolean> {
  const inFlightOcc = await prisma.jobOccurrence.findFirst({
    where: {
      assignedGroupId: groupId,
      status: { in: IN_FLIGHT_STATUSES as any },
    },
    select: { id: true },
  });
  if (inFlightOcc) return true;
  const activeCheckout = await prisma.checkout.findFirst({
    where: { groupId, releasedAt: null },
    select: { id: true },
  });
  return !!activeCheckout;
}

async function assertNotLocked(groupId: string): Promise<void> {
  if (await isGroupLocked(groupId)) {
    throw new ServiceError(
      "GROUP_LOCKED",
      "Group has in-flight work and can't be edited right now. Wait until all occurrences and rentals are done.",
      409,
    );
  }
}

// equipmentCostPercent invariant: either every worker has null (default
// even split), or every worker has a number and the numbers sum to 100.
// Observers are always excluded from the sum check.
function validatePercents(
  members: Array<{ role: string; equipmentCostPercent: number | null }>,
): void {
  const workers = members.filter((m) => m.role !== "observer");
  if (workers.length === 0) return; // no workers → no split to validate
  const set = workers.filter((m) => m.equipmentCostPercent != null);
  if (set.length === 0) return; // even-split default
  if (set.length !== workers.length) {
    throw new ServiceError(
      "INVALID_PERCENTS",
      "If any worker has a custom equipment cost %, every worker in the group must have one.",
      400,
    );
  }
  const total = workers.reduce((s, m) => s + (m.equipmentCostPercent ?? 0), 0);
  if (Math.abs(total - 100) > 0.001) {
    throw new ServiceError(
      "INVALID_PERCENTS",
      `Equipment cost percents must sum to 100 (got ${total.toFixed(2)}).`,
      400,
    );
  }
}

// Transaction-aware form of the group percent invariant. Reads through the
// passed client so it can validate rows written inside the same
// transaction (a plain `prisma` read would not see them).
async function assertGroupPercentsValid(client: AnyClient, groupId: string): Promise<void> {
  const members = await client.groupMember.findMany({
    where: { groupId },
    select: { role: true, equipmentCostPercent: true },
  });
  // Include the implicit claimer-as-worker slot. Claimer has no row in
  // GroupMember but always counts as a worker with even share (null).
  validatePercents([{ role: "worker", equipmentCostPercent: null }, ...members]);
}

export type GroupCreateInput = {
  name: string;
  description?: string | null;
  claimerUserId: string;
  members?: Array<{
    userId: string;
    role?: string; // "worker" | "observer"
    equipmentCostPercent?: number | null;
  }>;
};

export type GroupPatchInput = {
  name?: string;
  description?: string | null;
  claimerUserId?: string;
};

export type GroupMemberInput = {
  userId: string;
  role?: string;
  equipmentCostPercent?: number | null;
};

export type GroupPreferredEquipmentInput = {
  equipmentId?: string | null;
  equipmentCollectionId?: string | null;
};

export const groups = {
  /** List all groups (admin). Filter `includeArchived` to include soft-deleted. */
  async list(params?: { includeArchived?: boolean }) {
    return prisma.group.findMany({
      where: params?.includeArchived ? {} : { archivedAt: null },
      orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
      include: groupInclude,
    });
  },

  async getById(id: string) {
    const g = await prisma.group.findUnique({
      where: { id },
      include: groupInclude,
    });
    if (!g) throw new ServiceError("NOT_FOUND", "Group not found.", 404);
    return g;
  },

  /** Groups whose claimer is the given user (used by JobsTab claim chooser). */
  async listForClaimer(userId: string) {
    return prisma.group.findMany({
      where: { claimerUserId: userId, archivedAt: null },
      orderBy: { name: "asc" },
      include: groupInclude,
    });
  },

  /** Groups the given user is a member of (worker OR observer OR claimer). */
  async listForUser(userId: string) {
    return prisma.group.findMany({
      where: {
        archivedAt: null,
        OR: [
          { claimerUserId: userId },
          { members: { some: { userId } } },
        ],
      },
      orderBy: { name: "asc" },
      include: groupInclude,
    });
  },

  async create(currentUserId: string, input: GroupCreateInput) {
    const name = (input.name ?? "").trim();
    if (!name) throw new ServiceError("INVALID_INPUT", "Group name is required.", 400);

    const claimerExists = await prisma.user.findUnique({
      where: { id: input.claimerUserId },
      select: { id: true },
    });
    if (!claimerExists) throw new ServiceError("INVALID_INPUT", "Claimer user not found.", 400);

    // De-dupe member rows, drop claimer if accidentally listed (claimer
    // isn't stored in GroupMember — they're tracked via claimerUserId).
    const rawMembers = input.members ?? [];
    const seen = new Set<string>();
    const cleanedMembers: GroupMemberInput[] = [];
    for (const m of rawMembers) {
      if (!m?.userId) continue;
      if (m.userId === input.claimerUserId) continue;
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      cleanedMembers.push({
        userId: m.userId,
        role: m.role === "observer" ? "observer" : "worker",
        equipmentCostPercent: m.equipmentCostPercent ?? null,
      });
    }

    // Validate percents including the claimer's implicit worker share.
    // Claimer is always a worker for cost-split purposes.
    validatePercents([
      { role: "worker", equipmentCostPercent: null },
      ...cleanedMembers.map((m) => ({
        role: m.role ?? "worker",
        equipmentCostPercent: m.equipmentCostPercent ?? null,
      })),
    ]);

    return prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          name,
          description: input.description?.trim() || null,
          claimerUserId: input.claimerUserId,
          members: {
            create: cleanedMembers.map((m) => ({
              userId: m.userId,
              role: m.role ?? "worker",
              equipmentCostPercent: m.equipmentCostPercent ?? null,
            })),
          },
        },
        include: groupInclude,
      });

      // Money: the claimer plus each member's equipmentCostPercent are the
      // two inputs writeCheckoutSplits (services/equipment.ts) uses to decide
      // who is billed for this crew's equipment rentals. Snapshot the whole
      // split as created so any later charge can be traced to a roster.
      await writeAudit(tx, AUDIT.GROUP.CREATED, currentUserId, {
        groupId: created.id,
        name: created.name,
        description: created.description,
        claimerUserId: created.claimerUserId,
        memberUserIds: created.members.map((m) => m.userId),
        members: created.members.map((m) => ({
          userId: m.userId,
          role: m.role,
          equipmentCostPercent: m.equipmentCostPercent,
        })),
      });

      return created;
    });
  },

  async update(currentUserId: string, id: string, input: GroupPatchInput) {
    const g = await this.getById(id);
    if (g.archivedAt) {
      throw new ServiceError("ARCHIVED", "Group is archived.", 400);
    }
    await assertNotLocked(id);

    const data: Prisma.GroupUpdateInput = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n) throw new ServiceError("INVALID_INPUT", "Group name is required.", 400);
      data.name = n;
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.claimerUserId !== undefined) {
      const claimerExists = await prisma.user.findUnique({
        where: { id: input.claimerUserId },
        select: { id: true },
      });
      if (!claimerExists) throw new ServiceError("INVALID_INPUT", "Claimer user not found.", 400);
      data.claimer = { connect: { id: input.claimerUserId } };
    }

    return prisma.$transaction(async (tx) => {
      // Switching claimer: drop the new claimer from members (if present)
      // — claimer is implicit, not a GroupMember row.
      let droppedMember: { userId: string; role: string; equipmentCostPercent: number | null } | null = null;
      if (input.claimerUserId !== undefined) {
        droppedMember = await tx.groupMember.findFirst({
          where: { groupId: id, userId: input.claimerUserId },
          select: { userId: true, role: true, equipmentCostPercent: true },
        });
        await tx.groupMember.deleteMany({
          where: { groupId: id, userId: input.claimerUserId },
        });
      }

      const updated = await tx.group.update({
        where: { id },
        data,
        include: groupInclude,
      });

      // Money: the claimer is the worker who fronts a group rental and the
      // pivot writeCheckoutSplits bills against, so swapping claimers moves
      // real charges between people. Also records the GroupMember row (and
      // its equipmentCostPercent) silently destroyed when the incoming
      // claimer was already a member — that member's explicit share is gone.
      await writeAudit(tx, AUDIT.GROUP.UPDATED, currentUserId, {
        action: "group_updated",
        groupId: id,
        claimerChanged:
          input.claimerUserId !== undefined && input.claimerUserId !== g.claimerUserId,
        beforeClaimerUserId: g.claimerUserId,
        afterClaimerUserId: updated.claimerUserId,
        beforeName: g.name,
        afterName: updated.name,
        beforeDescription: g.description,
        afterDescription: updated.description,
        droppedMemberUserId: droppedMember?.userId ?? null,
        droppedMemberRole: droppedMember?.role ?? null,
        droppedMemberEquipmentCostPercent: droppedMember?.equipmentCostPercent ?? null,
      });

      return updated;
    });
  },

  async archive(currentUserId: string, id: string) {
    const g = await this.getById(id);
    if (g.archivedAt) return g;
    await assertNotLocked(id);
    // Reject archive when this group is the configured default crew on
    // any active Job. Auto-clearing would silently un-staff those jobs;
    // forcing the admin to detach first surfaces the impact and keeps
    // the data trail clean. Lists affected jobs so the message is
    // actionable rather than just "blocked".
    const defaultOn = await prisma.job.findMany({
      where: { defaultGroupId: id },
      select: { id: true, property: { select: { displayName: true, client: { select: { displayName: true } } } } },
      take: 5,
    });
    if (defaultOn.length > 0) {
      const labels = defaultOn.map((j) => {
        const p = j.property?.displayName ?? "(no property)";
        const c = j.property?.client?.displayName ?? "";
        return c ? `${p} — ${c}` : p;
      });
      const moreCount = await prisma.job.count({ where: { defaultGroupId: id } });
      const extra = moreCount > defaultOn.length ? ` and ${moreCount - defaultOn.length} more` : "";
      throw new ServiceError(
        "GROUP_DEFAULT_ON_JOBS",
        `Can't archive — this group is the default crew on ${moreCount} job${moreCount === 1 ? "" : "s"} (${labels.join("; ")}${extra}). Reassign or clear the default crew on those jobs first.`,
        409,
      );
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.group.update({
        where: { id },
        data: { archivedAt: new Date() },
        include: groupInclude,
      });

      // Money: an archived crew can't claim jobs or rent equipment, so this
      // cost split stops applying to any new charge. Snapshot the roster and
      // percents that were in force at archive time.
      await writeAudit(tx, AUDIT.GROUP.ARCHIVED, currentUserId, {
        groupId: id,
        name: updated.name,
        claimerUserId: updated.claimerUserId,
        memberUserIds: updated.members.map((m) => m.userId),
        members: updated.members.map((m) => ({
          userId: m.userId,
          role: m.role,
          equipmentCostPercent: m.equipmentCostPercent,
        })),
      });

      return updated;
    });
  },

  async unarchive(currentUserId: string, id: string) {
    const g = await this.getById(id);
    if (!g.archivedAt) return g;
    return prisma.$transaction(async (tx) => {
      const updated = await tx.group.update({
        where: { id },
        data: { archivedAt: null },
        include: groupInclude,
      });

      // Money: restoring the crew puts this claimer + percent split back in
      // force for future equipment rentals, so record who it re-enables.
      await writeAudit(tx, AUDIT.GROUP.UNARCHIVED, currentUserId, {
        groupId: id,
        name: updated.name,
        claimerUserId: updated.claimerUserId,
        memberUserIds: updated.members.map((m) => m.userId),
        members: updated.members.map((m) => ({
          userId: m.userId,
          role: m.role,
          equipmentCostPercent: m.equipmentCostPercent,
        })),
      });

      return updated;
    });
  },

  // ── Members ─────────────────────────────────────────────────────────────

  async addMember(currentUserId: string, groupId: string, input: GroupMemberInput) {
    const g = await this.getById(groupId);
    if (g.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);
    await assertNotLocked(groupId);

    if (input.userId === g.claimerUserId) {
      throw new ServiceError("INVALID_INPUT", "Claimer is already implicitly a member.", 400);
    }
    const exists = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!exists) throw new ServiceError("INVALID_INPUT", "User not found.", 400);

    const role = input.role === "observer" ? "observer" : "worker";

    return prisma.$transaction(async (tx) => {
      const created = await tx.groupMember.create({
        data: {
          groupId,
          userId: input.userId,
          role,
          equipmentCostPercent: input.equipmentCostPercent ?? null,
        },
      });

      // Percent validation runs inside the transaction so an invalid split
      // rolls the new member back instead of leaving a half-applied roster.
      await assertGroupPercentsValid(tx, groupId);

      // Money: adding a worker adds a payer to the crew's equipment rental
      // split. With an explicit equipmentCostPercent they take exactly that
      // share; with null every worker's even-split share shrinks instead.
      await writeAudit(tx, AUDIT.GROUP.MEMBER_ADDED, currentUserId, {
        groupId,
        memberUserId: created.userId,
        role: created.role,
        equipmentCostPercent: created.equipmentCostPercent,
        claimerUserId: g.claimerUserId,
      });

      return created;
    });
  },

  async removeMember(currentUserId: string, groupId: string, userId: string) {
    const g = await this.getById(groupId);
    if (g.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);
    await assertNotLocked(groupId);
    if (userId === g.claimerUserId) {
      throw new ServiceError(
        "INVALID_INPUT",
        "Can't remove the claimer. Reassign the claimer to another member first.",
        400,
      );
    }
    return prisma.$transaction(async (tx) => {
      // Snapshot the row before it's destroyed — its percent is the share
      // that is about to stop being billed to anyone.
      const removed = await tx.groupMember.findFirst({
        where: { groupId, userId },
        select: { userId: true, role: true, equipmentCostPercent: true },
      });

      await tx.groupMember.deleteMany({ where: { groupId, userId } });

      // Removing a member can invalidate the percent sum. Strategy: if the
      // removed worker had a non-null percent, reset all percents to null
      // (revert to even split) so the admin re-checks math.
      const m = await tx.groupMember.findMany({
        where: { groupId },
        select: { id: true, userId: true, role: true, equipmentCostPercent: true },
      });
      const workers = m.filter((x) => x.role !== "observer");
      const anySet = workers.some((x) => x.equipmentCostPercent != null);
      const allSet = workers.length > 0 && workers.every((x) => x.equipmentCostPercent != null);
      const percentResetApplied = anySet && !allSet;
      if (percentResetApplied) {
        await tx.groupMember.updateMany({
          where: { groupId },
          data: { equipmentCostPercent: null },
        });
      }

      // Money: two charges move here. (1) The removed member stops being
      // billed for this crew's equipment rentals at all. (2) When the reset
      // fires, EVERY remaining member's explicit equipmentCostPercent is
      // wiped to null and the crew silently reverts to an even split — a
      // bulk re-pricing that was invisible before this audit row. Prior
      // percents are snapshotted so the old split can be reconstructed.
      await writeAudit(tx, AUDIT.GROUP.MEMBER_REMOVED, currentUserId, {
        groupId,
        claimerUserId: g.claimerUserId,
        removedUserId: userId,
        removedRole: removed?.role ?? null,
        removedEquipmentCostPercent: removed?.equipmentCostPercent ?? null,
        memberFound: !!removed,
        percentResetApplied,
        // Values as they stood AFTER the delete but BEFORE the reset.
        priorPercents: m.map((x) => ({
          userId: x.userId,
          role: x.role,
          equipmentCostPercent: x.equipmentCostPercent,
        })),
        resetUserIds: percentResetApplied ? m.map((x) => x.userId) : [],
      });

      return { removed: true };
    });
  },

  async updateMember(
    currentUserId: string,
    groupId: string,
    userId: string,
    patch: { role?: string; equipmentCostPercent?: number | null },
  ) {
    const g = await this.getById(groupId);
    if (g.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);
    await assertNotLocked(groupId);

    const data: Prisma.GroupMemberUpdateInput = {};
    if (patch.role !== undefined) {
      data.role = patch.role === "observer" ? "observer" : "worker";
    }
    if (patch.equipmentCostPercent !== undefined) {
      data.equipmentCostPercent = patch.equipmentCostPercent;
    }

    return prisma.$transaction(async (tx) => {
      const before = await tx.groupMember.findFirst({
        where: { groupId, userId },
        select: { role: true, equipmentCostPercent: true },
      });

      const updated = await tx.groupMember.updateMany({
        where: { groupId, userId },
        data,
      });
      if (updated.count === 0) {
        throw new ServiceError("NOT_FOUND", "Member not found in group.", 404);
      }
      // Validate inside the transaction so an invalid split rolls the edit
      // back rather than persisting a roster that fails the invariant.
      await assertGroupPercentsValid(tx, groupId);
      const after = await tx.groupMember.findFirst({ where: { groupId, userId } });

      // Money: equipmentCostPercent IS this member's share of every group
      // equipment rental, and flipping role to/from "observer" removes or
      // adds them to the payer set entirely. Both before and after are
      // recorded so a disputed charge can be tied to the split in force.
      await writeAudit(tx, AUDIT.GROUP.MEMBER_UPDATED, currentUserId, {
        groupId,
        memberUserId: userId,
        claimerUserId: g.claimerUserId,
        beforeRole: before?.role ?? null,
        afterRole: after?.role ?? null,
        beforeEquipmentCostPercent: before?.equipmentCostPercent ?? null,
        afterEquipmentCostPercent: after?.equipmentCostPercent ?? null,
        roleChanged: (before?.role ?? null) !== (after?.role ?? null),
        equipmentCostPercentChanged:
          (before?.equipmentCostPercent ?? null) !== (after?.equipmentCostPercent ?? null),
      });

      return after;
    });
  },

  /** Validate equipmentCostPercent rule for the group. Throws on violation. */
  async validateGroupPercents(groupId: string): Promise<void> {
    return assertGroupPercentsValid(prisma, groupId);
  },

  // ── Preferred equipment ─────────────────────────────────────────────────

  async addPreferred(
    currentUserId: string,
    groupId: string,
    input: GroupPreferredEquipmentInput,
  ) {
    const g = await this.getById(groupId);
    const hasEquip = !!input.equipmentId;
    const hasCol = !!input.equipmentCollectionId;
    if (hasEquip === hasCol) {
      throw new ServiceError(
        "INVALID_INPUT",
        "Provide exactly one of equipmentId or equipmentCollectionId.",
        400,
      );
    }
    if (hasEquip) {
      const e = await prisma.equipment.findUnique({ where: { id: input.equipmentId! }, select: { id: true } });
      if (!e) throw new ServiceError("INVALID_INPUT", "Equipment not found.", 400);
    } else {
      const c = await prisma.equipmentCollection.findUnique({
        where: { id: input.equipmentCollectionId! },
        select: { id: true },
      });
      if (!c) throw new ServiceError("INVALID_INPUT", "Collection not found.", 400);
    }
    return prisma.$transaction(async (tx) => {
      const created = await tx.groupPreferredEquipment.create({
        data: {
          groupId,
          equipmentId: input.equipmentId ?? null,
          equipmentCollectionId: input.equipmentCollectionId ?? null,
        },
      });

      // Money: preferred equipment steers which gear this crew checks out,
      // and every checkout it leads to is a billable rental split across the
      // claimer and members by equipmentCostPercent.
      await writeAudit(tx, AUDIT.GROUP.UPDATED, currentUserId, {
        action: "preferred_equipment_added",
        groupId,
        claimerUserId: g.claimerUserId,
        preferredId: created.id,
        equipmentId: created.equipmentId,
        equipmentCollectionId: created.equipmentCollectionId,
      });

      return created;
    });
  },

  async removePreferred(currentUserId: string, preferredId: string) {
    // Snapshot before the delete — the audit row is the only remaining
    // record of what was removed. Missing row: keep today's silent success.
    const existing = await prisma.groupPreferredEquipment.findUnique({
      where: { id: preferredId },
      select: { id: true, groupId: true, equipmentId: true, equipmentCollectionId: true },
    });
    if (!existing) return { removed: true };

    await prisma
      .$transaction(async (tx) => {
        await tx.groupPreferredEquipment.delete({ where: { id: preferredId } });

        // Money: drops a default piece of gear off this crew, changing which
        // rentals get charged to the claimer and split across its members.
        await writeAudit(tx, AUDIT.GROUP.UPDATED, currentUserId, {
          action: "preferred_equipment_removed",
          groupId: existing.groupId,
          preferredId: existing.id,
          equipmentId: existing.equipmentId,
          equipmentCollectionId: existing.equipmentCollectionId,
        });
      })
      // Preserve the existing swallow-on-failure behavior (e.g. the row was
      // deleted concurrently); the audit row rolls back with the delete.
      .catch(() => {});

    return { removed: true };
  },

  // ── Helpers exposed for jobs service ────────────────────────────────────

  /**
   * Materialize a group's current roster into JobOccurrenceAssignee rows on
   * the given occurrence. Sets assignedGroupId; stamps assignedById per
   * member (claimer self-assigns, others assigned-by claimer).
   *
   * Caller is responsible for:
   *   - validating the occurrence has no existing individual assignees
   *   - validating the actor is allowed (admin OR group's claimer)
   */
  async attachGroupToOccurrence(
    tx: Tx,
    params: { occurrenceId: string; groupId: string; actorUserId: string; mode: "admin-assign" | "claimer-claim" },
  ) {
    const { occurrenceId, groupId, actorUserId, mode } = params;
    const g = await tx.group.findUnique({
      where: { id: groupId },
      include: { members: { select: { userId: true, role: true } } },
    });
    if (!g) throw new ServiceError("NOT_FOUND", "Group not found.", 404);
    if (g.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);

    // Members include the claimer + everyone in GroupMember.
    type AssigneeRow = { userId: string; role: string | null };
    const rows: AssigneeRow[] = [
      { userId: g.claimerUserId, role: null },
      ...g.members.map((m) => ({
        userId: m.userId,
        role: m.role === "observer" ? "observer" : null,
      })),
    ];

    const occBefore = await tx.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { jobId: true, assignedGroupId: true },
    });

    await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data: { assignedGroupId: groupId },
    });

    for (const r of rows) {
      const assignedById = mode === "claimer-claim" ? r.userId === actorUserId ? actorUserId : g.claimerUserId : actorUserId;
      await tx.jobOccurrenceAssignee.upsert({
        where: { occurrenceId_userId: { occurrenceId, userId: r.userId } },
        create: {
          occurrenceId,
          userId: r.userId,
          role: r.role,
          assignedById,
        },
        update: { role: r.role },
      });
    }

    // Money: staffing an occurrence with a crew decides who gets paid for
    // this job, and binds the occurrence to the group whose claimer +
    // equipmentCostPercent split any equipment rented against it.
    await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, actorUserId, {
      action: "group_attached_to_occurrence",
      occurrenceId,
      jobId: occBefore?.jobId ?? null,
      groupId,
      beforeAssignedGroupId: occBefore?.assignedGroupId ?? null,
      afterAssignedGroupId: groupId,
      mode,
      claimerUserId: g.claimerUserId,
      assignedUserIds: rows.map((r) => r.userId),
      assignees: rows.map((r) => ({ userId: r.userId, role: r.role })),
    });
  },

  /** Detach a group from an occurrence: remove materialized members, clear assignedGroupId. */
  async detachGroupFromOccurrence(tx: Tx, currentUserId: string, occurrenceId: string) {
    // Snapshot every assignee before the wipe: deleteMany clears ALL rows on
    // the occurrence, including any that did not come from the group.
    const removedAssignees = await tx.jobOccurrenceAssignee.findMany({
      where: { occurrenceId },
      select: { userId: true, role: true, assignedById: true },
    });
    const occBefore = await tx.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { jobId: true, assignedGroupId: true },
    });

    await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
    await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data: { assignedGroupId: null },
    });

    // Money: un-staffs the job — everyone listed here stops being on the
    // hook for (and paid for) this occurrence, and the crew whose
    // equipmentCostPercent split governed its rentals is unbound.
    await writeAudit(tx, AUDIT.JOB.ASSIGNEES_UPDATED, currentUserId, {
      action: "group_detached_from_occurrence",
      occurrenceId,
      jobId: occBefore?.jobId ?? null,
      beforeAssignedGroupId: occBefore?.assignedGroupId ?? null,
      afterAssignedGroupId: null,
      removedUserIds: removedAssignees.map((a) => a.userId),
      removedAssignees: removedAssignees.map((a) => ({
        userId: a.userId,
        role: a.role,
        assignedById: a.assignedById,
      })),
      removedCount: removedAssignees.length,
    });
  },

  /** Cascade preview for archiving a user — which groups they're in. */
  async previewUserArchiveCascade(userId: string) {
    const [claims, memberships] = await Promise.all([
      prisma.group.findMany({
        where: { claimerUserId: userId, archivedAt: null },
        select: { id: true, name: true },
      }),
      prisma.groupMember.findMany({
        where: { userId },
        select: { groupId: true, group: { select: { id: true, name: true, archivedAt: true } } },
      }),
    ]);
    // Any in-flight work blocks archive entirely (today's behavior).
    const inFlight = await prisma.jobOccurrenceAssignee.count({
      where: {
        userId,
        occurrence: { status: { in: IN_FLIGHT_STATUSES as any } },
      },
    });
    return {
      claimerOf: claims,
      memberOf: memberships
        .filter((m) => m.group && !m.group.archivedAt)
        .map((m) => ({ id: m.group!.id, name: m.group!.name })),
      inFlightOccurrences: inFlight,
    };
  },

  isGroupLocked,
};
