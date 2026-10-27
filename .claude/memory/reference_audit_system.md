---
name: reference-audit-system
description: "How audit logging works in this repo — writeAudit convention, where AUDIT constants live, the fact that AuditScope/AuditVerb are Prisma enums requiring a migration, and where the operator reads the trail."
metadata:
  node_type: memory
  type: reference
---

# Audit system mechanics

The rule that you must always audit is [[feedback-audit-every-mutation]].
This file is the *how*.

## The call

```ts
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";

await writeAudit(tx, AUDIT.SCOPE.VERB, currentUserId, { ...metadata });
```

- **Pass `tx`, not `prisma`.** The audit row must commit atomically with
  the mutation. If a bare `prisma.x.create` has no surrounding
  transaction, wrap it in one rather than auditing outside it.
- `actorUserId` may be `null` for genuinely anonymous flows (a client
  clicking an unsubscribe link). It must NOT be null just because the
  service signature forgot to carry the actor — thread the parameter
  through instead. Several functions historically shipped with no actor
  param at all; the routes had `await currentUserId(req)` available and
  simply never passed it.
- `metadata` is free-form JSON. Keep it flat and serializable.

## Where things live

| Thing | Path |
|---|---|
| `writeAudit` helper | `apps/api/src/lib/auditLogger.ts` |
| `AUDIT` constants | `apps/api/src/lib/auditActions.ts` |
| `AuditScope` / `AuditVerb` enums | `apps/api/prisma/schema.prisma` |
| `AuditEvent` model | `apps/api/prisma/schema.prisma` |
| Operator-facing trail | `apps/web/src/ui/tabs/HistoryTab.tsx` → `GET /api/audit` |

## Adding a new scope or verb requires a MIGRATION

`AuditScope` and `AuditVerb` are **Prisma enums**, not strings. A new
domain needs:

1. New value(s) in the enums in `schema.prisma`.
2. `npx prisma migrate dev --name add_audit_...` (never `db push` —
   see [[feedback-prisma-migrations]]).
3. New constant(s) in `auditActions.ts` mapping scope+verb.

No frontend work is needed: `HistoryTab` queries with pagination and a
date range only, and hardcodes no scope list, so new scopes surface
automatically.

Reuse an existing verb with a metadata discriminator when the action is a
variant of one already covered — the file's convention is to keep the
enum small (`USER.PRIVILEGES_UPDATED` is `[USER, UPDATED]` with the
detail in metadata). Add a distinct verb when the action is genuinely
different in kind, especially destructive ones: `OCCURRENCE_ARCHIVED`
maps to `RETIRED` and would misrepresent a hard delete, which is why
`OCCURRENCE_DELETED` exists separately.

## Scopes as of 2026-08-22

`USER · EQUIPMENT · CLIENT · JOB · PROPERTY · SETTING · NOTIFICATION ·
DOCUMENT · TIMELINE · BANNER · PAYMENT · EXPORT · WORKDAY ·
LEDGER_FOLLOWUP · POLICY_DOCUMENT · POLICY_SIGNATURE · PROMOTION ·
PROMO_OPT · VANITY · EXPENSE · SUPPLY · MILEAGE · GROUP · VEHICLE ·
CHANGE_REQUEST · EQUIPMENT_COLLECTION · CALENDAR_FEED`

The last eight were added on 2026-08-22 by the coverage sweep. `EXPENSE`
deliberately covers BOTH the job-linked `Expense` and its paired
tax-ledger `BusinessExpense` — they are written and deleted as a pair, so
one scope with a metadata discriminator beats two that always co-fire.

## Metadata patterns worth copying

- **Destructive**: snapshot the destroyed row *before* the delete —
  `PAYMENT.DELETED` carries `amountPaid`, `method`, `receiptNumber`, and
  the full `splits[]`, because after the cascade nothing else survives.
- **Money edits**: `{ changes: { field: { from, to } } }` rather than the
  new value alone.
- **Acting on someone else's behalf**: record both the actor and the
  subject (`superCreateMileageEntry` logs `actorUserId` *and*
  `driverUserId`).
- **Bulk operations**: one row for the batch with the affected ids and a
  total, not N rows.

## Two rules the gate now enforces mechanically (2026-10-22)

`audit-coverage-build-gate.test.ts` was a per-file count ratchet only, so
it could not see a WRONG audit row — only a missing one. Two checks were
added after an audit sweep found both shapes live:

1. **An audit row may not precede its own mutation.** `writeAudit(prisma,
   …)` followed within 6 lines by a bare-client `prisma.x.delete(…)`
   fails the build. `DELETE /pricing/:key` did exactly this, so a delete
   that threw left a row asserting a deletion that never happened.
2. **A `create*` / `update*` function may not write an ASSIGNED or
   REMOVED verb.** `customRoles.create` and `.update` both wrote
   `ROLE_ASSIGNED`, so defining a role and editing its icon read as
   somebody being granted one. Both carried a correct metadata
   `action:` string, which is why it survived: open a row and you saw
   the truth, filter by verb and you did not.

The lesson generalises — **the metadata `action:` string is a refinement,
never a correction.** `EQUIPMENT.UPDATED` + `action: "photo_added"` is
right; `ROLE_ASSIGNED` + `action: "role_created"` is a lie with a
footnote. The web's `entryLabel` builds its text from scope + verb alone
and never reads the metadata, so a wrong verb is what the operator reads.

**A read event is invisible to the ratchet.** It counts Prisma *writes*,
so a GET that hands out data scores perfectly while auditing nothing —
which is how five tax-export CSV endpoints (`books.export-tax`) ran
unaudited for their whole life despite `AUDIT.EXPORT.DOWNLOADED` existing
with a doc comment promising otherwise. Audit downloads deliberately; no
gate will ask.

Related: [[feedback-audit-every-mutation]], [[feedback-prisma-migrations]],
[[feedback-run-build-gate-after-changes]].
