---
name: feedback-prisma-migrations
description: "Schema changes must go through `prisma migrate dev`, never `db push`. The user has called this out repeatedly and it has caused real deployment problems."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:22:11.522Z
---

Every schema edit to `apps/api/prisma/schema.prisma` must be applied via `npx prisma migrate dev --name <descriptive-name>` so a migration file lands in `apps/api/prisma/migrations/`. Never use `npx prisma db push` — even when it's faster, even when Prisma prompts for a reset, even when "it's just dev."

**Why:** production deploys run `prisma migrate deploy`, which reads migration files. `db push` only updates the dev DB and leaves no record. Repeated db-push usage during a session means production gets stranded on the last migrated schema while the code expects the newer one — deploy will crash or silently behave wrong.

**How to apply:**
- Before touching `schema.prisma`, say out loud (to the user) that a schema change is coming and that you'll run `migrate dev`.
- After saving `schema.prisma`, run `npx prisma migrate dev --name <foo>` from `apps/api/`.
- If Prisma asks to reset the dev DB, **stop and ask the user** — don't fall back to `db push`. The reset prompt usually means there's drift from a prior `db push`; the right answer is to fix the drift via `migrate resolve` or by carefully diffing, not to keep using `db push`.
- If you need to script schema-aware data updates (seed-like work), still do the schema change via `migrate dev` first, then run the data script.

**The pattern that caused this:** the user pointed out the issue once during the session, I agreed not to repeat it, and then I db-pushed every subsequent schema change anyway. The fact that I "knew" was not sufficient. Default to `migrate dev` mechanically. Treat any urge to use `db push` as a flag to slow down and confirm with the user.

Related: [[feedback-apply-migration-to-dev-immediately]] — apply promptly after creating. [[feedback-never-edit-applied-migrations]] — once applied, migration files are frozen forever.
