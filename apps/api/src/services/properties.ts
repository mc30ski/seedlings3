import { Prisma, PropertyStatus, PropertyKind, JobStatus } from "@prisma/client";
import { withPortfolio } from "../lib/portfolioScope";
import { prisma } from "../db/prisma";
import { resolvePropertyPoint } from "./parcels";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { randomBytes } from "crypto";
import {
  clearScheduledVisitsInTx,
  rebuildRecurringChainInTx,
} from "./jobs";
import type {
  ServicesProperties,
  PropertyUpsert,
  PropertyListItemParams,
} from "../types/services";

type Tx = Prisma.TransactionClient;

function like(text?: string) {
  return text?.trim()
    ? { contains: text.trim(), mode: "insensitive" as const }
    : undefined;
}

/**
 * The rows a caller may see on the map: their granted territory, the portfolio
 * they asked for, and the assignment narrowing for somebody who is not
 * field-cleared. Identical to what `list()` applies, lifted out so the map
 * cannot drift into showing a property the list would withhold.
 */
function mapScopeWhere(params: {
  portfolioWhere?: Record<string, unknown>;
  portfolioSubtreePath?: string | "none";
  assignedToUserId?: string;
}): Prisma.PropertyWhereInput {
  const chosen: Prisma.PropertyWhereInput | null =
    params.portfolioSubtreePath === "none"
      ? { portfolios: { none: {} } }
      : params.portfolioSubtreePath
        ? { portfolios: { some: { portfolio: { path: { startsWith: params.portfolioSubtreePath } } } } }
        : null;
  const assigned: Prisma.PropertyWhereInput | null = params.assignedToUserId
    ? { jobs: { some: { occurrences: { some: { assignees: { some: { userId: params.assignedToUserId } } } } } } }
    : null;
  return {
    AND: [
      (params.portfolioWhere ?? {}) as Prisma.PropertyWhereInput,
      ...(chosen ? [chosen] : []),
      ...(assigned ? [assigned] : []),
    ],
  };
}

export const properties: ServicesProperties = {
  /**
   * The properties in a portfolio, as map pins.
   *
   * A pure read — never geocodes. The map opens on this instantly, however
   * many points happen to be known, and `unplaced` tells the page how much
   * is still to come so it can show "12/51 located" rather than a spinner
   * with no end in sight.
   */
  async mapPoints(params: {
    portfolioWhere?: Record<string, unknown>;
    portfolioSubtreePath?: string | "none";
    assignedToUserId?: string;
    /** The portfolio being looked at, so its own point can be returned with the
     *  pins. That point is not decoration: it is what the portfolio's weather
     *  forecast is anchored on, and seeing it against the properties is
     *  the only way to notice it is in the wrong place. */
    portfolioId?: string;
  }) {
    const where = mapScopeWhere(params);
    const rows = await prisma.property.findMany({
      where,
      select: {
        id: true, displayName: true, street1: true, city: true,
        lat: true, lng: true, parcelLookupError: true,
        portfolios: { select: { portfolio: { select: { id: true, name: true } } } },
        client: { select: { displayName: true } },
      },
      orderBy: { displayName: "asc" },
    });
    const portfolio =
      params.portfolioId && params.portfolioId !== "none"
        ? await prisma.portfolio.findUnique({
            where: { id: params.portfolioId },
            select: { id: true, name: true, lat: true, lng: true },
          })
        : null;

    return {
      /** The PORTFOLIO's own point, or null if nobody has set one. Distinct
       *  from the property pins and labelled as such on the map. */
      portfolioCentre: portfolio && portfolio.lat != null && portfolio.lng != null
        ? { id: portfolio.id, name: portfolio.name, lat: portfolio.lat, lng: portfolio.lng }
        : null,
      points: rows,
      total: rows.length,
      placed: rows.filter((r) => r.lat != null && r.lng != null).length,
      /** Still to geocode. Excludes ones already known to be unplaceable —
       *  those are reported separately so the counter can reach its target
       *  instead of stalling one short forever. */
      pending: rows.filter((r) => r.lat == null && !r.parcelLookupError).length,
      unplaceable: rows.filter((r) => r.lat == null && !!r.parcelLookupError).length,
    };
  },

  /**
   * Geocode the next few unplaced properties in a portfolio.
   *
   * SMALL BATCHES, called repeatedly. One address costs about three and a
   * half seconds against the free Census geocoder, so a request that tried
   * to do fifty would time out and deliver nothing; a request that does
   * five returns in a few seconds and the page asks again.
   *
   * A failure is RECORDED, not retried forever: an address the geocoder
   * cannot place gets `parcelLookupError`, which both this and the parcel
   * lookup skip. Without it the last few would be re-attempted on every
   * open of the map, for ever, at three seconds each.
   */
  async resolveMapPoints(params: {
    portfolioWhere?: Record<string, unknown>;
    portfolioSubtreePath?: string | "none";
    assignedToUserId?: string;
    limit: number;
  }) {
    const where = mapScopeWhere(params);
    const todo = await prisma.property.findMany({
      where: { AND: [where, { lat: null }, { parcelLookupError: null }] },
      select: { id: true },
      orderBy: { displayName: "asc" },
      take: params.limit,
    });

    const resolved: Array<{ id: string; lat: number; lng: number }> = [];
    const failed: string[] = [];
    // Sequential. The geocoder is a free public service and this is a
    // background trickle, not a race — hammering it four-wide to shave
    // seconds off a one-time fill is not a trade worth making.
    for (const t of todo) {
      const point = await resolvePropertyPoint(t.id, { persist: true });
      if (point) {
        resolved.push({ id: t.id, lat: point.lat, lng: point.lng });
      } else {
        failed.push(t.id);
        // Caches that a PUBLIC address could not be placed, so it is not
        // retried on every open at three seconds a go. No business state
        // changes and nothing operator-entered is overwritten.
        // audit-allow: derived geocoding cache, not an operator action.
        await prisma.property.update({
          where: { id: t.id },
          data: { parcelLookupError: "Could not geocode this address." },
        }).catch(() => {});
      }
    }

    const remaining = await prisma.property.count({
      where: { AND: [where, { lat: null }, { parcelLookupError: null }] },
    });
    return { resolved, failed, remaining };
  },

  async list(params: PropertyListItemParams) {
    const q = (params?.q ?? "").trim();
    const limit = Math.min(Math.max(params?.limit ?? 100, 1), 500);

    const where: Prisma.PropertyWhereInput = {};
    if (params?.clientId) where.clientId = params.clientId;

    // status / kind filters (like clients list)
    if (params?.status && params.status !== "ALL") where.status = params.status;
    if (params?.kind && params.kind !== "ALL") where.kind = params.kind;

    if (q) {
      where.OR = [
        { displayName: like(q) },
        { street1: like(q) },
        { city: like(q) },
        { state: like(q) },
        { postalCode: like(q) },
      ];
    }

    // ASSIGNMENT, VIA JOBS. Reaches the property through the work on it:
    // property -> job -> occurrence -> assignee. PropertiesTab drew this
    // exact set by filtering a full fetch client-side, which left every
    // address in the network response of somebody who may see four of them.
    if (params?.assignedToUserId) {
      where.jobs = {
        some: {
          occurrences: {
            some: { assignees: { some: { userId: params.assignedToUserId } } },
          },
        },
      };
    }

    // The CHOSEN portfolio, layered on top of the territory the caller may see.
    // Two separate fragments on purpose: `portfolioWhere` is what they are
    // allowed to see and `portfolioSubtreePath` is what they asked to look at,
    // and ANDing them means the request can only ever narrow.
    const chosen: Prisma.PropertyWhereInput | null =
      params?.portfolioSubtreePath === "none"
        ? { portfolios: { none: {} } }
        : params?.portfolioSubtreePath
          ? { portfolios: { some: { portfolio: { path: { startsWith: params.portfolioSubtreePath } } } } }
          : null;

    const rows = await prisma.property.findMany({
      // Territory. Membership is a join now, so this hops through it —
      // `portfolioWhere` emits the `some` for us.
      where: withPortfolio(withPortfolio(where, params?.portfolioWhere ?? {}), chosen ?? {}),
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        // THE PORTFOLIOS, for the badges on the property card. Names only —
        // the card states what the property belongs to; it does not filter.
        // Plural now: a property can be in a location portfolio and a route
        // at the same time, and a card showing only one of them would be
        // the old single-column model leaking through the UI.
        portfolios: { select: { portfolio: { select: { id: true, name: true } } } },
        client: { select: { id: true, displayName: true, isVip: true, vipReason: true } },
        pointOfContact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    return rows.map((p) => ({
      ...p,
    }));
  },

  async get(id: string) {
    return prisma.property.findUniqueOrThrow({
      where: { id },
      include: {
        client: { select: { id: true, displayName: true } },
        pointOfContact: true,
        // SAME SHAPE AS THE LIST. The property dialog seeds its portfolio
        // picker from whichever of the two it was handed; leaving it off
        // here would make the picker open empty for a property that is in
        // several, and saving would then clear them.
        portfolios: { select: { portfolio: { select: { id: true, name: true } } } },
      },
    });
  },

  async create(currentUserId: string, payload: PropertyUpsert) {
    return prisma.$transaction(async (tx) => {
      // WHICH PORTFOLIOS DOES A NEW PROPERTY BELONG TO?
      //
      // Nothing used to answer this at all: the old `areaId` was never set
      // on create, so every new property landed nowhere and its work
      // appeared in no rollup. That stayed invisible only because the seed
      // had backfilled every existing row and nobody held a scoped grant.
      //
      // Take what the caller said, else INHERIT, else leave it in nothing
      // honestly rather than guess. Inheritance is the client's other
      // properties, and only when they AGREE — a client split across two
      // portfolios has no obvious answer and picking one invents data.
      // "Agree" is now set equality, because a sibling can be in several.
      let portfolioIds: string[] = payload.portfolioIds ?? [];
      if (portfolioIds.length === 0) {
        const siblings = await tx.property.findMany({
          where: { clientId: payload.clientId },
          select: { portfolios: { select: { portfolioId: true } } },
        });
        const sets = siblings
          .map((x) => x.portfolios.map((m) => m.portfolioId).sort())
          .filter((ids) => ids.length > 0);
        const distinct = new Set(sets.map((ids) => ids.join("\u0000")));
        if (distinct.size === 1) portfolioIds = sets[0];
      }

      const created = await tx.property.create({
        data: {
          portfolios: { create: portfolioIds.map((portfolioId) => ({ portfolioId })) },
          clientId: payload.clientId,
          displayName: payload.displayName,
          kind: payload.kind ?? PropertyKind.SINGLE,
          status: payload.status ?? PropertyStatus.ACTIVE,
          street1: payload.street1 ?? null,
          street2: payload.street2 ?? null,
          city: payload.city ?? null,
          state: payload.state ?? null,
          postalCode: payload.postalCode ?? null,
          country: payload.country ?? null,
          accessNotes: payload.accessNotes ?? null,
          lotSize: payload.lotSize != null ? Number(payload.lotSize) : null,
          lotSizeUnit: payload.lotSizeUnit ?? null,
          pointOfContactId: payload.pointOfContactId ?? null,
        },
      });

      await writeAudit(tx, AUDIT.PROPERTY.CREATED, currentUserId, {
        propertyId: created.id,
        // Recorded either way. Belonging to none is a legal state with a real
        // consequence (no rollup counts this property's work), so it
        // belongs in the trail rather than being inferable only by noticing
        // an absence later.
        portfolioIds,
        portfoliosResolvedBy: payload.portfolioIds?.length
          ? "caller"
          : portfolioIds.length
            ? "inherited-from-client"
            : "none",
        clientId: created.clientId,
        displayName: created.displayName,
      });

      return created;
    });
  },

  async update(currentUserId: string, id: string, payload: PropertyUpsert) {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.property.update({
        where: { id },
        data: {
          clientId: payload.clientId, // allow move between clients in MVP if you want; otherwise omit
          displayName: payload.displayName,
          kind: payload.kind,
          status: payload.status,
          street1: payload.street1,
          street2: payload.street2,
          city: payload.city,
          state: payload.state,
          postalCode: payload.postalCode,
          country: payload.country,
          accessNotes: payload.accessNotes,
          lotSize: "lotSize" in payload ? (payload.lotSize != null ? Number(payload.lotSize) : null) : undefined,
          lotSizeUnit: "lotSizeUnit" in payload ? (payload.lotSizeUnit ?? null) : undefined,
          pointOfContactId: payload.pointOfContactId ?? null,
        },
      });

      await writeAudit(tx, AUDIT.PROPERTY.UPDATED, currentUserId, {
        propertyId: id,
        clientId: updated.clientId,
        displayName: updated.displayName,
      });

      return updated;
    });
  },

  async archive(
    currentUserId: string,
    id: string,
    // Optional external cascadeGroupId — set when Client.archive fans
    // out to Properties so every row it touches shares a correlation
    // id. When called directly (Property archive button), we mint a
    // fresh one so the Jobs it cascades to are linked back to this
    // Property archive.
    opts?: { cascadeGroupId?: string; tx?: Prisma.TransactionClient },
  ) {
    const cascadeGroupId = opts?.cascadeGroupId ?? `cg_${randomBytes(9).toString("hex")}`;
    const run = async (tx: Prisma.TransactionClient) => {
      const property = await tx.property.findUnique({ where: { id } });
      if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);
      if (property.status === PropertyStatus.ARCHIVED) {
        // Idempotent — cascades pass over already-archived Properties.
        return { archived: true as const, jobsArchived: 0, cascadeGroupId };
      }
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ARCHIVED, archivedAt: new Date() },
      });
      // Cascade — archive every non-archived Job on this Property in
      // the same transaction. Idempotent per Job (skips already-
      // archived rows). Each row gets its own audit event tagged with
      // the shared cascadeGroupId.
      const jobs = await tx.job.findMany({
        where: { propertyId: id, status: { not: JobStatus.ARCHIVED } },
        select: { id: true },
      });
      let jobsArchived = 0;
      for (const j of jobs) {
        await tx.job.update({
          where: { id: j.id },
          data: { status: JobStatus.ARCHIVED },
        });
        // Archive side effects — delete future SCHEDULED STANDARD
        // occurrences (parity with pause) so no worker gets dispatched
        // to an archived property.
        await clearScheduledVisitsInTx(
          tx,
          currentUserId,
          j.id,
          { cascadeGroupId, triggeredBy: "property_archive", propertyId: id },
          "ARCHIVED_REMOVED_FUTURE_OCCURRENCES",
        );
        await writeAudit(tx, AUDIT.JOB.ARCHIVED, currentUserId, {
          jobId: j.id,
          cascadeGroupId,
          triggeredBy: "property_archive",
          propertyId: id,
        });
        jobsArchived++;
      }
      await writeAudit(tx, AUDIT.PROPERTY.ARCHIVED, currentUserId, {
        propertyId: id,
        cascadeGroupId,
        jobsArchived,
      });
      return { archived: true as const, jobsArchived, cascadeGroupId };
    };
    return opts?.tx ? run(opts.tx) : prisma.$transaction(run);
  },

  async unarchive(
    currentUserId: string,
    id: string,
    opts?: { cascadeGroupId?: string; tx?: Prisma.TransactionClient },
  ) {
    const cascadeGroupId = opts?.cascadeGroupId ?? `cg_${randomBytes(9).toString("hex")}`;
    const run = async (tx: Prisma.TransactionClient) => {
      const property = await tx.property.findUnique({ where: { id } });
      if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);
      if (property.status !== PropertyStatus.ARCHIVED) {
        return { unarchived: true as const, jobsUnarchived: 0, cascadeGroupId };
      }
      await tx.property.update({
        where: { id },
        data: { status: PropertyStatus.ACTIVE, archivedAt: null },
      });
      // Symmetric cascade — return any Jobs that were archived in this
      // cascade (or independently) back to ACCEPTED. Idempotent per Job.
      const jobs = await tx.job.findMany({
        where: { propertyId: id, status: JobStatus.ARCHIVED },
        select: { id: true },
      });
      let jobsUnarchived = 0;
      for (const j of jobs) {
        await tx.job.update({
          where: { id: j.id },
          data: { status: JobStatus.ACCEPTED },
        });
        // Unarchive side effects — rebuild recurring chain (one fresh
        // SCHEDULED occurrence) so the operator doesn't have to force
        // it manually. Parity with unpause.
        await rebuildRecurringChainInTx(
          tx,
          currentUserId,
          j.id,
          "UNARCHIVED_REGENERATED_NEXT_OCCURRENCE",
          { cascadeGroupId, triggeredBy: "property_unarchive", propertyId: id },
        );
        await writeAudit(tx, AUDIT.JOB.UNARCHIVED, currentUserId, {
          jobId: j.id,
          cascadeGroupId,
          triggeredBy: "property_unarchive",
          propertyId: id,
        });
        jobsUnarchived++;
      }
      await writeAudit(tx, AUDIT.PROPERTY.UNARCHIVED, currentUserId, {
        propertyId: id,
        cascadeGroupId,
        jobsUnarchived,
      });
      return { unarchived: true as const, jobsUnarchived, cascadeGroupId };
    };
    return opts?.tx ? run(opts.tx) : prisma.$transaction(run);
  },

  async hardDelete(currentUserId: string, id: string) {
    const jobCount = await prisma.job.count({ where: { propertyId: id } });
    if (jobCount > 0) {
      throw new ServiceError(
        "HAS_DEPENDENCIES",
        `Cannot delete this property because it has ${jobCount} associated ${jobCount === 1 ? "job" : "jobs"}. Please delete the ${jobCount === 1 ? "job" : "jobs"} first.`,
        409
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.property.delete({ where: { id } });
      await writeAudit(tx, AUDIT.PROPERTY.DELETED, currentUserId, {
        propertyId: id,
      });
    });
    return { deleted: true as const };
  },

  async setPrimaryContact(
    currentUserId: string,
    id: string,
    contactId: string | null
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id },
        data: { pointOfContactId: contactId },
      });
      await writeAudit(tx, AUDIT.PROPERTY.PRIMARY_CONTACT_SET, currentUserId, {
        propertyId: id,
        contactId,
      });
    });
    return { primarySet: true as const };
  },
};
