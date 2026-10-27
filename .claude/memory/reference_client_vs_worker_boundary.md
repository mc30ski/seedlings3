---
name: reference-client-vs-worker-boundary
description: "Customers are kept out of staff surfaces by the payroll gate, not a client flag. A customer MAY also work for you; the protected thing is the order."
metadata:
  node_type: memory
  type: reference
---

There is **no "client" kind of capability** and no client branch in
authorization. A client contact's login is an ordinary `User` row with no
`workerType`, and `can()` returns false for a null `workerType` **before** it
walks their roles (`packages/permissions/permissions.ts`; **G31** asserts that
ordering, because a gate placed after the walk can be skipped by a lucky early
return). The same gate is repeated in `capabilitiesForUsers`
(`apps/api/src/lib/userCapabilities.ts`) — it originally was NOT, and the two
answered the same question differently: a UI badge from one, a 403 from the
other.

Portal access is orthogonal: `isClientContact` counts ACTIVE `ClientContact`
rows for the caller's Clerk id (`services/users.ts`) and never reads roles.

**A customer may also work for you.** Give them a `workerType` and grant roles
— they then pass the gate like anyone else. Do not write a rule saying
customers hold no roles; it is false.

**The ORDER is the protected thing.** A grant on a customer with no worker
type resolves to nothing today, so it looks harmless. It is **dormant, not
void** — set a worker type on that account later and every grant activates at
once, silently. Worker type FIRST, then grant.

**Enforced in the database since 2026-10-20** by
`20261020140000_client_grants_require_a_worker_type` — the schema's **only
triggers** (there were none before). Three entry points, one shared assertion
`assert_client_grant_has_worker_type`:

1. granting a role to an unclassified customer
2. clearing a worker type off a customer who holds grants
3. attaching a customer contact to an unclassified account that holds grants

They only ever RAISE, never edit, and surface as `check_violation` with a
message saying what to do. **G45** fails the build if the migration or its
triggers disappear. Never catch the violation and grant anyway.

Verified against prod data 2026-10-19: 27 users = 7 staff (all with
`UserRole`) + 20 client contacts (none with `UserRole`), no overlap, so the
conversion leaves every customer with zero grants.

Related: [[reference-capabilities-model]], [[reference-worker-class]],
[[project-permissions-build-state]].
