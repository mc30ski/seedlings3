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

    if (contact) {
      // Email match — link directly.
      await prisma.clientContact.update({
        where: { id: contact.id },
        data: { clerkUserId },
      });
      return { linked: true, contactId: contact.id };
    }

    // Smart-hint fallback: did this Clerk user recently come from a payment
    // page? `signup-from-page` stamps every active contact on the originating
    // client when a /pay visitor taps "Access your account." If exactly ONE
    // client has a recently-stamped unlinked contact, we propose it instead
    // of failing silently — the portal asks the client to confirm.
    const WINDOW_DAYS = 7;
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
    const stamped = await prisma.clientContact.findMany({
      where: {
        clientAccountCreatedFromPaymentPageAt: { gte: since },
        clerkUserId: null,
        status: "ACTIVE",
      },
      include: { client: { select: { id: true, displayName: true } } },
    });
    const byClient = new Map<string, typeof stamped>();
    for (const s of stamped) {
      const arr = byClient.get(s.clientId) ?? [];
      arr.push(s);
      byClient.set(s.clientId, arr);
    }
    if (byClient.size === 1) {
      const entry = [...byClient.values()][0]!;
      // Return ALL stamped contacts so the portal can ask "which of you are
      // you?" when the household has 2+ stamped people. Primary first, then
      // by stamp time. Single-contact clients use this list with one entry —
      // the portal renders a simple "Yes, that's me" in that case.
      const contacts = [...entry]
        .sort((a, b) => {
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          const at = a.clientAccountCreatedFromPaymentPageAt?.getTime() ?? 0;
          const bt = b.clientAccountCreatedFromPaymentPageAt?.getTime() ?? 0;
          return bt - at;
        })
        .map((c) => ({
          contactId: c.id,
          contactName: [c.firstName, c.lastName].filter(Boolean).join(" "),
          isPrimary: c.isPrimary,
        }));
      return {
        linked: false,
        reason: "candidate" as const,
        candidate: {
          clientId: entry[0]!.clientId,
          displayName: entry[0]!.client.displayName,
          contacts,
        },
      };
    }

    return { linked: false, reason: "no_match" };
  });

  // Client confirms the smart-hint candidate proposed by /client/link.
  // Re-verifies the candidate is still valid (the proposal might be stale
  // by the time they tap "Yes, that's me") before linking. An optional
  // `contactId` picks a specific stamped contact when the household has
  // multiple people — required to honor the portal's "which of you are
  // you?" prompt. Without it, falls back to primary.
  app.post("/client/link/confirm-candidate", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    const clientId = String(body.clientId ?? "");
    const requestedContactId =
      body.contactId != null ? String(body.contactId) : null;
    if (!clientId) throw app.httpErrors.badRequest("clientId is required.");

    // If already linked (race with another tab) — short-circuit success.
    const existing = await prisma.clientContact.findUnique({ where: { clerkUserId } });
    if (existing) return { linked: true, contactId: existing.id };

    const WINDOW_DAYS = 7;
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
    const baseWhere = {
      clientId,
      clientAccountCreatedFromPaymentPageAt: { gte: since },
      clerkUserId: null,
      status: "ACTIVE" as const,
    };
    // If the client picked a specific contact (multi-contact prompt), bind
    // the lookup to that id — but still enforce all the candidate filters
    // so we can't be tricked into linking an arbitrary contact.
    const candidate = requestedContactId
      ? await prisma.clientContact.findFirst({
          where: { ...baseWhere, id: requestedContactId },
        })
      : await prisma.clientContact.findFirst({
          where: baseWhere,
          orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        });
    if (!candidate) {
      throw app.httpErrors.notFound("This proposal is no longer available — ask an admin to link you manually.");
    }
    await prisma.clientContact.update({
      where: { id: candidate.id },
      data: { clerkUserId },
    });
    return { linked: true, contactId: candidate.id };
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

    // Last 30 days of completed/pending payment jobs
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        status: { in: ["CLOSED", "PENDING_PAYMENT"] },
        job: { propertyId: { in: propertyIds } },
        workflow: { not: "ESTIMATE" },
        isEstimate: false,
        completedAt: { gte: thirtyDaysAgo },
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
        jobType: true,
        price: true,
        notes: true,
        job: {
          select: {
            kind: true,
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
        assignees: {
          select: {
            role: true,
            user: { select: { displayName: true } },
          },
        },
        photos: {
          select: { id: true, r2Key: true, contentType: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
        payment: {
          select: {
            amountPaid: true,
            method: true,
            createdAt: true,
            confirmed: true,
            selfReported: true,
          },
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
          jobType: occ.jobType,
          price: occ.price,
          property: occ.job.property,
          workers: occ.assignees.filter((a) => a.role !== "observer").map((a) => (a.user?.displayName ?? "").split(" ")[0]).filter(Boolean),
          durationMinutes: occ.startedAt && occ.completedAt
            ? Math.round((new Date(occ.completedAt).getTime() - new Date(occ.startedAt).getTime()) / 60000)
            : null,
          photos: photos.filter(Boolean),
          // `paid` is true ONLY after the admin confirms the payment.
          // Until then, the row exists (because the client self-reported
          // via /pay/[token]) but the money hasn't been verified
          // received. We expose a separate `paymentPending` flag so the
          // client UI can render "we got your note — we'll confirm
          // shortly" instead of an outright "Paid" badge and a downloadable
          // receipt for money the business hasn't actually counted yet.
          paid: !!occ.payment?.confirmed,
          paymentPending: !!occ.payment && !occ.payment.confirmed,
          payment: occ.payment ? {
            amountPaid: occ.payment.amountPaid,
            method: occ.payment.method,
            paidAt: occ.payment.createdAt,
            confirmed: occ.payment.confirmed,
            selfReported: occ.payment.selfReported,
          } : null,
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
        status: { in: ["SCHEDULED", "IN_PROGRESS", "ACCEPTED", "PROPOSAL_SUBMITTED"] },
        job: { propertyId: { in: propertyIds } },
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
        isEstimate: true,
        jobType: true,
        price: true,
        proposalAmount: true,
        proposalNotes: true,
        notes: true,
        job: {
          select: {
            kind: true,
            property: {
              select: { id: true, displayName: true, street1: true, city: true, state: true },
            },
          },
        },
        assignees: {
          select: {
            role: true,
            user: { select: { displayName: true } },
          },
        },
        photos: {
          select: { id: true, r2Key: true, contentType: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take: 5,
        },
        changeRequests: {
          where: { status: "PENDING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, kind: true, status: true, proposedStartAt: true, comment: true, createdAt: true },
        },
      },
    });

    const items = await Promise.all(
      occurrences.map(async (occ) => {
        const photos = await Promise.all(
          occ.photos.map(async (p) => {
            try {
              return { id: p.id, url: await getDownloadUrl(p.r2Key, 3600), contentType: p.contentType };
            } catch { return null; }
          })
        );
        return {
          id: occ.id,
          kind: occ.kind,
          status: occ.status,
          startAt: occ.startAt,
          startedAt: occ.startedAt,
          estimatedMinutes: occ.estimatedMinutes,
          workflow: occ.workflow,
          isEstimate: occ.isEstimate,
          jobType: occ.jobType,
          price: occ.price,
          proposalAmount: (occ as any).proposalAmount ?? null,
          proposalNotes: (occ as any).proposalNotes ?? null,
          property: occ.job?.property ?? null,
          workers: occ.assignees.filter((a) => a.role !== "observer").map((a) => (a.user?.displayName ?? "").split(" ")[0]).filter(Boolean),
          photos: photos.filter(Boolean),
          pendingChangeRequest: occ.changeRequests[0] ?? null,
        };
      })
    );

    return { items };
  });

  // ── Change Requests (reschedule / skip) ─────────────────────────────────

  /** Resolve the User row for the current Clerk user. Auth plugin auto-provisions, so this should always exist. */
  async function getMyUser(clerkUserId: string) {
    return prisma.user.findUnique({ where: { clerkUserId } });
  }

  /** Verify the client may request changes on this occurrence (i.e. it belongs to one of their properties). */
  async function verifyOccurrenceForClient(occurrenceId: string, clerkUserId: string) {
    const contact = await getLinkedContact(clerkUserId);
    if (!contact) throw app.httpErrors.forbidden("Account not linked to a client.");
    const propertyIds = new Set(contact.client.properties.map((p) => p.id));
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { id: true, status: true, startAt: true, workflow: true, isEstimate: true, job: { select: { propertyId: true } } },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found.");
    if (!occ.job?.propertyId || !propertyIds.has(occ.job.propertyId)) {
      throw app.httpErrors.forbidden("This occurrence is not on one of your properties.");
    }
    return occ;
  }

  app.post("/client/occurrences/:id/reschedule-request", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    if (!body.proposedStartAt) throw app.httpErrors.badRequest("proposedStartAt is required");
    const proposed = new Date(String(body.proposedStartAt));
    if (isNaN(proposed.getTime())) throw app.httpErrors.badRequest("proposedStartAt is invalid");
    const occ = await verifyOccurrenceForClient(id, clerkUserId);
    if (occ.status !== "SCHEDULED" && occ.status !== "ACCEPTED") {
      throw app.httpErrors.badRequest("Only scheduled jobs can be rescheduled.");
    }
    const me = await getMyUser(clerkUserId);
    if (!me) throw app.httpErrors.unauthorized("User not provisioned.");
    // Prevent multiple pending requests on the same occurrence
    const existing = await prisma.occurrenceChangeRequest.findFirst({
      where: { occurrenceId: id, status: "PENDING" },
    });
    if (existing) throw app.httpErrors.conflict("A change request is already pending for this job.");
    return prisma.occurrenceChangeRequest.create({
      data: {
        occurrenceId: id,
        requestedById: me.id,
        kind: "RESCHEDULE",
        proposedStartAt: proposed,
        comment: body.comment ? String(body.comment).trim() : null,
      },
    });
  });

  app.post("/client/occurrences/:id/skip-request", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    const occ = await verifyOccurrenceForClient(id, clerkUserId);
    if (occ.status !== "SCHEDULED" && occ.status !== "ACCEPTED") {
      throw app.httpErrors.badRequest("Only scheduled jobs can be skipped.");
    }
    const me = await getMyUser(clerkUserId);
    if (!me) throw app.httpErrors.unauthorized("User not provisioned.");
    const existing = await prisma.occurrenceChangeRequest.findFirst({
      where: { occurrenceId: id, status: "PENDING" },
    });
    if (existing) throw app.httpErrors.conflict("A change request is already pending for this job.");
    return prisma.occurrenceChangeRequest.create({
      data: {
        occurrenceId: id,
        requestedById: me.id,
        kind: "SKIP",
        comment: body.comment ? String(body.comment).trim() : null,
      },
    });
  });

  app.delete("/client/change-requests/:id", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const me = await getMyUser(clerkUserId);
    if (!me) throw app.httpErrors.unauthorized("User not provisioned.");
    const cr = await prisma.occurrenceChangeRequest.findUnique({ where: { id } });
    if (!cr) throw app.httpErrors.notFound("Request not found.");
    if (cr.requestedById !== me.id) throw app.httpErrors.forbidden("Not your request.");
    if (cr.status !== "PENDING") throw app.httpErrors.badRequest("Only pending requests can be canceled.");
    await prisma.occurrenceChangeRequest.update({
      where: { id },
      data: { status: "CANCELED", resolvedAt: new Date() },
    });
    return { canceled: true };
  });

  app.get("/client/change-requests", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const me = await getMyUser(clerkUserId);
    if (!me) return { items: [] };
    const list = await prisma.occurrenceChangeRequest.findMany({
      where: { requestedById: me.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        occurrence: {
          select: { id: true, startAt: true, job: { select: { property: { select: { displayName: true } } } } },
        },
      },
    });
    return { items: list };
  });

  // ── Estimate accept / decline (client) ──────────────────────────────────

  /**
   * Estimate accept/decline — records the client's decision as a comment on the
   * occurrence. Admin sees the comment and proceeds with the existing
   * accept-estimate / reject-estimate flows on their side.
   */
  app.post("/client/estimates/:id/accept", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    const occ = await verifyOccurrenceForClient(id, clerkUserId);
    if (occ.workflow !== "ESTIMATE" && !occ.isEstimate) throw app.httpErrors.badRequest("Not an estimate.");
    if (occ.status !== "PROPOSAL_SUBMITTED") throw app.httpErrors.badRequest("Only submitted estimates can be accepted.");
    const me = await getMyUser(clerkUserId);
    if (!me) throw app.httpErrors.unauthorized("User not provisioned.");
    const note = body.comment ? String(body.comment).trim() : "";
    await prisma.occurrenceComment.create({
      data: {
        occurrenceId: id,
        authorId: me.id,
        body: `✅ Client accepted the estimate.${note ? `\n\n${note}` : ""}`,
      },
    });
    return { accepted: true };
  });

  app.post("/client/estimates/:id/decline", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    const occ = await verifyOccurrenceForClient(id, clerkUserId);
    if (occ.workflow !== "ESTIMATE" && !occ.isEstimate) throw app.httpErrors.badRequest("Not an estimate.");
    if (occ.status !== "PROPOSAL_SUBMITTED") throw app.httpErrors.badRequest("Only submitted estimates can be declined.");
    const me = await getMyUser(clerkUserId);
    if (!me) throw app.httpErrors.unauthorized("User not provisioned.");
    const reason = body.reason ? String(body.reason).trim() : "";
    await prisma.occurrenceComment.create({
      data: {
        occurrenceId: id,
        authorId: me.id,
        body: `❌ Client declined the estimate.${reason ? `\n\nReason: ${reason}` : ""}`,
      },
    });
    return { declined: true };
  });
}
