import { prisma } from "../db/prisma";

import { Role as RoleVal, WorkerType } from "@prisma/client";
import { verifyToken, createClerkClient } from "@clerk/backend";
import type { ServicesUsers, Role } from "../types/services";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { resolvePrivileges } from "../lib/privileges";
import { resolveImpersonation } from "../lib/impersonation";

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
    return prisma.user.findMany({
      where,
      include: { roles: true },
      orderBy: { displayName: "asc" },
    });
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

      // Strip the now-stale clerkUserId off any ClientContact rows that
      // pointed at this user. Without this, deleting a user leaves ghost
      // links — the contact shows "Linked" forever even though the Clerk
      // identity is gone — and blocks the next sign-up with that email
      // from auto-linking (the /client/link email match filters on
      // clerkUserId: null). Done in-transaction so a user delete + its
      // contact cleanup either both succeed or both abort.
      let contactsUnlinked = 0;
      if (user.clerkUserId) {
        const cleared = await tx.clientContact.updateMany({
          where: { clerkUserId: user.clerkUserId },
          data: { clerkUserId: null },
        });
        contactsUnlinked = cleared.count;
      }

      const userDelete = await tx.user.delete({ where: { id: userId } });

      await writeAudit(tx, AUDIT.USER.DELETED, currentUserId, {
        userRecord: { ...userDelete },
        contactsUnlinked,
      });

      return { deleted: true as const, clerkDeleted, contactsUnlinked };
    });
  },

  async pendingApprovalCount(): Promise<{ pending: number }> {
    const count = await prisma.user.count({ where: { isApproved: false } });
    return { pending: count };
  },

  // Implements a GET /me endpoint that authenticates with Clerk (via header or cookie),
  // ensures there’s a matching user in your Prisma DB, optionally bootstraps ADMIN/WORKER roles based on an env list,
  // then returns a normalized “me” object.
  async me(token: string, impersonateHeader?: string | string[] | null) {
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
    } else {
      // Keep the local mirror in sync with Clerk (the identity source of
      // truth) on EVERY /me — not just when the field was missing. So when
      // any user changes their email or name in Clerk, the next /me picks
      // it up. fetchedX is undefined if the Clerk fetch above failed — in
      // that case fall back to the stored value rather than clobbering it.
      // Diff-checked, so this is a DB write only when something changed.
      const nextEmail = fetchedEmail ?? user.email;
      const nextDisplayName = fetchedDisplayName ?? user.displayName;
      if (nextEmail !== user.email || nextDisplayName !== user.displayName) {
        user = await prisma.user.update({
          where: { clerkUserId },
          data: { email: nextEmail, displayName: nextDisplayName },
          include: { roles: true },
        });
      }
    }

    // Propagate the refreshed email to a linked client contact, if any.
    // A ClientContact linked to this account (by clerkUserId) is the same
    // person, so its email should track the account — otherwise a client
    // who updates their email leaves the CRM record (and payment-request
    // delivery) stale. Best-effort: a failure here must not break /me.
    // Only clients have a ClientContact — for workers/admins this is a
    // no-op, and the User row above IS their record. Phone is not synced:
    // the email-magic-link Clerk setup doesn't carry a phone number.
    if (user.email) {
      try {
        // Post multi-client refactor, a single Clerk identity may be
        // bound to N ClientContact rows (one per Client). Sync the
        // Clerk-side email to ALL of them whose stored email has
        // drifted — keeps identity consistent across the cross-
        // client roles for the same person.
        const linkedContacts = await prisma.clientContact.findMany({
          where: { clerkUserId },
          select: { id: true, email: true },
        });
        const targetEmail = user.email;
        const stale = linkedContacts.filter(
          (c) => (c.email ?? "").toLowerCase() !== targetEmail.toLowerCase(),
        );
        if (stale.length > 0) {
          await prisma.clientContact.updateMany({
            where: { id: { in: stale.map((c) => c.id) } },
            data: { email: targetEmail },
          });
        }
      } catch (e) {
        console.warn(
          { clerkUserId, error: (e as Error).message },
          "[/me] Linked ClientContact email sync failed (continuing)",
        );
      }
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
    const now = new Date();
    const isInsuranceValid = !!(user!.insuranceCertR2Key && user!.insuranceExpiresAt && user!.insuranceExpiresAt > now);

    // Real, unmodified identity values from the DB. The "effective" values
    // below may diverge from these when a Super has the View-as-another-role
    // mode active. The frontend uses realRoles/realWorkerType to keep the
    // impersonation menu visible so Super can always exit back to default.
    const realRolesArr = (user!.roles ?? []).map((r) => r.role) as Role[];
    const realWorkerType = user!.workerType ?? null;
    const realIsOwner = !!user!.isOwner;

    // Apply impersonation only when the underlying user really is SUPER and
    // the header parsed cleanly. Non-Super requests with this header silently
    // fall through with no impersonation applied.
    const impersonation = resolveImpersonation(realRolesArr, impersonateHeader ?? null);

    const effectiveRoles: Role[] = impersonation ? (impersonation.roles as Role[]) : realRolesArr;
    const effectiveWorkerType = impersonation ? impersonation.workerType : realWorkerType;
    const effectiveIsOwner = impersonation ? false : realIsOwner;

    // Privileges must be re-resolved against the EFFECTIVE roles/workerType.
    // resolvePrivileges short-circuits to all-true for ADMIN/SUPER, so if we
    // passed the real user row when impersonating a Trainee, the response
    // would still grant inventory/business-expense rights — defeating the
    // purpose. Build a synthetic shape with the swapped values.
    const privInput = impersonation
      ? {
          workerType: effectiveWorkerType ?? null,
          canPullInventory: user!.canPullInventory ?? null,
          canChargeBusinessExpenses: user!.canChargeBusinessExpenses ?? null,
          roles: effectiveRoles.map((r) => ({ role: r })),
        }
      : user!;
    const priv = resolvePrivileges(privInput as any);

    const me = {
      id: user!.id,
      isApproved: !!user!.isApproved,
      roles: effectiveRoles,
      email: user!.email ?? null,
      phone: user!.phone ?? null,
      firstName: user!.firstName ?? null,
      lastName: user!.lastName ?? null,
      displayName: user!.displayName ?? null,
      workerType: effectiveWorkerType,
      isOwner: effectiveIsOwner,
      homeBaseAddress: user!.homeBaseAddress ?? null,
      availableDays: user!.availableDays ? JSON.parse(user!.availableDays) : [],
      availableHoursPerDay: user!.availableHoursPerDay ?? 4,
      // Hourly wage — read-only for the user themselves; only a SUPER
      // can update it via PATCH /admin/users/:id/profile. Surfaced
      // here so workers can see what's on file for them in their
      // profile.
      hourlyWage: Number(user!.hourlyWage ?? 0),
      hasInsuranceCert: !!user!.insuranceCertR2Key,
      isInsuranceValid,
      insuranceExpiresAt: user!.insuranceExpiresAt?.toISOString() ?? null,
      contractorAgreedAt: user!.contractorAgreedAt?.toISOString() ?? null,
      w9Collected: !!user!.w9Collected,
      // Guaranteed payout period (contractors only). Surfaced so the
      // contractor can see their own period and remaining days on
      // ProfileTab. UI computes "active" from `guaranteedPayoutUntil > now`.
      guaranteedPayoutUntil: user!.guaranteedPayoutUntil?.toISOString() ?? null,
      guaranteedPayoutStartedAt: user!.guaranteedPayoutStartedAt?.toISOString() ?? null,
      // Override columns (for the user-edit UI to show explicit grants/denies)
      canPullInventoryOverride: user!.canPullInventory ?? null,
      canChargeBusinessExpensesOverride: user!.canChargeBusinessExpenses ?? null,
      // Resolved values (admin/super wins, otherwise override-or-default).
      // Computed against the effective roles above so impersonating a Trainee
      // correctly returns canPullInventory:false, canChargeBusinessExpenses:false.
      privileges: {
        canPullInventory: priv.canPullInventory,
        canChargeBusinessExpenses: priv.canChargeBusinessExpenses,
      },
      // Real (unimpersonated) identity values. Present even when no
      // impersonation is active so the frontend can unconditionally read
      // them — the View-as menu reads realRoles to decide whether to show
      // itself. When impersonation is OFF, real* === the regular fields.
      realRoles: realRolesArr,
      realWorkerType,
      isImpersonating: !!impersonation,
    };

    return me;
  },

  async setWorkerType(currentUserId: string, userId: string, workerType: string | null) {
    if (workerType !== null && workerType !== "EMPLOYEE" && workerType !== "CONTRACTOR" && workerType !== "TRAINEE") {
      throw new ServiceError("BAD_REQUEST", "Invalid worker type", 400);
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { workerType: workerType as WorkerType | null },
      });
      await writeAudit(tx, AUDIT.USER.WORKER_TYPE_SET, currentUserId, {
        userId, workerType: workerType ?? "UNCLASSIFIED",
      });
      return updated;
    });
  },

  // Set/unset the LLC-owner flag on a user. Singleton-enforced both in app
  // logic and via a partial unique index on User(isOwner) WHERE isOwner=true.
  // Route layer must restrict this to SUPER role — the service trusts its
  // caller, like setWorkerType.
  async setIsOwner(currentUserId: string, userId: string, isOwner: boolean) {
    return prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, isOwner: true } });
      if (!target) throw new ServiceError("NOT_FOUND", "User not found", 404);
      if (isOwner) {
        const existing = await tx.user.findFirst({
          where: { isOwner: true, NOT: { id: userId } },
          select: { id: true, displayName: true, email: true },
        });
        if (existing) {
          throw new ServiceError(
            "OWNER_ALREADY_SET",
            `Another user is already flagged as owner (${existing.displayName ?? existing.email ?? existing.id}). Clear that one first.`,
            409,
          );
        }
      }
      const updated = await tx.user.update({
        where: { id: userId },
        data: { isOwner },
      });
      await writeAudit(tx, AUDIT.USER.OWNER_FLAG_UPDATED, currentUserId, {
        userId, isOwner,
      });
      return updated;
    });
  },

  async updateInsuranceCert(userId: string, r2Key: string, fileName: string | null, contentType: string | null, expiresAt: string) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          insuranceCertR2Key: r2Key,
          insuranceCertFileName: fileName,
          insuranceCertContentType: contentType,
          insuranceExpiresAt: new Date(expiresAt),
        },
      });
      await writeAudit(tx, AUDIT.USER.INSURANCE_UPLOADED, userId, {
        r2Key, expiresAt,
      });
      return updated;
    });
  },

  async recordContractorAgreement(userId: string) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: { contractorAgreedAt: new Date() },
      });
      await writeAudit(tx, AUDIT.USER.CONTRACTOR_AGREED, userId, {});
      return updated;
    });
  },

  async setW9Collected(currentUserId: string, userId: string, collected: boolean) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: userId },
        data: {
          w9Collected: collected,
          w9CollectedAt: collected ? new Date() : null,
        },
      });
      await writeAudit(tx, AUDIT.USER.W9_COLLECTED, currentUserId, {
        userId, collected,
      });
      return updated;
    });
  },

  async setPrivilegeOverrides(
    currentUserId: string,
    userId: string,
    overrides: { canPullInventory?: boolean | null; canChargeBusinessExpenses?: boolean | null },
  ) {
    // null = clear override (use workerType default); true/false = explicit override.
    // undefined = leave alone.
    const data: any = {};
    if ("canPullInventory" in overrides) data.canPullInventory = overrides.canPullInventory;
    if ("canChargeBusinessExpenses" in overrides) {
      data.canChargeBusinessExpenses = overrides.canChargeBusinessExpenses;
    }
    if (Object.keys(data).length === 0) {
      return prisma.user.findUniqueOrThrow({ where: { id: userId } });
    }
    return prisma.$transaction(async (tx) => {
      const before = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { canPullInventory: true, canChargeBusinessExpenses: true },
      });
      const updated = await tx.user.update({ where: { id: userId }, data });
      await writeAudit(tx, AUDIT.USER.PRIVILEGES_UPDATED, currentUserId, {
        userId,
        before,
        after: {
          canPullInventory: updated.canPullInventory,
          canChargeBusinessExpenses: updated.canChargeBusinessExpenses,
        },
      });
      return updated;
    });
  },
};
