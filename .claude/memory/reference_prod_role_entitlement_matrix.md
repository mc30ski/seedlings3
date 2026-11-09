---
name: reference_prod_role_entitlement_matrix
description: "Production role grants - who actually holds schedule.manage vs schedule.view-all, and the two roles that hold one without the other"
metadata:
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-09T15:57:22.076Z
---

Read from the production database 2026-11-09 (read-only), with the one
change the operator made that day folded in. **Grants change in the role
builder without a deploy — re-read before relying on this.**

| Role | holders | `schedule.manage` | `schedule.view-all` |
|---|---|---|---|
| Super | 3 | Y | Y |
| Admin | 1 | Y | Y |
| **Auditor** (custom) | 1 | — | **Y** |
| **Coordinator** (custom) | 1 | **Y** | **Y — granted 2026-11-09** |
| Bookkeeper (custom) | 1 | — | — |
| Payroll (custom) | 1 | — | — |
| Worker | 3 | — | — |
| Trainee / Portfolio Lead / Field Clearance / the two "May …" exceptions | 0 | — | — |

**The two middle rows are the point.** No single entitlement covers both
"runs the schedule" and "watches the whole book":

- **Coordinator held `schedule.manage` WITHOUT `schedule.view-all`** until
  2026-11-09, when the operator granted it so Work → Repeating would open for
  them. The gap is worth remembering even though it is closed: a role that
  manages the whole schedule but is not declared able to SEE every visit is
  leaning on field clearance it does not have (Coordinator inherits Trainee,
  not Worker, so no `work.claim`). **The dev seed's Coordinator still lacks
  it** — `apps/api/prisma/seed.ts` EXAMPLE_ROLES — so the `coordinator`
  Playwright persona is still the manage-without-view-all case, which is what
  the persona sweep asserts against.
- **Auditor holds `schedule.view-all` WITHOUT `schedule.manage`** — the
  read-only oversight tier is REAL in production, not theoretical. Any
  whole-book screen must render for somebody who cannot act on it.

**Why:** `requires()` takes exactly ONE entitlement, so a route cannot say
"either of these". Picking the guard therefore picks who gets the feature, and
both halves of this split are live people. The dev seed has Coordinator,
Bookkeeper and Payroll as example custom roles but **no Auditor**, so the
read-only tier has no Playwright persona — build gates stand in for it.

**How to apply:** when gating a new whole-book read, use `schedule.view-all`
and expect to tell the operator that Coordinator needs the grant. See
[[reference_capabilities_model]] and [[project_repeating_tab]]. Prod URL is
commented out in `apps/api/.env` — see
[[reference_prod_db_url_is_commented_in_env]]; reads only, per
[[feedback_never_write_production_db]].
