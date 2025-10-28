import { prisma } from "../db/prisma";

import { Role as RoleVal } from "@prisma/client";
import { verifyToken, createClerkClient } from "@clerk/backend";
import type { ServicesUsers, Role } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

function parseBootstrapList() {
  return (process.env.ADMIN_BOOTSTRAP_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const users: ServicesUsers = {
  async list(params) {
    const where: any = {};
    if (params?.approved !== undefined) where.isApproved = params.approved;
    if (params?.role) where.roles = { some: { role: params.role as any } };
    return prisma.user.findMany({ where, include: { roles: true } });
  },

  async listHoldings() {
    const rows = await prisma.checkout.findMany({
      where: { releasedAt: null },
      include: {
        equipment: {
          select: {
            id: true,
            shortDesc: true,
            qrSlug: true,
            brand: true,
            model: true,
            type: true,
            energy: true,
            features: true,
            condition: true,
            issues: true,
            age: true,
          },
        },
      },
      orderBy: { reservedAt: "desc" },
    });

    return rows.map((r) => ({
      userId: r.userId,
      equipmentId: r.equipmentId,
      shortDesc: r.equipment?.shortDesc ?? "",
      qrSlug: r.equipment?.qrSlug ?? "",
      brand: r.equipment?.brand ?? null,
      model: r.equipment?.model ?? null,
      type: r.equipment?.type ?? null,
      energy: r.equipment?.energy ?? null,
      features: r.equipment?.features ?? null,
      condition: r.equipment?.condition ?? null,
      issues: r.equipment?.issues ?? null,
      age: r.equipment?.age ?? null,
      state: r.checkedOutAt ? ("CHECKED_OUT" as const) : ("RESERVED" as const),
      reservedAt: r.reservedAt,
      checkedOutAt: r.checkedOutAt ?? null,
    }));
  },

  async approve(currentUserId, userId) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isApproved: true },
      });

      await writeAudit(tx, AUDIT.USER.APPROVED, currentUserId, {
        userRecord: { ...updated },
      });

      return updated;
    });
  },

  async addRole(currentUserId, userId, role) {
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new ServiceError("NOT_FOUND", "User not found", 404);
      }

      const roleRow = await tx.userRole.create({
        data: { userId, role: role as any },
      });

      await writeAudit(tx, AUDIT.USER.ROLE_ASSIGNED, currentUserId, {
        userRecord: { ...user },
        roleRecord: { ...roleRow },
      });

      return roleRow;
    });
  },

  async removeRole(currentUserId, userId, role) {
    if (role === "WORKER") {
      const active = await prisma.checkout.count({
        where: { userId, releasedAt: null },
      });
      if (active > 0) {
        throw new ServiceError(
          "USER_HAS_ACTIVE_EQUIPMENT",
          "Cannot remove Worker role while the user has reserved/checked-out equipment.",
          409
        );
      }
    }

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new ServiceError("NOT_FOUND", "User not found", 404);
      }

      const toDelete = await tx.userRole.findFirst({
        where: { userId, role: role as any },
      });
      if (!toDelete) return { deleted: false };

      const roleRecord = await tx.userRole.delete({
        where: { id: toDelete.id },
      });

      await writeAudit(tx, AUDIT.USER.ROLE_REMOVED, currentUserId, {
        userRecord: { ...user },
        roleRecord: { ...roleRecord },
      });

      return { deleted: true };
    });
  },

  async remove(currentUserId, userId, actorUserId) {
    if (!actorUserId) {
      throw new ServiceError("UNAUTHORIZED", "Missing actor", 401);
    }
    if (actorUserId === userId) {
      throw new ServiceError(
        "CANNOT_DELETE_SELF",
        "You cannot delete your own account",
        400
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) {
      throw new ServiceError("NOT_FOUND", "User not found", 404);
    }

    return prisma.$transaction(async (tx) => {
      const isAdmin = user.roles.some((r) => r.role === "ADMIN");
      if (isAdmin) {
        const otherAdmins = await tx.userRole.count({
          where: { role: "ADMIN", userId: { not: userId } },
        });
        if (otherAdmins === 0) {
          throw new ServiceError(
            "LAST_ADMIN",
            "Cannot delete the last remaining admin",
            409
          );
        }
      }

      let clerkDeleted = false;
      if (user.clerkUserId) {
        try {
          await clerk.users.deleteUser(user.clerkUserId);
          clerkDeleted = true;
        } catch (e: any) {
          clerkDeleted =
            typeof e?.status === "number" ? e.status === 404 : false;
        }
      }

      const userDelete = await tx.user.delete({ where: { id: userId } });

      await writeAudit(tx, AUDIT.USER.DELETED, currentUserId, {
        userRecord: { ...userDelete },
      });

      return { deleted: true as const, clerkDeleted };
    });
  },

  async pendingApprovalCount(): Promise<{ pending: number }> {
    const count = await prisma.user.count({ where: { isApproved: false } });
    return { pending: count };
  },

  // Implements a GET /me endpoint that authenticates with Clerk (via header or cookie),
  // ensures there’s a matching user in your Prisma DB, optionally bootstraps ADMIN/WORKER roles based on an env list,
  // then returns a normalized “me” object.
  async me(token: string) {
    // Verify token with Clerk
    let clerkUserId: string;
    try {
      const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY,
      });
      clerkUserId = String((payload as any).sub);
      if (!clerkUserId) throw new Error("Missing sub in token");
    } catch (err) {
      throw new ServiceError("UNAUTHORIZED", "Invalid token", 401);
    }

    // Fetch Clerk profile (for email/displayName + bootstrap check)
    let fetchedEmail: string | undefined;
    let fetchedDisplayName: string | undefined;
    try {
      if (clerk) {
        const u = await clerk.users.getUser(clerkUserId);
        fetchedEmail =
          u.primaryEmailAddress?.emailAddress ??
          u.emailAddresses?.[0]?.emailAddress ??
          undefined;
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        fetchedDisplayName = (name || u.username || undefined) ?? undefined;
      }
    } catch (e) {
      console.warn(
        { clerkUserId, error: (e as Error).message },
        "[/me] Clerk profile fetch failed (continuing)"
      );
    }

    // Ensure local DB user exists (create if missing)
    let user = await prisma.user.findUnique({
      where: { clerkUserId },
      include: { roles: true },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          clerkUserId,
          email: fetchedEmail,
          displayName: fetchedDisplayName,
          isApproved: false,
        },
        include: { roles: true },
      });
    } else if (
      (!user.email || !user.displayName) &&
      (fetchedEmail || fetchedDisplayName)
    ) {
      user = await prisma.user.update({
        where: { clerkUserId },
        data: {
          email: user.email ?? fetchedEmail,
          displayName: user.displayName ?? fetchedDisplayName,
        },
        include: { roles: true },
      });
    }

    // Bootstrap admins via ADMIN_BOOTSTRAP_EMAILS (idempotent)
    const bootstrapEmails = parseBootstrapList();
    const normalizedEmail = (user.email ?? fetchedEmail ?? "").toLowerCase();
    const shouldBootstrap =
      normalizedEmail && bootstrapEmails.includes(normalizedEmail);

    if (shouldBootstrap) {
      await prisma.$transaction(async (tx) => {
        if (!user!.isApproved) {
          await tx.user.update({
            where: { id: user!.id },
            data: { isApproved: true },
          });
        }
        await tx.userRole.upsert({
          where: { userId_role: { userId: user!.id, role: RoleVal.WORKER } },
          update: {},
          create: { userId: user!.id, role: RoleVal.WORKER },
        });
        await tx.userRole.upsert({
          where: { userId_role: { userId: user!.id, role: RoleVal.ADMIN } },
          update: {},
          create: { userId: user!.id, role: RoleVal.ADMIN },
        });
      });
      user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: { roles: true },
      });
    }

    // Respond
    const me = {
      id: user!.id,
      isApproved: !!user!.isApproved,
      roles: (user!.roles ?? []).map((r) => r.role) as Role[],
      email: user!.email ?? null,
      displayName: user!.displayName ?? null,
    };

    return me;
  },
};
