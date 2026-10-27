---
name: patterns-legacy-reference
description: "Legacy long-form reference for API route/service scaffolding. Its tab template was deleted 2026-10-17 — for tabs read [[reference-tab-blend-pattern]] and [[reference-tab-ordering]] instead."
metadata:
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:26:21.161Z
---

# Code Patterns — Seedlings3

**Historical note (2026-08-21):** The tab conventions below are the
pre-blend pattern (per-role tab files, `purpose` prop, old stubs).
Since the 2026-08-21 tab-blend refactor ([[project-tab-refactor-2026-08-21]]),
role-aware tabs use the additive-scope prop pattern documented in
[[reference-tab-blend-pattern]] and the canonical top-tab / sub-tab
ordering in [[reference-tab-ordering]]. Prefer those over this file for
new tab work.

**Historical note (2026-10-13):** the API Route pattern below was REWRITTEN.
The role-guard version it used to show cannot compile — `requireRole` and the
`Role` enum are deleted. The Service pattern still applies.

## Web Tab Pattern (apps/web/src/ui/tabs/)

> **THE TAB TEMPLATE THAT WAS HERE IS DELETED.** It showed a `purpose`
> prop, the `Role` enum, a surface-flag factory and a per-role endpoint
> split — all gone. The route and service scaffolding
> further down is still accurate. For tabs, read
> [[reference-tab-blend-pattern]].

### Props
- Tabs take `TabPropsType` + `scope?: Scope`, where `Scope` is `{ can }`.
  There is no `purpose` and no `Role`: both are deleted. A tab asks
  `scope.can("x.manage")` for the capability the control's own route is
  guarded on.

### Standard Tab Structure

**Deleted 2026-10-17.** A ~115-line template lived here showing a tab built
from a `purpose` prop and a surface-flag factory, with one endpoint per
role. Every mechanism in it is gone, and a template
is the worst place to leave dead shapes — it exists to be copied.

For tabs, read [[reference-tab-blend-pattern]]: one tab per feature,
`scope.can(entitlement)` for what is on it, `TAB_REQUIREMENTS` for whether
it appears at all.

The route and service scaffolding below is still accurate.

### Action Helpers
- `doAction(item, "Name", "domain", "action", "nameField", () => load(false))` — POST `/api/{domain}/{id}/{action}`
- `doDelete(id, "Name", "domain", displayName, () => load(false))` — DELETE `/api/{domain}/{id}`
- Direct `apiPost`/`apiDelete` for nested resources (e.g., contacts on a client)

### Types Pattern (apps/web/src/lib/types.ts)
```ts
export const X_STATUS = ["ACTIVE", "ARCHIVED"] as const;
export type XStatus = (typeof X_STATUS)[number];

export type X = {
  id: string;
  status: XStatus;
  displayName: string;
  // ...fields
  createdAt?: string | null;
  updatedAt?: string | null;
};
```

## API Route Pattern (apps/api/src/routes/<resource>.ts)

**The old pattern in this slot was deleted, not deprecated.** It taught
a role-named guard built from `requireRole`, mounted on a role-named path.
`requireRole`, `RoleVal` and the `Role` enum no longer exist, the per-role
route files are gone, and **no route path or guard may carry a role name** —
G24b and the permissions gate fail the build on either. See
[[reference-capabilities-model]].

Routes live in a file named for the RESOURCE. Guards are built once per file
from `makeGuards(app)` and named for the entitlement they require:

```ts
import { makeGuards } from "../lib/routeGuards";
import { currentUserId } from "./_shared";

export default async function vehicleRoutes(app: FastifyInstance) {
  const { requires, approvedUser } = makeGuards(app);
  const req_equipmentView   = requires("equipment.view");
  const req_equipmentManage = requires("equipment.manage");

  // Read
  app.get("/vehicles", req_equipmentView, async (req: any) =>
    services.vehicles.list({ includeArchived: req.query?.includeArchived === "true" }));

  app.get("/vehicles/:id", req_equipmentView, async (req: any) =>
    services.vehicles.get(String(req.params.id)));

  // Write — same resource, a different entitlement
  app.post("/vehicles", req_equipmentManage, async (req: any) =>
    services.vehicles.create(await currentUserId(req), req.body ?? {}));

  app.patch("/vehicles/:id", req_equipmentManage, async (req: any) =>
    services.vehicles.update(await currentUserId(req), String(req.params.id), req.body));

  app.delete("/vehicles/:id", req_equipmentManage, async (req: any) =>
    services.vehicles.hardDelete(await currentUserId(req), String(req.params.id)));

  // "My own X" — approved caller, then scope the query to them yourself.
  // `approvedUser` is NOT an entitlement: a check everyone passes is not a
  // check. G24c treats it on a non-ownership route as privilege escalation.
  app.get("/me/vehicle-log", approvedUser, async (req: any) =>
    services.vehicles.logFor(await currentUserId(req)));
}
```

Rules that are mechanically enforced:

- **One endpoint per thing.** There is no per-role endpoint pair to write;
  an endpoint reads the caller's entitlements and responds accordingly.
- **Inside a handler**, ask `callerCan(req, "x.y")` — it reads `req.principal`
  and so honours the active perspective. For somebody else,
  `userCan(db, id, cap)`. **Never** re-read the caller from the DB; that
  restores their real powers through a lens and has shipped 3×. A service that
  needs the question takes a `CallerCan` parameter (`callerCanFn(req)`).
- **Register the route in the map.** `docs/features/permissions-ROUTE-MAP.md`
  is generated from the guards and G5 fails the build if the two disagree.
- **Every mutation writes an AuditEvent in the same edit** —
  [[feedback-audit-every-mutation]].
- Fastify treats `/x/:id` and `/x/:occurrenceId` as the SAME route. Differing
  param names in one path family is a duplicate-route boot failure, not a
  naming choice.

## API Service Pattern (apps/api/src/services/x.ts)

```ts
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";

export const x = {
  async list(params?) {
    const where: any = {};
    // build where from params
    return prisma.x.findMany({ where, include: { ... }, orderBy: { ... } });
  },

  async get(id: string) {
    const item = await prisma.x.findUnique({ where: { id }, include: { ... } });
    if (!item) throw new ServiceError("NOT_FOUND", "X not found", 404);
    return item;
  },

  async create(currentUserId: string, body: any) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.create({ data: { ...body } });
      await writeAudit(tx, AUDIT.X.CREATED, currentUserId, { xRecord: { ...item } });
      return item;
    });
  },

  async update(currentUserId: string, id: string, body: any) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.update({ where: { id }, data: { ...body } });
      await writeAudit(tx, AUDIT.X.UPDATED, currentUserId, { xRecord: { ...item } });
      return item;
    });
  },

  async someAction(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.update({ where: { id }, data: { status: "NEW_STATUS" } });
      await writeAudit(tx, AUDIT.X.SOME_ACTION, currentUserId, { xRecord: { ...item } });
      return item;
    });
  },

  async hardDelete(currentUserId: string, id: string) {
    return prisma.$transaction(async (tx) => {
      const item = await tx.x.delete({ where: { id } });
      await writeAudit(tx, AUDIT.X.DELETED, currentUserId, { xRecord: { ...item } });
      return { deleted: true };
    });
  },
};
```

## Tab Registration (pages/index.tsx)
- Tabs registered in `workerTabs` and `adminTabs` arrays
- Each tab: `{ value: "x", label: "X", icon: FiX, content: wrapWithInlineMessage(<XTab me={me} purpose="WORKER|ADMIN" />) }`
- Type references in `AdminTabs` and `WorkerTabs` union types in types.ts

## Notes on Existing Stubs (STALE — see 2026-08-21 refactor)

The notes below described the state before the tab-blend refactor. Current reality:

- UsersTab, ActivityTab, AuditTab (renamed from AuditLogTab) are all fully implemented; UsersTab got a `WorkerTeamRoster` sub-component in the blend refactor.
- JobsTab, PaymentsTab, ServicesTab are all shipped and non-trivial (JobsTab is ~9929 lines).
- Mobile app: still ignore for now.

For current tab status and the blended shape, see [[project-tab-refactor-2026-08-21]], [[reference-tab-blend-pattern]], and [[reference-tab-ordering]].
