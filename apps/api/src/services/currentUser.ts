import { prisma } from "../db/prisma";
import { createClerkClient } from "@clerk/backend";
import type { ServicesCurrentUser } from "../types/services";
import { writeAudit } from "../lib/auditLogger";
import { flattenRole, isEntitlement } from "@repo/permissions";
import { AUDIT } from "../lib/auditActions";
import { availablePerspectives } from "../lib/perspectives";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

export const currentUser: ServicesCurrentUser = {
  // The “current user” (aka "me") service.
  // Given a Clerk user ID, it loads or lazily creates a matching User row in your DB (with isApproved: false by default),
  // pulls email/display name from Clerk on first sight, and returns a normalized shape with the user’s roles.
  // Note: Not a route, used by the 'rbac.ts' Fastify plugin.
  async me(clerkUserId: string) {
    if (!clerkUserId) {
      return {
        id: "",
        isApproved: false,
        email: undefined,
        displayName: undefined,
        // No clerkUserId means no identity. Fails closed on both axes.
        workerType: null,
        roleGrants: [],
        perspectives: [],
      };
    }

    let user = await prisma.user.findUnique({
      where: { clerkUserId },
      include: {
        customRoles: {
          where: { suspendedAt: null, customRole: { suspendedAt: null } },
          include: { customRole: { include: { entitlements: true } } },
        },
        portfolioAssignments: {
          where: { suspendedAt: null, customRole: { suspendedAt: null } },
          include: { portfolio: { select: { path: true } } },
        },
      },
    });

    if (!user) {
      let email: string | null = null;
      let displayName: string | null = null;

      try {
        const u = await clerk.users.getUser(clerkUserId);
        email =
          u.primaryEmailAddress?.emailAddress ??
          u.emailAddresses?.[0]?.emailAddress ??
          null;

        const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        displayName = name || u.username || null;
      } catch {}

      await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            clerkUserId,
            email: email ?? undefined,
            displayName: displayName ?? undefined,
            isApproved: false,
          },
        });
        // Second, independent auto-provision path (this one runs from the
        // rbac plugin). Same gap as users.me: USER.SIGN_IN covers the
        // session, not the creation of the account row. Audited ONLY on
        // the create branch — this runs on every authenticated request.
        // Actor is the user themselves.
        await writeAudit(tx, AUDIT.USER.CREATED, created.id, {
          userId: created.id,
          clerkUserId,
          email: created.email ?? null,
          displayName: created.displayName ?? null,
          isApproved: false,
          source: "auto_provision_rbac",
        });
      });

      user = await prisma.user.findUnique({
        where: { clerkUserId },
        include: {
        customRoles: {
          where: { suspendedAt: null, customRole: { suspendedAt: null } },
          include: { customRole: { include: { entitlements: true } } },
        },
        portfolioAssignments: {
          where: { suspendedAt: null, customRole: { suspendedAt: null } },
          include: { portfolio: { select: { path: true } } },
        },
      },
      });
    }

    // ── Roles, flattened through inheritance ──────────────────────────────
    //
    // Entitlements load with the auth read, uncached (decision 15g) — this
    // query already runs on every authenticated request.
    //
    // SUSPENSION IS FILTERED IN THE QUERY, never in can(): a suspended grant
    // or a suspended role must not reach the principal at all.
    //
    // INHERITANCE IS FLATTENED HERE for the same reason. can() stays a pure
    // set operation, and the walk needs the whole role table — which is
    // small, and read once.
    const allRoles = await prisma.customRole.findMany({
      select: {
        id: true, name: true, key: true, inheritsFromId: true,
        isPerspective: true, perspectiveOrder: true,
        entitlements: { select: { entitlement: true } },
      },
    });
    // CARRY `isPerspective` AND `perspectiveOrder` THROUGH.
    //
    // They were SELECTED above and then dropped here, so every entry in
    // this map had `isPerspective: undefined`. `availablePerspectives`
    // filters on exactly that field, so it returned an empty list for
    // everybody — which made `principal.perspective` permanently null and
    // meant route guards NEVER honoured a perspective. The UI narrowed
    // (the `/me` route builds its own list elsewhere) while the server
    // went on answering at full authority.
    //
    // The `as never` at the call site is what let this compile: it
    // silences the structural check that would have said the map's value
    // type is missing two fields the callee reads. Same shape as the
    // perspective-icon bug — selected, dropped in a mapping, hidden by a
    // cast. If you touch this map, widen the type instead of casting.
    const byId = new Map(
      allRoles.map((r) => [
        r.id,
        { id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
          isPerspective: r.isPerspective, perspectiveOrder: r.perspectiveOrder,
          entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement) },
      ]),
    );

    const roleGrants = [
      // Held company-wide.
      ...(user!.customRoles ?? []).map((ucr) => ({
        roleId: ucr.customRoleId,
        name: byId.get(ucr.customRoleId)?.name ?? "",
        entitlements: flattenRole(ucr.customRoleId, byId as never),
      })),
      // Held within one portfolio's subtree.
      ...(user!.portfolioAssignments ?? []).map((aa) => ({
        roleId: aa.customRoleId,
        name: byId.get(aa.customRoleId)?.name ?? "",
        entitlements: flattenRole(aa.customRoleId, byId as never),
        portfolioPath: aa.portfolio?.path,
      })),
    ];

    // See lib/perspectives: offered only when they hold the role or one
    // that inherits it, which makes every perspective a subset of what they hold.
    const perspectives = availablePerspectives(
      [
        ...(user!.customRoles ?? []).map((ucr) => ucr.customRoleId),
        ...(user!.portfolioAssignments ?? []).map((aa) => aa.customRoleId),
      ],
      byId as never,
    );

    return {
      id: user!.id,
      isApproved: !!user!.isApproved,
      email: user!.email ?? undefined,
      displayName: user!.displayName ?? undefined,
      /** How this person is paid. NULL means nothing resolves — being in the
       *  system is not being cleared to act in it. */
      workerType: user!.workerType ?? null,
      /** Live roles, inheritance already flattened. */
      roleGrants,
      /** The perspectives this person may switch to, lowest access first. */
      perspectives,
    };
  },
};
