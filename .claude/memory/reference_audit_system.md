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
| Operator-facing trail | `apps/web/src/ui/tabs/HistoryTab.tsx` → `GET /api/admin/audit` |

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

Related: [[feedback-audit-every-mutation]], [[feedback-prisma-migrations]],
[[feedback-run-build-gate-after-changes]].
