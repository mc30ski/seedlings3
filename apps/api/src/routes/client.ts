import { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../db/prisma";
import { getDownloadUrl } from "../lib/r2";

/**
 * Client-facing routes. Require Clerk auth but NOT worker/admin roles.
 * Access is scoped to the client linked via ClientContact.clerkUserId.
 */
export default async function clientRoutes(app: FastifyInstance) {
  // Guard: must be authenticated via Clerk
  const clientGuard = {
    preHandler: async (req: FastifyRequest) => {
      const clerkUserId = req.auth?.clerkUserId;
      if (!clerkUserId) {
        throw app.httpErrors.unauthorized("Authentication required.");
      }
    },
  };

  /** Helper: get the client contact linked to this Clerk user, or null */
  async function getLinkedContact(clerkUserId: string) {
    return prisma.clientContact.findUnique({
      where: { clerkUserId },
      include: {
        client: {
          include: {
            properties: {
              where: { status: "ACTIVE" },
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
      },
    });
  }

  // Auto-link: try to match Clerk email to a ClientContact email
  app.post("/client/link", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;

    // Already linked?
    const existing = await prisma.clientContact.findUnique({ where: { clerkUserId } });
    if (existing) return { linked: true, contactId: existing.id };

    // Get the user's email from the User table (provisioned by auth plugin)
    const user = await prisma.user.findUnique({ where: { clerkUserId } });
    if (!user?.email) return { linked: false, reason: "no_email" };

    // Find a matching ClientContact by email (case-insensitive)
    const contact = await prisma.clientContact.findFirst({
      where: {
        email: { equals: user.email, mode: "insensitive" },
        clerkUserId: null, // not already linked to another account
      },
    });

    if (!contact) return { linked: false, reason: "no_match" };

    // Link it
    await prisma.clientContact.update({
      where: { id: contact.id },
      data: { clerkUserId },
    });

    return { linked: true, contactId: contact.id };
  });

  // Get client profile
  app.get("/client/me", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const contact = await getLinkedContact(clerkUserId);
    if (!contact) return { linked: false };

    return {
      linked: true,
      contact: {
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
      },
      client: {
        id: contact.client.id,
        displayName: contact.client.displayName,
        properties: contact.client.properties,
      },
    };
  });

  // Get completed jobs for client's properties
  app.get("/client/jobs", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const contact = await getLinkedContact(clerkUserId);
    if (!contact) return { items: [] };

    const propertyIds = contact.client.properties.map((p) => p.id);
    if (propertyIds.length === 0) return { items: [] };

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        job: { propertyId: { in: propertyIds } },
        workflow: { not: "ESTIMATE" },
        isEstimate: false,
      },
      orderBy: { completedAt: "desc" },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        startAt: true,
        completedAt: true,
        estimatedMinutes: true,
        startedAt: true,
        workflow: true,
        job: {
          select: {
            kind: true,
            property: {
              select: { id: true, displayName: true, city: true, state: true },
            },
          },
        },
        assignees: {
          select: {
            user: { select: { displayName: true } },
          },
        },
        photos: {
          select: { id: true, r2Key: true, contentType: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
        payment: {
          select: { amountPaid: true, method: true, createdAt: true },
        },
      },
    });

    // Generate photo URLs and sanitize
    const items = await Promise.all(
      occurrences.map(async (occ) => {
        const photos = await Promise.all(
          occ.photos.map(async (p) => {
            try {
              return { id: p.id, url: await getDownloadUrl(p.r2Key, 3600), contentType: p.contentType };
            } catch {
              return null;
            }
          })
        );

        return {
          id: occ.id,
          kind: occ.kind,
          status: occ.status,
          startAt: occ.startAt,
          completedAt: occ.completedAt,
          property: occ.job.property,
          workers: occ.assignees.map((a) => (a.user?.displayName ?? "").split(" ")[0]).filter(Boolean),
          durationMinutes: occ.startedAt && occ.completedAt
            ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000)
            : null,
          photos: photos.filter(Boolean),
          paid: !!occ.payment,
        };
      })
    );

    return { items };
  });

  // Get upcoming scheduled jobs for client's properties
  app.get("/client/upcoming", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const contact = await getLinkedContact(clerkUserId);
    if (!contact) return { items: [] };

    const propertyIds = contact.client.properties.map((p) => p.id);
    if (propertyIds.length === 0) return { items: [] };

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["SCHEDULED", "IN_PROGRESS"] },
        job: { propertyId: { in: propertyIds } },
        workflow: { not: "ESTIMATE" },
        isEstimate: false,
      },
      orderBy: { startAt: "asc" },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        startAt: true,
        startedAt: true,
        estimatedMinutes: true,
        workflow: true,
        job: {
          select: {
            kind: true,
            property: {
              select: { id: true, displayName: true, city: true, state: true },
            },
          },
        },
        assignees: {
          select: {
            user: { select: { displayName: true } },
          },
        },
      },
    });

    return {
      items: occurrences.map((occ) => ({
        id: occ.id,
        kind: occ.kind,
        status: occ.status,
        startAt: occ.startAt,
        startedAt: occ.startedAt,
        estimatedMinutes: occ.estimatedMinutes,
        property: occ.job.property,
        workers: occ.assignees.map((a) => (a.user?.displayName ?? "").split(" ")[0]).filter(Boolean),
      })),
    };
  });
}
