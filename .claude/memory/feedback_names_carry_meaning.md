---
name: feedback-names-carry-meaning
description: "Names must carry their intent — brevity is the wrong optimization function, especially for shared/exported/schema names that are read far from their definition."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
---

Variable / field / function names must carry enough of their meaning
that a reader at the callsite can't misinterpret them. Brevity is not
a virtue when it lets ambiguity in. No one cares about the character
count; everyone cares about the bugs ambiguous names produce.

**Why:** A boolean on `JobOccurrence` named for a role read like a
visibility rule ("only holders of `schedule.manage` can see it"). It was actually an assignment
rule — the checkbox label is `"Administered (workers cannot claim, must
be assigned)"`. During a client-visibility audit I filtered it out of
`/client/jobs` and `/client/upcoming` because
the name suggested that's what it meant. It didn't. Result: legitimate
completed jobs stopped showing to clients in production. Hours of
debugging that a name like `requiresAdminAssignment` or
`workersCannotSelfClaim` would have prevented outright.

**How to apply:**
- Schema fields, exported types, shared enums, prop names, event names,
  route params: err strongly toward names that encode the actual
  behavior, not a shorter approximation. Two seconds of typing beats a
  production bug.
- Boolean flags: name the specific behavior, not the category. Bad:
  `isSpecial`, `isRestricted`, or anything named for a role. Good:
  `mustBeAssigned`, `workersCannotSelfClaim`, `hiddenFromClientPortal`.
- Local scoped names (loop indices, single-callsite temporaries) can
  stay short. The rule is scoped to names that will be read at a
  distance from their definition.
- When touching a badly-named field mid-task, offer a rename. Don't
  silently accept the ambiguity because it's inherited; that's how the
  ambiguity turns into a fourth production bug.

**RESOLVED 2026-10-17.** That field is now `JobOccurrence.mustBeAssigned`,
renamed by a hand-written `ALTER TABLE … RENAME COLUMN` migration —
`prisma migrate dev` cannot tell a rename from a drop-plus-add and would
have emitted DROP + ADD, silently resetting every flagged visit to false.
~30 callsites, mechanical. The schema comment now also says outright: do
not filter client-facing queries on it.
