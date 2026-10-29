import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { resyncPortfoliosForProperty } from "../lib/occurrencePortfolio";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { can, flattenRole, isEntitlement, type Entitlement, type Principal } from "@repo/permissions";
import { assertMayGrant } from "./customRoles";

/**
 * AREAS — the territory tree, and who looks after which part of it.
 *
 * A portfolio narrows WHAT YOU SEE, never what you may do. Someone promoted to
 * look after Raleigh must still be able to pick up a job in Durham, because
 * people cover for each other — so `work.claim` and `work.complete` are
 * never portfolio-scoped (see NEVER_AREA_SCOPED in @repo/permissions).
 *
 * TWO WORDS, TWO MEANINGS. Roles SUSPEND; portfolios RETIRE. A retired portfolio is
 * finished and not coming back: hidden from every picker, still present in
 * all reporting, because history has to resolve through a closed territory.
 * Portfolios are never DELETED — an occurrence completed in Raleigh stays
 * completed in Raleigh after you stop serving it.
 *
 * AREAS ARE NEVER REPARENTED (G14). Moving a subtree would rewrite the
 * materialized path of everything beneath it and silently change what every
 * historical portfolio-scoped query returns. The supported move is
 * copy-and-retire: make the new portfolio in the right place, retag forward, retire
 * the old one. Slower, and it keeps every past answer intact.
 *
 * `path` IS BUILT FROM IDS, not names (G21). Names are neither unique nor
 * stable — two portfolios may legitimately both be called "Raleigh", and a rename
 * would invalidate a slug path. Delimited AND terminated ("/a/b/"), because
 * without the trailing delimiter a prefix test matches a sibling whose id
 * merely starts with the same characters.
 */
export const portfolios = {
  /**
   * The whole tree, with its own counts AND its subtree totals.
   *
   * THE TOTALS ARE COMPUTED HERE, DISTINCTLY, AND THAT IS THE POINT.
   *
   * `PortfoliosTab` used to derive a subtree total in the browser as a
   * prefix sum over descendants' own counts, reasoning that the whole tree
   * was already on the client so a second endpoint would be a second
   * source for a number the page could work out exactly. That was true
   * while a property had exactly one area. It stopped being true the
   * moment membership became a set: a property in both Briar Chapel and a
   * route beneath the same district is counted once by each child and
   * twice by their parent, and the parent then reports more properties
   * than exist.
   *
   * `COUNT(DISTINCT …)` over the subtree is the only arithmetic that
   * survives overlap, and it cannot be done from per-node counts — it
   * needs the ids. So it moves to the database, where the materialised
   * path makes "every descendant" a prefix match.
   *
   * Retired portfolios are included; callers filter for pickers.
   */
  async list() {
    const [rows, propTotals, occTotals] = await Promise.all([
      prisma.portfolio.findMany({
        orderBy: [{ path: "asc" }],
        select: {
          id: true, name: true, tier: true, parentId: true, path: true, lat: true, lng: true,
          retiredAt: true,
          _count: { select: { properties: true, occurrences: true, assignments: true } },
        },
      }),
      // `d.path LIKE p.path || '%'` is the subtree, and it includes the node
      // itself because a path is a prefix of itself. The trailing delimiter
      // the paths are stored with is what stops "/a/b/" matching "/a/bb/".
      prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
        SELECT p."id", COUNT(DISTINCT pp."propertyId") AS n
          FROM "Portfolio" p
          LEFT JOIN "Portfolio" d ON d."path" LIKE p."path" || '%'
          LEFT JOIN "PropertyPortfolio" pp ON pp."portfolioId" = d."id"
         GROUP BY p."id"`,
      prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
        SELECT p."id", COUNT(DISTINCT op."occurrenceId") AS n
          FROM "Portfolio" p
          LEFT JOIN "Portfolio" d ON d."path" LIKE p."path" || '%'
          LEFT JOIN "JobOccurrencePortfolio" op ON op."portfolioId" = d."id"
         GROUP BY p."id"`,
    ]);
    const props = new Map(propTotals.map((r) => [r.id, Number(r.n)]));
    const occs = new Map(occTotals.map((r) => [r.id, Number(r.n)]));
    return rows.map((r) => ({
      ...r,
      /** Depth from the root, for rendering the tree without re-walking it. */
      depth: r.path.split("/").filter(Boolean).length - 1,
      /** This portfolio AND everything beneath it, each thing counted once. */
      rollup: {
        properties: props.get(r.id) ?? 0,
        occurrences: occs.get(r.id) ?? 0,
      },
    }));
  },

  /**
   * Create a portfolio under `parentId` (or at the root when null).
   *
   * The path is computed from the parent's, so it is correct by construction
   * rather than by the caller remembering the format.
   */
  async create(
    actorUserId: string,
    input: { name: string; tier?: string | null; parentId?: string | null },
  ) {
    const name = input.name.trim();
    if (!name) throw new ServiceError("BAD_REQUEST", "A portfolio needs a name.", 400);

    return prisma.$transaction(async (tx) => {
      let parentPath = "/";
      if (!input.parentId) {
        // EXACTLY ONE ROOT, ALWAYS.
        //
        // Portfolio scoping is a path-prefix match, so with one root "the whole
        // company" is one prefix. A second root makes two disjoint trees and
        // there is then NO prefix that means everywhere: a company-wide
        // grant would have to be two grants, and the lens's "All portfolios"
        // would mean "both trees", which no path expresses. The model would
        // quietly lose the ability to say the thing it most needs to say.
        //
        // Null parent is allowed only to BOOTSTRAP an empty tree, so a
        // database that somehow has no root can still get one.
        const existing = await tx.portfolio.count();
        if (existing > 0) {
          throw new ServiceError(
            "AREA_NEEDS_A_PARENT",
            "Every portfolio sits inside another one. Pick the portfolio this belongs under.",
            400,
          );
        }
      }
      if (input.parentId) {
        const parent = await tx.portfolio.findUnique({
          where: { id: input.parentId },
          select: { id: true, path: true, retiredAt: true },
        });
        if (!parent) throw new ServiceError("NOT_FOUND", "Parent portfolio not found.", 404);
        if (parent.retiredAt) {
          throw new ServiceError(
            "PORTFOLIO_RETIRED",
            "That portfolio is retired. Creating inside it would put live work in a closed territory.",
            400,
          );
        }
        parentPath = parent.path;
      }

      // Two steps because the path contains the row's own id. Created with a
      // placeholder, then stamped — inside one transaction, so no reader ever
      // sees the placeholder.
      const created = await tx.portfolio.create({
        data: { name, tier: input.tier?.trim() || null, parentId: input.parentId ?? null, path: "pending" },
        select: { id: true },
      });
      const path = `${parentPath}${created.id}/`;
      // The path contains the row's own id, so it cannot be known before the
      // insert. Both writes are in one transaction, so no reader ever sees
      // the placeholder, and auditing this separately would log a "change"
      // to a row that did not exist a moment earlier.
      // audit-allow: second half of ONE creation; the writeAudit below records it.
      const portfolio = await tx.portfolio.update({
        where: { id: created.id },
        data: { path },
        select: { id: true, name: true, path: true, parentId: true },
      });
      await writeAudit(tx, AUDIT.PORTFOLIO.CREATED, actorUserId, {
        portfolioId: portfolio.id, name: portfolio.name, path: portfolio.path, parentId: portfolio.parentId,
      });
      return portfolio;
    });
  },

  /**
   * Rename a portfolio, or relabel its tier.
   *
   * `parentId` is deliberately NOT accepted. See the note on reparenting at
   * the top of this file — the path is the thing every portfolio-scoped query
   * matches on, and rewriting it changes what history says.
   */
  async rename(
    actorUserId: string,
    portfolioId: string,
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
      const before = await tx.portfolio.findUnique({
        where: { id: portfolioId },
        select: { id: true, name: true, tier: true, lat: true, lng: true },
      });
      if (!before) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);
      const portfolio = await tx.portfolio.update({
        where: { id: portfolioId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.tier !== undefined ? { tier: input.tier?.trim() || null } : {}),
          ...(touchingPoint ? { lat: input.lat ?? null, lng: input.lng ?? null } : {}),
        },
        select: { id: true, name: true, tier: true, lat: true, lng: true },
      });
      await writeAudit(tx, AUDIT.PORTFOLIO.UPDATED, actorUserId, {
        portfolioId,
        before: { name: before.name, tier: before.tier, lat: before.lat, lng: before.lng },
        after: { name: portfolio.name, tier: portfolio.tier, lat: portfolio.lat, lng: portfolio.lng },
      });
      return portfolio;
    });
  },

  /**
   * Retire a portfolio, or bring it back.
   *
   * Refuses while live work still points at it — retiring a territory that
   * still has scheduled visits would hide them from every picker while
   * leaving them on the schedule, which is the shape of bug where work
   * silently stops being anybody's job.
   */
  async setRetired(actorUserId: string, portfolioId: string, retired: boolean) {
    return prisma.$transaction(async (tx) => {
      const portfolio = await tx.portfolio.findUnique({
        where: { id: portfolioId },
        select: { id: true, name: true, retiredAt: true },
      });
      if (!portfolio) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);

      if (retired) {
        // THE ROOT CANNOT BE RETIRED. It is the tree itself — every path
        // starts with it, so retiring it would retire the coordinate system
        // every portfolio-scoped query matches on while leaving every row
        // pointing into it. The live-children and open-work checks below do
        // NOT cover this: clear both and the root would have gone.
        const root = await tx.portfolio.findFirst({
          where: { parentId: null },
          select: { id: true },
        });
        if (root?.id === portfolioId) {
          throw new ServiceError(
            "PORTFOLIO_IS_THE_ROOT",
            "This is the whole territory, not a place inside it — it cannot be retired. Rename it if the label is wrong.",
            400,
          );
        }

        const [liveChildren, openWork, leads] = await Promise.all([
          tx.portfolio.count({ where: { parentId: portfolioId, retiredAt: null } }),
          tx.jobOccurrence.count({
            where: { portfolios: { some: { portfolioId } }, completedAt: null },
          }),
          // WHO STILL LEADS IT. Suspended grants do not count — they are
          // already switched off and retiring cannot make them worse.
          tx.portfolioAssignment.findMany({
            where: { portfolioId, suspendedAt: null },
            select: { user: { select: { displayName: true, email: true } } },
          }),
        ]);
        if (liveChildren > 0) {
          throw new ServiceError(
            "PORTFOLIO_HAS_LIVE_CHILDREN",
            `Retire the ${liveChildren} portfolio(s) inside it first.`,
            400,
          );
        }
        if (openWork > 0) {
          throw new ServiceError(
            "PORTFOLIO_HAS_OPEN_WORK",
            `${openWork} visit(s) here are not finished. Retag or complete them first — ` +
              `retiring now would hide them from every picker while leaving them on the schedule.`,
            400,
          );
        }
        // SOMEBODY STILL LEADS IT.
        //
        // The third thing that depends on a portfolio, and the one that was
        // missing. Scoping deliberately ignores `retiredAt` (invariant 4 —
        // history has to resolve through a closed portfolio), so retiring
        // one somebody is assigned to does NOT revoke them: they stay
        // confined to it exactly as before. What changes is that
        // `GET /me/portfolios` filters retired nodes out, so their lens
        // chip loses its only option and disappears — leaving a person
        // narrowed to a portfolio that no picker in the app will name.
        //
        // Nothing breaks loudly. They simply keep seeing a subset with no
        // way to ask what it is, and the operator who retired it is told
        // nothing. Refusing, and naming who, is the same shape as the two
        // checks above: a portfolio is retirable when nothing still
        // depends on it.
        if (leads.length > 0) {
          const who = leads
            .map((a) => a.user.displayName || a.user.email || "somebody")
            .slice(0, 3)
            .join(", ");
          const more = leads.length > 3 ? ` and ${leads.length - 3} more` : "";
          throw new ServiceError(
            "PORTFOLIO_HAS_LEADS",
            `${who}${more} still lead${leads.length === 1 ? "s" : ""} this portfolio. ` +
              `Move or revoke ${leads.length === 1 ? "that grant" : "those grants"} first — ` +
              `retiring now would leave ${leads.length === 1 ? "them" : "them"} confined to a ` +
              `portfolio that no picker in the app will show.`,
            400,
          );
        }
      }

      const updated = await tx.portfolio.update({
        where: { id: portfolioId },
        data: { retiredAt: retired ? new Date() : null },
        select: { id: true, name: true, retiredAt: true },
      });
      await writeAudit(
        tx,
        retired ? AUDIT.PORTFOLIO.RETIRED : AUDIT.PORTFOLIO.UNRETIRED,
        actorUserId,
        { portfolioId, name: updated.name },
      );
      return updated;
    });
  },

  /**
   * Give someone a role WITHIN a portfolio.
   *
   * This is the only way portfolio scoping ever grants anything: the role says
   * what, the portfolio says where. An assignment can only ever ADD places
   * somebody can see — it never cages a person who already holds the role
   * company-wide (see portfolioScope invariant 1).
   */
  async assign(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    input: { userId: string; portfolioId: string; customRoleId: string; isTemporary?: boolean; note?: string | null },
  ) {
    return prisma.$transaction(async (tx) => {
      const [portfolio, role] = await Promise.all([
        tx.portfolio.findUnique({ where: { id: input.portfolioId }, select: { id: true, name: true, parentId: true, retiredAt: true } }),
        tx.customRole.findUnique({ where: { id: input.customRoleId }, select: { id: true, name: true, suspendedAt: true } }),
      ]);
      if (!portfolio) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found.", 404);

      // NOBODY IS ASSIGNED TO THE ROOT, and this is a correctness rule
      // rather than tidiness.
      //
      // "This role at the root" and "this role company-wide" look like the
      // same sentence, and they are not the same query. A company-wide
      // grant produces NO filter. A root-scoped grant produces
      // `portfolio.path startsWith <root>`, and a relation filter cannot match a
      // row whose portfolioId is null — so it silently drops every untagged
      // record. Unassigned portfolios are allowed (discouraged, but allowed), so
      // the two diverge the moment anything is untagged, and the symptom is
      // the bad kind: a page that renders perfectly with rows missing.
      //
      // The way to say "everywhere" is the ordinary global role grant on
      // the People tab. This refuses the lookalike that means something
      // subtly narrower.
      if (portfolio.parentId === null) {
        const roots = await tx.portfolio.count({ where: { parentId: null } });
        if (roots === 1) {
          throw new ServiceError(
            "PORTFOLIO_IS_THE_ROOT",
            "This is the whole territory, not a place to be put in charge of. " +
              "Grant the role itself to give somebody company-wide access.",
            400,
          );
        }
      }
      if (portfolio.retiredAt) {
        throw new ServiceError("PORTFOLIO_RETIRED", "That portfolio is retired — nobody new looks after it.", 400);
      }
      if (role.suspendedAt) {
        throw new ServiceError(
          "ROLE_SUSPENDED",
          `"${role.name}" is suspended, so the assignment would grant nothing. Un-suspend it first.`,
          400,
        );
      }

      // G6 THROUGH THE PORTFOLIO DOOR.
      //
      // A portfolio assignment is a ROLE GRANT that happens to carry a place:
      // `currentUser` loads `portfolioAssignments` into the principal exactly as
      // it loads `customRoles`, so this row confers real capabilities. It
      // therefore has to pass the SAME test `customRoles.grant` applies —
      // you cannot hand out what you do not hold.
      //
      // It did not, and that was a privilege-escalation hole: `portfolios.manage`
      // alone let its holder assign ANY role, including one holding every
      // entitlement, to anybody inside a portfolio. It was unreachable in
      // practice only because `portfolios.manage` happened to sit in a single
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

      const assignment = await tx.portfolioAssignment.upsert({
        where: {
          userId_portfolioId_customRoleId: {
            userId: input.userId, portfolioId: input.portfolioId, customRoleId: input.customRoleId,
          },
        },
        create: {
          userId: input.userId,
          portfolioId: input.portfolioId,
          customRoleId: input.customRoleId,
          isTemporary: !!input.isTemporary,
          note: input.note?.trim() || null,
          grantedById: actorUserId,
          suspendedAt: null,
        },
        // Re-assigning an existing grant un-suspends it rather than creating a
        // duplicate: the operator's intent is "this person looks after this
        // portfolio", and a second row would be invisible in the UI.
        update: {
          suspendedAt: null,
          isTemporary: !!input.isTemporary,
          note: input.note?.trim() || null,
        },
        select: { id: true },
      });
      await writeAudit(tx, AUDIT.PORTFOLIO_ASSIGNMENT.ROLE_ASSIGNED, actorUserId, {
        assignmentId: assignment.id,
        userId: input.userId,
        portfolioId: input.portfolioId,
        portfolioName: portfolio.name,
        customRoleId: input.customRoleId,
        roleName: role.name,
        isTemporary: !!input.isTemporary,
      });
      return assignment;
    });
  },

  /** Take a portfolio assignment away. */
  async revoke(actorUserId: string, assignmentId: string) {
    return prisma.$transaction(async (tx) => {
      const grant = await tx.portfolioAssignment.findUnique({
        where: { id: assignmentId },
        select: { id: true, userId: true, portfolioId: true, customRoleId: true },
      });
      if (!grant) throw new ServiceError("NOT_FOUND", "Assignment not found.", 404);
      await tx.portfolioAssignment.delete({ where: { id: assignmentId } });
      await writeAudit(tx, AUDIT.PORTFOLIO_ASSIGNMENT.ROLE_REMOVED, actorUserId, {
        assignmentId, userId: grant.userId, portfolioId: grant.portfolioId, customRoleId: grant.customRoleId,
      });
      return { ok: true };
    });
  },

  /**
   * Set which portfolios a property belongs to.
   *
   * REPLACES `retagProperty`, which moved a property from one area to
   * another because `areaId` was a single column. Membership is a set now,
   * so the honest primitive is "these are the ones" — add, remove and move
   * are all the same call with a different list, and the UI never has to
   * decide which verb it is performing.
   *
   * Structural, and that is why it needs `portfolios.manage` rather than a
   * scheduling capability: a property is a lasting customer relationship,
   * so this decides whose books its work lands on.
   *
   * OPEN VISITS FOLLOW, COMPLETED ONES DO NOT. The resync below is the
   * whole reason the membership rows exist on an occurrence rather than
   * being derived — see `lib/occurrencePortfolio.ts`. A completed visit's
   * portfolios are frozen and this cannot touch them (G12/G22), because
   * they are where the money was attributed and restating that would
   * change what every past rollup reports.
   */
  async setPropertyPortfolios(
    actorUserId: string,
    principal: Principal,
    propertyId: string,
    portfolioIds: readonly string[],
  ) {
    return prisma.$transaction(async (tx) => {
      const property = await tx.property.findUnique({
        where: { id: propertyId },
        select: {
          id: true,
          displayName: true,
          portfolios: { select: { portfolio: { select: { id: true, name: true } } } },
        },
      });
      if (!property) throw new ServiceError("NOT_FOUND", "Property not found.", 404);

      const want = [...new Set(portfolioIds)];
      const targets = want.length
        ? await tx.portfolio.findMany({
            where: { id: { in: want } },
            select: { id: true, name: true, retiredAt: true },
          })
        : [];
      const missing = want.filter((id) => !targets.some((t) => t.id === id));
      if (missing.length) {
        throw new ServiceError("NOT_FOUND", `${missing.length} portfolio(s) not found.`, 404);
      }
      // A retired portfolio stays in REPORTING and out of PICKERS, so
      // adding live work to one would hide it everywhere while leaving it
      // on the schedule. Removing from one is always allowed — that is the
      // way out of a closed portfolio.
      //
      // Written as a plain `if (t.retiredAt) throw` rather than a filter
      // and a length check, because G13 reads this shape. A gate that
      // cannot see the refusal is not enforcing it.
      const had = new Set(property.portfolios.map((m) => m.portfolio.id));
      for (const t of targets) {
        if (had.has(t.id)) continue;
        if (t.retiredAt) {
          throw new ServiceError(
            "PORTFOLIO_RETIRED",
            `"${t.name}" is retired. Moving live work into a closed portfolio would ` +
              `hide it from every picker while leaving it on the schedule.`,
            400,
          );
        }
      }

      const wantSet = new Set(want);
      const add = want.filter((id) => !had.has(id));
      const remove = [...had].filter((id) => !wantSet.has(id));
      if (add.length === 0 && remove.length === 0) {
        return { ok: true, changed: false, occurrencesResynced: 0 };
      }

      // BOTH SIDES OF EVERY CHANGE (G16).
      //
      // This rule used to live on `retagOccurrence`, which moved one visit
      // between areas. That endpoint is gone — an open visit follows its
      // property now, so a per-visit override would be erased by the next
      // resync — but the escalation it guarded is unchanged and simply
      // moved up a level. A one-sided check is the whole problem: checking
      // only what you add to lets a lead pull revenue onto their own books
      // from a portfolio they have no part in; checking only what you
      // remove from lets them push a loss off. Needing `schedule.manage`
      // in both means work only moves between portfolios the same person
      // is answerable for.
      //
      // The PRINCIPAL is passed in rather than looked up, for the reason
      // `can()` takes one: a fresh read would ignore an active perspective
      // and answer with powers that perspective is hiding.
      const nodes = new Map(
        (
          await tx.portfolio.findMany({
            where: { id: { in: [...add, ...remove] } },
            select: { id: true, name: true, path: true },
          })
        ).map((r) => [r.id, r]),
      );

      // Written as two explicit checks rather than a loop over both lists.
      // A loop is tidier and G16 cannot read it: the gate counts the
      // `can(principal, "schedule.manage", …)` calls and requires two,
      // because a single-sided check is precisely the bug. A rule a gate
      // cannot see is a rule that comes back.
      for (const id of remove) {
        const fromNode = nodes.get(id);
        if (fromNode && !can(principal, "schedule.manage", { portfolioPath: fromNode.path })) {
          throw new ServiceError(
            "NOT_AUTHORIZED_IN_SOURCE_PORTFOLIO",
            `You do not run the schedule in "${fromNode.name}", so you cannot move work out of it.`,
            403,
          );
        }
      }
      for (const id of add) {
        const toNode = nodes.get(id);
        if (toNode && !can(principal, "schedule.manage", { portfolioPath: toNode.path })) {
          throw new ServiceError(
            "NOT_AUTHORIZED_IN_DESTINATION_PORTFOLIO",
            `You do not run the schedule in "${toNode.name}", so you cannot move work into it.`,
            403,
          );
        }
      }

      // audit-allow: one of three writes making up ONE membership change,
      // which the writeAudit below records in full — the names before and
      // after, both deltas, and how many open visits were resynced. Three
      // entries for one operator action would be noise in the trail and
      // would still not say what changed.
      if (remove.length) {
        await tx.propertyPortfolio.deleteMany({
          where: { propertyId, portfolioId: { in: remove } },
        });
      }
      // audit-allow: as above — same change, recorded once below.
      if (add.length) {
        await tx.propertyPortfolio.createMany({
          data: add.map((portfolioId) => ({ propertyId, portfolioId, addedById: actorUserId })),
          skipDuplicates: true,
        });
      }

      // audit-allow: part of ONE membership change, which the writeAudit
      // below records in full — including the resynced count.
      const resynced = await resyncPortfoliosForProperty(tx, propertyId);

      await writeAudit(tx, AUDIT.PORTFOLIO_ASSIGNMENT.UPDATED, actorUserId, {
        action: "property_membership_set",
        propertyId,
        propertyName: property.displayName,
        from: property.portfolios.map((m) => m.portfolio.name),
        to: targets.map((t) => t.name),
        added: add,
        removed: remove,
        openOccurrencesResynced: resynced,
        why: "Open visits follow the property; completed ones keep what they counted toward.",
      });
      return { ok: true, changed: true, occurrencesResynced: resynced };
    });
  },

  /** Every portfolio assignment, for the access-review surface. */
  async assignments(opts?: { userId?: string; portfolioId?: string }) {
    return prisma.portfolioAssignment.findMany({
      where: {
        ...(opts?.userId ? { userId: opts.userId } : {}),
        ...(opts?.portfolioId ? { portfolioId: opts.portfolioId } : {}),
      },
      orderBy: [{ grantedAt: "desc" }],
      select: {
        id: true, userId: true, isTemporary: true, note: true,
        suspendedAt: true, grantedAt: true,
        user: { select: { id: true, displayName: true, email: true } },
        portfolio: { select: { id: true, name: true, path: true, retiredAt: true } },
        customRole: { select: { id: true, name: true, suspendedAt: true } },
      },
    });
  },
};
