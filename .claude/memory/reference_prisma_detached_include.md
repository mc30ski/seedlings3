---
name: reference-prisma-detached-include
description: A Prisma include/select lifted into its own const is NOT key-checked by TypeScript — it 500s at runtime instead.
metadata:
  type: reference
---

TypeScript excess-property-checks only a FRESH object literal at the call
site. Lift a Prisma `include`/`select` into its own `const` and TS stops
checking its keys entirely — it can name a relation that does not exist and
still compile clean. The failure appears only at runtime, from the database,
as a bare Fastify 500.

Shipped to production 2026-09-08: `BusinessExpense.supplyPurchase` became
`supplyPurchases` (list) when the ledger link went many-to-one; the detached
include in `apps/api/src/routes/admin.ts` still said `supplyPurchase`. Both
apps typechecked, 1047 gate tests passed, the Ledger tab was down.

**Correct form:** `Prisma.validator<Prisma.<Model>Include>()({ ... })` — it
key-checks AND preserves the literal type, so downstream payload inference
stays narrow. A bare `: Prisma.XInclude` annotation checks the keys but
WIDENS the result, which breaks callers reading nested relations (it broke
`groups.ts` → `worker.ts` `m.user`).

Mechanically enforced by the "a detached Prisma include/select is
type-annotated" test in
`apps/api/src/services/job-materials-build-gate.test.ts`. See
[[feedback-never-ship-a-red-spec]] for how it reached production.
