---
name: project_repeating_tab
description: "Work → Repeating - the whole-book repeating job occurrence table with selection pause/resume; built 2026-11-09, two clocks + one-off fix 2026-11-10, canonical spec docs/features/repeating.md"
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-11T00:00:00.000Z
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
screen; no pagination. (2026-11-10: 58 → **53** once one-offs stopped
qualifying — see the fifth bug below.)

**The `PENDING_PAYMENT` hole is visible, not closed.** Those cannot be held
(`pauseStream` 409s on anything but SCHEDULED) and re-enter the schedule when
their payment clears. Operator's rule: settle first. Rows show the blocker and
link to Payments, so end-of-season is **two passes**. No deferred-pause
mechanism — that would be a second source of truth, the thing that got the
previous version deleted.

## The two clocks (2026-11-10)

`awaitingPaymentDays` ("Waiting 27 days") and `expiredDays` ("Expired 13d" +
a red left stripe). Two halves of one story: the next visit is only created
when the current one closes, so a payment left past one cadence period IS the
stream stopping. **Production 2026-11-10: 9 expired, oldest 31 days, 8 of the
9 awaiting payment.**

Three things a future session will get wrong by reasoning rather than looking:

- **The money clock anchors on `completedAt`, not the invoice.**
  `paymentRequestFirstSentAt` looks right and the schema even advertises it as
  powering an "originally requested N days ago" display — but no web code had
  ever read it, and it is **null on 10 of 12 pending rows in dev**. It would
  show nothing precisely on the worst row: the visit nobody ever invoiced.
- **Expiry measures `rawStartAt`, never `startAt`.**
  `computeNextOccurrenceStart` returns `startAt` as a *display* date that
  snaps an overdue visit forward to today, so measured against it nothing is
  ever late. Its own doc comment reserves `rawStartAt` for this question.
- **A `STREAM_PAUSED` stream is never expired**, and only a stream's LATEST
  visit can be (decided by one `groupBy` over all of the job's occurrences,
  `CANCELED`/`ARCHIVED` excluded). A 29-day unpaid visit on a stream that kept
  going is *not* expired — dev has exactly that row, and it is the case that
  proves the signal means something.

`nextVisitWarningSuppressedAt` is **carried, not obeyed**: shown muted and
kept out of the count, because this screen is where the book gets reviewed.

**Expired wears the HOUSE SIGN** — the near-black chip Work → Jobs puts on
the Today group for expired next visits. Same stall from the other end; two
colours for one condition makes it look like two problems. Uses the `solid`
step on gray, NOT the Jobs chip's pinned `gray.600`/`gray.50` — a raw ramp
value is the same wash in all 14 themes, and 4 of them ground the page in
near-black. See [[reference_theming]].

## Vocabulary: "Paused repeating", never "Held" (2026-11-10)

The badge said **"Held"** — invented for this tab, used nowhere else. The
rest of the app says "Paused repeating" (Jobs filter, Customers filter,
Services alert) and the button ON THE SAME ROW says "Pause repeating".
Action and state must use one word. See [[feedback_names_carry_meaning]].

**Full two words, never bare "Paused"** — `PAUSED` is a WORKER'S TIMER
stopped mid-visit and renders as "Timer paused" in the same column. Internal
predicate is `isPausedRepeating` for the same reason. Gated, including a
scan of every operator-facing string for residual hold-language.

**Second invented word: "due a check-back"** → **"to review"**, which is what
the header alert and Tasks section ("Paused repeating to review") already
call this queue — and they navigate to exactly this set. The DATE stays a
"Reminder date" (the dialog's own field label); the WORK ITEM its arrival
creates is a review. Internal `dueOnly` / `reminderDue` are accurate and stay.

**Dead code found by the vocabulary scan:** `SortKey` carried `"checkBack"`
with a live `case` and was absent from `SORTABLE` — the one list both
affordances render from — so nothing could select it. tsc is happy with an
unreachable union member. Gate now asserts every SortKey is in SORTABLE.

**The near-black fill means EXPIRED and nothing else** on the summary strip.
The "N repeating" chip went `solid` on gray when active = near-black = the
expired colour, on an unrelated chip. Now `tone="neutral"`: no fill, no
ring — which is truer anyway, since its being active means NO filter.

## EVERY STREAM IS LISTED, visit or no visit (2026-11-11)

**THE BUG THAT COST A CUSTOMER — the most important thing in this file.**
The tab listed live OCCURRENCES, so a stream vanished the moment its last
visit closed/cancelled or was never created. **9 prod streams invisible.**
One was cancelled in September with her job still an ACCEPTED fortnightly;
her phone contact was accidentally blocked so she couldn't reach the
business, and the business couldn't see she was unserved. **73 days, 5 missed
visits, bad review arrived before anyone noticed.**

Fix is **ADDITIVE**: the occurrence pass is untouched; a second JOB-rooted
pass (`dormantStreams`) appends rows for streams with no live visit. Prod
53 → 61.

- **May disappear only if deliberately archived** — customer, property, or
  job. PROPOSED excluded (a quote isn't a customer). Everything else listed.
- **ONE synthetic status `NO_VISIT`** + `dormancy` (`never-ran`/`cancelled`/
  `stopped`) for the kind. Ranks FIRST in STATE_ORDER. **The first cut put
  "STOPPED"/"CANCELLED" in `status` — and "CANCELLED" has TWO Ls where
  `JobOccurrenceStatus.CANCELED` has one.** A `=== "CANCELED"` check would
  silently skip these rows and `=== "CANCELLED"` would silently skip the real
  ones, with nothing failing. Label + filter key on `dormancy`, never a
  status string. Gated on BOTH service and tab — a tab-only assertion passed
  while the service went right back to emitting the enum-alike.
- **`missedCycles`, not days.** 73 days is meaningless without the cadence;
  "5.2 missed" reads the same weekly or monthly. Worst-neglect breaks ties.
  Counts only visits actually SERVED (not cancelled, not future).
- **Two rootings, one capability**: occurrence→`job.property`,
  job→`property`; route passes both together, gated that they match.
- **A dormant row has NO occurrence**: key is `job:<id>`, `occurrenceId` null.
  **Open passes `occurrenceId`, never `id`.**
- **Repeating tested either way round** — one prod job carries its cadence
  only on its occurrences (Rex); a job-only test drops it.

**Related but NOT the same thing:** `listNextOccurrenceGhosts` misses all of
these for three reasons of its own (bails with no occurrences, treats a
cancelled latest as ending the series, skips a latest that is a ONE-OFF —
which is how 4 customers went dark while being served by hand). A ghost
PROJECTS the next visit; this asks about the customer. Don't merge them.

## MULTI-SELECT REMOVED 2026-11-10 — don't rebuild it casually

Bulk pause/resume worked and was careful. It went because the book is ~40
pausable streams (one screenful): *"we don't have enough that make it worth
it for now. I can rethink it when there are many more clients."*

**Removed in EVERY layer** — service (`pauseSelection`/`resumeSelection`/
`withinScope`/`MAX_SELECTION`), both routes, `useStreamPauseSelection`, the
dialog's `pause-many`/`resume-many` modes, the tab's checkboxes/bar — and a
gate asserts it stays gone in all five. Same reasoning as the
`Job.clientBulkPausedAt` columns this feature's own header warns about: each
leftover is individually harmless, which is how they all come back one at a
time. **To rebuild deliberately, delete that gate on purpose.**

**The design, if it returns:** bulk is ONE DECISION applied to N rows, not N
decisions — end of season is one decision, so one reason/note/reminder was
the right shape. Reminder came from the reason's horizon (`season_over` =
150d in prod), so no date was typed. Resume defaulted to each stream's OWN
cadence; a shared date piles the book into one April week.

**Reminder lives under the STATE badge, not in Reason (2026-11-11).**
"Paused repeating" asks "until when?" and the answer was two columns away in
small grey text under a heading saying *Reason* — operator: "it's not
obvious." Now `review 3/15/2027` beneath the badge, red + `review due` when
past. **Next visit cannot carry it**: on a paused row that column shows the
date the pause is HOLDING, not a next visit. No reminder → amber
`no reminder — won't resurface` (both resurfacing surfaces query only DUE
reminders, so one without a date is invisible forever).

## Messaging from a row (2026-11-10)

`ClientContactMenu` — Text/Email/Call + a draft keyed to the row's next
action (pausing / restarting). **Awaiting-payment drafts NOTHING** — Money →
Payments owns that message (invoice link + handoff record).
**Full-width BUTTON, not an icon** — the actions column's rule is one width,
one size, one alignment for every control in it; a square icon in a stack of
stretched buttons was the one thing that didn't line up. Order: Pause/Resume,
Message, Open. **Drafts, never sends** — opens the operator's own SMS/mail client via the
same `buildSmsHref`/`fetchCommsCc` the job cards use, so CC matches.
**Contacts ride on `clients.view`, not `schedule.view-all`** — seeing every
visit ≠ holding every phone number; omitted SERVER-side, not UI-hidden.
Prod: all 53 rows have a phone, none an email.

## The strip is EVERY filter on the screen (2026-11-10)

Two buttons under it each repeated a chip: "To review" and the pause-reason
icon. Both folded in. The **"N paused" chip IS the reason menu** — the shared
`StreamPauseFilter` with a new `trigger` prop (a prop, not a second
component: what must stay single is the item list + the switching-off-drops-
the-reason rule). Jobs/Services pass no trigger and keep the icon; gated.

- **Chip BODY filters (one click, toggles, like its five neighbours); only
  the CARET opens the menu.** Making the whole chip the trigger meant a
  click filtered nothing — you had to open the menu and pick "Paused — any
  reason". Operator: *"that isn't obvious."* The Badge IS the Select trigger
  (`asChild`), so the body stops the event at **`pointerdown`** — Ark opens
  there, and stopping only `click` is too late.
- The neutral "N repeating" chip lights with `gray.emphasized` + ring, NOT
  `gray.solid` (that's expired). Excluding it from emphasis entirely was an
  overcorrection — the chip that clears every filter showed no sign of use.
- **Its count follows the reason** (`passesPauseFilter`), label becomes
  "1 paused · Season over". Same count-matches-rows rule as the other five.
- One `setLens(target, reason)`; the chips compute their toggle on top.

**THE INVISIBLE-CHIP BUG — worth remembering.** `Select.Trigger asChild`
let Chakra's trigger recipe override the badge's `solid` BACKGROUND while
leaving its `solid` FOREGROUND — white text on white ground. Not ugly,
*absent*, and the e2e read the right string from the DOM throughout. A chip
now names BOTH halves (`{palette}.solid` / `{palette}.contrast`) and pins
back the height/border/fontSize the recipe imposes. See
[[reference_theming]] — "`solid` is a fill, not an ink" is exactly this.
**A host recipe can strip half a variant; measure the rendered chip.**

**The selection bar was invisible-in-plain-sight.** Operator: "there is no
place to take a collective action... what is the point of selecting them?"
It existed, sticky at the viewport bottom — but on the page's own `bg` behind
a hairline rule, with OUTLINE buttons identical to the per-row ones, so it
read as more page. Now `bg.panel` + shadow + purple border + **solid**
buttons (solid = the commit rung). One Clear, in the bar, not two at opposite
ends. **`toBeVisible()` passed throughout — the e2e now asserts
`toBeInViewport()`.**

## One rule, one component, two screens (2026-11-10)

Money → Awaiting payment showed "Requested 3 days ago"; Repeating showed
"Waiting 27 days". **Same rows, two screens, two numbers, no way to
reconcile them without opening the job.** Both now show both.

- Rule: `apps/api/src/lib/paymentWait.ts` — `describePaymentWait()`.
  Called by `listRepeatingStreams` AND `paymentRequests.listOutstanding`.
- Component: `apps/web/src/ui/components/PaymentWaitBadges.tsx`. The wording
  helpers were deleted from OutstandingRequestsSection when they moved here.
- **Waiting is drawn FIRST** — a re-send moves "Requested" back to today
  while the visit has been unpaid six weeks, so the resettable number first
  makes an old receivable look fresh.
- **"Never requested" is its own state.** `listOutstanding` selects on
  `paymentRequestSentAt != null`, so Money **structurally cannot** show a
  visit nobody invoiced. Repeating is the only screen that does. 9 of 12 dev
  pending rows.
- `listOutstanding` **lost its `date-handling-allow: elapsed-time`**: it
  floored milliseconds, so an 11pm request read "Requested today" the next
  morning and disagreed with this screen's calendar days.
- Hue is the ONE axis they differ on (orange here, purple there) — purple
  means *Held* in this column, and the Money card's own comment rejects
  orange. Shape/wording/order/loud-rule are identical and gated.

## The summary strip is the filter (2026-11-10)

Each chip filters to its slice; clicking the lit one clears. **Each chip
resolves to ONE piece of state** — "held" writes the existing `pausedOnly`,
"due" writes the existing `dueOnly`, and which chip is lit is DERIVED
(`activeLens`), never stored. Giving them their own booleans would be the
deleted bulk-pause bug in miniature: two switches for one question that
drift. Gated, plus: a chip's count and its filter are the same module-level
predicate, and changing the lens drops the selection.

## A fifth bug — this one WAS live in production

**Five `ONE_OFF` occurrences were listed as repeating streams.** Cadence was
the whole membership test, and cadence resolves *through the job* — so a
one-off carrying none of its own, on a job still holding `frequencyDays: 14`
from when it did repeat, resolved to 14 and passed. On a screen whose first
paragraph tells the operator one-off visits are not listed.

`listNextOccurrenceGhosts` carries a comment about the **identical** trap; it
excludes every non-`STANDARD` workflow for exactly this fix. **Dev is 100%
`STANDARD`, so no test and no amount of clicking could have found it** — it
turned up only from counting production rows by workflow. The lesson is the
one worth keeping: for a membership rule that resolves through a parent,
*count the live data by the discriminator before trusting the rule.*

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
