---
name: project_now_tab
description: "Work → Now (built 2026-11-16): the wall display's PRIVATE board, signed in. Reuses buildPrivateBoard — no second derivation of 'today'. Gated schedule.view-all; the timeclock half is withheld SERVER-side on time.view. Landing tab now chosen by capability, never by role."
metadata:
  node_type: memory
  type: project
  modified: 2026-11-16T00:00:00.000Z
---

Canonical spec: `docs/features/now.md`. Read it before changing the tab —
this file is the why-it-exists and the traps.

## It is not a new query

`buildPrivateBoard` (`apps/api/src/services/displays.ts`) already answered
"who is out, what are they on, what is left" — it drives the paired wall
screen. It was unreachable without a *device* token. `GET /board/now` calls
the same builder with the caller's portfolio scope and drops `mode` and
`photos` (the photo URLs need a display token and would 401).

**Do not add a parallel query for this.** A second derivation of "today" is
how two screens disagree about how much work is left — see
[[project_payment_math]] for the Take Payment preview that did exactly that.

`buildPrivateBoard` now takes an optional `BoardScope`. The wall display
passes nothing and is byte-identical to before.

## Gating, and the half that is withheld on the SERVER

- Tab + route: **`schedule.view-all`** — the oversight read, the same rung
  Repeating opens on. Production's Auditor holds it with no schedule write,
  so the board must render for somebody who cannot act on it. See
  [[reference_prod_role_entitlement_matrix]].
- **The timeclock is `time.view`**, which that guard does not imply. The
  route omits `onTheClock` / `assignedNotClockedIn` AND filters the
  `not_clocked_in` row out of `attention` (it names the same people in its
  `detail`). Withheld, not hidden — a panel the browser declines to draw
  over data already sent is one `curl` from being read.
- Those two fields are **optional** in the web type on purpose: `[]` means
  nobody is clocked in, `undefined` means you may not see it, and the tab
  says which. Never conflate "didn't render" with "empty".

## The landing tab is a CAPABILITY question

The staff tab is persisted, so every ordinary load already returns you where
you left off. The **only** override is the first-open-of-the-ET-day takeover
in `pages/index.tsx`, which now lands on
`canSeeTab("now", scopeCan) ? "now" : "home"`.

A role → tab table was the alternative and it is the deleted model rebuilt:
it has to answer for a role nobody anticipated and answers by falling to the
nearest bucket. **If asked for per-role default tabs again, say this.**
See [[reference_capabilities_model]] and [[feedback_names_carry_meaning]].

## The portfolio lens reaches the visits and NOT the hardware

Visits narrow (and everything counted from them, including each worker's
rows). **Vehicles out and equipment out do not** — a truck belongs to the
business, not a territory, and inventing a filter would *under*-report what
is out. Those two panels carry a "business-wide" badge.

`TAB_NARROWING` lists `now` as `{grant: true, lens: true}`, NOT `{part}` —
`{part}` means "company-wide apart from one panel", the opposite of what is
true here. See [[project_repeating_tab]] for the bug that shape prevents.

## Start working: a capability, not a pay class (corrected same day)

The card **navigates to Home** (operator's call — Home is where the day
actually starts; do not re-launch the workflow from the board).

It shipped gated on `me?.workerType` being set. **The operator caught it by
asking "does that section only show up if you have the entitlements to do
work?" — it did not.** An UNPAID observer HAS a worker type, so his wife's
read-only Auditor account was being offered a button to start her working
day. Now `scope.can("work.claim")` (the `isFieldCleared` question) AND
`canSeeTab("home", scope.can)` for the destination. The pay class is
subsumed — `can()` refuses a null `workerType` before walking roles (G31).

Gated in `tab-requirements-build-gate.test.ts`, deliberately scoped to
`NowTab.tsx`: a pay class legitimately decides much of what the app DRAWS,
so a general rule would cry wolf. It is never legitimate for a pay class to
decide whether an ACTION is offered.

## Two things found while building it

- **Home's begin-workday hero was wired to `onLaunchWorkflow={() => {}}`.**
  The whole card was armed — cursor, hover, action row — and clicking it did
  nothing. Shipped that way; the workflow itself was always fine (the Tasks
  shortcut "Prepare for Work Day" launches the same id). Fixed in the same
  change. The Now spec proves the launcher ran by reading the
  persisted staff-tab stamp after the click, which cannot pass against a
  no-op.
- **My own new gate assertion was vacuous on first write.** It compared
  `withPortfolio` count against `prisma.jobOccurrence.findMany` count — but
  the photo query is `jobOccurrencePhoto`, so the tallies counted different
  things and the inequality held with slack. Unscoping a query passed;
  adding a fourth unscoped query passed. Rewritten per-query (split the
  builder body on `prisma.`) and re-mutated: 7/7 caught. Exactly
  [[feedback_mutation_test_every_gate]].

## Verified 2026-11-16

Build gate 2234/2234 · both tsc clean · `now-board-owner.spec.ts` 3/3 ·
driven in the browser at 1280 and at 390 (no sideways scroll) · the
`employee` persona sees no tab and makes **zero** calls to `/board/now`.

**The withheld-timeclock branch IS drivable** — I first said it was not.
**scheduler, coordinator and districtLead** all hold `schedule.view-all`
WITHOUT `time.view` (dev's coordinator has the whole-book read, contrary to
an older note here). `scheduler-now-board-withheld.spec.ts` asserts on the
RESPONSE BODY, not the page: the claim is that the data does not travel, and
a page-only assertion passes just as happily against the broken version.
Mutation-tested by disabling the server gate — fails as intended, restored,
green again.

Dev personas holding the tab at all: **coordinator, scheduler, owner,
districtLead** (from `tests/e2e/inventory/persona-sweep.json`, which the
sweep regenerates). Of those, coordinator alone lacks `work.claim`, so it is
the one that correctly shows no Start-working card.
