import { prisma } from "../db/prisma";
import { Prisma } from "@prisma/client";
import { ServiceError } from "../lib/errors";

type Tx = Prisma.TransactionClient;

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

  async create(input: GroupCreateInput) {
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

    return prisma.group.create({
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
  },

  async update(id: string, input: GroupPatchInput) {
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
      // Switching claimer: drop the new claimer from members (if present)
      // — claimer is implicit, not a GroupMember row.
      await prisma.groupMember.deleteMany({
        where: { groupId: id, userId: input.claimerUserId },
      });
      data.claimer = { connect: { id: input.claimerUserId } };
    }

    return prisma.group.update({
      where: { id },
      data,
      include: groupInclude,
    });
  },

  async archive(id: string) {
    const g = await this.getById(id);
    if (g.archivedAt) return g;
    await assertNotLocked(id);
    return prisma.group.update({
      where: { id },
      data: { archivedAt: new Date() },
      include: groupInclude,
    });
  },

  async unarchive(id: string) {
    const g = await this.getById(id);
    if (!g.archivedAt) return g;
    return prisma.group.update({
      where: { id },
      data: { archivedAt: null },
      include: groupInclude,
    });
  },

  // ── Members ─────────────────────────────────────────────────────────────

  async addMember(groupId: string, input: GroupMemberInput) {
    const g = await this.getById(groupId);
    if (g.archivedAt) throw new ServiceError("ARCHIVED", "Group is archived.", 400);
    await assertNotLocked(groupId);

    if (input.userId === g.claimerUserId) {
      throw new ServiceError("INVALID_INPUT", "Claimer is already implicitly a member.", 400);
    }
    const exists = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!exists) throw new ServiceError("INVALID_INPUT", "User not found.", 400);

    const role = input.role === "observer" ? "observer" : "worker";

    const created = await prisma.groupMember.create({
      data: {
        groupId,
        userId: input.userId,
        role,
        equipmentCostPercent: input.equipmentCostPercent ?? null,
      },
    });

    await this.validateGroupPercents(groupId);
    return created;
  },

  async removeMember(groupId: string, userId: string) {
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
    await prisma.groupMember.deleteMany({ where: { groupId, userId } });

    // Removing a member can invalidate the percent sum. Strategy: if the
    // removed worker had a non-null percent, reset all percents to null
    // (revert to even split) so the admin re-checks math.
    const m = await prisma.groupMember.findMany({
      where: { groupId },
      select: { id: true, role: true, equipmentCostPercent: true },
    });
    const workers = m.filter((x) => x.role !== "observer");
    const anySet = workers.some((x) => x.equipmentCostPercent != null);
    const allSet = workers.length > 0 && workers.every((x) => x.equipmentCostPercent != null);
    if (anySet && !allSet) {
      await prisma.groupMember.updateMany({
        where: { groupId },
        data: { equipmentCostPercent: null },
      });
    }
    return { removed: true };
  },

  async updateMember(
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

    const updated = await prisma.groupMember.updateMany({
      where: { groupId, userId },
      data,
    });
    if (updated.count === 0) {
      throw new ServiceError("NOT_FOUND", "Member not found in group.", 404);
    }
    await this.validateGroupPercents(groupId);
    return prisma.groupMember.findFirst({ where: { groupId, userId } });
  },

  /** Validate equipmentCostPercent rule for the group. Throws on violation. */
  async validateGroupPercents(groupId: string): Promise<void> {
    const members = await prisma.groupMember.findMany({
      where: { groupId },
      select: { role: true, equipmentCostPercent: true },
    });
    // Include the implicit claimer-as-worker slot. Claimer has no row in
    // GroupMember but always counts as a worker with even share (null).
    validatePercents([{ role: "worker", equipmentCostPercent: null }, ...members]);
  },

  // ── Preferred equipment ─────────────────────────────────────────────────

  async addPreferred(groupId: string, input: GroupPreferredEquipmentInput) {
    await this.getById(groupId);
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
    return prisma.groupPreferredEquipment.create({
      data: {
        groupId,
        equipmentId: input.equipmentId ?? null,
        equipmentCollectionId: input.equipmentCollectionId ?? null,
      },
    });
  },

  async removePreferred(preferredId: string) {
    await prisma.groupPreferredEquipment.delete({ where: { id: preferredId } }).catch(() => {});
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
  },

  /** Detach a group from an occurrence: remove materialized members, clear assignedGroupId. */
  async detachGroupFromOccurrence(tx: Tx, occurrenceId: string) {
    await tx.jobOccurrenceAssignee.deleteMany({ where: { occurrenceId } });
    await tx.jobOccurrence.update({
      where: { id: occurrenceId },
      data: { assignedGroupId: null },
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
