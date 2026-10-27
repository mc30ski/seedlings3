---
name: reference-role-grant-rules
description: "A person holds one ladder rung plus any number of other roles. isSystem is provenance only; isLadderRung carries the exclusivity rule."
metadata:
  node_type: memory
  type: reference
---

**A person may hold any number of roles.** What they can do is the union of
all of them, each flattened through inheritance, then the payroll gate, then
narrowed by any active perspective. Two shapes are refused by
`customRoles.assign`, both about duplication rather than danger:

1. **Two rungs of the starter ladder** (`ONE_LADDER_ROLE`) — each rung
   already contains the one below.
2. **Two roles in one inheritance chain** (`SAME_ROLE_CHAIN`) — the union is
   just the wider of the two, and provenance becomes ambiguous. Roles that
   merely OVERLAP are fine and stack.

**`isLadderRung` carries rule 1, not `isSystem`.** `isSystem` means "the
install script made it", which is SEVEN roles: the four rungs plus Field
Clearance and the two "May …" exception roles. Those three exist to be
granted ON TOP of a rung, and while the rule read `isSystem` they could
never be granted to anyone holding one — verified on dev, both returned
`ONE_DEFAULTS_ROLE`. `isSystem` is now provenance only and gates nothing.

**The same conflation hid it.** `UsersTab`'s picker filtered out
`isPerspective`, reasoning a perspective is a lens rather than a role to
hand out. All four rungs ARE perspectives, so the ladder could not be
granted from that screen at all — which is why nobody noticed the rule
underneath refused every grant. **Being offered as a lens and being
grantable are different properties.** So are "installed by the script" and
"a rung of the ladder".

**Promotion is one endpoint**, `POST /users/:id/roles/move` → `moveLadderRung`.
Revoke-then-grant leaves a window with no rung, and a failure on the second
call demotes somebody the operator was promoting. One audit row carries
`movedFromRoleName`, so a promotion does not read as a revocation followed
by a grant.

**Deleting a role is allowed, including a starter one.** Suspend first
(reversible, shows who loses what), then delete; both now require typing the
role's name. `UserCustomRole.customRoleId` and `AreaAssignment.customRoleId`
CASCADE, so the grants go with it, and `install-starter-roles.ts` recreates
roles while granting them to NOBODY. The way back is
**`scripts/grant-role.ts`** (`--email`, `--role`, dry run by default), which
exists precisely so the delete guard could come off.

**Perspective order** is global and dense: `PUT /roles/perspectives/order`
takes the whole ordered array and rewrites `1..n`. A per-role integer cannot
hold a total order — dev had "Coordinator" at `null`, which the dropdown's
`(a.perspectiveOrder ?? 0)` sort put ABOVE the entire ladder. Roles tab →
Perspective order.

Related: [[reference-capabilities-model]],
[[reference-client-vs-worker-boundary]], [[feedback-names-carry-meaning]].


**THE MIGRATION AND THE INSTALLER DRIFTED — fixed 2026-10-27.** The
2026-10-12 `convert_roles_to_grants` migration HAND-COPIED the starter-role
set from `install-starter-roles.ts`. By 2026-10-26 **six of eight roles
disagreed**: Super short 12 entitlements (incl. `money.approve`,
`people.approve`, `books.export-tax`, `reports.business`), Admin holding 4
that had moved up to Super, Trainee holding a `reports.view` policy had
removed, and three roles absent entirely (district-lead, the two
exceptions). Promoting with only the migration would have shipped that.

Fix: `ALL_STARTER_ROLES` is now **exported**, and
`scripts/generate-starter-roles-migration.ts` GENERATES the catch-up
migration from it — a generator cannot drift from its own input. Migration
`20261027090000_starter_roles_to_current_policy` is its output; do not
hand-edit it, regenerate it.

**Never hand-copy that set into SQL again.** That is the whole lesson.

Proven three ways before shipping:
1. the generator's definitions match the dev database the installer built
   (8/8 roles, entitlements + inheritance + perspective order + icons);
2. applying it to an already-current database changes NOTHING — including
   every role id, so no grant is orphaned;
3. applying it to a database deliberately drifted to production's state
   restores Super to exactly its pre-drift 25 entitlements, recreates
   district-lead, and sets `STAFF_DEFAULT_ROLE_ID` to the Worker rung.

A caveat for whoever verifies next: `install-starter-roles.ts` with no
`--apply` prints the FULL set it would install, not a diff — so "it still
lists the roles" is not evidence of drift. Compare against the database.
