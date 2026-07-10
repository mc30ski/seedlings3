import { FastifyInstance, FastifyRequest } from "fastify";
import { prisma } from "../db/prisma";
import { getDownloadUrl } from "../lib/r2";
import { etMidnight, etToday, etStartOfMonth, etAddDays, etFormatDateOpts } from "../lib/dates";
import { effectiveClerkUserId } from "../plugins/clientImpersonation";

/**
 * Client-facing routes. Require Clerk auth but NOT worker/admin roles.
 * Access is scoped to the client linked via ClientContact.clerkUserId.
 *
 * Business Start Date cutoff is OPERATOR-ONLY: do NOT call resolveCutoff()
 * here or pass a cutoff to any service from this file. The BSD setting is
 * an internal accounting boundary — clients should always see their full
 * service history (within whatever per-route window applies, e.g. the
 * 12-month cap on /client/jobs). Bleeding the cutoff into client views
 * would gaslight clients about service the business actually performed.
 */
export default async function clientRoutes(app: FastifyInstance) {
  // Guard: must be authenticated via Clerk. When a Super is impersonating
  // a client (via the x-impersonate-client-contact header, resolved by
  // plugins/clientImpersonation.ts), the caller's own clerkUserId is
  // real but we want every route body to run against the impersonated
  // client's identity. Swap it here so the downstream `req.auth.clerkUserId`
  // reads on lines 63/159/etc pick up the target's ID with zero per-route
  // edits. The `effectiveClerkUserId` helper returns the impersonation
  // target when active, or the real caller otherwise.
  //
  // Read-only enforcement (no non-GET methods while impersonating) is
  // already handled at the plugin layer — nothing further to check here.
  const clientGuard = {
    preHandler: async (req: FastifyRequest) => {
      const clerkUserId = effectiveClerkUserId(req);
      if (!clerkUserId) {
        throw app.httpErrors.unauthorized("Authentication required.");
      }
      // Route bodies read from req.auth.clerkUserId — patch it so they
      // transparently see the impersonation target.
      (req as any).auth = { ...(req as any).auth, clerkUserId };
    },
  };

  /** Helper: get ALL ClientContact rows linked to this Clerk user. A
   *  single person can be a contact across multiple Clients (e.g.,
   *  a person who pays for a rental AND has us service their own
   *  home), and `clerkUserId` is intentionally not unique — each
   *  matching row represents one client-relationship for the same
   *  underlying person. Returns [] when not linked.
   *
   *  Stable order: oldest first by createdAt. The first row is the
   *  "primary identity carrier" used for the self-view (name/email/
   *  phone on /client/me); the union of `contact.client.properties`
   *  across all rows is what every other client-portal endpoint
   *  scopes its data by. */
  async function getLinkedContacts(clerkUserId: string) {
    // Returns every property regardless of `status` (ACTIVE or
    // ARCHIVED). Callers that want only ACTIVE (e.g. the /client/me
    // "my properties" list shown in the UI) filter at the response
    // mapping. History and change-request scoping keep ARCHIVED
    // included so old, paid-for work on a retired property is still
    // visible to the client instead of being silently hidden.
    return prisma.clientContact.findMany({
      where: { clerkUserId },
      orderBy: { createdAt: "asc" },
      include: {
        client: {
          include: {
            properties: {
              select: { id: true, displayName: true, street1: true, city: true, state: true, status: true },
            },
          },
        },
      },
    });
  }

  // Auto-link: try to match Clerk email to ClientContact email(s).
  // After the multi-client refactor, a single Clerk identity can be
  // bound to ClientContact rows on multiple Clients. We link ALL
  // matching unlinked rows in one shot so the portal sees every
  // client/property the person belongs to from their first session.
  app.post("/client/link", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;

    // Already linked to at least one contact? Short-circuit — we're done.
    const existing = await prisma.clientContact.findFirst({ where: { clerkUserId } });
    if (existing) return { linked: true, contactId: existing.id };

    // Get the user's email from the User table (provisioned by auth plugin)
    const user = await prisma.user.findUnique({ where: { clerkUserId } });
    if (!user?.email) return { linked: false, reason: "no_email" };

    // Find EVERY matching ClientContact by email (case-insensitive)
    // that isn't already bound to a different Clerk user. Returns
    // [] when no match.
    const matches = await prisma.clientContact.findMany({
      where: {
        email: { equals: user.email, mode: "insensitive" },
        clerkUserId: null,
      },
      select: { id: true },
    });

    if (matches.length > 0) {
      // Bind every matching contact to the same Clerk identity in
      // a single updateMany. Subsequent logins will resolve via the
      // clerkUserId index across all of them.
      await prisma.clientContact.updateMany({
        where: { id: { in: matches.map((m) => m.id) } },
        data: { clerkUserId },
      });
      // The portal's existing flows assume a single contactId in
      // the response — return the first match (stable across
      // retries via primary-then-createdAt ordering on the source
      // list).
      return { linked: true, contactId: matches[0].id, linkedCount: matches.length };
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

    // If already linked to at least one contact (race with another tab)
    // — short-circuit success. clerkUserId is no longer unique post-
    // multi-client refactor, so findFirst is correct here.
    const existing = await prisma.clientContact.findFirst({ where: { clerkUserId } });
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
    const contacts = await getLinkedContacts(clerkUserId);
    if (contacts.length === 0) return { linked: false };

    // Identity comes from the oldest contact row (stable across
    // multi-client setups). The properties payload is the union
    // across every linked client so the portal can show all of
    // them in one list.  Filter to ACTIVE at the response layer —
    // getLinkedContacts returns ALL properties so downstream history
    // queries can include archived ones, but the client's "My
    // Properties" list shouldn't clutter with retired addresses.
    const isActiveProp = (p: { status?: string }) => p.status === "ACTIVE";
    const primary = contacts[0];
    const allProperties = contacts.flatMap((c) => c.client.properties).filter(isActiveProp);

    return {
      linked: true,
      contact: {
        id: primary.id,
        firstName: primary.firstName,
        lastName: primary.lastName,
        email: primary.email,
        phone: primary.phone,
      },
      // Back-compat for single-client clients: the `client` field
      // still exists and points at the first (and usually only)
      // Client. Multi-client clients additionally read `clients[]`
      // for the full list — UI can group properties by client when
      // it's more than one.
      client: {
        id: primary.client.id,
        displayName: primary.client.displayName,
        properties: allProperties,
      },
      clients: contacts.map((c) => ({
        id: c.client.id,
        displayName: c.client.displayName,
        properties: c.client.properties.filter(isActiveProp),
      })),
    };
  });

  // Get completed jobs for client's properties
  app.get("/client/jobs", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const contacts = await getLinkedContacts(clerkUserId);
    if (contacts.length === 0) return { items: [], monthsBack: 1, maxMonthsBack: 12, hasMore: false };

    // Union of property IDs across every linked Client. A client
    // who's a contact on more than one Client sees jobs from all of
    // their properties in one stream.
    const propertyIds = contacts.flatMap((c) => c.client.properties.map((p) => p.id));
    if (propertyIds.length === 0) return { items: [], monthsBack: 1, maxMonthsBack: 12, hasMore: false };

    // Service history window: monthsBack=N covers the current calendar
    // month plus the previous (N-1) months. Default is 3 months — enough
    // to always show the client's most recent visits regardless of what
    // day of the month they open the app. A "monthsBack=1" default meant
    // that on the 1st or 2nd of any month, clients saw essentially
    // nothing and had to hit "Show more" to see last month's history —
    // which is what most people would consider "recent."
    // Client's "Show more" button increments monthsBack from there, up
    // to 12 (one year). Beyond a year, the data is archived from the
    // client's point of view — they call/text us if they need older
    // records.
    const MAX_MONTHS_BACK = 12;
    const MAX_JOBS = 100;
    const DEFAULT_MONTHS_BACK = 3;
    const rawMonths = Number(req.query?.monthsBack);
    const monthsBack = Number.isFinite(rawMonths)
      ? Math.min(MAX_MONTHS_BACK, Math.max(1, Math.floor(rawMonths)))
      : DEFAULT_MONTHS_BACK;
    // First-of-month in ET, then walk back monthsBack-1 months via string
    // arithmetic so DST/UTC don't shift the boundary.
    const startKey = etStartOfMonth(); // YYYY-MM-01 in ET
    const [sy, sm] = startKey.split("-").map(Number);
    // First-of-month for (current month - monthsBack + 1).
    const targetMonth0 = sm - 1 - (monthsBack - 1); // 0-indexed, may be negative
    const yShift = Math.floor(targetMonth0 / 12);
    const mShifted = ((targetMonth0 % 12) + 12) % 12; // 0..11
    const targetKey = `${sy + yShift}-${String(mShifted + 1).padStart(2, "0")}-01`;
    const startOfMonth = etMidnight(targetKey);

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        // COMPLETED, CLOSED, and PENDING_PAYMENT are all "the work is
        // done" states from the client's point of view. Previously only
        // CLOSED/PENDING_PAYMENT was listed here, which silently hid
        // every occurrence in COMPLETED status — real, finished work the
        // client couldn't see.
        status: { in: ["COMPLETED", "CLOSED", "PENDING_PAYMENT"] },
        job: { propertyId: { in: propertyIds } },
        // Only real client-facing service work belongs in the history.
        // Internal workflows (TASK, REMINDER, EVENT, FOLLOWUP,
        // ANNOUNCEMENT, ESTIMATE) never surface to the client — same
        // rule applied by the worker route.
        workflow: { in: ["STANDARD", "ONE_OFF"] },
        // isAdminOnly is INTENTIONALLY NOT filtered here. That flag is
        // about worker ASSIGNMENT behavior ("Administered — workers
        // cannot claim, must be assigned") — nothing to do with what the
        // client sees. Estimates auto-set it to true but they're already
        // excluded by the workflow filter above, so leaving it off can't
        // leak them. Removing the filter here fixes a bug where admins
        // who checked "Administered" on a legitimate service to control
        // assignment inadvertently hid the completed job from the client.
        // Historical data has some rows in a completion state with
        // completedAt=null (admin PATCH paths didn't always stamp it —
        // fixed forward but historical rows persist). Include those by
        // falling back to startedAt when completedAt is null so the
        // client's history isn't silently blank for legacy rows.
        OR: [
          { completedAt: { gte: startOfMonth } },
          { AND: [{ completedAt: null }, { startedAt: { gte: startOfMonth } }] },
        ],
      },
      // Prisma can't order by COALESCE; explicit tie-breaker on startedAt
      // for the null-completedAt fallback rows so they still sort roughly
      // by recency.
      orderBy: [{ completedAt: "desc" }, { startedAt: "desc" }],
      take: MAX_JOBS,
      select: {
        id: true,
        kind: true,
        status: true,
        startAt: true,
        completedAt: true,
        // estimatedMinutes / startedAt: intentionally not selected.
        // Duration and estimated-duration must not surface on the
        // client's history — how long a job took doesn't matter to the
        // client and can leave a bad impression ("that only took 20
        // minutes?"). Kept out of the payload at the boundary so a
        // future accidental render can't leak it. Same rationale on
        // /client/upcoming below.
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

    // Pre-load the PAYMENT_METHODS taxonomy once so each payment row can
    // ship a resolved `methodLabel` string. Keeps the client receipt
    // generator from needing to know the taxonomy itself.
    const { loadPaymentMethods } = await import("../services/paymentMethods");
    const paymentMethods = await loadPaymentMethods(prisma);
    const labelByKey = new Map<string, string>(paymentMethods.map((m) => [m.key, m.label]));
    const resolveMethodLabel = (key: string): string =>
      labelByKey.get(key) ?? key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

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
          property: occ.job?.property ?? null,
          // Return full displayName ("First Last") — receipts need the
          // full name. Casual UI uses workerLabel() to extract the first
          // name for friendlier "Crew: Mark & Sarah" rendering.
          workers: occ.assignees.filter((a) => a.role !== "observer").map((a) => (a.user?.displayName ?? "").trim()).filter(Boolean),
          // durationMinutes intentionally omitted — see comment on the select above.
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
            // Resolved server-side from the PAYMENT_METHODS taxonomy so
            // the client receipt generator never needs to know about
            // the configurable label list.
            methodLabel: resolveMethodLabel(occ.payment.method),
            paidAt: occ.payment.createdAt,
            confirmed: occ.payment.confirmed,
            selfReported: occ.payment.selfReported,
          } : null,
        };
      })
    );

    // hasMore = client can still load older months. Stops at the year
    // cap. Also stops short if we already returned the MAX_JOBS ceiling
    // (more pagination wouldn't fetch new rows since we always sort
    // most-recent-first within the requested window).
    const hasMore = monthsBack < MAX_MONTHS_BACK && items.length < MAX_JOBS;
    return {
      items,
      monthsBack,
      maxMonthsBack: MAX_MONTHS_BACK,
      hasMore,
      windowStart: startOfMonth.toISOString(),
    };
  });

  // Get upcoming scheduled jobs for client's properties
  app.get("/client/upcoming", clientGuard, async (req: any) => {
    const clerkUserId = req.auth.clerkUserId!;
    const contacts = await getLinkedContacts(clerkUserId);
    if (contacts.length === 0) return { items: [] };

    const propertyIds = contacts.flatMap((c) => c.client.properties.map((p) => p.id));
    if (propertyIds.length === 0) return { items: [] };

    // Date cutoff for the "upcoming" list. A SCHEDULED / ACCEPTED /
    // PAUSED occurrence with startAt before the start of today (ET) is
    // stale — probably a job whose close-out step was skipped by the
    // crew. Those must NOT show as "upcoming."
    //
    // IN_PROGRESS gets a 2-day grace window instead of a hard cutoff:
    // a worker who started a job late last night should still see it as
    // in progress. An IN_PROGRESS row older than 2 days is stale and
    // hidden — surfacing it as "Happening Now" a month later looks
    // broken to the client (which is exactly the 6/2 bug the operator
    // hit).
    const upcomingCutoff = etMidnight(etToday());
    // date-handling-allow: elapsed-time
    const inProgressCutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

    const occurrences = await prisma.jobOccurrence.findMany({
      where: {
        // PROPOSAL_SUBMITTED intentionally excluded — estimates are
        // internal and must never surface in the client portal.
        job: { propertyId: { in: propertyIds } },
        // Only real client-facing service work surfaces to the client.
        // Internal workflows (TASK, REMINDER, EVENT, FOLLOWUP,
        // ANNOUNCEMENT, ESTIMATE) never leak into the portal.
        workflow: { in: ["STANDARD", "ONE_OFF"] },
        // Belt-and-suspenders exclusion for any occurrence flagged as
        // an estimate via legacy isEstimate.
        isEstimate: false,
        // isAdminOnly is INTENTIONALLY NOT filtered — see the same
        // note in the /client/jobs query above. It's an assignment
        // rule, not a visibility rule.
        OR: [
          {
            // Truly-active IN_PROGRESS: started less than 2 days ago
            // and either startedAt or startAt is within the grace
            // window. Rows outside this window are hidden as stale.
            status: "IN_PROGRESS",
            OR: [
              { startedAt: { gte: inProgressCutoff } },
              { startAt: { gte: inProgressCutoff } },
            ],
          },
          {
            // Everything else: strict "must be today or later" cutoff.
            // Note that ACCEPTED here is technically dead (only present
            // in the ESTIMATE workflow which is filtered out above) but
            // kept for safety.  PAUSED is included so paused-mid-job
            // rows still appear in the client's Upcoming view — dropping
            // them silently would look like the job vanished.
            status: { in: ["SCHEDULED", "ACCEPTED", "PAUSED"] },
            startAt: { gte: upcomingCutoff },
          },
        ],
      },
      orderBy: { startAt: "asc" },
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        startAt: true,
        startedAt: true,
        // estimatedMinutes intentionally not selected — see the note on
        // the /client/jobs select above. Not exposed to clients.
        workflow: true,
        isOneOff: true,
        frequencyDays: true,
        jobType: true,
        price: true,
        notes: true,
        job: {
          select: {
            kind: true,
            frequencyDays: true,
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
        // Two surfaces use these:
        //   - pendingChangeRequest (status=PENDING) → banner on the card
        //     while admin processes the request
        //   - latest resolved-with-note → admin's dismissal/approval note
        //     shown on the card so the client sees the response.
        //     Naturally disappears when the next recurring occurrence is
        //     created (that's a different row, no requests on it).
        // Both fetched in one query (take 5 covers any realistic spread
        // of resolved + pending; client side splits them).
        changeRequests: {
          where: {
            OR: [
              { status: "PENDING" },
              { resolutionNote: { not: null } },
            ],
          },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            kind: true,
            status: true,
            proposedStartAt: true,
            comment: true,
            resolutionNote: true,
            resolvedAt: true,
            createdAt: true,
          },
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
        // Effective frequency: occurrence-level override wins, else the
        // job's default. Null means non-recurring.
        const effectiveFreq = (occ as any).frequencyDays ?? occ.job?.frequencyDays ?? null;
        return {
          id: occ.id,
          kind: occ.kind,
          status: occ.status,
          startAt: occ.startAt,
          startedAt: occ.startedAt,
          // estimatedMinutes intentionally omitted — see comment on the select above.
          workflow: occ.workflow,
          isOneOff: (occ as any).isOneOff ?? false,
          frequencyDays: effectiveFreq,
          jobType: occ.jobType,
          price: occ.price,
          property: occ.job?.property ?? null,
          // Return full displayName ("First Last") — receipts need the
          // full name. Casual UI uses workerLabel() to extract the first
          // name for friendlier "Crew: Mark & Sarah" rendering.
          workers: occ.assignees.filter((a) => a.role !== "observer").map((a) => (a.user?.displayName ?? "").trim()).filter(Boolean),
          photos: photos.filter(Boolean),
          // Split the prefetched change requests into pending (banner)
          // and most-recent-resolved-with-note (response from admin).
          pendingChangeRequest: occ.changeRequests.find((c) => c.status === "PENDING") ?? null,
          lastResolvedRequest:
            occ.changeRequests.find((c) => c.status !== "PENDING" && !!c.resolutionNote) ?? null,
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
    const contacts = await getLinkedContacts(clerkUserId);
    if (contacts.length === 0) throw app.httpErrors.forbidden("Account not linked to a client.");
    const propertyIds = new Set(contacts.flatMap((c) => c.client.properties.map((p) => p.id)));
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        id: true,
        status: true,
        startAt: true,
        workflow: true,
        isEstimate: true,
        isOneOff: true,
        frequencyDays: true,
        job: { select: { propertyId: true, frequencyDays: true } },
      },
    });
    if (!occ) throw app.httpErrors.notFound("Occurrence not found.");
    if (!occ.job?.propertyId || !propertyIds.has(occ.job.propertyId)) {
      throw app.httpErrors.forbidden("This occurrence is not on one of your properties.");
    }
    return occ;
  }

  /**
   * Fire-and-forget admin notification when a client submits a change
   * request. Push to every approved admin/super. SMS/email gated by the
   * NOTIFY_CHANGE_REQUEST_VIA_SMS_EMAIL setting (default off, push-only).
   */
  async function notifyAdminsOfChangeRequest(opts: {
    kind: "RESCHEDULE" | "SKIP";
    propertyLabel: string;
    clientLabel: string;
    occurrenceDateLabel: string;
    comment: string | null;
    /** Optional client-suggested new date for RESCHEDULE. Not applied
     *  by approval — just included in the admin push so they have it
     *  before reaching out. */
    proposedStartAt?: Date | null;
  }): Promise<void> {
    try {
      const admins = await prisma.user.findMany({
        where: {
          isApproved: true,
          roles: { some: { role: { in: ["ADMIN" as any, "SUPER" as any] } } },
        },
        select: { id: true },
      });
      const setting = await prisma.setting.findUnique({
        where: { key: "NOTIFY_CHANGE_REQUEST_VIA_SMS_EMAIL" },
      });
      const allowSmsEmail = setting?.value === "true";
      const { notifyWorker } = await import("../lib/notifications");
      const verb = opts.kind === "RESCHEDULE" ? "reschedule" : "skip";
      const subject = `New ${verb} request - ${opts.clientLabel}`;
      const suggestion =
        opts.kind === "RESCHEDULE" && opts.proposedStartAt
          ? ` Suggested: ${etFormatDateOpts(opts.proposedStartAt, { weekday: "short", month: "short", day: "numeric" })}.`
          : "";
      const body =
        `${opts.clientLabel} requested a ${verb} for ${opts.propertyLabel} on ${opts.occurrenceDateLabel}.` +
        suggestion +
        (opts.comment ? ` "${opts.comment}"` : "");
      for (const u of admins) {
        notifyWorker(u.id, body, { subject, pushOnly: !allowSmsEmail }).catch(() => {});
      }
    } catch (err) {
      // Notifications are best-effort — never let a failure here break
      // the request creation.
      // eslint-disable-next-line no-console
      console.warn("notifyAdminsOfChangeRequest failed:", err);
    }
  }

  /** Best-effort context lookup for the notification message. */
  async function buildChangeRequestContext(occurrenceId: string, requestedByUserId: string) {
    const occ = await prisma.jobOccurrence.findUnique({
      where: { id: occurrenceId },
      select: {
        startAt: true,
        job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } },
      },
    });
    const reqUser = await prisma.user.findUnique({
      where: { id: requestedByUserId },
      select: { displayName: true, firstName: true, lastName: true, email: true },
    });
    const propertyLabel = occ?.job?.property?.displayName ?? "(property)";
    const clientLabel =
      occ?.job?.property?.client?.displayName ??
      reqUser?.displayName ??
      ([reqUser?.firstName, reqUser?.lastName].filter(Boolean).join(" ") ||
        reqUser?.email ||
        "(client)");
    const dateLabel = occ?.startAt
      ? etFormatDateOpts(new Date(occ.startAt), { weekday: "short", month: "short", day: "numeric" })
      : "an upcoming visit";
    return { propertyLabel, clientLabel, dateLabel };
  }

  app.post("/client/occurrences/:id/reschedule-request", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    // Reschedule requests are conversation starters, not commands. The
    // client *may* suggest a date (defaults to 3 days from now in the
    // UI); the admin uses it as context when reaching out to confirm a
    // real time. Approving the request does NOT auto-apply this date —
    // the admin does the actual schedule edit through normal admin
    // tooling after talking to the client.
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
    const comment = body.comment ? String(body.comment).trim() : null;
    // Required suggested date — must parse AND be in the future.
    // Three layers of defense (browser min attr, client submit guard,
    // and here) — this one is the final gate so client cannot bypass
    // by crafting a direct API call.
    if (!body.proposedStartAt) {
      throw app.httpErrors.badRequest("proposedStartAt is required.");
    }
    const proposed = new Date(String(body.proposedStartAt));
    if (isNaN(proposed.getTime())) {
      throw app.httpErrors.badRequest("proposedStartAt is not a valid date.");
    }
    // "In the future" = after start-of-today, so a same-day reschedule
    // (e.g., a client picking today late at night for a tomorrow visit
    // that already moved past midnight) doesn't get rejected. The UI
    // pushes them at least to tomorrow anyway.
    const startOfToday = etMidnight(etToday());
    if (proposed.getTime() < startOfToday.getTime()) {
      throw app.httpErrors.badRequest("The suggested date must be in the future.");
    }
    const created = await prisma.occurrenceChangeRequest.create({
      data: {
        occurrenceId: id,
        requestedById: me.id,
        kind: "RESCHEDULE",
        proposedStartAt: proposed,
        comment,
      },
    });
    const ctx = await buildChangeRequestContext(id, me.id);
    void notifyAdminsOfChangeRequest({
      kind: "RESCHEDULE",
      propertyLabel: ctx.propertyLabel,
      clientLabel: ctx.clientLabel,
      occurrenceDateLabel: ctx.dateLabel,
      comment,
      proposedStartAt: proposed,
    });
    return created;
  });

  app.post("/client/occurrences/:id/skip-request", clientGuard, async (req: any) => {
    const id = String(req.params.id);
    const clerkUserId = req.auth.clerkUserId!;
    const body = req.body || {};
    const occ = await verifyOccurrenceForClient(id, clerkUserId);
    if (occ.status !== "SCHEDULED" && occ.status !== "ACCEPTED") {
      throw app.httpErrors.badRequest("Only scheduled jobs can be skipped.");
    }
    // Skip is recurring-only. Skipping a one-off would just be a
    // cancellation, which is a heavier conversation that shouldn't go
    // through the casual self-service skip path. The UI hides the Skip
    // button on one-offs; this is the server-side enforcement.
    const isOneOff = !!(occ as any).isOneOff || occ.workflow === "ONE_OFF";
    const effectiveFreq = (occ as any).frequencyDays ?? occ.job?.frequencyDays ?? null;
    if (isOneOff || !effectiveFreq || effectiveFreq <= 0) {
      throw app.httpErrors.badRequest(
        "Only recurring visits can be skipped. For a one-time visit, contact us to cancel."
      );
    }
    const me = await getMyUser(clerkUserId);
    if (!me) throw app.httpErrors.unauthorized("User not provisioned.");
    const existing = await prisma.occurrenceChangeRequest.findFirst({
      where: { occurrenceId: id, status: "PENDING" },
    });
    if (existing) throw app.httpErrors.conflict("A change request is already pending for this job.");
    const comment = body.comment ? String(body.comment).trim() : null;
    const created = await prisma.occurrenceChangeRequest.create({
      data: {
        occurrenceId: id,
        requestedById: me.id,
        kind: "SKIP",
        comment,
      },
    });
    const ctx = await buildChangeRequestContext(id, me.id);
    void notifyAdminsOfChangeRequest({
      kind: "SKIP",
      propertyLabel: ctx.propertyLabel,
      clientLabel: ctx.clientLabel,
      occurrenceDateLabel: ctx.dateLabel,
      comment,
    });
    return created;
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

  // Client-facing estimate accept/decline endpoints removed —
  // estimates are internal to the company and must never surface in the
  // client portal.  If a client-visible quote flow is ever needed again
  // it should be redesigned from scratch as a separate feature.
}
