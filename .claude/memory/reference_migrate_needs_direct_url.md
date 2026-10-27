---
name: reference-migrate-needs-direct-url
description: "The Schema Engine must not go through the Neon pooler. schema.prisma declares directUrl = env(\"DIRECT_URL\"); any command that sets DATABASE_URL by hand must set DIRECT_URL too or it silently migrates the WRONG branch."
metadata:
  node_type: memory
  type: reference
---

Both Neon URLs in `apps/api/.env` are `-pooler` hosts. That is right for Prisma
Client and wrong for `migrate`: a migration takes a Postgres advisory lock, and
under transaction pooling the backend that takes it is not the one that returns
to release it, so the lock strands. A `prisma migrate deploy` hung this way on
2026-10-22 and the backend had to be killed by hand.

Fixed 2026-10-23: `apps/api/prisma/schema.prisma` declares
`directUrl = env("DIRECT_URL")`, and `.env` carries a `DIRECT_URL` beside each
`DATABASE_URL` — the same string with `-pooler` removed. `url` stays pooled.

**The trap this created, and why `script.db.prod.sh` sets both variables.**
Once `directUrl` exists, every Schema Engine command reads `DIRECT_URL` and
ignores `DATABASE_URL` for the connection it migrates. A command that overrides
only `DATABASE_URL="<prod>"` therefore picks up the **dev** `DIRECT_URL` from
`.env` and migrates DEV while printing PRODUCTION at every step. The script
derives `PROD_DIRECT_URL` from `PROD_URL` by stripping `-pooler` (so the two can
never name different branches) and passes both, with four refusals around the
derivation. Any new script that sets `DATABASE_URL` inline for a migrate / db
push / db pull must do the same.

**Vercel needs nothing.** `prisma generate` does not resolve datasource env
vars — verified by running it with `DIRECT_URL` unset — so `postinstall` on a
deploy is unaffected, and Prisma Client at runtime only uses `url`. `prisma
validate`, `migrate` and `db` DO fail hard on an unset `DIRECT_URL`; those only
run by hand or through the script.

Related: [[feedback-prisma-migrations]] · [[feedback-never-write-production-db]]
· [[project-neon-pipelineconnect-workaround]]
