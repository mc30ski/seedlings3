import type { FastifyInstance } from "fastify";
import { makeGuards } from "../lib/routeGuards";
import { services } from "../services";

import {
  ENTITLEMENT_GROUPS,
  ENTITLEMENTS,
  heldCapabilities,
  type Entitlement,
  type Principal,
  PERSPECTIVE_ICONS,
  isPerspectiveIcon,
} from "@repo/permissions";

/**
 * ROLES AND AREAS — the HTTP surface for the permissions model.
 *
 * This file existed as a gap for the whole build: the model, `can()`, the
 * area scoping and the services were all written, and NOTHING could reach
 * them. There was no way to define a role, grant one, make an area or assign
 * anybody to it except by writing SQL. That is why `roles.define`,
 * `areas.manage`, `people.grant-roles` and `settings.manage` were entitlements
 * no route guarded — they had nothing to guard.
 *
 * HOW THESE ROUTES ARE GUARDED. Each one requires the entitlement that names
 * the thing it does — `roles.define` to shape a role, `people.grant-roles` to
 * hand one out, `areas.manage` for the territory tree. There is no legacy
 * check, no `RoleVal`, and no cutover flag: those were removed with the
 * `Role` enum, and `requires(entitlement)` asks `can()` and nothing else.
 *
 * Two things still make this file the most dangerous one in the API, and both
 * are enforced rather than advised:
 *   - `assertMayGrant` — you cannot put an entitlement in a role, inherit
 *     from a role, or assign one, beyond what you hold yourself (G6).
 *   - The actor's capability set arrives as a PARAMETER read from
 *     `req.principal`, never looked up here, so an active perspective
 *     narrows what the caller can hand out.
 */
async function currentUserId(req: any) {
  return (await services.currentUser.me(req.auth?.clerkUserId)).id;
}

/**
 * What the CALLER holds, from the principal the auth read resolved.
 *
 * Passed into the role service so it can refuse to grant anything beyond it
 * (G6). Read from `req.principal` rather than looked up, so an active
 * perspective narrows what the caller may hand out — otherwise someone
 * working inside a restricted perspective could still mint a role with the powers
 * that perspective exists to hide.
 */
function callerCapabilities(req: any): Entitlement[] {
  const principal = req.principal as Principal | undefined;
  return principal ? heldCapabilities(principal) : [];
}

export default async function permissionRoutes(app: FastifyInstance) {
  const { requires } = makeGuards(app);
  const rolesDefine = requires("roles.define");
  const rolesView = requires("roles.view");
  const grantRoles = requires("people.grant-roles");
  const areasManage = requires("areas.manage");
  const scheduleManage = requires("schedule.manage");

  // ── The vocabulary ──────────────────────────────────────────────────────
  //
  // The role builder renders from this rather than hardcoding a list, so an
  // entitlement added to the TypeScript union appears in the UI without a
  // second edit. Grouped and copy-carrying, because a checkbox labelled
  // "money.approve" tells an operator nothing about what it lets someone do.
  app.get("/entitlements", rolesView, async () => ({
    groups: ENTITLEMENT_GROUPS,
    all: ENTITLEMENTS,
  }));

  // ── Roles ───────────────────────────────────────────────────────────────

  // READING the catalogue is `roles.view`, not `roles.define`. Someone who
  // may GRANT a role has to be able to see which roles exist; gating the
  // list on the edit capability meant a `people.grant-roles` holder could
  // not list what they were allowed to hand out, which is why the role
  // picker could not be built. Editing below still needs `roles.define`.
  app.get("/roles", rolesView, async () => services.customRoles.list());

  /**
   * WHO HOLDS THIS ROLE — the people behind the count.
   *
   * `GET /roles` returns `holders: 3`, which is enough to warn before an
   * edit and useless for acting on it. Both kinds of grant are returned
   * and labelled, because they answer different questions: a company-wide
   * grant means "everywhere", an area grant means "here only", and a
   * reader who cannot tell them apart will misread a boundary as absolute.
   */
  app.get("/roles/:id/holders", rolesView, async (req: any) =>
    services.customRoles.holders(String(req.params.id)),
  );

  app.post("/roles", rolesDefine, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body ?? {};
    return services.customRoles.create(uid, callerCapabilities(req), {
      name: String(b.name ?? ""),
      description: b.description != null ? String(b.description) : null,
      inheritsFromId: b.inheritsFromId != null ? String(b.inheritsFromId) : null,
      entitlements: Array.isArray(b.entitlements) ? b.entitlements.map(String) : [],
    });
  });

  app.patch("/roles/:id", rolesDefine, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body ?? {};
    return services.customRoles.update(uid, callerCapabilities(req), String(req.params.id), {
      ...(b.name !== undefined ? { name: String(b.name) } : {}),
      ...(b.description !== undefined ? { description: b.description == null ? null : String(b.description) } : {}),
      ...(b.inheritsFromId !== undefined
        ? { inheritsFromId: b.inheritsFromId == null ? null : String(b.inheritsFromId) }
        : {}),
      ...(b.isPerspective !== undefined ? { isPerspective: !!b.isPerspective } : {}),
      // Validated against the shared key list, never free text: this value
      // is read back by the web to pick a component, and an unknown key
      // would silently draw nothing.
      ...(b.perspectiveIcon !== undefined
        ? {
            perspectiveIcon:
              b.perspectiveIcon === null || b.perspectiveIcon === ""
                ? null
                : isPerspectiveIcon(b.perspectiveIcon)
                  ? b.perspectiveIcon
                  : (() => {
                      throw app.httpErrors.badRequest(
                        `perspectiveIcon must be one of ${PERSPECTIVE_ICONS.join(", ")}`,
                      );
                    })(),
          }
        : {}),
      ...(b.perspectiveOrder !== undefined
        ? { perspectiveOrder: b.perspectiveOrder == null ? null : Number(b.perspectiveOrder) }
        : {}),
    });
  });

  /**
   * Replace a role's OWN entitlements.
   *
   * Absolute, never a delta (decision 18). A role is the full list of what it
   * grants, so the builder sends the whole set and the service replaces it —
   * there is no "add this one" call, because a partial update is how two
   * operators editing the same role silently drop each other's changes.
   */
  app.put("/roles/:id/entitlements", rolesDefine, async (req: any) => {
    const uid = await currentUserId(req);
    const list = Array.isArray(req.body?.entitlements) ? req.body.entitlements.map(String) : [];
    return services.customRoles.setEntitlements(uid, callerCapabilities(req), String(req.params.id), list);
  });

  // Suspend / un-suspend, which is also how a role is switched off for
  // everyone at once. Deleting is possible only from suspended, so there is
  // always a reversible step before an irreversible one.
  // Shaping the picker is shaping roles, so `roles.define` — the same
  // capability that decides a role EXISTS. `roles.view` is deliberately not
  // enough: the order is a company-wide setting, not a per-person
  // preference.
  app.put("/roles/perspectives/order", rolesDefine, async (req: any) => {
    const ids = (req.body || {}).roleIds;
    if (!Array.isArray(ids) || ids.some((i: unknown) => typeof i !== "string")) {
      throw app.httpErrors.badRequest("roleIds must be an array of role ids, in the order you want them.");
    }
    return services.customRoles.reorderPerspectives(await currentUserId(req), ids as string[]);
  });

  app.post("/roles/:id/suspend", rolesDefine, async (req: any) =>
    services.customRoles.suspend(await currentUserId(req), String(req.params.id)),
  );
  app.post("/roles/:id/unsuspend", rolesDefine, async (req: any) =>
    services.customRoles.unsuspend(await currentUserId(req), String(req.params.id)),
  );
  app.delete("/roles/:id", rolesDefine, async (req: any) =>
    services.customRoles.remove(await currentUserId(req), String(req.params.id)),
  );

  // ── Granting roles to people ────────────────────────────────────────────
  //
  // Separate entitlement from `roles.define` on purpose: deciding what a
  // role means and deciding who holds it are different powers, and an office
  // manager may well need the second without the first.
  // GRANTING A ROLE TO A CUSTOMER.
  //
  // A client contact's login is an ordinary User row. Granting it a role is
  // refused BY THE DATABASE when that account has no worker type —
  // migration 20261020140000_client_grants_require_a_worker_type — and the
  // refusal surfaces here as a check_violation whose message says what to do.
  //
  // That is not an accident of layering: a customer who also works for you
  // is legitimate, so the rule cannot be "customers hold no roles". It is
  // the ORDER that is dangerous. A grant on a customer with no worker type
  // resolves to nothing today (the payroll gate in `can()`) and so looks
  // harmless, but it is dormant rather than void — give that account a
  // worker type later and every grant on it activates at once. Set the
  // worker type first, then grant.
  //
  // Do not "handle" the violation by catching it and granting anyway.
  app.post("/users/:id/roles", grantRoles, async (req: any) => {
    const uid = await currentUserId(req);
    return services.customRoles.assign(
      uid,
      callerCapabilities(req),
      String(req.params.id),
      String(req.body?.customRoleId ?? ""),
    );
  });
  // Promotion, atomically. Two requests would leave a window where the
  // person holds nothing in that chain, and a failure on the second would
  // demote them — the opposite of what the operator clicked.
  //
  // Along ANY inheritance chain, not just the starter ladder: an operator
  // who builds their own hierarchy gets the same atomic move.
  app.post("/users/:id/roles/move", grantRoles, async (req: any) => {
    const toRoleId = String((req.body || {}).toRoleId ?? "");
    if (!toRoleId) throw app.httpErrors.badRequest("toRoleId is required.");
    return services.customRoles.moveWithinChain(
      await currentUserId(req),
      callerCapabilities(req),
      String(req.params.id),
      toRoleId,
    );
  });

  app.delete("/users/:id/roles/:roleId", grantRoles, async (req: any) => {
    const uid = await currentUserId(req);
    return services.customRoles.revoke(uid, String(req.params.id), String(req.params.roleId));
  });

  // ── Areas ───────────────────────────────────────────────────────────────

  app.get("/areas", areasManage, async () => services.areas.list());

  app.post("/areas", areasManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body ?? {};
    return services.areas.create(uid, {
      name: String(b.name ?? ""),
      tier: b.tier != null ? String(b.tier) : null,
      parentId: b.parentId != null ? String(b.parentId) : null,
    });
  });

  // Rename only — `parentId` is not accepted. Areas are never reparented
  // (G14): the materialized path is what every area-scoped query matches on,
  // so moving a subtree would change what history says. Copy-and-retire.
  app.patch("/areas/:id", areasManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body ?? {};
    // A BLANK COORDINATE FIELD CLEARS THE POINT, it does not mean "unchanged"
    // — the editor always sends both, so `""` is the operator emptying the
    // box. `undefined` (key absent) is what means unchanged. Number() is not
    // used on its own because Number("") is 0, which would silently drop the
    // area onto the equator off the coast of Africa.
    const coord = (v: any) => (v === null || v === "" ? null : Number(v));
    return services.areas.rename(uid, String(req.params.id), {
      ...(b.name !== undefined ? { name: String(b.name) } : {}),
      ...(b.tier !== undefined ? { tier: b.tier == null ? null : String(b.tier) } : {}),
      ...(b.lat !== undefined ? { lat: coord(b.lat) } : {}),
      ...(b.lng !== undefined ? { lng: coord(b.lng) } : {}),
    });
  });

  app.post("/areas/:id/retire", areasManage, async (req: any) =>
    services.areas.setRetired(await currentUserId(req), String(req.params.id), true),
  );
  app.post("/areas/:id/unretire", areasManage, async (req: any) =>
    services.areas.setRetired(await currentUserId(req), String(req.params.id), false),
  );

  // ── Who looks after where ───────────────────────────────────────────────

  app.get("/area-assignments", areasManage, async (req: any) =>
    services.areas.assignments({
      userId: typeof req.query?.userId === "string" ? req.query.userId : undefined,
      areaId: typeof req.query?.areaId === "string" ? req.query.areaId : undefined,
    }),
  );

  app.post("/area-assignments", areasManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body ?? {};
    return services.areas.assign(uid, callerCapabilities(req), {
      userId: String(b.userId ?? ""),
      areaId: String(b.areaId ?? ""),
      customRoleId: String(b.customRoleId ?? ""),
      isTemporary: !!b.isTemporary,
      note: b.note != null ? String(b.note) : null,
    });
  });

  app.delete("/area-assignments/:id", areasManage, async (req: any) =>
    services.areas.revoke(await currentUserId(req), String(req.params.id)),
  );

  // ── Moving work between areas ───────────────────────────────────────────

  /**
   * Put a property in an area. `areaId: null` takes it out of every area.
   *
   * `areas.manage` because this is structural: a property is a lasting
   * customer relationship, so moving it decides whose books every future
   * visit there lands on.
   */
  app.patch("/properties/:id/area", areasManage, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body ?? {};
    return services.areas.retagProperty(
      uid,
      String(req.params.id),
      b.areaId == null ? null : String(b.areaId),
    );
  });

  /**
   * Move ONE visit to another area.
   *
   * Guarded by `schedule.manage` rather than `areas.manage`, because this is
   * day-to-day correction rather than shaping the tree — and the service
   * then checks that capability in BOTH the source and destination area
   * (G16). The route guard alone is not the enforcement: holding
   * `schedule.manage` somewhere is not holding it in the two places that
   * matter.
   */
  app.patch("/occurrences/:id/area", scheduleManage, async (req: any) => {
    const uid = await currentUserId(req);
    return services.areas.retagOccurrence(
      uid,
      req.principal as Principal,
      String(req.params.id),
      String(req.body?.areaId ?? ""),
    );
  });
}
