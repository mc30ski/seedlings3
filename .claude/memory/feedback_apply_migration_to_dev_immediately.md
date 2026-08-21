---
name: feedback-apply-migration-to-dev-immediately
description: "When the schema changes, apply the migration to the dev DB immediately — don't leave it for \"later.\" If `prisma migrate dev` fails (e.g. DB unreachable), retry as soon as the DB is back, before the user hits the broken state at runtime."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:19:29.633Z
---

When schema changes are part of a feature build, applying the migration to dev MUST be part of the same workflow as writing the code that depends on it. Don't ship the code with an unapplied migration.

**Why:** User has been burned by this — built a feature, code looked fine, first runtime interaction returned 500 because the table didn't exist. Two-step thinking ("I'll handcraft the SQL now and apply it later") creates a window where dev DB is out of sync with the code; that window is exactly when bugs sneak in.

**How to apply:**

- Default path: `cd apps/api && npx prisma migrate dev --name <descriptive_name>` — creates the migration file, applies it to dev, AND regenerates the Prisma client in one command.
- If `migrate dev` fails because the DB is unreachable: handcraft the SQL + `npx prisma generate` offline IF you need to keep building, but treat that as a TODO to revisit. The moment the DB is back, run `npx prisma migrate deploy` (or re-run `migrate dev` for a clean apply) before the user can interact with the broken code path.
- Never assume "the migration will get applied at deploy time" for the dev workflow. Dev needs the schema applied as soon as the code that uses it lands.

Related: [[feedback-prisma-migrations]] — never use `db push`, only `prisma migrate dev`. See also [[feedback-never-edit-applied-migrations]] once a migration has run.
