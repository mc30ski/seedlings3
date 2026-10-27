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
plus `enforceAssigneeInvariants(tx, occurrenceId, actor)`. Gated by
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

**How to apply:** both gates are now the same question —
`isClaimer || canManageSchedule`, i.e. `schedule.manage`, on the client and
on the server. It used to be the tab's view flag on one side against a role
flag on the other — two different things that could disagree. A
SUPER in Worker view therefore sees a stricter UI than the server enforces —
which is why this hid for months behind "just switch to Admin and it works".
See also [[feedback_role_resolution_from_req_user]] and
[[reference_build_gates_roster]].

## Second invariant, same chokepoint (2026-10-12)

`enforceAssigneeInvariants` (renamed from `enforceClaimerInvariant`) now
enforces a second rule: **only a paid person takes a paid seat**. A
non-observer assignee must satisfy `isPaid()` — EMPLOYEE or CONTRACTOR.
UNPAID, or no worker type at all, means observer only.

Why it is in the same function: it has to run BEFORE the claimer repair,
because demoting someone can remove the claimer. Putting it in a separate
exported function callers must remember would rot the way the claimer
invariant did across four write paths.

Why it matters: `rateFor` refuses to price a worker with no pay class, so an
unpaid person in a paid seat makes `computeBreakdown` throw — the visit
cannot be completed by anyone. Proven by execution, not inferred.

A row whose `workerType` was not loaded is **left alone**. Reading an absent
join as "not on payroll" would demote a whole team over a missing `select`.

Gate: G33 in `claimer-invariant-build-gate.test.ts`. Boundary refusal is
`canHoldPaidSeat` in `changeAssigneeRole`; `setWorkerType` vacates open paid
seats when someone leaves payroll, and leaves COMPLETED work alone.

## The WEB had eleven copies of the rule (2026-10-27)

The server rule is one line in `updateOccurrenceStatus`. The web wrote it out
at **eleven** callsites, and **four** were wrong — found only because a
production visit showed three different answers on one screen:

- the card line said David (an OBSERVER) was "Claimer - Lead Worker"
- the Manage Team dialog badged Michael "Claimer"
- the API considered the visit to have **no claimer**

Two defects. `JobsTab.tsx` and `ServicesTab.tsx` computed
`assignedById === userId` without `&& role !== "observer"`, and tested that
flag FIRST in the label ternary, so a self-assigned observer could never even
render as "Observer". Worse, `TeamMemberList.getClaimerUserId` ended
`?? nonObservers[0]` — when nobody had self-assigned it **invented** a
claimer, which is precisely the broken state the invariant exists to surface.
A guessed claimer makes "workers, no claimer" look normal.

Now: **one definition**, `assigneeIsClaimer` in
`apps/web/src/ui/tabs/JobsTab.utils.ts`, and the gate's "server and UI still
agree" test forbids `assignedById === ` anywhere else under `apps/web/src`.
That test used to pin ONE literal in `JobsTab.tsx` — which proved nothing
about the other ten copies. Don't weaken it back to a single-literal check.

**Fallbacks are the trap, not the missing half.** A caller that needs a
person to act as (a view-as target, a "lead" name on a collapsed card) picks
its own fallback at the callsite and must not call the result "Claimer".

**You could never claim a visit yourself.** `TeamMemberList` gates its whole
control row on `!isMe`, so Make Claimer appeared on everyone's card but
yours. Invisible for as long as the dialog pretended you already were the
claimer. Your own card now gets a **Claim** button; `reassign-claimer` always
accepted your own id.

**Where leaderless rows came from in prod:** completing a visit generates the
next one and copies the default crew, taking `assigneeSource[0]` as claimer
with no role check (`jobs.ts:339`). If a job's default crew lists an observer
first, the visit is born with an observer nominated — then repaired by
`enforceAssigneeInvariants`. Correct by cleanup, not by construction. The
rows that shipped predate the enforcer (first commit 2026-09-30).
