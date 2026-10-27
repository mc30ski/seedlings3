import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import * as displays from "../services/displays";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereVia, withArea } from "../lib/areaScope";
import { WORKER_TYPES, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate } from "./_shared";

export default async function displayRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_displaysManage = requires("displays.manage");
  const req_scheduleContribute = requires("schedule.contribute");

  // List photos across all jobs with optional date range
  //
  // NARROWS ITS RESULTS, AND DELIBERATELY DOES NOT REFUSE. A holder of
  // `schedule.contribute` is allowed here and gets a 200 — with fewer rows.
  // So this route carries no scoping annotation: that marker asserts the
  // route 403s a bare holder, and authz-matrix verifies the claim, so
  // putting it on a list that merely returns less is reported as a stale
  // annotation. Scoping a list and refusing a request are different claims
  // and the suite is right to tell them apart. (Nor can the marker be
  // NAMED in prose here — the parser reads these comments literally and
  // matched it inside the sentence explaining its absence.)
  //
  // WHY, AND WHAT IT LOOKED LIKE. This had ONLY the area filter below, and
  // `areaWhereVia` returns no filter at all for a caller with no area grant
  // — which is everybody, because no AreaAssignment rows exist yet. So the
  // guard, `schedule.contribute` ("add notes, photos and guidance to a
  // visit"), was handing back 200 photos from every property in the book,
  // each with the customer's name and street address, to the base rung.
  // A trainee opening Share Photos saw exactly what the owner saw, while
  // their own on-screen notice promised "you only see the jobs, clients and
  // properties you are assigned to".
  //
  // The guard is NOT the thing that was wrong: contributing to the visits
  // you are on is a reasonable thing for the base rung to do. What was
  // missing is the scoping that makes the sentence true. Same rule as the
  // delete below — yours, or you hold `schedule.manage` — so the two cannot
  // drift apart.
  app.get("/photos", req_scheduleContribute, async (req: any) => {
    const { from, to } = (req.query || {}) as { from?: string; to?: string };

    // OUTWARD-FACING, so the opt-out applies. `hiddenFromPublicAt` means
    // "do not put this in front of other people" — the sprinkler-head
    // close-up, the one with a plate in frame — and this wall feeds a post
    // to Instagram, which is the furthest out a photo can go. It was not
    // filtering on the flag, so a photo pulled down from the lobby screen
    // was still offered for publication. photo-visibility-build-gate covers
    // the feed, the wall and the private board; this route predated it and
    // is now in that gate too.
    const where: any = { hiddenFromPublicAt: null };
    if (from || to) {
      where.occurrence = { startAt: {} };
      if (from) where.occurrence.startAt.gte = etMidnight(from as EtDateKey);
      if (to) where.occurrence.startAt.lte = etEndOfDay(to as EtDateKey);
    }

    if (!callerCan(req, "schedule.manage")) {
      const uid = await currentUserId(req);
      // MERGED, not assigned: the date filter above may already own
      // `where.occurrence`, and overwriting it would silently widen the
      // window back to all time while looking like a narrowing.
      where.OR = [
        { occurrence: { ...(where.occurrence ?? {}), assignees: { some: { userId: uid } } } },
        { uploadedById: uid },
      ];
    }

    // The cross-job photo wall is a LIST, so it narrows to the territories
    // this caller may see — the photos hang off occurrences, which carry the
    // area.
    Object.assign(where, withArea(where, areaWhereVia(req.principal, "schedule.contribute", "occurrence")));
    const photos = await prisma.jobOccurrencePhoto.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        uploadedBy: { select: { id: true, displayName: true } },
        occurrence: {
          select: {
            id: true,
            startAt: true,
            status: true,
            jobType: true,
            job: {
              select: {
                id: true,
                kind: true,
                property: {
                  select: { id: true, displayName: true, street1: true, city: true, state: true },
                },
              },
            },
          },
        },
      },
    });

    return Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        fileName: p.fileName,
        contentType: p.contentType,
        uploadedBy: p.uploadedBy,
        createdAt: p.createdAt,
        url: await getDownloadUrl(p.r2Key),
        occurrence: {
          id: p.occurrence.id,
          startAt: p.occurrence.startAt,
          status: p.occurrence.status,
          jobType: p.occurrence.jobType,
          property: p.occurrence.job?.property
            ? {
                displayName: p.occurrence.job.property.displayName,
                address: [p.occurrence.job.property.street1, p.occurrence.job.property.city, p.occurrence.job.property.state].filter(Boolean).join(", "),
              }
            : null,
        },
      }))
    );
  });
  app.delete("/photos/:id", req_scheduleContribute, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.id);

    const photo = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw app.httpErrors.notFound("Photo not found");

    // YOUR OWN PHOTO, OR THE AUTHORITY TO MODERATE SOMEBODY ELSE'S.
    //
    // This is the CROSS-JOB gallery delete, and it had neither check — only
    // `schedule.contribute`, which the baseline Trainee role holds and every
    // other role inherits. So the least-privileged account in the system
    // could hard-delete any worker's proof-of-work photo company-wide, plus
    // the R2 object, leaving the audit row as the only trace.
    //
    // Its per-occurrence sibling (`DELETE /occurrences/:id/photos/:photoId`)
    // has always enforced "you can only delete your own photos" on the SAME
    // guard. One of the two was wrong; it was this one. Adding
    // `schedule.manage` keeps the pairing moderation path working — and note
    // that HIDING a photo (`POST /photos/:photoId/visibility`) already
    // required `displays.manage`, so deleting one forever was the cheaper
    // action of the two.
    if (photo.uploadedById !== uid && !callerCan(req, "schedule.manage")) {
      throw app.httpErrors.forbidden(
        "You can only delete your own photos.",
      );
    }

    await deleteObject(photo.r2Key);
    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrencePhoto.delete({ where: { id: photoId } });
      // Destructive: somebody removed a worker's proof-of-work photo and the
      // R2 object with it. This snapshot is the only surviving evidence.
      await writeAudit(tx, AUDIT.JOB.PHOTO_DELETED, uid, {
        photoId: photo.id,
        occurrenceId: photo.occurrenceId,
        action: "occurrence_photo_deleted",
        fileName: photo.fileName,
        contentType: photo.contentType,
        r2Key: photo.r2Key,
        uploadedById: photo.uploadedById,
        uploadedAt: photo.createdAt.toISOString(),
      });
    });

    return { ok: true };
  });
  app.get("/displays", req_displaysManage, async () => {
    // Sweep dead rows here too. Purging only when a NEW pairing starts meant
    // expired requests sat in the table indefinitely on a quiet week — hidden
    // from this list by the expiry filter, but still there.
    await displays.purgeDeadPairings().catch(() => {});
    const [paired, pending] = await Promise.all([
      prisma.display.findMany({
        where: { revokedAt: null },
        orderBy: { pairedAt: "desc" },
        include: { pairedBy: { select: { id: true, displayName: true } } },
      }),
      prisma.displayPairing.findMany({
        where: { approvedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const now = Date.now();
    return {
      displays: paired.map((d) => {
        const seen = d.lastSeenAt ? now - d.lastSeenAt.getTime() : null;
        // How long this screen has been silent. A screen polls every 45
        // seconds, so this separates "unplugged over the weekend" from "that
        // device was wiped and re-paired as a new row weeks ago" — which look
        // identical in the list otherwise.
        // date-handling-allow: elapsed-time — real time since the last poll, not a calendar day count. A screen quiet since 11pm last night has been quiet an hour, not a day, so etDaysBetween would answer a different question.
        const quietDays = Math.floor((seen ?? now - d.pairedAt.getTime()) / 86_400_000);
        return {
          id: d.id,
          name: d.name,
          mode: d.mode,
          farViewing: d.farViewing,
          pairedAt: d.pairedAt.toISOString(),
          pairedBy: d.pairedBy?.displayName ?? null,
          lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
          lastSeenIp: d.lastSeenIp,
          quietDays,
          // Derived rather than stored, so it can never go stale itself.
          liveness:
            seen == null ? "never" : seen < LIVE_WINDOW_MS ? "live" : seen < OFFLINE_WINDOW_MS ? "stale" : "offline",
        };
      }),
      // THE CODE IS DELIBERATELY NOT HERE.
      //
      // Typing the digits off the screen is the step that ties an approval to
      // the screen the operator is actually looking at. Shipping them in this
      // payload made that a formality — the panel never rendered them, but
      // anyone with the network tab could approve a request coming from a
      // browser they had never seen.
      pending: pending.map((p) => ({
        id: p.id,
        requestedIp: p.requestedIp,
        requestedUserAgent: p.requestedUserAgent,
        expiresAt: p.expiresAt.toISOString(),
      })),
    };
  });
  app.post("/displays/approve", req_displaysManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    const code = String(b.code ?? "").replace(/\D/g, "");
    // Required, not defaulted. Silently naming three screens "Display" makes
    // the management list unusable — and revoking the wrong one is the kind of
    // mistake that takes the shop board down mid-morning.
    const name = String(b.name ?? "").trim();
    const mode = b.mode === "PRIVATE" ? "PRIVATE" : "PUBLIC";
    const farViewing = b.farViewing !== false;

    if (code.length !== 6) throw app.httpErrors.badRequest("A six-digit code is required.");
    if (!name) throw app.httpErrors.badRequest("Give the screen a name — you will be picking it out of a list later.");

    // RE-PAIRING AN EXISTING SCREEN. When a device loses its browser storage —
    // wiped profile, replaced stick, factory reset — it comes back asking to
    // pair as if it were new. Approving that leaves the old row behind: a
    // credential nobody holds, sitting in the list looking like a TV that is
    // merely switched off. Naming the screen it replaces revokes the old one
    // in the same transaction, so the ghost never exists.
    const replaceId = String(b.replaceDisplayId ?? "").trim() || null;
    let replacing: { id: string; name: string } | null = null;
    if (replaceId) {
      const old_ = await prisma.display.findUnique({ where: { id: replaceId } });
      if (!old_ || old_.revokedAt) throw app.httpErrors.notFound("That screen is not connected.");
      replacing = { id: old_.id, name: old_.name };
    }

    const pairing = await prisma.displayPairing.findUnique({ where: { code } });
    if (!pairing || pairing.expiresAt < new Date()) {
      throw app.httpErrors.notFound("That code has expired. Reload the display for a new one.");
    }
    if (pairing.approvedAt) {
      throw app.httpErrors.conflict("That code has already been used.");
    }

    const token = displays.newDisplayToken();

    const display = await prisma.$transaction(async (tx) => {
      const created = await tx.display.create({
        data: {
          name,
          mode,
          farViewing,
          tokenHash: displays.hashSecret(token),
          pairedById: uid,
        },
      });
      // audit-allow: marks the pairing consumed inside the SAME transaction
      // as the DISPLAY.APPROVED row below, which already records who approved
      // what, from which address, into which mode.
      await tx.displayPairing.update({
        where: { id: pairing.id },
        data: { approvedAt: new Date(), approvedById: uid, displayId: created.id, issuedToken: token },
      });
      if (replacing) {
        // audit-allow: the replaced screen's revocation is recorded by the
        // DISPLAY.APPROVED row below, which carries replacedDisplayId and
        // name. One event, both halves — a separate revoke row would read as
        // an unexplained disconnect next to an unexplained pairing.
        await tx.display.update({
          where: { id: replacing.id },
          data: { revokedAt: new Date(), revokedById: uid },
        });
      }
      await writeAudit(tx, AUDIT.DISPLAY.APPROVED, uid, {
        displayId: created.id,
        name,
        mode,
        code,
        requestedIp: pairing.requestedIp,
        requestedUserAgent: pairing.requestedUserAgent,
        // Both sides of a replacement land in one row, so the trail reads as
        // "this screen took over from that one" rather than as an unexplained
        // revoke next to an unexplained pairing.
        replacedDisplayId: replacing?.id ?? null,
        replacedDisplayName: replacing?.name ?? null,
      });
      return created;
    });

    return { id: display.id, name: display.name, mode: display.mode };
  });
  app.patch("/displays/:id", req_displaysManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const b = req.body || {};
    const before = await prisma.display.findUnique({ where: { id } });
    if (!before || before.revokedAt) throw app.httpErrors.notFound("Display not found.");

    const data: any = {};
    if (typeof b.name === "string" && b.name.trim()) data.name = b.name.trim();
    if (b.mode === "PUBLIC" || b.mode === "PRIVATE") data.mode = b.mode;
    if (typeof b.farViewing === "boolean") data.farViewing = b.farViewing;
    if (Object.keys(data).length === 0) return { ok: true };

    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.display.update({ where: { id }, data });
      await writeAudit(tx, AUDIT.DISPLAY.UPDATED, uid, {
        displayId: id,
        nameBefore: before.name,
        nameAfter: updated.name,
        // The one that matters. Moving a screen from PUBLIC to PRIVATE widens
        // what a device in a room full of strangers can read.
        modeBefore: before.mode,
        modeAfter: updated.mode,
        farViewingBefore: before.farViewing,
        farViewingAfter: updated.farViewing,
      });
      return updated;
    });
    return { id: after.id, name: after.name, mode: after.mode, farViewing: after.farViewing };
  });
  app.post("/displays/:id/revoke", req_displaysManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const before = await prisma.display.findUnique({ where: { id } });
    if (!before || before.revokedAt) throw app.httpErrors.notFound("Display not found.");

    await prisma.$transaction(async (tx) => {
      await tx.display.update({ where: { id }, data: { revokedAt: new Date(), revokedById: uid } });
      await writeAudit(tx, AUDIT.DISPLAY.DELETED, uid, {
        displayId: id,
        name: before.name,
        mode: before.mode,
        lastSeenAt: before.lastSeenAt,
      });
    });
    return { ok: true };
  });
  app.post("/photos/:photoId/visibility", req_displaysManage, async (req: any) => {
    const uid = await currentUserId(req);
    const photoId = String(req.params.photoId);
    const hidden = (req.body || {}).hidden !== false;
    const before = await prisma.jobOccurrencePhoto.findUnique({ where: { id: photoId } });
    if (!before) throw app.httpErrors.notFound("Photo not found.");

    await prisma.$transaction(async (tx) => {
      await tx.jobOccurrencePhoto.update({
        where: { id: photoId },
        data: {
          hiddenFromPublicAt: hidden ? new Date() : null,
          hiddenById: hidden ? uid : null,
        },
      });
      await writeAudit(tx, AUDIT.DISPLAY.UPDATED, uid, {
        photoId,
        occurrenceId: before.occurrenceId,
        hidden,
        surface: "public_photo_visibility",
      });
    });
    return { ok: true, hidden };
  });
}
