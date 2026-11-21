---
name: project_e2e_full_run_2026_11_13
description: "Full Playwright run 2026-11-13: 348 passed / 6 failed / 17 skipped in 1.8h. NONE from the portfolio-narrowing, Repeating-explainer, date-brand or AcceptPaymentDialog work. Five of the six reproduce in isolation and are STALE SEED DATA — the seed ages out of the default date windows specs assume. One is Clerk rate-limiting."
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-21T00:00:00.000Z
---

Run after the portfolio-narrowing table, the Repeating `TabExplainer`, the
branded-date mirror work and the `AcceptPaymentDialog` payout fix (all in
commit `1c76b116`). Supersedes [[project_e2e_full_run_2026_10_31]].

**348 passed · 6 failed · 17 skipped · 1.8 hours**, 8 projects.
`--no-deps`, reusing existing auth states.

## The six, and why none of them is the new work

| Failure | Cause |
|---|---|
| `auth.setup` → authenticate newhire | Clerk `too_many_requests`. Environmental. |
| `display-stale-links` × 2 — photo 200→404 while paired | **SOLVED 2026-11-21: the dev photos bucket was empty.** All 5 specs now pass. |
| `route-planner` × 2 — `suggestions` null | **No jobs exist on the planned day.** |
| `tips-owner` — "Total Gross" never visible | **No payroll data in the default window.** |

All five non-auth failures **reproduce in isolation** (4.1m, 15 passed /
5 failed), so none is a full-suite timing artefact — which is what the
`tips` spec's own comment predicted it would be. Isolation ruled that out
rather than confirming it.

## THE ROOT CAUSE OF THREE OF THEM: the seed ages out from under the specs

Both of these were diagnosed from the failure **screenshot**, not the
stack — the product had already explained itself on screen:

- **Route planner**: *"No available or claimed jobs found for 2026-11-14."*
  The tab plans for TOMORROW. The planner ran (`Last analyzed 11/13/2026,
  1:54:05 PM`), returned no error, and correctly answered
  `suggestions: null` because there was nothing to plan. The spec asserts
  `suggestions` is truthy, which silently requires jobs to exist tomorrow. Proven against the DB: **2026-11-14 holds zero occurrences**, while
  11-13 has 3, 11-15 has 1 and 11-16 has 2 — the seed has a GAP exactly on
  the day the tab plans for, so the same spec would have passed a day later.
- **Tips → payroll**: the panel opened and said *"Worker Payroll (0) — No
  workers logged in this window"* over a range of **11/09–11/15/2026**.
  The newest seeded `PayrollPeriod` is `periodStart 2026-10-25 / payDay
  2026-11-05` — two weeks outside it. Reconcile defaults to this calendar
  week Mon–Sun, which is deliberate
  ([[feedback_exports_default_range]]), so the window is right and the
  data is old.

**The reusable rule: a spec that needs seeded data to land inside a
DEFAULT date window rots as the clock moves.** It passes the day it is
written and fails weeks later with no code change in between, and the
failure reads like a regression in whatever shipped most recently. Before
treating a date-windowed spec as red, check the seed's newest row against
the window on screen. `npm run db:seed` is the fix, not a code change —
see [[feedback_always_seed_dev]].

Neither spec was touched, because the product is right in both cases and
the next reseed makes them green. If they fail again on fresh seed data,
*then* there is something to fix.

## THE PHOTO 404 IS SOLVED (2026-11-21) — read this before the section below

The dev photos bucket `seedlings-photos-dev` held **zero objects**. The 22
rows pointed at `seed/landscaping/*.jpg` that were never uploaded, so the
route's `getObjectBufferIfPresent` correctly found nothing and 404'd.

**The credentials theory below is wrong** and is kept only to show how the
wrong turn was taken. Presigning a GET for one of those keys succeeds and
the fetch returns a signed **404**, not a 403 — which is the tell: a
credential failure cannot produce a signed 404. The earlier
"`Resolved credential object is not valid`" came from calling the helper
outside the app's env loading, not from the values themselves.

Fixed by running `apps/api/scripts/seed-photo-objects.ts <dir>`, which
exists for this and had evidently never been run on this machine. See
[[project_now_tab]] — the objects now in the bucket are synthetic
placeholders.

## The photo 404, as it was mis-diagnosed

22 `JobOccurrencePhoto` rows reuse 7 distinct keys
(`seed/landscaping/00…05,07.jpg`); statuses are publishable and nothing is
hidden, so the route's first three 404 branches are not it. What remains is
`getObjectBufferIfPresent`. Calling it directly on those keys in this
environment throws **`Resolved credential object is not valid`** — all 11
`R2_*` vars are present in `apps/api/.env`, so the values themselves do not
resolve to usable credentials here (dotenvx encryption is the likely
reason). Note the helper rethrows anything that is not `NoSuchKey` /
`NotFound` / 404, so a credential failure is NOT what turns into the
spec's 404 — that part is still unproven. **Subject is R2 access in dev,
not the code under test.** Left open, as it was.

## Attribution method

The diff was already committed, so stashing was not available. Instead:
of the 33 changed files, exactly one (`payroll.ts`, both sides) sits in a
failing spec's blast radius, and its diff is **type-level plus a
`periodDates()` that only casts** — the spread writes the same three keys
with the same values, so runtime is byte-identical. It cannot remove a
payroll column.
