---
name: reference-capabilities-model
description: The Role enum is deleted; authorization is capabilities via requires()/callerCan()/scope.can, with perspectives as narrowing lenses.
metadata:
  type: reference
---

**`Role` (WORKER/ADMIN/SUPER/STAFF) and `UserRole` are DELETED** as of
2026-10-12. A role is a `CustomRole` row — name, entitlement set, parent to
inherit from. **61 entitlements** (`roles.view` added 2026-10-15 to split
SEEING the role catalogue from EDITING it), each carrying a human sentence in
`packages/permissions/entitlements.ts` that the UI can render. See
`docs/features/permissions-ROUTE-MAP.md` (**639 rows, GENERATED** —
`npm run routemap` / `routemap:check`, from
`apps/api/scripts/build-route-map.ts`; **G5 fails the build whenever it and
the guards disagree**). **Never hand-reconcile this file.** Three separate
ad-hoc scripts corrupted it the same way: a regex matching only
`## entitlement.name (n)` headers silently folded the OWNERSHIP / PUBLIC /
CLIENT-PORTAL / SYSTEM sections into the preceding entitlement group, leaving
the row count plausible and ~143 routes in the wrong bucket. The generator
keeps the prose preamble and derives the body from the guards.) and
[[reference-worker-class]].

Counts move. Verify before quoting: entitlements from `entitlements.ts`,
routes by counting `requires(` across `apps/api/src/routes/`.

## How to ask

| Question | Ask |
|---|---|
| May this ROUTE run? | `requires(entitlement)` — one arg, no flag, no fallback |
| Ownership route (my own earnings) | `approvedUser` — approved caller, no capability |
| May the CALLER do X, in a handler? | `callerCan(req, cap)` — honours their lens |
| Caller check from inside a SERVICE? | the `CallerCan` function parameter threaded in from the route |
| May SOMEBODY ELSE? | `userCan(db, id, cap)` / `capabilitiesForUsers(db, ids)` |
| Web: should this button exist? | `scope.can(cap)` |
| Web: which layout? | **No layout flags.** One tab per feature; `TAB_REQUIREMENTS` decides which tabs exist, `scope.can()` decides what is on them. The surface flags and their factory were deleted 2026-10-17 |

**Never resolve the CALLER with a fresh DB read.** It bypasses the active
perspective and hands back their real powers. Shipped 3× — see
[[reference-view-as-endpoints]]. That is what `CallerCan` exists for: a
service that needs to ask about the caller takes the question as a parameter
instead of going to the database for the answer. 13 such reads were closed;
the few that must read carry a `// caller-read-allow: <reason>` annotation,
which G39 requires.

**`approvedUser` is not an entitlement.** A check every person passes is not a
check. It marks the ~95 ownership endpoints, which then scope their own query
to the caller.

## No role names anywhere

Not in a URL, not in a guard name (G24b/G41), not in a route filename.
Measured against `HEAD`: **431** route declarations began with a role segment,
across **354** distinct paths and 415 distinct verb+suffix combinations; the
working tree has **0**. The route layer is 19 resource files + `_shared.ts`.
`client.ts` is KEPT deliberately — the
client portal is its own dedicated path, not mixed with custom roles.

Two kinds of duplication, both verified against `HEAD`:
- **33** prefixed verb+suffix combinations already had a bare `/X` twin, so
  they had to be MERGED before the prefix could be dropped.
- **9** existed under BOTH an `admin` and a `super` prefix — the same handler
  twice, differing only in whether admin-hidden rows came back and gated on
  the SAME entitlement. **The client picked its own privilege level by
  choosing a URL.** All nine were deleted down to one neutral route
  (`/documents`, `/timeline`) that decides from a capability.

A path is not a check. That is the whole lesson.

## Gates

G24a one authorization path (no readable flag, no `requireRole(`) · G24b no
role-named guard · G24c `approvedUser` only on ownership routes · G24d · G5
guard matches the route map · G4 the perspective reaches the principal and
comes from `me.perspectives` · G19 the enum does not exist · G20 no per-person
grants · G35 a perspective can only narrow · G37/G37b · G38 · G39
caller-read annotations (its `CALLER_ID` list now includes `uid`/`user.id`,
which a real bypass walked through) · G40 · **G41 no role name anywhere in a
route path** · G30 worker class never by negation · G33 only a paid person
takes a paid seat. G6's grant check now covers `areas.assign()` — the service
method in `areas.ts`, reached by holders of the `areas.manage` entitlement —
as well as
`customRoles.*` — an area assignment is a role grant, and it had none.

**G15 IS built** — `apps/api/src/services/ui-capability-build-gate.test.ts`
asserts every UI action's condition matches its route's guard, and carries a
shrink-only PENDING backlog. (A stale `it.todo("G15")` sat in
`permissions-build-gate.test.ts` long after it shipped, which is why three
memory files called it unbuilt.) **G13 and G25 were built 2026-10-18**; the permissions gate has no `it.todo`
left. G13: a retired area refuses new work and stays in reporting. G25: a
route narrows by the capability it is guarded on. Both are static — nothing
yet runs a query as a territory-limited principal.

## Setup, not bootstrap

`apps/api/scripts/install-starter-roles.ts` — ladder **Trainee(13) →
Worker(16) → Admin(37) → Super(60)**, by inheritance, upserted by immutable
`key` so re-running preserves ids and therefore every grant. It ADOPTS a
same-named unkeyed role rather than dying on the name constraint. The dev seed
calls the same function. The env-var break-glass is deleted — there is no
in-app recovery path, by design; re-run the script. **The file is still untracked in git.**

"Super" is not hardcoded anywhere. It is the name of a starter role that
happens to hold all 60 entitlements — a seed fact, not a system property. If
you catch yourself reasoning about what "someone with `settings.manage` can do", you are reasoning
about one row in a table the user can edit.

## THE DELETED SHAPES — never reintroduce, and never re-explain in code

**This section is the ONE place that record lives.** Do not scatter
past-tense explanations of the old model through the codebase: a comment
saying `This used to post { role: "ADMIN" }` still puts `ADMIN` in the file,
so a search for it still lands there. Past tense helps whoever is already
reading that line; it does nothing for whoever is grepping. Comments say what
the code does NOW. The history lives here.

Never reintroduce, in code OR in a comment:

| Gone | What replaced it |
|---|---|
| `Role` enum — `WORKER` / `ADMIN` / `SUPER` / `STAFF` | `CustomRole` rows, renameable by the operator |
| `UserRole` table | `UserCustomRole` → `CustomRole` |
| `requireRole`, `RoleVal`, `adminGuard` / `superGuard` / `workerGuard` | `requires(entitlement)` + `callerCan(req, cap)` |
| `lib/privileges.ts`, `resolvePrivileges` | `can()` in `packages/permissions` |
| `User.canPullInventory`, `User.canChargeBusinessExpenses` columns | the `inventory.pull` / `expenses.charge` entitlements |
| `TRAINEE` as a `workerType` | EMPLOYEE + a Trainee *role*; `workerType` is EMPLOYEE / CONTRACTOR / UNPAID |
| `type Surface`, the `purpose` prop, `isAdminOrSuper` | `scope.can(capability)` — `Scope` has one field |
| `ENTITLEMENTS_ENABLED` cutover flag | nothing; the cord is cut |
| `/admin/*`, `/super/*`, `/worker/*` route prefixes | routes named for their RESOURCE |
| `routes/admin.ts`, `routes/worker.ts` | 19 resource route files + `_shared.ts` |
| Four shells (Client / Worker / Admin / Super) | TWO: `client` and `staff` |
| `?workerView=1` | `?selfScoped=1` |
| An env var that grants anything (`ADMIN_BOOTSTRAP_EMAILS`) | nothing; re-run `install-starter-roles.ts` |

Three places may still NAME these, because naming them is the job:

- **`prisma/migrations/**`** — frozen history
  ([[feedback_never_edit_applied_migrations]]).
- **Gate assertion strings and detector regexes** — `permissions-build-gate`,
  `source-hygiene-build-gate`, `stale-reference-build-gate` and friends
  match on the old shape to forbid it. Deleting the string disarms the gate.
- **This file.**

Enforced by `stale-reference-build-gate.test.ts` (rules A–D): dead file
paths, role words as authority, role-named identifiers, and role enum
literals in comments.

**Still open, needs a decision:** `/api/me` ships
`privileges: { canPullInventory, canChargeBusinessExpenses }` — the names of
two dropped columns, carrying capability values. ~10 web sites read it
(`scope.ts` `isFieldCleared`, `JobsTab`, `ProfileTab`, `UsersTab`,
`ManageInvoiceChargesDialog`). Renaming to the capabilities is a coordinated
API+web change; tsc catches every miss. Not done.

## Building roles — what the API gives a UI

`GET /roles` already returns what a role builder needs: `own` vs `effective`
entitlements (inheritance resolved), `holders`, `areaGrants`, and
`descendants` (how many roles inherit from it — editing this one changes
them). `PATCH /roles/:id` accepts `isPerspective` and `perspectiveOrder`, so
perspectives are managed as roles, not as a separate thing.

Added 2026-10-15, both previously missing:
- `GET /roles/:id/holders` (`roles.view`) — the people behind the count,
  company-wide and area grants in one list with an explicit `scope`.
- `GET /users/:id/effective-permissions` (`people.manage`) — per capability:
  copy, `scope`, `overriddenByGlobal`, and `via[]` naming the role HELD and
  the role it is WRITTEN ON. Verified: someone with `schedule.manage`'s `schedule.view` reports
  "via Admin, written on Trainee". The area paths are unexercised — there
  are zero `AreaAssignment` rows.

`roles.view` exists because `GET /roles` was gated on `roles.define`, so a
`people.grant-roles` holder could not list what they were allowed to hand
out — the two are separated on purpose ("an office manager may well need the
second without the first") and the gating undid that.

## `isOwner` (LLC Owner) is NOT a role, and never was

A boolean on `User` with a partial unique index — at most one. Checked all 76
usages 2026-10-15: **no route is gated on it** and the capability system does
not know it exists. It is business identity, and it changes how money is
CLASSIFIED, not who may do what:

- the owner's `PaymentSplit` rows carry `ownerEarnings = true`, which the
  Gusto/payroll exports filter out — a draw, not a paycheck;
- the rest is display copy ("You're not on payroll — you're the LLC Owner")
  and a badge on the forecast.

Set via `PATCH /users/:id/owner` on `settings.manage` — business identity,
not a job attribute, which is why it is not `people.manage`.

**Its one interaction with perspectives, and why it is safe.** `/api/me`
returns `isOwner: perspective ? false : realIsOwner` — a narrowed lens blanks
it, deliberately ("an owner looking through a narrower lens is not an owner
in it"). That cannot corrupt accounting: every money path reads `isOwner`
from the DATABASE (`payments.ts`, `reconcileWorkers.ts`) or from the
persisted `ownerEarnings` flag on the split, never from the `/me` payload. A
lens changes what the owner SEES, never how their pay is classified.

**Watch in the UI phase:** this is the one remaining flag that changes
behaviour and is not a capability. It is easy to mistake for a role. It must
never gate an action — `scope.can(...)` decides that.

`time.ts` already carries the right instinct in a comment: the hours
endpoint is deliberately NOT special-cased for owners, because an owner on a
four-person crew should see their 25% share, not 100%.

## Perspectives

A named SUBSET of what you hold, offered only if you hold its role or one
that INHERITS it (walk up the chain) — so every lens is a subset by
construction and no `X-Perspective` value can grant anything. Replaced the
role swap, which dropped custom grants wholesale and so could only ever show
the generic worker experience.

**UI IS BUILT** (verified 2026-10-18). `RoleChip` is the perspective picker
and reads `me.perspectives`; `RolesTab.tsx` is the role builder and
`AreasTab.tsx` the area tree. A refusal no longer shows the raw
`NOT_AUTHORIZED` code — `InlineMessage` runs it through `refusalPhrase()`
from `@repo/permissions`. The plan is at
`docs/features/permissions-UI-BUILD.md`, headed with what shipped.

See also [[project_permissions_build_state]].

## Perspectives were NEVER enforced server-side until 2026-10-23

For as long as the feature existed, `principal.perspective` was **always
null**, so `can()` skipped its perspective branch and every route guard —
and `callerCan` — answered at the person's full authority. The UI narrowed
because `GET /me` builds its own list; nothing else did.

Proof, before the fix: a real trainee got **403** from `GET /roles`; the
owner viewing through the *Trainee perspective*, reporting the same 12
capabilities with no `roles.view`, got **200**.

**The cause was two dropped fields.** `services/currentUser.ts` selected
`isPerspective` and `perspectiveOrder` and then omitted them when building
its `byId` map. `availablePerspectives` filters on `r.isPerspective`, which
was `undefined` for every role, so it returned `[]` → nothing for
`resolvePerspective` to match → null perspective. **`byId as never` at the
call site is what let it compile.** This is the third instance of that one
shape (the perspective ICON was lost the same way, twice) — see
[[reference_prisma_detached_include]]. If a map feeds a function that reads
a field, widen the type; never cast.

**Not a privilege escalation** — a perspective is self-imposed and the
person holds those powers anyway. But the feature was cosmetic, and the
model doc claimed the opposite.

**Audit rows now record the view.** `writeAudit` adds
`viewedAs: { roleId, name }` from an AsyncLocalStorage context opened in an
`onRequest` hook (`lib/requestContext.ts`). A first attempt used
`enterWith` where the perspective is resolved and **failed silently** —
Fastify runs the handler in a sibling async context, so the store was gone
by the time `writeAudit` read it, and rows simply had no perspective.
Open the store with `run()` at `onRequest`, then mutate it.

**Copy that was false:** the confirm dialog said "The audit log flags this
action as impersonated" — untrue twice (a perspective impersonates nobody,
and nothing was recorded). It now reads "The action runs with your full
authority, and the audit records you".
