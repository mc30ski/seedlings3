---
name: project_repeating_tab
description: "Work → Repeating - the whole-book repeating job occurrence table with selection pause/resume; shipped 2026-11-09, canonical spec docs/features/repeating.md"
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-09T18:00:28.392Z
---

Built 2026-11-09. **Canonical spec: `docs/features/repeating.md`** — read that,
not this. This file is the pointer plus what the doc cannot say.

Work → Repeating lists every live repeating job occurrence across the book and
acts on a visible row selection. `schedule.view-all` to read,
`schedule.manage` to act — see [[reference_prod_role_entitlement_matrix]].

**DO NOT REBUILD CLIENT-LEVEL BULK PAUSE.** It shipped and was removed; two
dead columns (`Job.clientBulkPausedAt` / `clientBulkPausedById`) remain and
`repeating-build-gate` fails the build if anything reads them. The operator's
objection was that it "sorta hid what was happening as it cascaded actions".
The replacement is a **lens, not a second kind of pause**: every write loops
the ordinary per-occurrence `pauseStream` / `resumeStream`, nothing records
that a batch happened, and the confirm lists every row by name. See
[[project_pause_redesign]].

**Scale, production 2026-11-09:** 74 repeating jobs, 57 live occurrences — 29
SCHEDULED, 16 held (12 of them `season_over`), 12 `PENDING_PAYMENT`. Fits one
screen; no pagination.

**The `PENDING_PAYMENT` hole is visible, not closed.** Those cannot be held
(`pauseStream` 409s on anything but SCHEDULED) and re-enter the schedule when
their payment clears. Operator's rule: settle first. Rows show the blocker and
link to Payments, so end-of-season is **two passes**. No deferred-pause
mechanism — that would be a second source of truth, the thing that got the
previous version deleted.

## Four bugs found AFTER the first green run — all invisible to the suite

Worth reading before trusting a green build on UI work:

1. **Named pause reasons returned zero rows** while "any reason" worked. The
   shared `passesPauseFilter` reads `streamPauseReasonCode`; the row carried
   `pauseReasonCode`. The predicate marks its fields **optional**, so the
   mismatch typechecked and matched nothing — and "any reason" returns before
   it reads the field, which made it look like missing data. An `as any` at
   the `StreamPauseActions` callsite is what let the shapes look compatible.
   **Fix: the row speaks the occurrence's own field names and is passed
   uncast.** Gated.
2. **"Open" landed on "No jobs match current filters"** for most rows. It
   reused `goToStreamPauseReminders`, which resolves the job by looking the
   occurrence up in `/stream-pauses/reminders` — held occurrences whose
   check-back is already DUE — and switches on the held-only filter. Fix:
   `streamReviewJobId` on ServicesTab; pass the jobId the row already has.
3. **Mobile was unusable.** One grid serves both widths; the phone template
   had 2 tracks and the row has 7 children, so auto-placement dealt half the
   cells into the checkbox track and `minmax(0,…)` shrank them to nothing —
   text one character per line, rows ~1700px. Fix: every cell pinned to
   column 2 at base. **Nothing caught it because tsc, the gate and the
   desktop spec all look at 1280px.** `repeating-mobile-owner.spec.ts` now
   renders narrow and measures.
4. **Columns did not line up**, then **the action buttons were jumbled** —
   both the same cause: a track whose width depends on its content, inside a
   row that is its own grid. Fixed tracks + one stretched stack.

## Things a future session will trip on

- **The read-only tier has no dev persona.** The seed's example roles are
  Coordinator, Bookkeeper, Payroll — none holds `schedule.view-all` without
  `schedule.manage`, though production's Auditor does. The gate asserts every
  affordance sits behind `canManage` instead. Adding an Auditor example role
  + a Clerk account would make it drivable.
- **Mobile specs must navigate by `navigate:staffTab`**, not by stamping
  `seedlings_staffTab`: the restore races `/api/me`, and until capabilities
  land the tab is not visible, so the app falls back to Work → Home. Related
  but distinct from [[feedback_e2e_localstorage_stamp_race]].
- **`employee-mobile` cannot test this tab** — that project signs in as the
  employee account, which correctly cannot see it. Use an `-owner` spec with
  `test.use({ ...devices["iPhone 13"] })`.
- `/stream-pauses/reminders` still scopes with `portfolioWhere` (the
  occurrence's frozen rows) while this feature uses `occurrencePortfolioWhere`
  (the property's current membership). The new one is correct; the old was
  left alone rather than silently changing who sees reminders. See
  [[project_portfolio_money_basis]].
- `npm run routemap` now rewrites the gated "N distinct method+path pairs"
  sentence itself. It used to leave it to a human and the build failed one
  step later, in a file the author had not edited.
