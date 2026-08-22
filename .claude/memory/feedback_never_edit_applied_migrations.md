---
name: feedback-never-edit-applied-migrations
description: "Once `prisma migrate dev` has applied a migration.sql file to any database, that file is FROZEN. Never edit it — write a new migration instead. Editing produces checksum drift that breaks migrate dev on dev and can strand prod."
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:21:21.438Z
---

Once `prisma migrate dev` has applied a migration.sql file to any database, that file is FROZEN forever. It represents a promise: "this is the exact SQL that was run on the database at this timestamp." Prisma's `_prisma_migrations` table stores a checksum of the applied file to enforce this. Editing the file — even to add a backfill statement, even in the same session, even before committing — makes the checksum drift and blocks all future `migrate dev` runs on that DB until the drift is resolved.

**Why:** Prod deploys via `prisma migrate deploy`, which reads the file as-it-is-on-disk. If dev's `_prisma_migrations` checksum reflects the pre-edit content but the file on disk has been changed, then:
- Dev is stuck (drift blocks new `migrate dev`).
- Prod's fate depends on whether prod has already applied the file. If yes → prod is on the pre-edit version, and the next deploy will fail with checksum mismatch. If no → prod applies the edited version, and dev + prod diverge.

**How to apply:** If you need to add a backfill, tweak logic, or fix anything about a migration file after `migrate dev` has run it — even in the same session — write a **new** migration:
```
npx prisma migrate dev --name backfill_foo_bar
```
The new migration references the columns/tables the previous one added; Prisma runs them in order. This is what migration ordering exists for. Never edit an applied file, no matter how trivial the change looks. If tempted, stop and write the new migration.

**The pattern that caused this:** In session `d1686705`, I created migration `add_payment_request_history` via `migrate dev` (Prisma generated just the two `ALTER TABLE` lines). It applied to dev. I then edited the file to add a backfill `UPDATE` statement so it would "run when this deploys to prod," and ran the backfill separately on dev via `prisma db execute`. The user's dev DB then had a checksum for the 2-line version, but the file on disk was 13 lines. Nine days later, when a NEW migration needed to be applied, Prisma refused because of the drift, forcing a non-destructive checksum resync fix. The correct move at the time would have been a second migration named e.g. `backfill_payment_request_first_sent_at`.

The user's [[feedback-prisma-migrations]] memory already covers "never `db push`" but did not explicitly forbid post-apply edits. This memory is the missing piece. See also [[feedback-apply-migration-to-dev-immediately]] for the companion "apply promptly" rule.
