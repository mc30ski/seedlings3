---
name: project_dev_migration_history_baselined
description: Dev's _prisma_migrations table went missing and was baselined 2026-10-11 — migrate dev works again
metadata:
  node_type: memory
  type: project
---

**2026-10-11:** the Neon dev database (`ep-jolly-wildflower-adh5uaav`,
`neondb`) had **no `_prisma_migrations` table** while 223 migrations sat on
disk. `prisma migrate dev` therefore read total drift and offered only a
reset, which broke the documented workflow in `README.md:141`.

Dev's live schema was verified **identical** to `schema.prisma` (empty
`migrate diff`), so the schema was never the problem — only the bookkeeping.
Fixed by baselining: `npx prisma migrate resolve --applied <name>` for all
223. Result: 223 rows, 0 failed, `migrate status` → "Database schema is up to
date!", all data counts unchanged.

**How it went missing is unknown.** 198 of the 223 folders carry `migrate
dev`'s own 14-digit timestamp, so `migrate dev` worked here many times and
the table existed. A past `db push` or manual drop is the likely cause.
Neon's branch operations log is the only record that could date it. Do not
assume dev "has always used db push" — that was a wrong guess made during
this incident.

Also established: the `neondb_owner` role has **CREATEDB = true**, so
`migrate dev` can create its own shadow database. `shadowDatabaseUrl` in
`schema.prisma` has been commented out since the first commit and does not
need to be set.

**The workflow, restored and unchanged:**
1. Edit `schema.prisma`
2. `npm -w apps/api run prisma:migrate:dev` — writes the migration file AND
   applies it to Neon dev
3. User promotes: `npm -w apps/api run migrate:deploy` (verify → migrate →
   verify, via `apps/api/scripts/migrate-deploy.ts`)

See also [[feedback_prisma_migrations]],
[[feedback_apply_migration_to_dev_immediately]],
[[reference_readme_holds_procedures]].
