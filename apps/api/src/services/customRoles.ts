import { prisma } from "../db/prisma";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { ServiceError } from "../lib/errors";
import { ENTITLEMENT_COPY, assertEntitlement, flattenRole, isEntitlement, type Entitlement, type RoleDefinition } from "@repo/permissions";

/**
 * CUSTOM ROLES — defining them, and granting them to people.
 *
 * Every grant in this system goes through a NAMED role. There are no
 * per-person entitlement grants, ever (G20). The cost is that an exception
 * needs its own role — to stop one contractor pulling inventory you assign
 * "Contractor — no inventory" rather than ticking a box on them. That is the
 * point: exceptions become named, visible and reusable, and "why does Jake
 * have this?" always has exactly one kind of answer.
 *
 * TWO WORDS, TWO MEANINGS. Roles SUSPEND; areas RETIRE. A suspended role is
 * paused and coming back — grants go inactive immediately, assignments
 * survive, un-suspending restores everything. Suspension is also how you
 * switch a role off for everyone at once, so there is no separate role-wide
 * mechanism to get out of step with it.
 *
 * Deliberately NOT time-based expiry: date-driven revocation fails silently
 * at the worst possible moment, which is why `suspendedAt` is a switch rather
 * than a deadline.
 */

/**
 * YOU CANNOT GRANT WHAT YOU DO NOT HOLD (G6).
 *
 * `assertEntitlement` only checks a string is in the vocabulary. That is not
 * the security question. Without this, anyone holding `roles.define` could
 * mint a role containing `books.export-tax`, `money.approve` or
 * `payroll.manage` and have it assigned — a complete privilege escalation
 * through the role builder, which is the one surface whose entire job is
 * deciding who may do what.
 *
 * THE ACTOR'S SET IS PASSED IN, never resolved here. Same reason `can()`
 * takes a principal rather than a userId: a lookup inside this function
 * would read the actor's REAL capabilities and ignore any active
 * perspective, so someone looking through a narrowed perspective could grant
 * powers the perspective is supposed to be hiding from them.
 */
export function assertMayGrant(
  actorCapabilities: readonly Entitlement[],
  wanted: readonly Entitlement[],
) {
  const held = new Set(actorCapabilities);
  const beyond = [...new Set(wanted)].filter((e) => !held.has(e)).sort();
  if (beyond.length > 0) {
    throw new ServiceError(
      "CANNOT_GRANT_UNHELD",
      `You cannot put ${beyond.join(", ")} in a role — you do not hold ` +
        `${beyond.length === 1 ? "it" : "them"} yourself.`,
      403,
    );
  }
}

export const customRoles = {
  /**
   * Every role, with its resolved entitlement set.
   *
   * Resolution happens HERE rather than in the caller because inheritance is
   * the whole reason a role builder is usable: an operator editing "Admin"
   * has to see the entitlements it gets from Worker and Trainee, not just the
   * nineteen it adds. `own` and `effective` are both returned so the UI can
   * show which came from where, and so editing only ever writes `own`.
   */
  /**
   * The people who hold a role, company-wide grants and area grants alike.
   *
   * Returned as one list with a `scope` on each row rather than two lists,
   * because the question a reader has is "who has this?" and splitting the
   * answer by mechanism makes them reconcile two tables to get it. The
   * distinction still matters — a global grant beats area scoping, so an
   * area row and a global row for the same person are NOT the same fact —
   * so `scope` is explicit rather than inferred from a null areaId.
   */
  /**
   * EVERY CAPABILITY THIS PERSON HOLDS, AND WHERE EACH ONE CAME FROM.
   *
   * The flat capability list already exists on `/api/me` and in the user
   * directory, and it cannot answer the question an operator actually has:
   * *why* can this person do that, and is it everywhere or just here.
   *
   * The part that earns the endpoint is `scope`. A GLOBAL grant beats area
   * scoping — hold a capability company-wide through any role and no area
   * assignment narrows it. So "Pete manages Raleigh" reads like a boundary
   * while a stray global grant has quietly erased it, and nothing on screen
   * says so today. Here, a capability held both ways resolves to `global`
   * and still lists the area grants underneath, so the contradiction is
   * visible instead of implied.
   *
   * Inheritance is reported, not flattened away: holding "Estimator" may be
   * why someone has `schedule.view`, but "Worker" is where it is written,
   * and editing the wrong one of those two is how a fix misses.
   */
  async effectivePermissionsFor(userId: string) {
    const roles = await prisma.customRole.findMany({
      select: {
        id: true, name: true, key: true, inheritsFromId: true, suspendedAt: true,
        entitlements: { select: { entitlement: true } },
      },
    });
    const byId = new Map(roles.map((r) => [r.id, r]));

    /** Each entitlement this role yields, with the role it is written on. */
    const chain = (rootId: string) => {
      const out: Array<{ entitlement: string; writtenOn: string }> = [];
      const seen = new Set<string>();
      let cur: string | null = rootId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const r = byId.get(cur);
        if (!r) break;
        for (const e of r.entitlements) out.push({ entitlement: e.entitlement, writtenOn: r.name });
        cur = r.inheritsFromId;
      }
      return out;
    };

    const [globalGrants, areaGrants] = await Promise.all([
      prisma.userCustomRole.findMany({
        where: { userId, suspendedAt: null, customRole: { suspendedAt: null } },
        select: { customRoleId: true },
      }),
      prisma.areaAssignment.findMany({
        where: { userId, suspendedAt: null, customRole: { suspendedAt: null } },
        select: { customRoleId: true, area: { select: { id: true, name: true, retiredAt: true } } },
      }),
    ]);

    type Source = {
      roleId: string; roleName: string; writtenOn: string;
      scope: "global" | "area"; areaId: string | null; areaName: string | null;
    };
    const sources = new Map<string, Source[]>();
    const add = (ent: string, src: Source) => {
      const list = sources.get(ent) ?? [];
      list.push(src);
      sources.set(ent, list);
    };

    for (const g of globalGrants) {
      const role = byId.get(g.customRoleId);
      if (!role) continue;
      for (const { entitlement, writtenOn } of chain(g.customRoleId)) {
        add(entitlement, { roleId: role.id, roleName: role.name, writtenOn, scope: "global", areaId: null, areaName: null });
      }
    }
    for (const a of areaGrants) {
      const role = byId.get(a.customRoleId);
      if (!role) continue;
      for (const { entitlement, writtenOn } of chain(a.customRoleId)) {
        add(entitlement, { roleId: role.id, roleName: role.name, writtenOn, scope: "area", areaId: a.area.id, areaName: a.area.name });
      }
    }

    return [...sources.entries()]
      .map(([entitlement, via]) => ({
        entitlement,
        copy: ENTITLEMENT_COPY.get(entitlement) ?? null,
        // Global wins. Stated here so no reader has to derive it from the
        // list below and get it wrong.
        scope: via.some((v) => v.scope === "global") ? ("global" as const) : ("area" as const),
        overriddenByGlobal:
          via.some((v) => v.scope === "global") && via.some((v) => v.scope === "area"),
        via,
      }))
      .sort((a, b) => a.entitlement.localeCompare(b.entitlement));
  },

  async holders(customRoleId: string) {
    const [global, area] = await Promise.all([
      prisma.userCustomRole.findMany({
        where: { customRoleId },
        select: {
          suspendedAt: true,
          user: { select: { id: true, displayName: true, email: true, workerType: true } },
        },
      }),
      prisma.areaAssignment.findMany({
        where: { customRoleId },
        select: {
          suspendedAt: true,
          isTemporary: true,
          area: { select: { id: true, name: true, path: true, retiredAt: true } },
          user: { select: { id: true, displayName: true, email: true, workerType: true } },
        },
      }),
    ]);

    return [
      ...global.map((g) => ({
        scope: "global" as const,
        userId: g.user.id,
        displayName: g.user.displayName,
        email: g.user.email,
        workerType: g.user.workerType,
        suspendedAt: g.suspendedAt,
        area: null,
        isTemporary: false,
      })),
      ...area.map((a) => ({
        scope: "area" as const,
        userId: a.user.id,
        displayName: a.user.displayName,
        email: a.user.email,
        workerType: a.user.workerType,
        suspendedAt: a.suspendedAt,
        area: { id: a.area.id, name: a.area.name, retired: !!a.area.retiredAt },
        isTemporary: a.isTemporary,
      })),
    ].sort((x, y) => (x.displayName ?? "").localeCompare(y.displayName ?? ""));
  },

  async list() {
    const rows = await prisma.customRole.findMany({
      orderBy: [{ perspectiveOrder: "asc" }, { name: "asc" }],
      select: {
        id: true, key: true, name: true, description: true,
        isSystem: true, suspendedAt: true, inheritsFromId: true,
        isPerspective: true, perspectiveOrder: true, perspectiveIcon: true, isLadderRung: true,
        entitlements: { select: { entitlement: true } },
        _count: { select: { userGrants: true, areaGrants: true, inheritedBy: true } },
      },
    });
    const byId = new Map<string, RoleDefinition>(
      rows.map((r) => [r.id, {
        id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
        entitlements: r.entitlements.map((e) => e.entitlement as Entitlement),
      }]),
    );
    return rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      suspendedAt: r.suspendedAt,
      inheritsFromId: r.inheritsFromId,
      isPerspective: r.isPerspective,
      perspectiveIcon: r.perspectiveIcon,
      isLadderRung: r.isLadderRung,
      perspectiveOrder: r.perspectiveOrder,
      /** Only what this role itself grants — what the builder edits. */
      own: r.entitlements.map((e) => e.entitlement).sort(),
      /** What holding it actually gives, inheritance resolved. */
      effective: flattenRole(r.id, byId),
      holders: r._count.userGrants,
      areaGrants: r._count.areaGrants,
      /** Editing this role changes this many descendants (G34). */
      descendants: r._count.inheritedBy,
    }));
  },

  /**
   * Define a new role.
   *
   * No `key`: keys belong to roles a starter script owns, and the script
   * upserts by them. A role created here is the operator's, so it has a name
   * they can rename freely and nothing will ever overwrite it.
   */
  async create(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    input: { name: string; description?: string | null; inheritsFromId?: string | null; entitlements?: string[] },
  ) {
    const name = input.name.trim();
    if (!name) throw new ServiceError("BAD_REQUEST", "A role needs a name.", 400);
    const wanted = (input.entitlements ?? []).map(assertEntitlement);
    assertMayGrant(actorCapabilities, wanted);

    return prisma.$transaction(async (tx) => {
      if (input.inheritsFromId) {
        const parent = await tx.customRole.findUnique({
          where: { id: input.inheritsFromId },
          select: { id: true },
        });
        if (!parent) throw new ServiceError("NOT_FOUND", "The role it inherits from does not exist.", 404);
      }
      const existing = await tx.customRole.findUnique({ where: { name }, select: { id: true } });
      if (existing) {
        throw new ServiceError("NAME_TAKEN", `A role called "${name}" already exists.`, 409);
      }
      const role = await tx.customRole.create({
        data: {
          name,
          description: input.description?.trim() || null,
          inheritsFromId: input.inheritsFromId ?? null,
          createdById: actorUserId,
          entitlements: {
            create: (input.entitlements ?? []).map((entitlement) => ({ entitlement })),
          },
        },
        select: { id: true, name: true },
      });
      // DEFINING a role, not granting one. This wrote ROLE_ASSIGNED, so
      // every role ever created reads in the trail as somebody being given
      // a role — and the two are not the same question. It went unnoticed
      // because the metadata says "role_created" directly below, so a
      // reader who opened the row saw the truth while a reader who
      // filtered by verb did not. AUDIT.ROLE.CREATED already existed and
      // had no call sites.
      await writeAudit(tx, AUDIT.ROLE.CREATED, actorUserId, {
        action: "role_created",
        customRoleId: role.id,
        name: role.name,
        inheritsFromId: input.inheritsFromId ?? null,
        entitlements: input.entitlements ?? [],
      });
      return role;
    });
  },

  /**
   * Rename a role, re-describe it, or change what it builds on.
   *
   * `name` is a LABEL and nothing branches on it, so renaming is always safe
   * — including for a starter role, whose `key` is what the script matches.
   *
   * Changing `inheritsFromId` is the dangerous half: it can create a cycle,
   * which `flattenRole` refuses to resolve rather than looping. Checked here
   * by walking up from the proposed parent, because a cycle written to the
   * database would break every permission check for everyone holding any
   * role in it.
   */
  async update(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    customRoleId: string,
    input: { name?: string; description?: string | null; inheritsFromId?: string | null; isPerspective?: boolean; perspectiveOrder?: number | null; perspectiveIcon?: string | null },
  ) {
    return prisma.$transaction(async (tx) => {
      const role = await tx.customRole.findUnique({
        where: { id: customRoleId },
        select: { id: true, name: true, inheritsFromId: true },
      });
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found.", 404);

      if (input.inheritsFromId !== undefined && input.inheritsFromId !== null) {
        if (input.inheritsFromId === customRoleId) {
          throw new ServiceError("ROLE_CYCLE", "A role cannot inherit from itself.", 400);
        }
        // Walk up from the proposed parent. If we reach this role, the edit
        // would close a loop.
        const all = await tx.customRole.findMany({ select: { id: true, inheritsFromId: true } });
        const parentOf = new Map(all.map((r) => [r.id, r.inheritsFromId]));
        const seen = new Set<string>();
        let cur: string | null | undefined = input.inheritsFromId;
        while (cur) {
          if (cur === customRoleId) {
            throw new ServiceError(
              "ROLE_CYCLE",
              "That would make the roles inherit in a circle, which cannot be resolved to an entitlement set.",
              400,
            );
          }
          if (seen.has(cur)) break;
          seen.add(cur);
          cur = parentOf.get(cur) ?? null;
        }
      }

      // Re-parenting changes what the role GRANTS, so it is a grant and
      // goes through the same check. Pointing a role at a richer parent
      // would otherwise be a way around assertMayGrant entirely.
      if (input.inheritsFromId) {
        const all = await tx.customRole.findMany({
          select: { id: true, name: true, key: true, inheritsFromId: true,
                    entitlements: { select: { entitlement: true } } },
        });
        const byId = new Map(all.map((r) => [r.id, {
          id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
          entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement) as Entitlement[],
        }]));
        assertMayGrant(actorCapabilities, flattenRole(input.inheritsFromId, byId));
      }

      const updated = await tx.customRole.update({
        where: { id: customRoleId },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(input.inheritsFromId !== undefined ? { inheritsFromId: input.inheritsFromId } : {}),
          ...(input.isPerspective !== undefined ? { isPerspective: input.isPerspective } : {}),
          // NOT cleared when `isPerspective` goes false: toggling a role
          // off and back on should not lose the icon somebody chose.
          ...(input.perspectiveIcon !== undefined ? { perspectiveIcon: input.perspectiveIcon } : {}),
          ...(input.perspectiveOrder !== undefined ? { perspectiveOrder: input.perspectiveOrder } : {}),
        },
        select: { id: true, name: true },
      });
      // EDITING a role's definition — its name, parent, perspective flag
      // or icon. Same bug as `create` above: it wrote ROLE_ASSIGNED, so
      // changing an icon logged as a grant. Every other edit path in this
      // file (suspend, unsuspend, setEntitlements, reorderPerspectives)
      // already writes ROLE.UPDATED; these two were the outliers.
      await writeAudit(tx, AUDIT.ROLE.UPDATED, actorUserId, {
        action: "role_updated",
        customRoleId,
        before: { name: role.name, inheritsFromId: role.inheritsFromId },
        after: input,
      });
      return updated;
    });
  },

  /**
   * Grant a role to a person.
   *
   * ENFORCES THE ONE-SYSTEM-ROLE RULE (G26), whose MEANING CHANGED and whose
   * old justification no longer holds.
   *
   * It was written for worker-type defaults: a person has one worker type, so
   * holding both "Employee Defaults" and "Contractor Defaults" would union
   * two pay classes. Those roles do not exist — worker type confers no
   * entitlement at all now (G31), and the reseed deletes them by name.
   *
   * `isSystem` today marks the STARTER LADDER — Trainee, Worker, Admin,
   * Super — which the install script owns and nobody may delete. The rule
   * survives because the ladder is built on INHERITANCE: Admin already
   * contains Worker, which contains Trainee. One rung is the whole point, and
   * holding two is not "more access", it is a duplicate that makes the
   * provenance view claim a capability comes from the lower rung.
   *
   * Still not expressible as a unique index — the condition is "at most one
   * row whose JOINED role has isSystem" — so it is enforced here.
   */
  async assign(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    userId: string,
    customRoleId: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const role = await tx.customRole.findUnique({
        where: { id: customRoleId },
        select: { id: true, name: true, isSystem: true, isLadderRung: true, suspendedAt: true },
      });
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found", 404);
      if (role.suspendedAt) {
        throw new ServiceError(
          "ROLE_SUSPENDED",
          `"${role.name}" is suspended. Un-suspend it before granting it to anyone.`,
          409,
        );
      }

      // Granting a role grants EVERYTHING IN IT, inheritance included (G6).
      // Checking the role's own entitlements would miss the parent chain,
      // which is where the powerful ones live.
      const all = await tx.customRole.findMany({
        select: { id: true, name: true, key: true, inheritsFromId: true,
                  entitlements: { select: { entitlement: true } } },
      });
      const byId = new Map(all.map((r) => [r.id, {
        id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
        entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement) as Entitlement[],
      }]));
      assertMayGrant(actorCapabilities, flattenRole(customRoleId, byId));

      // ── What may NOT be held alongside what ──────────────────────────
      //
      // A person may hold ANY NUMBER of roles; what they can do is the union
      // of all of them. Two shapes are refused, and both are about
      // duplication rather than danger.
      //
      // This was keyed on `isSystem`, which means "the install script made
      // it" — seven roles, not four. Field Clearance and the two "May …"
      // roles exist to be granted ON TOP of a rung and were therefore
      // ungrantable to anybody who held one. See `isLadderRung` in the
      // schema.
      const heldGrants = await tx.userCustomRole.findMany({
        where: { userId },
        select: {
          customRoleId: true,
          customRole: { select: { name: true, isLadderRung: true } },
        },
      });
      // `customRoleId`, NOT the grant's own `id`. Those are different id
      // spaces and never equal, so the "already holds this one" escape was
      // dead: re-granting the role somebody already held — the path that
      // un-suspends them — was refused along with everything else.
      const others = heldGrants.filter((g) => g.customRoleId !== customRoleId);

      // 1. TWO RUNGS OF THE LADDER. Checked explicitly rather than left to
      //    the chain rule below, so it still holds if an operator re-points
      //    a rung's inheritance, and so the message can name the move.
      if (role.isLadderRung) {
        const otherRung = others.find((g) => g.customRole.isLadderRung);
        if (otherRung) {
          throw new ServiceError(
            "ONE_LADDER_ROLE",
            `This person already holds "${otherRung.customRole.name}". The starter roles build ` +
              `on each other, so one is all they need — revoke "${otherRung.customRole.name}" ` +
              `first if you are moving them to "${role.name}".`,
            409,
          );
        }
      }

      // 2. TWO ROLES IN ONE INHERITANCE CHAIN. Granting a role that already
      //    contains one they hold (or is contained by it) adds nothing: the
      //    union is just the wider of the two. It also makes the provenance
      //    view attribute a capability to whichever row it happens to read
      //    first. Roles that merely OVERLAP are fine and stack — Field
      //    Clearance on a Worker is redundant today and still meaningful if
      //    they are later moved down to Trainee.
      const chainOf = (start: string) => {
        const out = new Set<string>();
        let cur: string | null | undefined = start;
        while (cur && !out.has(cur)) {
          out.add(cur);
          cur = byId.get(cur)?.inheritsFromId ?? null;
        }
        return out;
      };
      const targetChain = chainOf(customRoleId);
      const clash = others.find(
        (g) => targetChain.has(g.customRoleId) || chainOf(g.customRoleId).has(customRoleId),
      );
      if (clash) {
        throw new ServiceError(
          "SAME_ROLE_CHAIN",
          `"${role.name}" and "${clash.customRole.name}" are in the same inheritance chain, so ` +
            `one already contains the other — holding both adds nothing. Revoke ` +
            `"${clash.customRole.name}" if you are moving them to "${role.name}".`,
          409,
        );
      }

      const grant = await tx.userCustomRole.upsert({
        where: { userId_customRoleId: { userId, customRoleId } },
        create: { userId, customRoleId, grantedById: actorUserId },
        update: { suspendedAt: null },
        select: { id: true, userId: true, customRoleId: true },
      });

      await writeAudit(tx, AUDIT.ROLE.ROLE_ASSIGNED, actorUserId, {
        grantedToUserId: userId,
        customRoleId,
        roleName: role.name,
        isSystem: role.isSystem,
      });
      return grant;
    });
  },

  /**
   * Put the perspective dropdown in a given order.
   *
   * ONE ENDPOINT FOR THE WHOLE LIST, not an editable number per role.
   * `perspectiveOrder` is a free integer, so editing one at a time cannot
   * keep a total order: two roles collide, a gap opens, and the sort
   * (`(a.perspectiveOrder ?? 0) - (b.perspectiveOrder ?? 0)`) puts anything
   * unset at the top. Rewriting every row from one ordered array makes the
   * order dense and total by construction — 1..n, no gaps, no ties.
   *
   * The array must name EXACTLY the current perspectives. A stale client
   * that omits one would otherwise silently leave it unordered, which is
   * the same bug by a slower route.
   *
   * Flagging a role as a perspective is a separate act (`update`); a newly
   * flagged role has no order yet and sorts to the end until somebody
   * places it.
   */
  async reorderPerspectives(actorUserId: string, roleIds: readonly string[]) {
    return prisma.$transaction(async (tx) => {
      const current = await tx.customRole.findMany({
        where: { isPerspective: true },
        select: { id: true, name: true, perspectiveOrder: true },
      });
      const currentIds = new Set(current.map((r) => r.id));
      const given = [...roleIds];
      const givenSet = new Set(given);

      if (givenSet.size !== given.length) {
        throw new ServiceError("DUPLICATE_ROLE", "The same role appears twice in the order.", 400);
      }
      const missing = current.filter((r) => !givenSet.has(r.id)).map((r) => r.name);
      const unknown = given.filter((id) => !currentIds.has(id));
      if (missing.length || unknown.length) {
        throw new ServiceError(
          "PERSPECTIVE_SET_MISMATCH",
          missing.length
            ? `The order left out ${missing.join(", ")}. Send every perspective, in the order you want them.`
            : `The order names ${unknown.length} role(s) that are not perspectives.`,
          409,
        );
      }

      for (const [i, id] of given.entries()) {
        await tx.customRole.update({ where: { id }, data: { perspectiveOrder: i + 1 } });
      }

      const before = [...current]
        .sort((a, b) => (a.perspectiveOrder ?? 0) - (b.perspectiveOrder ?? 0))
        .map((r) => r.name);
      const byId = new Map(current.map((r) => [r.id, r.name]));
      await writeAudit(tx, AUDIT.ROLE.UPDATED, actorUserId, {
        what: "perspective order",
        before,
        after: given.map((id) => byId.get(id) ?? id),
      });
      return { ordered: given.length };
    });
  },

  /**
   * Move somebody from one rung of the ladder to another, atomically.
   *
   * Promotion is the common reason to touch a grant, and the exclusivity
   * rule makes it two operations — revoke the old rung, grant the new one.
   * Done as two requests there is a window where the person holds NOTHING,
   * and if the second fails they stay there: demoted by a half-finished
   * promotion. One transaction, or neither.
   *
   * Only between rungs. Any other pair is an ordinary grant and does not
   * need this.
   */
  /**
   * Move somebody along ONE inheritance chain, atomically.
   *
   * WAS `moveLadderRung`, AND IT ASSUMED THE APP HAS EXACTLY ONE LADDER.
   * It refused any target without `isLadderRung`, and — worse — found the
   * role to move FROM with `where: { customRole: { isLadderRung: true } }`,
   * which only has one answer because the installer flags one chain. An
   * operator who builds a second hierarchy of their own (an office ladder,
   * say) got no move at all: the UI could only offer revoke-then-grant,
   * which is the two-request window this endpoint exists to close.
   *
   * THE CHAIN IS THE UNIT, not a flag. "Same chain" here means exactly what
   * `assign()`'s SAME_ROLE_CHAIN refusal means — one role is an ancestor or
   * a descendant of the other — so the set this will move within is
   * precisely the set a plain grant refuses. The two can't drift into
   * offering a move the grant path would reject, which is the shape of bug
   * that ships when a UI rule and a server rule are written separately.
   *
   * SIBLINGS ARE NOT A CHAIN. Coordinator and Worker both inherit Trainee
   * and neither contains the other, so holding both is legal and meaningful
   * — a coordinator who also works in the field. Moving between them would
   * silently revoke one half of that.
   *
   * `isLadderRung` keeps its job in `assign()`, where ONE_LADDER_ROLE is a
   * stricter rule about the STARTER ladder specifically. It is no longer
   * what decides whether a move is possible.
   */
  async moveWithinChain(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    userId: string,
    toRoleId: string,
  ) {
    return prisma.$transaction(async (tx) => {
      const to = await tx.customRole.findUnique({
        where: { id: toRoleId },
        select: { id: true, name: true, suspendedAt: true },
      });
      if (!to) throw new ServiceError("NOT_FOUND", "Role not found", 404);
      if (to.suspendedAt) {
        throw new ServiceError("ROLE_SUSPENDED", `"${to.name}" is suspended.`, 409);
      }

      const all = await tx.customRole.findMany({
        select: { id: true, name: true, key: true, inheritsFromId: true,
                  entitlements: { select: { entitlement: true } } },
      });
      const byId = new Map(all.map((r) => [r.id, {
        id: r.id, name: r.name, key: r.key, inheritsFromId: r.inheritsFromId,
        entitlements: r.entitlements.map((e) => e.entitlement).filter(isEntitlement) as Entitlement[],
      }]));
      // The same ceiling as a plain grant: you cannot move somebody ONTO a
      // rung carrying entitlements you do not hold yourself.
      assertMayGrant(actorCapabilities, flattenRole(toRoleId, byId));

      // WHAT THEY HOLD IN THIS CHAIN — ancestors and descendants of the
      // target, which is the same walk `assign()` does. Reading every grant
      // and filtering here rather than asking the database for a flagged
      // row is what makes this work for a hierarchy the operator built.
      const chainOf = (start: string) => {
        const out = new Set<string>();
        let cur: string | null | undefined = start;
        while (cur && !out.has(cur)) {
          out.add(cur);
          cur = byId.get(cur)?.inheritsFromId ?? null;
        }
        return out;
      };
      const targetChain = chainOf(toRoleId);
      const grants = await tx.userCustomRole.findMany({
        where: { userId },
        select: { id: true, customRoleId: true, customRole: { select: { name: true } } },
      });
      // Holding nothing in the chain is tolerated and resolves to a plain
      // grant, as it did before: the picker only offers "Move to" when
      // there IS something to move from, so this is the race where a
      // second operator revoked it in between, not an error to show.
      const from =
        grants.find(
          (g) =>
            targetChain.has(g.customRoleId) || chainOf(g.customRoleId).has(toRoleId),
        ) ?? null;
      if (from && from.customRoleId === toRoleId) {
        return { moved: false, from: from.customRole.name, to: to.name };
      }
      // The move is ONE event. A separate ROLE_REMOVED row would read as a
      // revocation that happened to be followed by a grant, which is how a
      // promotion comes to look identical to a demotion in the trail.
      // audit-allow: the ROLE_ASSIGNED row below carries movedFromRoleId and movedFromRoleName, both halves in one row.
      if (from) await tx.userCustomRole.delete({ where: { id: from.id } });

      await tx.userCustomRole.upsert({
        where: { userId_customRoleId: { userId, customRoleId: toRoleId } },
        create: { userId, customRoleId: toRoleId, grantedById: actorUserId },
        update: { suspendedAt: null, grantedById: actorUserId },
      });

      // ONE audit row for the move, not a revoke and a grant that a reader
      // has to pair up by timestamp.
      await writeAudit(tx, AUDIT.ROLE.ROLE_ASSIGNED, actorUserId, {
        grantedToUserId: userId,
        customRoleId: toRoleId,
        roleName: to.name,
        movedFromRoleId: from?.customRoleId ?? null,
        movedFromRoleName: from?.customRole.name ?? null,
        why: "Moved along one inheritance chain.",
      });
      return { moved: true, from: from?.customRole.name ?? null, to: to.name };
    });
  },

  /** Revoke a role from a person. The audit log keeps who held it and when. */
  async revoke(actorUserId: string, userId: string, customRoleId: string) {
    return prisma.$transaction(async (tx) => {
      const grant = await tx.userCustomRole.findUnique({
        where: { userId_customRoleId: { userId, customRoleId } },
        select: { id: true, customRole: { select: { name: true, isSystem: true } } },
      });
      if (!grant) return { revoked: false };

      await tx.userCustomRole.delete({ where: { id: grant.id } });
      await writeAudit(tx, AUDIT.ROLE.ROLE_REMOVED, actorUserId, {
        revokedFromUserId: userId,
        customRoleId,
        roleName: grant.customRole.name,
        isSystem: grant.customRole.isSystem,
      });
      return { revoked: true };
    });
  },

  /**
   * Suspend a role: grants go inactive immediately, assignments survive.
   *
   * System roles cannot be suspended. They are assigned from the worker type,
   * so suspending one would strip a whole class of worker of the privileges
   * their type is defined by, with no obvious way back.
   */
  async suspend(actorUserId: string, customRoleId: string) {
    return prisma.$transaction(async (tx) => {
      const role = await tx.customRole.findUnique({
        where: { id: customRoleId },
        select: { id: true, name: true, isSystem: true, _count: { select: { userGrants: true } } },
      });
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found", 404);
      // NO `isSystem` BLOCK. A starter role is as suspendable as any other:
      // if the operator wants their ladder to look different, that is their
      // call, and suspension is reversible and shows them who loses what.
      // The flag means "the install script made it", nothing more.

      const updated = await tx.customRole.update({
        where: { id: customRoleId },
        data: { suspendedAt: new Date() },
        select: { id: true, suspendedAt: true },
      });
      await writeAudit(tx, AUDIT.ROLE.UPDATED, actorUserId, {
        customRoleId,
        roleName: role.name,
        action: "suspended",
        // The confirm dialog warns BY NAME; the log records the count so the
        // blast radius is answerable after the fact too.
        peopleAffected: role._count.userGrants,
      });
      return updated;
    });
  },

  async unsuspend(actorUserId: string, customRoleId: string) {
    return prisma.$transaction(async (tx) => {
      const role = await tx.customRole.findUnique({
        where: { id: customRoleId },
        select: { id: true, name: true },
      });
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found", 404);
      const updated = await tx.customRole.update({
        where: { id: customRoleId },
        data: { suspendedAt: null },
        select: { id: true, suspendedAt: true },
      });
      await writeAudit(tx, AUDIT.ROLE.UPDATED, actorUserId, {
        customRoleId,
        roleName: role.name,
        action: "unsuspended",
      });
      return updated;
    });
  },

  /**
   * Delete a role — only from the suspended state.
   *
   * Two steps on purpose. Deleting outright would revoke everyone's grants in
   * one irreversible action; suspending first makes the consequence visible
   * and reversible before it becomes permanent.
   */
  async remove(actorUserId: string, customRoleId: string) {
    return prisma.$transaction(async (tx) => {
      const role = await tx.customRole.findUnique({
        where: { id: customRoleId },
        select: {
          id: true,
          name: true,
          isSystem: true,
          suspendedAt: true,
          userGrants: { select: { userId: true } },
          entitlements: { select: { entitlement: true } },
        },
      });
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found", 404);
      // NO `isSystem` BLOCK — deleting a starter role is allowed.
      //
      // The block existed because deleting one is unrecoverable from inside
      // the app: `UserCustomRole.customRoleId` cascades, so every grant goes
      // with the role, and `install-starter-roles.ts` recreates the role
      // while granting it to nobody. Delete the role that carries
      // `people.grant-roles` and nothing can grant it back.
      //
      // `scripts/grant-role.ts` is the way back, which is why this is now
      // allowed: the recovery path exists BEFORE the guard came off. It
      // needs shell access and the database URL — as privileged as the thing
      // it recovers, and deliberately not reachable from the UI.
      //
      // The suspend-first rule below is the remaining protection, and it is
      // the honest one: it is reversible and it shows you who loses what.
      if (!role.suspendedAt) {
        throw new ServiceError(
          "SUSPEND_FIRST",
          `Suspend "${role.name}" first. Suspending is reversible and shows you who loses what; deleting is not.`,
          409,
        );
      }

      // Snapshot before destroying — the repo rule for destructive paths.
      await writeAudit(tx, AUDIT.ROLE.DELETED, actorUserId, {
        customRoleId,
        roleName: role.name,
        heldBy: role.userGrants.map((g) => g.userId),
        entitlements: role.entitlements.map((e) => e.entitlement),
      });
      await tx.customRole.delete({ where: { id: customRoleId } });
      return { deleted: true };
    });
  },

  /**
   * Replace a role's entitlements.
   *
   * Custom roles are ABSOLUTE, never deltas from a base. A role is the set it
   * grants, full stop — so changing a base role can never silently change
   * what every role derived from it grants. The builder may COPY a base as a
   * starting point, which is a one-time convenience, not a live link.
   */
  async setEntitlements(
    actorUserId: string,
    actorCapabilities: readonly Entitlement[],
    customRoleId: string,
    entitlements: string[],
  ) {
    // Every string crosses the boundary through the guard. A stored value
    // outside the union is a grant the builder displays and can() denies,
    // with no error anywhere (G28).
    const valid: Entitlement[] = entitlements.map(assertEntitlement);
    assertMayGrant(actorCapabilities, valid);

    return prisma.$transaction(async (tx) => {
      const role = await tx.customRole.findUnique({
        where: { id: customRoleId },
        select: { id: true, name: true, entitlements: { select: { entitlement: true } } },
      });
      if (!role) throw new ServiceError("NOT_FOUND", "Role not found", 404);

      const before = role.entitlements.map((e) => e.entitlement).sort();
      await tx.roleEntitlement.deleteMany({ where: { customRoleId } });
      for (const entitlement of [...new Set(valid)]) {
        // audit-allow: the ROLE.UPDATED event below records the whole set as
        // before/after, which is the granularity that answers "what changed".
        // One event per entitlement row would bury that in noise.
        await tx.roleEntitlement.create({ data: { customRoleId, entitlement } });
      }

      await writeAudit(tx, AUDIT.ROLE.UPDATED, actorUserId, {
        customRoleId,
        roleName: role.name,
        action: "entitlements-set",
        before,
        after: [...new Set(valid)].sort(),
      });
      return { entitlements: [...new Set(valid)].sort() };
    });
  },
};
