import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { can, flattenRole, isEntitlement, type Entitlement, type Principal } from "@repo/permissions";
import { assertMayGrant } from "./customRoles";

/**
 * AREAS — the territory tree, and who looks after which part of it.
 *
 * An area narrows WHAT YOU SEE, never what you may do. Someone promoted to
 * look after Raleigh must still be able to pick up a job in Durham, because
 * people cover for each other — so `work.claim` and `work.complete` are
 * never area-scoped (see NEVER_AREA_SCOPED in @repo/permissions).
 *
 * TWO WORDS, TWO MEANINGS. Roles SUSPEND; areas RETIRE. A retired area is
 * finished and not coming back: hidden from every picker, still present in
 * all reporting, because history has to resolve through a closed territory.
 * Areas are never DELETED — an occurrence completed in Raleigh stays
 * completed in Raleigh after you stop serving it.
 *
 * AREAS ARE NEVER REPARENTED (G14). Moving a subtree would rewrite the
 * materialized path of everything beneath it and silently change what every
 * historical area-scoped query returns. The supported move is
 * copy-and-retire: make the new area in the right place, retag forward, retire
 * the old one. Slower, and it keeps every past answer intact.
 *
 * `path` IS BUILT FROM IDS, not names (G21). Names are neither unique nor
 * stable — two areas may legitimately both be called "Raleigh", and a rename
 * would invalidate a slug path. Delimited AND terminated ("/a/b/"), because
 * without the trailing delimiter a prefix test matches a sibling whose id
 * merely starts with the same characters.
 */
export const areas = {
  /** The whole tree. Retired areas are included — callers filter for pickers. */
  async list() {
    const rows = await prisma.area.findMany({
      orderBy: [{ path: "asc" }],
      select: {
        id: true, name: true, tier: true, parentId: true, path: true, lat: true, lng: true,
        retiredAt: true,
        _count: { select: { properties: true, occurrences: true, assignments: true } },
      },
    });
    return rows.map((r) => ({
      ...r,
      /** Depth from the root, for rendering the tree without re-walking it. */
      depth: r.path.split("/").filter(Boolean).length - 1,
    }));
  },

  /**
   * Create an area under `parentId` (or at the root when null).
   *
   * The path is computed from the parent's, so it is correct by construction
   * rather than by the caller remembering the format.
   */
  async create(
    actorUserId: string,
    input: { name: string; tier?: string | null; parentId?: string | null },
  ) {
    const name = input.name.trim();
    if (!name) throw new ServiceError("BAD_REQUEST", "An area needs a name.", 400);

    return prisma.$transaction(async (tx) => {
      let parentPath = "/";
      if (!input.parentId) {
        // EXACTLY ONE ROOT, ALWAYS.
        //
        // Area scoping is a path-prefix match, so with one root "the whole
        // company" is one prefix. A second root makes two disjoint trees and
        // there is then NO prefix that means everywhere: a company-wide
        // grant would have to be two grants, and the lens's "All areas"
        // would mean "both trees", which no path expresses. The model would
        // quietly lose the ability to say the thing it most needs to say.
        //
        // Null parent is allowed only to BOOTSTRAP an empty tree, so a
        // database that somehow has no root can still get one.
        const existing = await tx.area.count();
        if (existing > 0) {
          throw new ServiceError(
            "AREA_NEEDS_A_PARENT",
            "Every area sits inside another one. Pick the area this belongs under.",
            400,
          );
        }
      }
      if (input.parentId) {
        const parent = await tx.area.findUnique({
          where: { id: input.parentId },
          select: { id: true, path: true, retiredAt: true },
        });
        if (!parent) throw new ServiceError("NOT_FOUND", "Parent area not found.", 404);
        if (parent.retiredAt) {
          throw new ServiceError(
            "AREA_RETIRED",
            "That area is retired. Creating inside it would put live work in a closed territory.",
            400,
          );
        }
        parentPath = parent.path;
      }

      // Two steps because the path contains the row's own id. Created with a
      // placeholder, then stamped — inside one transaction, so no reader ever
      // sees the placeholder.
      const created = await tx.area.create({
        data: { name, tier: input.tier?.trim() || null, parentId: input.parentId ?? null, path: "pending" },
        select: { id: true },
      });
      const path = `${parentPath}${created.id}/`;
      // The path contains the row's own id, so it cannot be known before the
      // insert. Both writes are in one transaction, so no reader ever sees
      // the placeholder, and auditing this separately would log a "change"
      // to a row that did not exist a moment earlier.
      // audit-allow: second half of ONE creation; the writeAudit below records it.
      const area = await tx.area.update({
        where: { id: created.id },
        data: { path },
        select: { id: true, name: true, path: true, parentId: true },
      });
      await writeAudit(tx, AUDIT.AREA.CREATED, actorUserId, {
        areaId: area.id, name: area.name, path: area.path, parentId: area.parentId,
      });
      return area;
    });
  },

  /**
   * Rename an area, or relabel its tier.
   *
   * `parentId` is deliberately NOT accepted. See the note on reparenting at
   * the top of this file — the path is the thing every area-scoped query
   * matches on, and rewriting it changes what history says.
   */
  async rename(
    actorUserId: string,
    areaId: string,
    input: { name?: string; tier?: string | null; lat?: number | null; lng?: number | null },
  ) {
    // COORDINATES COME AS A PAIR OR NOT AT ALL. Half a point is not a
    // location — a lat with no lng would read as "configured" to the weather
    // resolver and then resolve to nothing, which is the silent-wrong-answer
    // shape this codebase keeps paying for. Clearing is also a pair.
    const touchingPoint = input.lat !== undefined || input.lng !== undefined;
    if (touchingPoint) {
      const bothBlank = (input.lat ?? null) === null && (input.lng ?? null) === null;
      const bothSet = typeof input.lat === "number" && typeof input.lng === "number";
      if (!bothBlank && !bothSet) {
        throw new ServiceError("INCOMPLETE_POINT", "Give both a latitude and a longitude, or clear both.", 400);
      }
      if (bothSet) {
        if (!Number.isFinite(input.lat!) || input.lat! < -90 || input.lat! > 90) {
          throw new ServiceError("BAD_LATITUDE", "Latitude must be between -90 and 90.", 400);
        }
        if (!Number.isFinite(input.lng!) || input.lng! < -180 || input.lng! > 180) {
          throw new ServiceError("BAD_LONGITUDE", "Longitude must be between -180 and 180.", 400);
        }
      }
    }

    return prisma.$transaction(async (tx) => {
      const before = await tx.area.findUnique({
        where: { id: areaId },
        select: { id: true, name: true, tier: true, lat: true, lng: true },
      });
      if (!before) throw new ServiceError("NOT_FOUND", "Area not found.", 404);
      const area = await tx.area.update({
        where: { id: areaId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.tier !== undefined ? { tier: input.tier?.trim() || null } : {}),
          ...(touchingPoint ? { lat: input.lat ?? null, lng: input.lng ?? null } : {}),
        },
        select: { id: true, name: true, tier: true, lat: true, lng: true },
      });
      await writeAudit(tx, AUDIT.AREA.UPDATED, actorUserId, {
        areaId,
        before: { name: before.name, tier: before.tier, lat: before.lat, lng: before.lng },
        after: { name: area.name, tier: area.tier, lat: area.lat, lng: area.lng },
      });
      return area;
    });
  },

  /**
   * Retire an area, or bring it back.
   *
   * Refuses while live work still points at it — retiring a territory that
   * still has scheduled visits would hide them from every picker while
   * leaving them on the schedule, which is the shape of bug where work
   * silently stops being anybody's job.
   */
  async setRetired(actorUserId: string, areaId: string, retired: boolean) {
    return prisma.$transaction(async (tx) => {
      const area = await tx.area.findUnique({
        where: { id: areaId },
        select: { id: true, name: true, retiredAt: true },
      });
      if (!area) throw new ServiceError("NOT_FOUND", "Area not found.", 404);

      if (retired) {
        // THE ROOT CANNOT BE RETIRED. It is the tree itself — every path
        // starts with it, so retiring it would retire the coordinate system
        // every area-scoped query matches on while leaving every row
        // pointing into it. The live-children and open-work checks below do
        // NOT cover this: clear both and the root would have gone.
        const root = await tx.area.findFirst({
          where: { parentId: null },
          select: { id: true },
        });
        if (root?.id === areaId) {
          throw new ServiceError(
            "AREA_IS_THE_ROOT",
            "This is the whole territory, not a place inside it — it cannot be retired. Rename it if the label is wrong.",
            400,
          );
        }

        const [liveChildren, openWork] = await Promise.all([
          tx.area.count({ where: { parentId: areaId, retiredAt: null } }),
          tx.jobOccurrence.count({ where: { areaId, completedAt: null } }),
        ]);
        if (liveChildren > 0) {
          throw new ServiceError(
            "AREA_HAS_LIVE_CHILDREN",
            `Retire the ${liveChildren} area(s) inside it first.`,
            400,
          );
        }
        if (openWork > 0) {
          throw new ServiceError(
            "AREA_HAS_OPEN_WORK",
            `${openWork} visit(s) here are not finished. Retag or complete them first — ` +
              `retiring now would hide them from every picker while leaving them on the schedule.`,
            400,
          );
        }
      }

      const updated = await tx.area.update({
        where: { id: areaId },
        data: { retiredAt: retired ? new Date() : null },
        select: { id: true, name: true, retiredAt: true },
      });
      await writeAudit(
        tx,
        retired ? AUDIT.AREA.RETIRED : AUDIT.AREA.UNRETIRED,
        actorUserId,
        { areaId, name: updated.name },
      );
      return updated;
    });
  },

  /**
   * Give someone a role WITHIN an area.
   *
   * This is the only way area scoping ever grants anything: the role says
   * what, the area says where. An assignment can only ever ADD places
   * somebody can see — it never cages a person who already holds the role
   * company-wide (see areaScope invariant 1).
   */
  async assign(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    input: { userId: string; areaId: string; customRoleId: string; isTemporary?: boolean; note?: string | null },
  ) {
    return prisma.$transaction(async (tx) => {
      const [area, role] = await Promise.all([
        tx.area.findUnique({ where: { id: input.areaId }, select: { id: true, name: true, parentId: true, retiredAt: true } }),
        tx.customRole.findUnique({ where: { id: input.customRoleId }, select: { id: true, name: true, suspendedAt: true } }),
      ]);
      if (!area) throw new ServiceError("NOT_FOUND", "Area not found.", 404);
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found.", 404);

      // NOBODY IS ASSIGNED TO THE ROOT, and this is a correctness rule
      // rather than tidiness.
      //
      // "This role at the root" and "this role company-wide" look like the
      // same sentence, and they are not the same query. A company-wide
      // grant produces NO filter. A root-scoped grant produces
      // `area.path startsWith <root>`, and a relation filter cannot match a
      // row whose areaId is null — so it silently drops every untagged
      // record. Unassigned areas are allowed (discouraged, but allowed), so
      // the two diverge the moment anything is untagged, and the symptom is
      // the bad kind: a page that renders perfectly with rows missing.
      //
      // The way to say "everywhere" is the ordinary global role grant on
      // the People tab. This refuses the lookalike that means something
      // subtly narrower.
      if (area.parentId === null) {
        const roots = await tx.area.count({ where: { parentId: null } });
        if (roots === 1) {
          throw new ServiceError(
            "AREA_IS_THE_ROOT",
            "This is the whole territory, not a place to be put in charge of. " +
              "Grant the role itself to give somebody company-wide access.",
            400,
          );
        }
      }
      if (area.retiredAt) {
        throw new ServiceError("AREA_RETIRED", "That area is retired — nobody new looks after it.", 400);
      }
      if (role.suspendedAt) {
        throw new ServiceError(
          "ROLE_SUSPENDED",
          `"${role.name}" is suspended, so the assignment would grant nothing. Un-suspend it first.`,
          400,
        );
      }

      // G6 THROUGH THE AREA DOOR.
      //
      // An area assignment is a ROLE GRANT that happens to carry a place:
      // `currentUser` loads `areaAssignments` into the principal exactly as
      // it loads `customRoles`, so this row confers real capabilities. It
      // therefore has to pass the SAME test `customRoles.grant` applies —
      // you cannot hand out what you do not hold.
      //
      // It did not, and that was a privilege-escalation hole: `areas.manage`
      // alone let its holder assign ANY role, including one holding every
      // entitlement, to anybody inside an area. It was unreachable in
      // practice only because `areas.manage` happened to sit in a single
      // starter role — a seed fact, not a check, and exactly the kind of
      // accident this codebase has learned not to rely on.
      //
      // Flattened, because granting a role grants its whole parent chain,
      // which is where the powerful entitlements live.
      const allRoles = await tx.customRole.findMany({
        select: { id: true, name: true, key: true, inheritsFromId: true,
                  entitlements: { select: { entitlement: true } } },
      });
      const byId = new Map(allRoles.map((r) => [r.id, {
        id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
        entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement) as Entitlement[],
      }]));
      assertMayGrant(actorCapabilities, flattenRole(input.customRoleId, byId));

      const assignment = await tx.areaAssignment.upsert({
        where: {
          userId_areaId_customRoleId: {
            userId: input.userId, areaId: input.areaId, customRoleId: input.customRoleId,
          },
        },
        create: {
          userId: input.userId,
          areaId: input.areaId,
          customRoleId: input.customRoleId,
          isTemporary: !!input.isTemporary,
          note: input.note?.trim() || null,
          grantedById: actorUserId,
          suspendedAt: null,
        },
        // Re-assigning an existing grant un-suspends it rather than creating a
        // duplicate: the operator's intent is "this person looks after this
        // area", and a second row would be invisible in the UI.
        update: {
          suspendedAt: null,
          isTemporary: !!input.isTemporary,
          note: input.note?.trim() || null,
        },
        select: { id: true },
      });
      await writeAudit(tx, AUDIT.AREA_ASSIGNMENT.ROLE_ASSIGNED, actorUserId, {
        assignmentId: assignment.id,
        userId: input.userId,
        areaId: input.areaId,
        areaName: area.name,
        customRoleId: input.customRoleId,
        roleName: role.name,
        isTemporary: !!input.isTemporary,
      });
      return assignment;
    });
  },

  /** Take an area assignment away. */
  async revoke(actorUserId: string, assignmentId: string) {
    return prisma.$transaction(async (tx) => {
      const grant = await tx.areaAssignment.findUnique({
        where: { id: assignmentId },
        select: { id: true, userId: true, areaId: true, customRoleId: true },
      });
      if (!grant) throw new ServiceError("NOT_FOUND", "Assignment not found.", 404);
      await tx.areaAssignment.delete({ where: { id: assignmentId } });
      await writeAudit(tx, AUDIT.AREA_ASSIGNMENT.ROLE_REMOVED, actorUserId, {
        assignmentId, userId: grant.userId, areaId: grant.areaId, customRoleId: grant.customRoleId,
      });
      return { ok: true };
    });
  },

  /**
   * Move a PROPERTY into a different area.
   *
   * Structural, and that is why it needs `areas.manage` rather than a
   * scheduling capability: a property is a lasting customer relationship, so
   * moving it decides whose books every FUTURE visit there lands on. The
   * visits already on the schedule are deliberately left where they are —
   * see the note below.
   */
  async retagProperty(
    actorUserId: string,
    propertyId: string,
    toAreaId: string | null,
  ) {
    return prisma.$transaction(async (tx) => {
      const property = await tx.property.findUnique({
        where: { id: propertyId },
        select: { id: true, displayName: true, areaId: true },
      });
      if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);

      let to: { id: string; name: string } | null = null;
      if (toAreaId) {
        const area = await tx.area.findUnique({
          where: { id: toAreaId },
          select: { id: true, name: true, retiredAt: true },
        });
        if (!area) throw new ServiceError("NOT_FOUND", "Area not found.", 404);
        if (area.retiredAt) {
          throw new ServiceError(
            "AREA_RETIRED",
            `"${area.name}" is retired. Moving live work into a closed territory ` +
              `would hide it from every picker while leaving it on the schedule.`,
            400,
          );
        }
        to = { id: area.id, name: area.name };
      }

      if (property.areaId === toAreaId) {
        return { ok: true, changed: false, occurrencesRetagged: 0 };
      }

      await tx.property.update({ where: { id: propertyId }, data: { areaId: toAreaId } });

      // FUTURE work follows; finished work does not.
      //
      // Scheduled visits move with the property, because they will be done by
      // whoever looks after the new area. Completed ones stay: their area is
      // where the work actually happened and where the money was attributed,
      // and restating that would change what every past rollup reports (G22).
      // audit-allow: part of ONE retag, which the writeAudit below records in
      // full — including `openOccurrencesMoved`, the count this produces.
      const moved = await tx.jobOccurrence.updateMany({
        where: { job: { propertyId }, completedAt: null },
        data: { areaId: toAreaId },
      });

      await writeAudit(tx, AUDIT.AREA_ASSIGNMENT.UPDATED, actorUserId, {
        action: "property_retagged",
        propertyId,
        propertyName: property.displayName,
        fromAreaId: property.areaId,
        toAreaId,
        toAreaName: to?.name ?? null,
        openOccurrencesMoved: moved.count,
        why: "Future visits follow the property; completed ones keep the area the work happened in.",
      });
      return { ok: true, changed: true, occurrencesRetagged: moved.count };
    });
  },

  /**
   * Move ONE visit into a different area.
   *
   * REQUIRES `schedule.manage` IN BOTH THE SOURCE AND THE DESTINATION (G16).
   * A single-sided check is the whole problem: with only the destination
   * checked, a manager could pull revenue onto their own books from a
   * territory they have no part in; with only the source checked, they could
   * push a loss off them. Needing both means a move only happens between two
   * places the same person is answerable for.
   *
   * The caller passes the resolved PRINCIPAL rather than a user id, for the
   * reason `can()` does: a lookup here would ignore an active perspective and
   * answer with powers the perspective is hiding.
   */
  async retagOccurrence(
    actorUserId: string,
    principal: Principal,
    occurrenceId: string,
    toAreaId: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const occ = await tx.jobOccurrence.findUnique({
        where: { id: occurrenceId },
        select: {
          id: true, areaId: true, completedAt: true, status: true,
          area: { select: { id: true, name: true, path: true } },
        },
      });
      if (!occ) throw new ServiceError("NOT_FOUND", "Visit not found.", 404);

      // G22: the area is frozen at completion. The money has been attributed
      // to that territory, and moving it afterwards restates history.
      if (occ.completedAt) {
        throw new ServiceError(
          "OCCURRENCE_COMPLETED",
          "This visit is finished, so its area is fixed — that is the territory " +
            "the work happened in and the money was attributed to.",
          400,
        );
      }

      const to = await tx.area.findUnique({
        where: { id: toAreaId },
        select: { id: true, name: true, path: true, retiredAt: true },
      });
      if (!to) throw new ServiceError("NOT_FOUND", "Area not found.", 404);
      if (to.retiredAt) {
        throw new ServiceError(
          "AREA_RETIRED",
          `"${to.name}" is retired — live work must not move into a closed territory.`,
          400,
        );
      }
      if (occ.areaId === toAreaId) return { ok: true, changed: false };

      // BOTH sides. The source check is skipped only when there is no source
      // — an untagged visit is nobody's revenue yet, so there is nothing to
      // move off anyone's books.
      if (occ.area?.path && !can(principal, "schedule.manage", { areaPath: occ.area.path })) {
        throw new ServiceError(
          "NOT_AUTHORIZED_IN_SOURCE_AREA",
          `You do not run the schedule in "${occ.area.name}", so you cannot move ` +
            `work out of it.`,
          403,
        );
      }
      if (!can(principal, "schedule.manage", { areaPath: to.path })) {
        throw new ServiceError(
          "NOT_AUTHORIZED_IN_DESTINATION_AREA",
          `You do not run the schedule in "${to.name}", so you cannot move work ` +
            `into it.`,
          403,
        );
      }

      await tx.jobOccurrence.update({
        where: { id: occurrenceId },
        data: { areaId: toAreaId },
      });
      await writeAudit(tx, AUDIT.AREA_ASSIGNMENT.UPDATED, actorUserId, {
        action: "occurrence_retagged",
        occurrenceId,
        fromAreaId: occ.areaId,
        fromAreaName: occ.area?.name ?? null,
        toAreaId,
        toAreaName: to.name,
      });
      return { ok: true, changed: true };
    });
  },

  /** Every area assignment, for the access-review surface. */
  async assignments(opts?: { userId?: string; areaId?: string }) {
    return prisma.areaAssignment.findMany({
      where: {
        ...(opts?.userId ? { userId: opts.userId } : {}),
        ...(opts?.areaId ? { areaId: opts.areaId } : {}),
      },
      orderBy: [{ grantedAt: "desc" }],
      select: {
        id: true, userId: true, isTemporary: true, note: true,
        suspendedAt: true, grantedAt: true,
        user: { select: { id: true, displayName: true, email: true } },
        area: { select: { id: true, name: true, path: true, retiredAt: true } },
        customRole: { select: { id: true, name: true, suspendedAt: true } },
      },
    });
  },
};
