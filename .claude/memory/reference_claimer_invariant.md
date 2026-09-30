---
name: reference_claimer_invariant
description: An occurrence is UNCLAIMED or has exactly one claimer — canonical helper + build gate; "workers but no claimer" is unstartable
metadata:
  type: reference
---

2026-09-29. `JobOccurrence` is either **UNCLAIMED** (no non-observer
assignees) or has **exactly one claimer** — a non-observer assignee whose
`assignedById === userId`. There is no third state, and "has workers, has no
claimer" is the failure mode that shipped: `updateOccurrenceStatus` throws
NOT_CLAIMER, and the Jobs card hides Start/Complete with no explanation, so
the worker at the property has no controls and no reason given.

Canonical: `apps/api/src/lib/claimerInvariant.ts` — pure `planClaimerRepair(rows)`
plus `enforceClaimerInvariant(tx, occurrenceId, actor)`. Gated by
`claimer-invariant-build-gate.test.ts`: every `jobOccurrenceAssignee` write
either ends its function with the enforcer or carries
`// claimer-invariant-allow: <reason>` directly above it. Repair existing rows
with `npm run repair:claimers` (dry run; `-- --apply` writes).

**Why:** four unrelated write paths produced leaderless visits.
(1) `setOccurrenceAssignees` promoted the new claimer with
`createMany({ skipDuplicates: true })` — createMany cannot UPDATE, and
`@@unique([occurrenceId, userId])` meant the existing row was skipped, so the
promotion silently did nothing. (2) `updateLightEstimate` / `addOccurrenceAssignee`
stamped `assignedById = actorUserId`. (3) `groups.attachGroupToOccurrence` in
admin mode stamped the actor on every row, claimer included, and its `update:`
branch never repaired `assignedById`. (4) `removeOccurrenceAssignee` let an
admin delete the claimer. `assignedById` is also `onDelete: SetNull`, so
deleting a User nulls it.

**How to apply:** the UI gate is `isClaimer || forAdmin` where `forAdmin` is the
VIEW; the server gate is `isClaimer || isAdmin` where `isAdmin` is the ROLE. A
SUPER in Worker view therefore sees a stricter UI than the server enforces —
which is why this hid for months behind "just switch to Admin and it works".
See also [[feedback_role_resolution_from_req_user]] and
[[reference_build_gates_roster]].
