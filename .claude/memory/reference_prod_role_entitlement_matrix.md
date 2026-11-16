---
name: reference_prod_role_entitlement_matrix
description: "Production role grants, re-read 2026-11-15: full entitlement counts for all 12 roles, who holds schedule.manage vs schedule.view-all, and Auditor as the complete read-only tier"
metadata:
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-15T00:00:00.000Z
---

Re-read from the production database **2026-11-15** (read-only), resolving
inheritance to effective sets. Supersedes the 2026-11-09 read. **Grants change in the role
builder without a deploy — re-read before relying on this.**

| Role | holders | `schedule.manage` | `schedule.view-all` |
|---|---|---|---|
| Super | 3 | Y | Y |
| Admin | 1 | Y | Y |
| **Auditor** (custom) | **2** (was 1 — see below) | — | **Y** |
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


## Effective entitlement counts, all 12 roles (2026-11-15)

Super 68 · Portfolio Lead 44 · Admin 43 · **Auditor 25** · Coordinator 19 ·
Worker 17 · Trainee 14 · Bookkeeper 7 · Payroll 4 · Field Clearance 3 ·
the two "May …" exceptions 1 each.

Inheritance in prod: Super ← Admin ← Worker ← Trainee; Portfolio Lead ← Admin;
Coordinator ← Trainee. **Auditor, Bookkeeper and Payroll inherit NOTHING** —
deliberate, and the Bookkeeper description says why: "the point of this role
is the half it does NOT have."

## AUDITOR IS THE COMPLETE READ-ONLY TIER

Verified by filtering its 25 entitlements for anything that can change
something (`.manage` `.approve` `.record` `.adjust` `.define` `.grant-roles`
`.claim` `.complete` `.charge` `.hold` `.pull` `.send` …): **none matched.**
It holds essentially every `.view` in the system plus `schedule.view-all`,
`reports.business`, `books.view` and `forecasts.view`. The only read-ish
thing it lacks is `routes.plan`.

**It includes `payroll.view`, `books.view`, `time.view` and `audit.view`** —
so an Auditor sees what every person is paid and the log of who changed
what. Say that out loud before granting it; the narrower build is a clone
without `payroll.view`.

**Second holder added 2026-11-15**: the operator's wife, as an observer
(`workerType = UNPAID`, Auditor only). The pattern for "someone who should
see the business but take no part in it" is **UNPAID + Auditor** — UNPAID
passes the payroll gate so the app opens, while `isPaid()` stays false so
they can never take a paid seat (G33) or reach a payroll export.

## Adding an observer: the order, and where it bites

`STAFF_DEFAULT_ROLE_ID` is SET in prod and resolves to **Worker**, so
"Approve as Worker" auto-grants field clearance (`work.claim`,
`work.complete`, `inventory.pull`) that an observer must not keep.
**Remove the Worker chip BEFORE setting the pay class** — while the account
is unclassified every grant is dormant, so removing it then costs nothing;
set the pay class first and field clearance activates for real.

This account did land in `approved + roled + unclassified` — the state the
Approve-as-Worker modal exists to prevent by PATCHing the worker type
before approving. The row said so plainly ("No pay class — this person can
do nothing"), so the UI caught it. **Which path produced it was never
established** — offered to read the audit trail, not taken up. If it
recurs, that is the thread to pull.
