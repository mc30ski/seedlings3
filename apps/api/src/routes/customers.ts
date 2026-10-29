import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt, evaluateHoursApproval, loadHoursApprovalVarianceThreshold, loadPriorPersonMinutes } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import * as displays from "../services/displays";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, etTomorrow, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { InstructionScope, JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, paymentSplitCutoffWhere, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { portfolioWhere, portfolioWhereVia } from "../lib/portfolioScope";
import { WORKER_TYPES, classify, isFeeable, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate, occInEditableState } from "./_shared";
import { fetchWeatherAlerts } from "../services/weatherAlerts";
import { cached } from "../lib/cache";
import { businessLatLng } from "../lib/businessLocation";
import { hourlyForecastForOccurrence } from "../services/hourlyForecast";
import { ServiceError } from "../lib/errors";
import { persistCompletionSplits } from "../services/payments";
import { computeMyOccurrenceNet } from "../services/workerEarnings";
import { redactObserverFieldsForCaller, redactPeekFieldsForCaller, redactUnclearedFieldsForCaller } from "../lib/observerRedaction";
import { capabilitiesForUsers, userCan } from "../lib/userCapabilities";

export default async function customerRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_clientsContribute = requires("clients.contribute");
  const req_clientsManage = requires("clients.manage");
  const req_clientsView = requires("clients.view");
  const req_clientsViewAs = requires("clients.view-as");
  const req_identityLink = requires("identity.link");

  // ── Unlinked Clerk client accounts (admin re-link worklist) ──
  //
  // The auto-link in /client/link matches a Clerk user to a ClientContact by
  // exact email. When the client signed up with a different email than what
  // we have on file, that fails silently — they have a Clerk account that's
  // not connected to any client record ("phantom"). This endpoint lists
  // those phantoms so someone with `routes.plan` can manually link them.
  app.get("/clients/unlinked-accounts", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: these accounts are precisely the ones with NO client
    // record yet — that is what "unlinked" means — so they have no property,
    // no occurrence and therefore no territory to filter on. Scoping would
    // return nothing to everyone.
    const { nearEmail } = (req.query || {}) as { nearEmail?: string };
    const candidates = await prisma.user.findMany({
      where: {
        // A client-shaped account: holds no internal role at all. Was
        // `roles: { none: {} }`. NOTE this now also matches a brand-new
        // internal hire nobody has granted a role to yet — which is a real
        // state in this model, and they genuinely do look client-shaped
        // until somebody decides what they may do.
        customRoles: { none: {} },
        isApproved: true,        // exclude pending-approval signups (those go through Users approval flow)
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        clerkUserId: true,
        email: true,
        firstName: true,
        lastName: true,
        displayName: true,
        createdAt: true,
      },
    });
    const linked = await prisma.clientContact.findMany({
      where: { clerkUserId: { not: null } },
      select: { clerkUserId: true },
    });
    const linkedIds = new Set(linked.map((c) => c.clerkUserId!));
    const out = candidates.filter((u) => !linkedIds.has(u.clerkUserId));
    if (nearEmail) {
      // Shared-prefix similarity on the email local part — same heuristic the
      // contact-side picker uses, so admin starting from either side sees the
      // strongest match at the top.
      const localOf = (e: string | null | undefined) =>
        (e ?? "").toLowerCase().split("@")[0] ?? "";
      const hint = localOf(nearEmail);
      const score = (e: string | null | undefined) => {
        const a = localOf(e);
        let i = 0;
        while (i < Math.min(a.length, hint.length) && a[i] === hint[i]) i++;
        return i;
      };
      out.sort((x, y) => score(y.email) - score(x.email));
    }
    return out;
  });
  // Pre-flight check: does this email/phone already exist on any active
  // contact? Used by the ContactDialog to warn the person filling it in before they
  // finish a wizard step — catches "recreate after delete" and shared-
  // household-email collisions while they're still typing, instead of
  // failing at the final batchSave.
  app.get("/client-contacts/check", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: an existence lookup by email/phone used before
    //   creating a contact; it answers "is this person already in the
    //   system", which is a company-wide question and returns no territorial
    //   rows
    const { email, phone } = (req.query || {}) as { email?: string; phone?: string };
    const e = (email ?? "").trim();
    const p = (phone ?? "").trim();
    const orClauses: any[] = [];
    if (e) orClauses.push({ email: { equals: e, mode: "insensitive" as const } });
    if (p) orClauses.push({ normalizedPhone: p });
    if (orClauses.length === 0) return [];
    return prisma.clientContact.findMany({
      where: { status: "ACTIVE", OR: orClauses },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        normalizedPhone: true,
        isPrimary: true,
        // Surfaced so the warning dialog can call out "this person
        // already has a login account" — if any match has
        // clerkUserId set, adding this new contact will auto-bind
        // it to the same Clerk identity (the create flow
        // propagates from existing matches).
        clerkUserId: true,
        client: { select: { id: true, displayName: true } },
      },
      take: 10,
    });
  });
  // Unlinked contacts to choose from when admin is wiring up a phantom.
  // Returns ACTIVE contacts that don't yet have a clerkUserId, optionally
  // sorted by email-local-part similarity to a hint (`?nearEmail=...`).
  app.get("/client-contacts/unlinked", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: the identity-linking worklist — contacts with no
    //   Clerk account. Linking a login is an account-administration job
    //   (identity.link), not a territorial one
    const { nearEmail } = (req.query || {}) as { nearEmail?: string };
    const rows = await prisma.clientContact.findMany({
      where: { clerkUserId: null, status: "ACTIVE" },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        client: { select: { id: true, displayName: true } },
      },
      take: 200,
    });
    if (nearEmail) {
      const localOf = (e: string | null | undefined) =>
        (e ?? "").toLowerCase().split("@")[0] ?? "";
      const hint = localOf(nearEmail);
      // Rough similarity: shared-prefix length on the local part. Cheap,
      // effective for the common "john@gmail.com" vs "john.smith@outlook.com"
      // pattern. Stable sort keeps the recency tiebreak.
      const score = (e: string | null | undefined) => {
        const a = localOf(e);
        let i = 0;
        while (i < Math.min(a.length, hint.length) && a[i] === hint[i]) i++;
        return i;
      };
      rows.sort((x, y) => score(y.email) - score(x.email));
    }
    return rows;
  });
  // Link a Clerk user to a contact. With `force=true` admin can override an
  // existing link on either side. Each link/unlink is audit-logged.
  app.post("/client-contacts/:contactId/link-clerk", req_identityLink, async (req: any) => {
    const uid = await currentUserId(req);
    const contactId = String(req.params.contactId);
    const body = req.body || {};
    const clerkUserId = String(body.clerkUserId ?? "").trim();
    const force = !!body.force;
    if (!clerkUserId) throw app.httpErrors.badRequest("clerkUserId is required.");

    const contact = await prisma.clientContact.findUnique({ where: { id: contactId } });
    if (!contact) throw app.httpErrors.notFound("Contact not found.");

    const targetUser = await prisma.user.findUnique({ where: { clerkUserId } });
    if (!targetUser) throw app.httpErrors.notFound("Clerk user not found.");

    // clerkUserId is no longer globally unique on ClientContact —
    // the same Clerk identity can be linked to multiple contacts
    // (one per Client) as long as they represent the same person.
    // We only flag the "wrong contact" conflict when the existing
    // link is on a contact whose IDENTITY (email/phone) doesn't
    // match the one we're about to repoint. Cross-client linking
    // of the same person is now legitimate, not a conflict.
    const otherLinked = await prisma.clientContact.findMany({
      where: { clerkUserId, NOT: { id: contactId } },
      select: { id: true, email: true, normalizedPhone: true },
    });
    if (otherLinked.length > 0 && !force) {
      const sameIdentity = otherLinked.every(
        (c) =>
          (c.email && contact.email && c.email.toLowerCase() === contact.email.toLowerCase()) ||
          (c.normalizedPhone && c.normalizedPhone === contact.normalizedPhone),
      );
      if (!sameIdentity) {
        throw app.httpErrors.conflict(
          "That Clerk account is already linked to a contact with different identity. Pass force=true to repoint it.",
        );
      }
    }
    if (contact.clerkUserId && contact.clerkUserId !== clerkUserId && !force) {
      throw app.httpErrors.conflict(
        "This contact is already linked to a different Clerk account. Pass force=true to replace.",
      );
    }

    // Repoint candidates: any existing link on a contact whose
    // identity (email/phone) DOESN'T match the target contact's.
    // Same-identity links stay — those are the legitimate multi-
    // client shared-login case and shouldn't be cleared.
    const repointTargets = otherLinked.filter(
      (c) =>
        !(c.email && contact.email && c.email.toLowerCase() === contact.email.toLowerCase()) &&
        !(c.normalizedPhone && contact.normalizedPhone && c.normalizedPhone === contact.normalizedPhone),
    );

    return prisma.$transaction(async (tx) => {
      // If forcing a repoint, clear stale clerkUserId on the non-
      // matching contacts. Same-identity siblings keep their link.
      if (force && repointTargets.length > 0) {
        await tx.clientContact.updateMany({
          where: { id: { in: repointTargets.map((r) => r.id) } },
          data: { clerkUserId: null },
        });
        for (const r of repointTargets) {
          await writeAudit(tx, AUDIT.CLIENT.CONTACT_UNLINKED, uid, {
            contactId: r.id,
            clerkUserId,
            reason: "repointed",
          });
        }
      }
      const updated = await tx.clientContact.update({
        where: { id: contactId },
        data: { clerkUserId },
      });
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_LINKED, uid, {
        contactId,
        clerkUserId,
        force,
      });
      return updated;
    });
  });
  app.delete("/client-contacts/:contactId/link-clerk", req_identityLink, async (req: any) => {
    const uid = await currentUserId(req);
    const contactId = String(req.params.contactId);
    const contact = await prisma.clientContact.findUnique({ where: { id: contactId } });
    if (!contact) throw app.httpErrors.notFound("Contact not found.");
    if (!contact.clerkUserId) return { unlinked: true, contact };
    return prisma.$transaction(async (tx) => {
      const updated = await tx.clientContact.update({
        where: { id: contactId },
        data: { clerkUserId: null },
      });
      await writeAudit(tx, AUDIT.CLIENT.CONTACT_UNLINKED, uid, {
        contactId,
        clerkUserId: contact.clerkUserId,
      });
      return { unlinked: true, contact: updated };
    });
  });
  // `identity.link`: list every ClientContact for a client that has a Clerk
  // account, so the frontend can render the "View as which contact?"
  // picker. Contacts without a clerkUserId are still listed so the
  // picker can explain why they're not selectable ("Never logged in").
  //
  // Sorted: primary first, then by createdAt ascending (stable order).
  app.get("/clients/:id/impersonatable-contacts", req_clientsViewAs, async (req: any) => {
    const clientId = String(req.params.id);
    const contacts = await prisma.clientContact.findMany({
      where: { clientId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        isPrimary: true,
        clerkUserId: true,
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return {
      clientId,
      contacts: contacts.map((c) => ({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        role: c.role,
        isPrimary: c.isPrimary,
        // Boolean, never the clerkUserId itself — frontend doesn't need
        // to know that value, only whether the contact CAN be impersonated.
        hasClerkAccount: !!c.clerkUserId,
      })),
    };
  });
  app.post("/clients", req_clientsManage, async (req: any) => {
    return services.clients.create(await currentUserId(req), req.body);
  });
  app.patch("/clients/:id", req_clientsManage, async (req: any) => {
    return services.clients.update(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });
  app.post("/clients/:id/archive", req_clientsManage, async (req: any) => {
    return services.clients.archive(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  app.post("/clients/:id/unarchive", req_clientsManage, async (req: any) => {
    return services.clients.unarchive(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  // Preview counts — how many child rows will an archive cascade touch?
  // Used by the confirm dialog on the archive button so the operator sees
  // "This will also archive N Properties and M Jobs" before proceeding.
  // Cheap; two count queries + a group-by. Not gated by cutoff — this is
  // an operational preview, not a financial one.
  app.get("/clients/:id/archive-preview", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const clientId = String(req.params.id);
    const [propertiesToArchive, jobsToArchive] = await Promise.all([
      prisma.property.count({
        where: { clientId, status: { not: "ARCHIVED" as any } },
      }),
      prisma.job.count({
        where: {
          property: { clientId },
          status: { not: "ARCHIVED" as any },
        },
      }),
    ]);
    return { propertiesToArchive, jobsToArchive };
  });
  // Symmetric preview for unarchive — counts rows that WOULD be brought
  // back to active. Uses status=ARCHIVED so the number matches what the
  // cascade will actually touch.
  app.get("/clients/:id/unarchive-preview", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const clientId = String(req.params.id);
    const [propertiesToUnarchive, jobsToUnarchive] = await Promise.all([
      prisma.property.count({
        where: { clientId, status: "ARCHIVED" as any },
      }),
      prisma.job.count({
        where: {
          property: { clientId },
          status: "ARCHIVED" as any,
        },
      }),
    ]);
    return { propertiesToUnarchive, jobsToUnarchive };
  });
  app.delete("/clients/:id", req_clientsManage, async (req: any) => {
    return services.clients.delete(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  app.post("/clients/:id/contacts", req_clientsManage, async (req: any) => {
    return services.clients.addContact(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });
  app.patch(
    "/clients/:id/contacts/:contactId",
    req_clientsManage,
    async (req: any) => {
      return services.clients.updateContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId),
        req.body
      );
    }
  );
  app.post("/contacts/:id/archive", req_clientsManage, async (req: any) => {
    return services.clients.archiveContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  app.post("/contacts/:id/unarchive", req_clientsManage, async (req: any) => {
    return services.clients.unarchiveContact(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  app.delete(
    "/clients/:id/contacts/:contactId",
    req_clientsManage,
    async (req: any) => {
      return services.clients.deleteContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId)
      );
    }
  );
  app.post(
    "/clients/:id/contacts/:contactId/primary",
    req_clientsManage,
    async (req: any) => {
      return services.clients.setPrimaryContact(
        await currentUserId(req),
        String(req.params.id),
        String(req.params.contactId)
      );
    }
  );
  app.post("/properties", req_clientsManage, async (req: any) => {
    return services.properties.create(await currentUserId(req), req.body);
  });
  app.patch("/properties/:id", req_clientsManage, async (req: any) => {
    return services.properties.update(
      await currentUserId(req),
      String(req.params.id),
      req.body
    );
  });
  app.post("/properties/:id/archive", req_clientsManage, async (req: any) => {
    return services.properties.archive(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  app.post("/properties/:id/unarchive", req_clientsManage, async (req: any) => {
    return services.properties.unarchive(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  // Preview for Property archive cascade — same shape as the Client one.
  app.get("/properties/:id/archive-preview", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const propertyId = String(req.params.id);
    const jobsToArchive = await prisma.job.count({
      where: { propertyId, status: { not: "ARCHIVED" as any } },
    });
    return { jobsToArchive };
  });
  app.get("/properties/:id/unarchive-preview", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const propertyId = String(req.params.id);
    const jobsToUnarchive = await prisma.job.count({
      where: { propertyId, status: "ARCHIVED" as any },
    });
    return { jobsToUnarchive };
  });
  app.delete("/properties/:id", req_clientsManage, async (req: any) => {
    return services.properties.hardDelete(
      await currentUserId(req),
      String(req.params.id)
    );
  });
  // Primary contact for the property (optional)
  app.post(
    "/properties/:id/primary-contact",
    req_clientsManage,
    async (req: any) => {
      const { contactId } = (req.body || {}) as { contactId?: string | null };
      return services.properties.setPrimaryContact(
        await currentUserId(req),
        String(req.params.id),
        contactId ?? null
      );
    }
  );
  app.post("/properties/:id/photos/upload-url", req_clientsContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const propertyId = String(req.params.id);
    const { fileName, contentType } = (req.body || {}) as { fileName?: string; contentType?: string };
    const name = fileName || `photo-${Date.now()}.jpg`;
    const ct = contentType || "image/jpeg";
    const key = `properties/${propertyId}/${Date.now()}-${name}`;
    const uploadUrl = await getUploadUrl(key, ct, 300, "property-photos");
    return { uploadUrl, key, contentType: ct };
  });
  app.post("/properties/:id/photos/confirm", req_clientsContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const propertyId = String(req.params.id);
    const { key, fileName, contentType, description } = (req.body || {}) as {
      key: string; fileName?: string; contentType?: string; description?: string;
    };
    if (!key) throw app.httpErrors.badRequest("key is required");
    const count = await prisma.propertyPhoto.count({ where: { propertyId } });
    if (count >= 20) throw app.httpErrors.badRequest("Maximum 20 photos per property");
    return prisma.$transaction(async (tx) => {
      const photo = await tx.propertyPhoto.create({
        data: {
          propertyId,
          r2Key: key,
          fileName: fileName ?? null,
          contentType: contentType ?? null,
          description: description?.trim() || null,
          sortOrder: count,
          uploadedById: uid,
        },
      });
      // Records a new photo joining the property gallery workers see on site.
      await writeAudit(tx, AUDIT.PROPERTY.UPDATED, uid, {
        propertyId,
        photoId: photo.id,
        action: "photo_added",
        fileName: photo.fileName,
        r2Key: photo.r2Key,
      });
      return photo;
    });
  });
  app.patch("/properties/:id/photos/:photoId", req_clientsContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const propertyId = String(req.params.id);
    const photoId = String(req.params.photoId);
    const body = req.body || {};
    const data: any = {};
    if ("description" in body) data.description = body.description?.trim() || null;
    if ("sortOrder" in body) data.sortOrder = Number(body.sortOrder);
    return prisma.$transaction(async (tx) => {
      const photo = await tx.propertyPhoto.update({ where: { id: photoId }, data });
      // Records a caption / ordering edit on a property photo.
      await writeAudit(tx, AUDIT.PROPERTY.UPDATED, uid, {
        propertyId,
        photoId,
        action: "photo_updated",
        changedFields: Object.keys(data),
        description: photo.description,
        sortOrder: photo.sortOrder,
      });
      return photo;
    });
  });
  app.delete("/properties/:id/photos/:photoId", req_clientsContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.photoId);
    const photo = await prisma.propertyPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");
    await deleteObject(photo.r2Key, "property-photos");
    await prisma.$transaction(async (tx) => {
      await tx.propertyPhoto.delete({ where: { id: photoId } });
      // Destructive: the row + the R2 object are both gone, so this snapshot
      // is the only surviving record of the photo.
      await writeAudit(tx, AUDIT.PROPERTY.UPDATED, uid, {
        propertyId: photo.propertyId,
        photoId: photo.id,
        action: "photo_deleted",
        fileName: photo.fileName,
        contentType: photo.contentType,
        description: photo.description,
        sortOrder: photo.sortOrder,
        r2Key: photo.r2Key,
        uploadedById: photo.uploadedById,
      });
    });
    return { deleted: true };
  });
  /**
   * The id to scope a customer LIST to, or undefined for the whole book.
   *
   * Mirrors what ClientsTab and PropertiesTab were doing in the browser:
   * somebody who cannot manage clients and is not field-cleared sees the
   * customers behind the visits they are on. Both tabs asked exactly this
   * (`!canManageClients && !isFieldCleared(me)`), fetched everything, and
   * filtered locally — so the rows were withheld from the screen but not
   * from the response. Same predicate, enforced where it withholds data.
   *
   * `work.claim` is field clearance (see web `isFieldCleared`), and
   * `clients.manage` is the office path that never had the restriction.
   */
  async function assignedScopeFor(req: any): Promise<string | undefined> {
    // THREE WAYS TO SEE THE WHOLE BOOK, and they are three different
    // people: you edit it (`clients.manage`), you work it (`work.claim`),
    // or you watch it and do neither (`clients.view-all`). The third was
    // missing, so a read-only oversight role — a bookkeeper, an owner's
    // partner — was scoped to "the customers you are assigned to", which
    // for somebody who works no visits is none of them. The tab filters on
    // the same three; this is the half that matters, because without it
    // the rows never leave the server.
    if (
      callerCan(req, "clients.manage") ||
      callerCan(req, "work.claim") ||
      callerCan(req, "clients.view-all")
    ) {
      return undefined;
    }
    return currentUserId(req);
  }

  // ONE ROUTE. `clients.view` rather than `approvedUser`, which is also a fix:
  // the worker twin let ANY approved account list every customer, and a
  // signed-in client holds no entitlement at all, so they could read it too.
  // `internalTags` are trimmed for anyone without `clients.manage`, which is
  // exactly who the deleted `/clients` route served.
  app.get("/clients", req_clientsView, async (req: any) => {
    const { q, status, limit } = (req.query || {}) as {
      q?: string;
      status?: "ACTIVE" | "ARCHIVED" | "ALL";
      limit?: string;
    };
    const list = await services.clients.list({
      q,
      status: status as any,
      limit: limit ? Number(limit) : undefined,
      portfolioWhere: portfolioWhere(req.principal, "clients.view"),
      assignedToUserId: await assignedScopeFor(req),
    });
    if (!callerCan(req, "clients.manage")) {
      for (const c of list) (c as any).internalTags = undefined;
    }
    return list;
  });
  app.get("/clients/:id", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const client = await services.clients.get(String(req.params.id));
    if (client && !callerCan(req, "clients.manage")) {
      (client as any).internalTags = undefined;
    }
    return client;
  });
  // ── MAP POINTS ──────────────────────────────────────────────────────────
  //
  // Two endpoints, deliberately split: a READ that is always fast, and a
  // RESOLVE that is slow and incremental.
  //
  // WHY NOT ONE CALL THAT JUST GEOCODES EVERYTHING. The Census geocoder
  // takes ~3.5 SECONDS per address (measured, not assumed). Production has
  // 51 properties without a point; doing them in one request is ~44s even
  // at four-way concurrency, which exceeds the serverless budget and would
  // return nothing at all. So the map opens instantly on whatever is
  // already known, then asks for small batches until it is done.
  //
  // EVERY POINT IS PERSISTED AS IT IS FOUND, so this is a one-time cost per
  // property, ever — close the page halfway and the rest resolve next time
  // with nothing repeated. That is also why no cron and no backfill script
  // are needed: the data fills in as the feature is used.
  app.get("/properties/points", req_clientsView, async (req: any) => {
    const { portfolioId } = (req.query || {}) as { portfolioId?: string };

    let portfolioSubtreePath: string | "none" | undefined;
    if (portfolioId === "none") portfolioSubtreePath = "none";
    else if (portfolioId) {
      const picked = await prisma.portfolio.findUnique({ where: { id: String(portfolioId) }, select: { path: true } });
      portfolioSubtreePath = picked?.path ?? "\u0000no-such-portfolio";
    }

    return services.properties.mapPoints({
      portfolioWhere: portfolioWhere(req.principal, "clients.view"),
      portfolioSubtreePath,
      assignedToUserId: await assignedScopeFor(req),
      portfolioId: portfolioId && portfolioId !== "none" ? String(portfolioId) : undefined,
    });
  });

  /**
   * Geocode the next few properties that have no point yet.
   *
   * `limit` is small on purpose — each address costs seconds, and a caller
   * that asks for forty gets a timeout instead of an answer. The browser
   * calls this repeatedly and watches `remaining` go to zero.
   */
  app.post("/properties/points/resolve", req_clientsView, async (req: any) => {
    const b = (req.body || {}) as { portfolioId?: string; limit?: number };

    let portfolioSubtreePath: string | "none" | undefined;
    if (b.portfolioId === "none") portfolioSubtreePath = "none";
    else if (b.portfolioId) {
      const picked = await prisma.portfolio.findUnique({ where: { id: String(b.portfolioId) }, select: { path: true } });
      portfolioSubtreePath = picked?.path ?? "\u0000no-such-portfolio";
    }

    return services.properties.resolveMapPoints({
      portfolioWhere: portfolioWhere(req.principal, "clients.view"),
      portfolioSubtreePath,
      assignedToUserId: await assignedScopeFor(req),
      limit: Math.min(Math.max(Number(b.limit) || 5, 1), 10),
    });
  });

  app.get("/properties", req_clientsView, async (req: any) => {
    const { q, clientId, status, kind, limit, portfolioId } = (req.query || {}) as {
      q?: string;
      clientId?: string;
      status?: "ACTIVE" | "ARCHIVED" | "ALL";
      kind?: string | "ALL";
      limit?: string;
      portfolioId?: string;
    };

    // "Show me this portfolio's properties." Resolved to a PATH here so the
    // SUBTREE comes with it — picking a district includes its routes, and
    // the list then agrees with the count beside it on the Portfolios tab.
    //
    // An unknown id narrows to nothing rather than being ignored, which
    // would silently answer with every property instead. `none` asks for
    // the properties in NO portfolio — the one question the portfolio tree cannot
    // answer about itself, and the one worth asking, because an untagged
    // property is invisible to every portfolio-scoped reader.
    //
    // A VIEW filter, never a permission: the service ANDs it with the
    // caller's own `portfolioWhere`, so it can only ever subtract.
    let portfolioSubtreePath: string | "none" | undefined;
    if (portfolioId === "none") {
      portfolioSubtreePath = "none";
    } else if (portfolioId) {
      const picked = await prisma.portfolio.findUnique({
        where: { id: String(portfolioId) },
        select: { path: true },
      });
      portfolioSubtreePath = picked?.path ?? "\u0000no-such-portfolio";
    }
    const props = await services.properties.list({
      q,
      clientId,
      status: status as any,
      kind: (kind as any) ?? "ALL",
      limit: limit ? Number(limit) : undefined,
      // Territory is resolved HERE because only the route has the principal.
      portfolioWhere: portfolioWhere(req.principal, "clients.view"),
      portfolioSubtreePath,
      assignedToUserId: await assignedScopeFor(req),
    });
    // Attach last 3 photos from most recent occurrence for each property
    const propIds = (Array.isArray(props) ? props : []).map((p: any) => p.id);
    if (propIds.length > 0) {
      const photos = await prisma.jobOccurrencePhoto.findMany({
        where: {
          occurrence: { job: { propertyId: { in: propIds } } },
        },
        select: {
          id: true, r2Key: true, contentType: true, createdAt: true,
          occurrence: { select: { job: { select: { propertyId: true } } } },
        },
        orderBy: { createdAt: "desc" },
      });
      // Group by property, take last 3 per property. Reminders + tasks
      // can have a null `job` (no parent property), so skip those —
      // they aren't relevant to property-level photo grouping.
      const byProperty = new Map<string, any[]>();
      for (const p of photos) {
        const pid = p.occurrence.job?.propertyId;
        if (!pid) continue;
        if (!byProperty.has(pid)) byProperty.set(pid, []);
        const arr = byProperty.get(pid)!;
        if (arr.length < 3) arr.push(p);
      }
      // Generate URLs and attach
      for (const prop of (Array.isArray(props) ? props : []) as any[]) {
        const propPhotos = byProperty.get(prop.id) ?? [];
        prop.lastPhotos = await Promise.all(
          propPhotos.map(async (p: any) => ({
            id: p.id,
            url: await getDownloadUrl(p.r2Key),
            contentType: p.contentType,
          }))
        );
      }
    }
    return props;
  });
  app.get("/properties/:id", req_clientsView, async (req: any) => {
    // portfolio-scope-allow: a by-id read, not discovery. Lists narrow
    //   territorially; reaching a specific record does not, because
    //   `work.claim` and `work.complete` are deliberately never portfolio-scoped
    //   so people can cover another district — and a worker covering a visit
    //   needs the record behind it. You also cannot reach this without
    //   already holding the id, and every list that hands out ids IS
    //   filtered.
    const id = String(req.params.id);
    return services.properties.get(id);
  });
  // ── Property Photos (worker read) ──
  app.get("/properties/:id/photos", req_clientsContribute, async (req: any) => {
    const propertyId = String(req.params.id);
    const photos = await prisma.propertyPhoto.findMany({
      where: { propertyId },
      orderBy: { sortOrder: "asc" },
    });
    const withUrls = await Promise.all(
      // Both twins required `clients.contribute`, and one of them returned
      // `...p` — so the URL alone decided whether the storage key leaked.
      photos.map(async (p) => ({
        ...(callerCan(req, "clients.manage")
          ? p
          : {
              id: p.id,
              fileName: p.fileName,
              description: p.description,
              sortOrder: p.sortOrder,
            }),
        url: await getDownloadUrl(p.r2Key, 86400, "property-photos"),
      }))
    );
    return withUrls;
  });
}
