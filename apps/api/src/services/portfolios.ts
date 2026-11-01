import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { resyncPortfoliosForProperty } from "../lib/occurrencePortfolio";
import { orderPortfolioTree } from "../lib/portfolioOrder";
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
  async list(params?: {
    /** Subtrees the caller may see PROPERTIES in (`clients.view`), or null
     *  for no restriction. `[]` means nowhere, so every count is 0. */
    propertyPaths?: string[] | null;
    /** Subtrees the caller may see VISITS in (`schedule.view`). */
    occurrencePaths?: string[] | null;
  }) {
    /**
     * EVERY COUNT ON THIS TAB IS SCOPED, and it has to be scoped the SAME
     * WAY the panel beside it is.
     *
     * This method used to count every row in the database. Two bugs came
     * out of that, one visible and one not:
     *
     *   · The tree said "Carrboro · 4" while the panel under it said
     *     "Nothing in Carrboro yet", because the panel goes through
     *     `GET /properties?portfolioId=`, which ANDs the caller's
     *     `portfolioWhere` — their grants AND their chosen lens. With a
     *     lens set anywhere else the two disagreed, with nothing on
     *     screen to explain it.
     *   · A portfolio-limited lead saw property and visit counts for the
     *     WHOLE COMPANY, including districts they hold nothing in.
     *
     * So visibility is decided by whether the PROPERTY is visible, not
     * whether the node is — which is what the panel does, and the only
     * way the two can agree. A property in a visible zone and also in a
     * Book the caller cannot see still counts under that Book, exactly as
     * the panel lists it there.
     */
    const pathsOr = (paths: string[], col: string) =>
      Prisma.join(
        paths.map((p) => Prisma.sql`${Prisma.raw(col)} LIKE ${p} || '%'`),
        " OR ",
      );

    // "This membership's property is one the caller may see."
    const propVisible =
      params?.propertyPaths == null
        ? Prisma.sql`TRUE`
        : params.propertyPaths.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`EXISTS (
              SELECT 1 FROM "PropertyPortfolio" vp
                JOIN "Portfolio" v ON v."id" = vp."portfolioId"
               WHERE vp."propertyId" = pp."propertyId"
                 AND (${pathsOr(params.propertyPaths, 'v."path"')}))`;

    // The same question for a visit, asked THROUGH ITS PROPERTY — because
    // that is how every occurrence list scopes itself
    // (`portfolioWhereVia(principal, "schedule.view", "property")`). A
    // task with no job has no property and so is never territorial.
    const occVisible =
      params?.occurrencePaths == null
        ? Prisma.sql`TRUE`
        : params.occurrencePaths.length === 0
          ? Prisma.sql`FALSE`
          : Prisma.sql`EXISTS (
              SELECT 1 FROM "JobOccurrence" o
                JOIN "Job" j ON j."id" = o."jobId"
                JOIN "PropertyPortfolio" vp ON vp."propertyId" = j."propertyId"
                JOIN "Portfolio" v ON v."id" = vp."portfolioId"
               WHERE o."id" = op."occurrenceId"
                 AND (${pathsOr(params.occurrencePaths, 'v."path"')}))`;

    const [rows, propOwn, propTotals, occOwn, occTotals, untagged] = await Promise.all([
      prisma.portfolio.findMany({
        // Re-sequenced below. `path` is the stable fallback, not the
        // answer: it orders siblings by the cuid they were given at
        // creation, which is to say arbitrarily.
        orderBy: [{ path: "asc" }],
        select: {
          id: true, name: true, tier: true, parentId: true, path: true, lat: true, lng: true,
          sortOrder: true, instructions: true, color: true,
          retiredAt: true,
          // Assignments are PEOPLE, not territory, and are not narrowed:
          // who looks after a portfolio is the point of the tab.
          _count: { select: { assignments: true } },
        },
      }),
      // OWN counts come from the same predicate as the rollups rather than
      // from Prisma's `_count`, so one filter cannot drift from the other.
      prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
        SELECT pp."portfolioId" AS "id", COUNT(DISTINCT pp."propertyId") AS n
          FROM "PropertyPortfolio" pp
         WHERE ${propVisible}
         GROUP BY pp."portfolioId"`,
      // `d.path LIKE p.path || '%'` is the subtree, and it includes the node
      // itself because a path is a prefix of itself. The trailing delimiter
      // the paths are stored with is what stops "/a/b/" matching "/a/bb/".
      // The visibility test rides on the JOIN's ON clause, not a WHERE, so
      // a node with nothing visible in it still appears with a 0.
      prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
        SELECT p."id", COUNT(DISTINCT pp."propertyId") AS n
          FROM "Portfolio" p
          LEFT JOIN "Portfolio" d ON d."path" LIKE p."path" || '%'
          LEFT JOIN "PropertyPortfolio" pp
                 ON pp."portfolioId" = d."id" AND ${propVisible}
         GROUP BY p."id"`,
      prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
        SELECT op."portfolioId" AS "id", COUNT(DISTINCT op."occurrenceId") AS n
          FROM "JobOccurrencePortfolio" op
         WHERE ${occVisible}
         GROUP BY op."portfolioId"`,
      prisma.$queryRaw<Array<{ id: string; n: bigint }>>`
        SELECT p."id", COUNT(DISTINCT op."occurrenceId") AS n
          FROM "Portfolio" p
          LEFT JOIN "Portfolio" d ON d."path" LIKE p."path" || '%'
          LEFT JOIN "JobOccurrencePortfolio" op
                 ON op."portfolioId" = d."id" AND ${occVisible}
         GROUP BY p."id"`,
      /**
       * PROPERTIES IN NO PORTFOLIO AT ALL.
       *
       * Not reachable by any subtree query, because membership is rows and
       * these have none — so the root, whose subtree is every node, still
       * did not count them. A node labelled "All properties" that omits
       * some properties is wrong in its own name, and the symptom is the
       * bad kind: strip a property's last portfolio and it disappears from
       * the tree with nowhere to look for it.
       *
       * ZERO FOR A PORTFOLIO-LIMITED CALLER, and that is not a shortcut.
       * An untagged property sits in no territory, so it is outside every
       * grant; counting it for somebody confined to one district would
       * show them a property they cannot otherwise see. Only a reader with
       * no territorial restriction has any claim on it.
       */
      params?.propertyPaths == null
        ? prisma.property.count({ where: { portfolios: { none: {} } } })
        : Promise.resolve(0),
    ]);
    const n = (rowsIn: Array<{ id: string; n: bigint }>) =>
      new Map(rowsIn.map((r) => [r.id, Number(r.n)]));
    // DEPTH-FIRST, BY SIBLING ORDER. The client renders this flat array as
    // indented rows and never rebuilds the tree, so the array's order is
    // the order on screen.
    const ordered = orderPortfolioTree(rows);
    /**
     * The sole root is the CONTAINER, not a territory — the same test the
     * tab uses to suppress its own-count and the assign path uses to
     * refuse putting anybody in charge of it. Untagged properties are
     * counted there and nowhere else: with several roots there is no one
     * container to attribute them to, so they stay uncounted rather than
     * being added to an arbitrary one.
     */
    const roots = rows.filter((r) => r.parentId === null);
    const soleRootId = roots.length === 1 ? roots[0].id : null;
    const propOwnBy = n(propOwn);
    const props = n(propTotals);
    const occOwnBy = n(occOwn);
    const occs = n(occTotals);
    return ordered.map((r) => ({
      ...r,
      _count: {
        ...r._count,
        /** Narrowed, like everything else on this tab. */
        properties: propOwnBy.get(r.id) ?? 0,
        occurrences: occOwnBy.get(r.id) ?? 0,
      },
      /** Depth from the root, for rendering the tree without re-walking it. */
      depth: r.path.split("/").filter(Boolean).length - 1,
      /** This portfolio AND everything beneath it, each thing counted once. */
      rollup: {
        properties: (props.get(r.id) ?? 0) + (r.id === soleRootId ? untagged : 0),
        occurrences: occs.get(r.id) ?? 0,
        /** Of those, how many are in NO portfolio. Only ever non-zero on
         *  the sole root, so the tab can show the gap rather than leave
         *  it to be noticed. */
        untagged: r.id === soleRootId ? untagged : 0,
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
   * What stops this portfolio being deleted, if anything.
   *
   * Returned to the UI so the button can be disabled WITH THE REASON
   * rather than clickable and refused. Four conditions, and the second is
   * the one that surprises people: a node can hold no properties today
   * and still be permanently undeletable because completed visits from
   * when it did still point at it.
   *
   * All four are `onDelete: Restrict` in the schema, so the database
   * refuses regardless — this exists to say WHY before you click, not to
   * be the safety net. The net is already there.
   */
  async deleteBlockers(portfolioId: string) {
    const [properties, occurrences, assignments, children] = await Promise.all([
      prisma.propertyPortfolio.count({ where: { portfolioId } }),
      prisma.jobOccurrencePortfolio.count({ where: { portfolioId } }),
      prisma.portfolioAssignment.count({ where: { portfolioId } }),
      prisma.portfolio.count({ where: { parentId: portfolioId } }),
    ]);
    return { properties, occurrences, assignments, children };
  },

  /**
   * DELETE A RETIRED PORTFOLIO, PERMANENTLY.
   *
   * The only irreversible operation in this model. A move moves back, a
   * retire unretires, a re-tag re-tags — this does not, and with history
   * snapshots deliberately not built there is nothing to restore from.
   *
   * RETIRED FIRST, ALWAYS. Retirement is the speed bump: it takes the
   * portfolio out of every picker while leaving it in reporting, so
   * anything still depending on it has a chance to surface before the row
   * goes. Deleting straight from active would skip that.
   *
   * EMPTY MEANS FOUR THINGS, checked here and enforced again by the
   * schema's four `Restrict` foreign keys. The occurrence count is the
   * one that keeps a node alive forever: once real work has been
   * attributed to a portfolio, that attribution is history and history
   * has to resolve through it. In practice this draws the line exactly
   * where it should — you can delete a mistake, never a record.
   *
   * SNAPSHOT FIRST, because there is nothing else. The audit carries the
   * node's name, tier, path and parent, so the trail can at least say
   * what was removed and from where.
   */
  async remove(actorUserId: string, portfolioId: string) {
    return prisma.$transaction(async (tx) => {
      const node = await tx.portfolio.findUnique({
        where: { id: portfolioId },
        select: {
          id: true, name: true, tier: true, path: true, parentId: true,
          retiredAt: true, instructions: true, color: true,
        },
      });
      if (!node) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);
      if (node.parentId === null) {
        throw new ServiceError("ROOT_CANNOT_BE_DELETED", "This is the whole territory, not a portfolio to delete.", 400);
      }
      if (!node.retiredAt) {
        throw new ServiceError(
          "NOT_RETIRED",
          `"${node.name}" is still in use. Retire it first — that takes it out of every picker and gives anything still pointing at it a chance to surface.`,
          400,
        );
      }

      const [properties, occurrences, assignments, children] = await Promise.all([
        tx.propertyPortfolio.count({ where: { portfolioId } }),
        tx.jobOccurrencePortfolio.count({ where: { portfolioId } }),
        tx.portfolioAssignment.count({ where: { portfolioId } }),
        tx.portfolio.count({ where: { parentId: portfolioId } }),
      ]);
      const blockers = [
        properties && `${properties} ${properties === 1 ? "property" : "properties"}`,
        occurrences && `${occurrences} ${occurrences === 1 ? "visit" : "visits"}`,
        assignments && `${assignments} ${assignments === 1 ? "lead" : "leads"}`,
        children && `${children} ${children === 1 ? "portfolio" : "portfolios"} inside it`,
      ].filter(Boolean);
      if (blockers.length > 0) {
        throw new ServiceError(
          "NOT_EMPTY",
          `"${node.name}" still has ${blockers.join(", ")}. Move or detach them first — a portfolio that history points at cannot be removed.`,
          400,
        );
      }

      // SNAPSHOT BEFORE THE ROW GOES. Written first so a failure leaves a
      // record of the attempt rather than a deletion with no trail.
      await writeAudit(tx, AUDIT.PORTFOLIO.DELETED, actorUserId, {
        portfolioId,
        name: node.name,
        tier: node.tier,
        path: node.path,
        parentId: node.parentId,
        instructions: node.instructions,
        color: node.color,
        why: "Retired and empty — no properties, visits, leads or children.",
      });
      await tx.portfolio.delete({ where: { id: portfolioId } });
      return { ok: true, deleted: true, name: node.name };
    });
  },

  /**
   * MOVE A PORTFOLIO TO A DIFFERENT PARENT.
   *
   * This was refused outright for most of the build (G14), on the grounds
   * that moving a node rewrites the materialized path of everything
   * beneath it and so restates what every historical query returns. The
   * first half is true and the second is not any more:
   *
   *   · NOTHING STORES A PATH. Both join tables key on `portfolioId`, a
   *     grant resolves its reach from the live row on every request, and
   *     the lens header carries an id. So a move needs this transaction
   *     and no backfill — the next request is already consistent.
   *   · MONEY IS GROUPED BY CURRENT MEMBERSHIP, since the "as it
   *     happened" basis was removed. There is no longer a view whose
   *     whole promise was that a past total could not move.
   *
   * What a move DOES change, and the caller is told before confirming:
   * every rollup above the moved node, and — because grants resolve
   * per-request — who can see the subtree. A lead on the old parent
   * loses it; a lead on the new parent gains it. That is recorded here
   * because nothing else records it.
   *
   * REFUSED, in order:
   *   · into its own subtree — that detaches the branch from the tree and
   *     leaves a ring nothing can reach
   *   · to the top — a second root is inexpressible, because portfolio
   *     scoping is a path PREFIX test and "both trees" is not a prefix
   *   · a retired node, or into one — retirement means finished
   */
  async move(actorUserId: string, portfolioId: string, newParentId: string) {
    return prisma.$transaction(async (tx) => {
      const node = await tx.portfolio.findUnique({
        where: { id: portfolioId },
        select: { id: true, name: true, path: true, parentId: true, retiredAt: true },
      });
      if (!node) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);
      if (node.parentId === null) {
        throw new ServiceError(
          "ROOT_CANNOT_MOVE",
          "This is the whole territory — there is nowhere above it to move to.",
          400,
        );
      }
      if (node.retiredAt) {
        throw new ServiceError("PORTFOLIO_RETIRED", "That portfolio is retired. Bring it back first.", 400);
      }

      const parent = await tx.portfolio.findUnique({
        where: { id: newParentId },
        select: { id: true, name: true, path: true, retiredAt: true },
      });
      if (!parent) throw new ServiceError("NOT_FOUND", "That parent does not exist.", 404);
      if (parent.retiredAt) {
        throw new ServiceError("PARENT_RETIRED", `"${parent.name}" is retired, so nothing can be moved into it.`, 400);
      }
      if (parent.id === node.parentId) {
        return { ok: true, moved: false, reason: "Already there." };
      }
      // A NODE CANNOT GO INSIDE ITSELF. The prefix test catches the node
      // itself too, since a path is a prefix of itself.
      if (parent.path.startsWith(node.path)) {
        throw new ServiceError(
          "CYCLE",
          `"${parent.name}" is inside "${node.name}", so moving it there would detach the branch from the tree.`,
          400,
        );
      }

      // WHO LOSES AND GAINS SIGHT OF IT. Read BEFORE the paths change,
      // because both answers are prefix tests against the old position.
      const assignments = await tx.portfolioAssignment.findMany({
        where: { suspendedAt: null },
        select: { portfolio: { select: { path: true, name: true } }, user: { select: { id: true, displayName: true } } },
      });
      const covered = (p: string) => assignments.filter((a) => p.startsWith(a.portfolio.path));
      const before = covered(node.path).map((a) => a.user.displayName ?? a.user.id);
      const newPath = `${parent.path}${node.id}/`;
      const after = covered(newPath).map((a) => a.user.displayName ?? a.user.id);
      const lost = before.filter((x) => !after.includes(x));
      const gained = after.filter((x) => !before.includes(x));

      // THE SUBTREE, REPATHED IN ONE TRANSACTION. Every descendant's path
      // begins with the node's old path, so the rewrite is a prefix swap.
      // Done in SQL rather than row by row: a partial rewrite leaves nodes
      // matching no prefix, which does not error — it quietly empties
      // every portfolio-scoped view of them.
      const descendants = await tx.portfolio.findMany({
        where: { path: { startsWith: node.path } },
        select: { id: true, path: true },
      });
      for (const d of descendants) {
        // audit-allow: one of two writes making up ONE move, which the
        // writeAudit below records in full — both paths, the new parent,
        // how many descendants were repathed, and who gains and loses
        // sight of the subtree. An entry per descendant would be noise
        // and would still not say what moved.
        await tx.portfolio.update({
          where: { id: d.id },
          data: { path: `${newPath}${d.path.slice(node.path.length)}` },
        });
      }
      // The node's own parent pointer, last — the paths above are what
      // every query reads, and this is what rebuilds them next time.
      // audit-allow: as above — the same move, recorded once below.
      await tx.portfolio.update({
        where: { id: portfolioId },
        data: { parentId: parent.id },
      });

      await writeAudit(tx, AUDIT.PORTFOLIO.UPDATED, actorUserId, {
        action: "moved_to_new_parent",
        portfolioId,
        name: node.name,
        fromParentId: node.parentId,
        toParentId: parent.id,
        toParentName: parent.name,
        fromPath: node.path,
        toPath: newPath,
        descendantsRepathed: descendants.length - 1,
        // The access delta, because grants resolve per request and this
        // is the only place the change is written down.
        visibilityLost: lost,
        visibilityGained: gained,
        why: "Rollups above this node change. No membership or history was rewritten.",
      });
      return {
        ok: true,
        moved: true,
        toParentName: parent.name,
        descendantsRepathed: descendants.length - 1,
        visibilityLost: lost,
        visibilityGained: gained,
      };
    });
  },

  /**
   * Move a portfolio UP or DOWN AMONG ITS SIBLINGS.
   *
   * NOT REPARENTING, and the distinction is the whole safety argument.
   * `parentId` is never touched, no path is rewritten, and no descendant
   * is read — so every portfolio-scoped query returns exactly what it
   * returned before, and no history is restated. See the note at the top
   * of this file for why the other kind of move is refused (G14).
   *
   * NORMALISE, THEN SWAP. Every sibling is renumbered 0..n-1 in its
   * current display order before the swap. Without that, a tree whose
   * nodes all sit at the default 0 would swap one zero for another and
   * the button would appear broken — which is exactly the state every row
   * is in until the first reorder.
   *
   * The ROOT HAS NO SIBLINGS to move among, and nothing stops a tree from
   * having several roots in principle, so this is left to the generic
   * "already at the end" answer rather than a special case.
   */
  async reorder(actorUserId: string, portfolioId: string, direction: "up" | "down") {
    return prisma.$transaction(async (tx) => {
      const node = await tx.portfolio.findUnique({
        where: { id: portfolioId },
        select: { id: true, name: true, parentId: true },
      });
      if (!node) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);

      // The siblings, in the order they are currently shown. Retired ones
      // are INCLUDED: they still occupy a position in the list, and
      // skipping them would make two visible neighbours swap past a third
      // node the operator cannot see — a move that does not match what
      // they clicked.
      const siblings = await tx.portfolio.findMany({
        where: { parentId: node.parentId },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, sortOrder: true },
      });

      const at = siblings.findIndex((x) => x.id === portfolioId);
      const to = at + (direction === "up" ? -1 : 1);
      if (at === -1 || to < 0 || to >= siblings.length) {
        return { ok: true, moved: false, reason: "Already at the end of its level." };
      }

      const next = siblings.slice();
      [next[at], next[to]] = [next[to], next[at]];

      // Renumber the whole level. Cheap — a level is a handful of rows —
      // and it leaves the column in a state where the next move is a
      // plain swap rather than another normalise.
      for (let i = 0; i < next.length; i++) {
        if (next[i].sortOrder === i) continue;
        await tx.portfolio.update({ where: { id: next[i].id }, data: { sortOrder: i } });
      }

      await writeAudit(tx, AUDIT.PORTFOLIO.UPDATED, actorUserId, {
        action: "sibling_order_changed",
        portfolioId,
        name: node.name,
        direction,
        from: at,
        to,
        order: next.map((x) => x.name),
        why: "Display order among siblings. No path, parent or membership changed.",
      });
      return { ok: true, moved: true, swappedWith: siblings[to].name };
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
    input: {
      name?: string;
      tier?: string | null;
      lat?: number | null;
      lng?: number | null;
      instructions?: string | null;
      color?: string | null;
    },
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
        select: { id: true, name: true, tier: true, lat: true, lng: true, instructions: true, color: true },
      });
      if (!before) throw new ServiceError("NOT_FOUND", "Portfolio not found.", 404);
      const portfolio = await tx.portfolio.update({
        where: { id: portfolioId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.tier !== undefined ? { tier: input.tier?.trim() || null } : {}),
          ...(touchingPoint ? { lat: input.lat ?? null, lng: input.lng ?? null } : {}),
          // An emptied box CLEARS the rule rather than leaving the old one
          // in place — same convention as the coordinates above, and the
          // alternative is a filing rule nobody can delete.
          ...(input.instructions !== undefined
            ? { instructions: input.instructions?.trim() || null }
            : {}),
          // Null is AUTO, not "no colour" — see the schema note.
          ...(input.color !== undefined ? { color: input.color?.trim() || null } : {}),
        },
        select: { id: true, name: true, tier: true, lat: true, lng: true, instructions: true, color: true },
      });
      await writeAudit(tx, AUDIT.PORTFOLIO.UPDATED, actorUserId, {
        portfolioId,
        before: {
          name: before.name, tier: before.tier, lat: before.lat, lng: before.lng,
          instructions: before.instructions, color: before.color,
        },
        after: {
          name: portfolio.name, tier: portfolio.tier, lat: portfolio.lat, lng: portfolio.lng,
          instructions: portfolio.instructions, color: portfolio.color,
        },
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
