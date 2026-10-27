---
name: project_ui_plan_from_backend_changes
description: "What the 2026-10-13 backend/API changes oblige the UI to do — verified consumer-by-consumer, with the one latent crash"
metadata:
  node_type: memory
  type: project
  modified: 2026-10-13T00:00:00.000Z
---

**Written 2026-10-13, after the backend hardening pass.** Every item below was
checked against the ACTUAL web consumers, not inferred from the API diff. The
headline is reassuring and the exception matters:

**Nothing in the web app is broken right now by the entitlement narrowings** —
but one change is a landmine, and several surfaces are now allowed to show
more than they do.

Master plan lives at `docs/features/permissions-UI-BUILD.md`. This file is the
derivation; the doc is the work list.

## 1. THE LATENT CRASH — `StatisticsTab`

`/statistics` and `/operations` now OMIT the per-worker money columns
(`totalEarnings`, `netEarnings`, `totalExpenses`, plus `wageGross` and
`avgHourlyRate` on `/operations`) unless the caller holds `payroll.view`.

`StatisticsTab.tsx` renders them unguarded:

```
w.netEarnings.toFixed(2)      // line ~327
w.totalEarnings.toFixed(2)    // line ~341
active.reduce((s, w) => s + w.netEarnings, 0)   // line ~162
```

With the field absent that is **`TypeError: Cannot read properties of
undefined (reading 'toFixed')`** — a crash, not a blank, plus a NaN average.

**Why it is not live:** StatisticsTab is COMMENTED OUT of both the worker and
the shell (`pages/index.tsx` ~65-71, ~1067, ~1765), and `/operations`'s
`workerStats` has **no web consumer at all**. So nobody can reach it today.

**The trap:** whoever re-wires that tab hits the crash, and it will look like
a UI bug rather than a contract change. Gate those StatBoxes on
`scope.can("payroll.view")` BEFORE re-mounting. Do not "fix" it by having the
server send 0 — a zero reads as "earned nothing", which is a lie.

## 2. Surfaces now ALLOWED to show more than they do

Widenings, so nothing breaks — but the UI is now stricter than the API, which
is the drift G15 exists to catch.

- ~~Guides approval queue → `content.view`.~~ **REVERTED — the change and
  this recommendation were both wrong.** `education.md`'s capability table
  gives Approve / publish / send back to Super ALONE, and
  `scheduler-guides.spec.ts` asserts someone with `schedule.manage` gets 403 from
  `/api/guides/pending-approvals{,/count}`. I re-pointed those guards at
  `content.view` on the strength of that entitlement's one-line copy, which
  does not outrank a feature spec plus an explicit test. Guards are back on
  `content.approve`; the COPY is now "See guide drafts and the media library",
  because the copy was the defect.
  **Entitlement copy is a label, not policy.** When copy and a feature spec
  disagree, the spec wins and the copy gets fixed.
- **Marketing reads.** Six pure content reads moved `marketing.manage` →
  `marketing.view` (`/promotions`, `/promotions/:id`,
  `/promotions/allowed-domains`, `/vanity`, `/vanity/:id`,
  `/vanity/animation-settings`). `marketing.view` is held by baseline
  Trainee, so a read-only promotions view is now possible for everyone.
  `PromotionsTab`/`VanityUrlsTab` are admin surfaces; decide whether a
  read-only mount is wanted. **Do not widen the PII reads** —
  `/promotions/contacts`, `…/deliveries`, `…/landing`, `…/invoice-photos`
  stay on `manage`.

## 3. Reads that now redact — hide the control, don't render undefined

- **`GET /users` and `/users/:id`** keep `people.view` but drop
  `hourlyWage`, `email`, `phone`, `homeBaseAddress` (and on the list,
  `roleGrants` + `capabilities`) unless the caller holds `people.manage`.
  Verified consumers — `UsersTab`, `HistoryTab`, `PreviewRoutesTab` — are all
  admin surfaces that hold `people.manage`, so they are unaffected. If any of
  those is ever mounted for a worker, the columns must be gated on
  `scope.can("people.manage")` rather than rendering blanks.
- **`/users/:id/earnings-summary`** moved `people.view` → `payroll.view`.
  `ProfileTab`'s `EarningsSection` catches the error and renders nothing, so a
  non-holder sees no earnings block instead of a crash. Graceful today; make
  it an explicit capability check rather than a silent catch.

## 4. New API behaviours the UI should speak

- **`REFERENCED_RECORD_NOT_FOUND` (404)** is new, from mapping Prisma P2003.
  It fires when a referenced row is gone — pin/like a visit that was archived
  while it was on screen, dismiss a deleted banner. The message is already
  human ("…may have been archived or deleted — refresh and try again"), so
  `getErrorMessage()` renders something usable. Better: treat it as a signal
  to refresh the list rather than only showing a toast.
- **`GET /occurrences/:id/comms-handoff`** now requires you to be ON the
  visit, or to hold `money.record` / `schedule.manage`. Claimers and holders of `schedule.manage`
  both satisfy that, so `PaymentCommsButtons` and `JobsTab` are unaffected —
  but the UI should not OFFER the handoff to a worker who is not on the visit.
- **`POST /occurrences/:occurrenceId/mark-paid`** (was `admin-mark-paid`). The
  single caller in `OutstandingRequestsSection` is updated.

## 5. The homeless-user problem is now PROVEN, not hypothetical

`coordinator`, `bookkeeper`, `payroll` and `unpaid` are real accounts that
authenticate and hold **ZERO capabilities**. (The surface-flag factory is
deleted; the equivalent today is that no `TAB_REQUIREMENTS` row matches.) There is
no tab to land on and no
`topTab` that makes sense.

Two separate pieces of work:
1. **UI** — a capability-driven landing surface, and a legible "you have no
   access yet" state instead of an empty shell. This is
   `permissions-UI-BUILD.md` §2's "a custom role is not homeless", with four
   live accounts proving it.
2. **SEED** — those three personas are not in `apps/api/prisma/seed.ts` at all (only
   `unpaid` is, deliberately, with `roleKey: null`). Until they get grants,
   the intended office-staff / books-without-payroll / payroll-without-books
   surfaces cannot be exercised by anyone, UI or test. See
   [[project_permissions_build_state]].

## 6. Carried over, unchanged by today

- The 403 path still renders the literal string `NOT_AUTHORIZED` to the user.
- `UsersTab`'s `addRole`/`removeRole` still speak the deleted enum and fail;
  they are now typed `LegacyRoleName` so the breakage is visible.
- The web surface type is `Surface`, not `Role` (G37 enforces it).
- `/api/me` still ships `privileges: { canPullInventory,
  canChargeBusinessExpenses }` — dropped column NAMES carrying capability
  values. ~10 consumers. Renaming is a coordinated API+web change, not done.

See also [[reference_api_e2e_suite]], [[reference_capabilities_model]],
[[reference_tab_blend_pattern]].
