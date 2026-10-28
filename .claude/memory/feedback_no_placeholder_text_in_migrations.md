---
name: feedback_no_placeholder_text_in_migrations
description: Never write placeholder/filler text into user-facing fields from a migration or script — write the real copy or leave it empty
metadata:
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-28T18:24:35.353Z
---

**Never write placeholder text into a user-visible field from a migration
or a script.** Names, descriptions, labels, notes — if a person will read
it, write the real copy, or leave it NULL so it is obviously unset. Never
write a note about the migration itself.

**Why:** migration `20261012170000_convert_roles_to_grants` created the
five starter roles with the description

> "Installed by migration from the legacy Role enum."

It was still there in production on 2026-10-28, on Trainee, Worker, Admin,
Super and Field Clearance — read by the operator every time they opened the
Roles tab, and shown beside a role at the moment somebody grants it, which
is the one place a description has a job to do.

It survived because every later pass is *correctly* conservative:

- the starter-roles catch-up migration carries the real descriptions but
  its `ON CONFLICT DO UPDATE` sets only structural fields
  (`isSystem`, `isLadderRung`, `isPerspective`, `perspectiveOrder`,
  `perspectiveIcon`, `inheritsFromId`);
- `install-starter-roles.ts` says it outright —
  `// name/description are NOT updated: the operator owns the label.`

So the placeholder is permanent until a human retypes it by hand. Dev never
showed the problem, because dev's rows were created by the installer, which
sets the description on INSERT. Only the upgraded database carried it.

**How to apply:** when a migration must create a row carrying user-facing
text, take the final wording from the canonical source — for roles that is
`ALL_STARTER_ROLES` in `apps/api/scripts/install-starter-roles.ts`. Generate
the migration from that source rather than hand-writing copy into SQL. If
the real wording is not known yet, leave the column NULL; an empty
description reads as "nobody has written this", while a plausible sentence
reads as finished and never gets revisited.

The same reasoning covers seeded Settings, seeded role names, and any
default label a migration inserts. See [[feedback_names_carry_meaning]] and
[[feedback_never_edit_applied_migrations]] — the latter is why this cannot
be fixed by editing the original migration.
