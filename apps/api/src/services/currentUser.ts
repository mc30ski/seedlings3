import { prisma } from "../db/prisma";
import { createClerkClient } from "@clerk/backend";
import type { ServicesCurrentUser, Role } from "../types/services";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

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
        roles: [] as Role[],
        email: undefined,
        displayName: undefined,
      };
    }

    let user = await prisma.user.findUnique({
      where: { clerkUserId },
      include: { roles: true },
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
        include: { roles: true },
      });
    }

    return {
      id: user!.id,
      isApproved: !!user!.isApproved,
      roles: (user!.roles ?? []).map((r) => r.role) as Role[],
      email: user!.email ?? undefined,
      displayName: user!.displayName ?? undefined,
    };
  },
};
