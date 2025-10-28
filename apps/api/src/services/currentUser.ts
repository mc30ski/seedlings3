import { prisma } from "../db/prisma";
import { createClerkClient } from "@clerk/backend";
import type { ServicesCurrentUser, Role } from "../types/services";

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

      await prisma.user.create({
        data: {
          clerkUserId,
          email: email ?? undefined,
          displayName: displayName ?? undefined,
          isApproved: false,
        },
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
