# Repeating — Feature Reference

**Work → Repeating.** Every repeating job occurrence in the book in one list,
with the hold and restart actions on it.

> **Vocabulary.** The unit is the **job occurrence**, not the service. One
> service can carry several repeating occurrences — mowing and hedging on the
> same job — and each is held separately, so "repeating service" named the
> wrong thing and promised fewer rows than the table shows. The operator
> already meets this wording on the Settings card that owns the reasons,
> "Repeating Job Occurrence Pause Reasons". It is used consistently across
> this tab, the shared pause dialog, Services, Work → Jobs, Clients, Crews,
> Settings and the Tasks card.
>
> **It stops at the customer portal.** `routes/client.ts` still tells a
> customer "Only recurring visits can be skipped", and should: "job
> occurrence" is the vocabulary of the people who run the business, not of
> the homeowner reading it. Internal precision is not a reason to hand a
> customer a model name.

Canonical spec. Bound to:

- backend gate — [`apps/api/src/services/repeating-build-gate.test.ts`](../../apps/api/src/services/repeating-build-gate.test.ts)
- Playwright — `apps/web/tests/e2e/specs/repeating-*.spec.ts`
- the pause mechanics it acts on — [`occurrenceStreamPause.ts`](../../apps/api/src/services/occurrenceStreamPause.ts)

If code and this document disagree, one of them is wrong; fix both in the
same PR.

---

## Why it exists

Pausing a repeating job occurrence lives on the occurrence itself, one card at a time, and
that is the right place for it: a stream has no model of its own, it *is* the
occurrence chain, so there is nowhere else the decision could live.

It is the wrong place for the decision made **once a season**. At the end of a
growing year the operator holds most of the book — 29 scheduled streams on a
74-service book, in production, in November 2026 — which meant opening 29
cards across two tabs and remembering which were done. Twelve streams were
already held under `season_over` by hand when this was built.

## What it is NOT

A client-level "Pause services" / "Resume services" pair shipped once and was
**removed**. Two dead columns are still on the `Job` model from it
(`clientBulkPausedAt`, `clientBulkPausedById`) and the schema comment records
why:

> it was only ever a loop that paused each Job in turn. It read as a
> client-level switch while actually being a one-shot batch against whatever
> Jobs existed at that moment … and the `Job.clientBulkPausedAt` bookkeeping
> it needed to un-do itself was a second way to pause a Job that had to stay
> in step with the first.

It did not stay in step: a stale stamp swept up a job the operator had
deliberately stopped.

**The failure was not batching. It was a batch that remembered itself.** The
rules that fall out of that, and that the gate enforces:

1. **No new state.** Nothing on this screen writes a column, a flag or an id
   that records that a selection happened. The only writes are the ordinary
   per-occurrence pause and resume.
2. **No cascade.** The operator ticks rows they can see. Nothing is inferred
   from a customer, a portfolio or a date range.
3. **The confirm names every row.** A count alone is what "sorta hid what was
   happening" last time.
4. **The AuditEvent trail is the record of a sweep** — N rows, one actor, one
   second. That is what the removed feature's own schema comment said it was
   relying on anyway.

## Membership — what is in the list

A row is a **live repeating occurrence**:

- its status is one of `ACTIVE_STREAM_STATUSES` (`SCHEDULED`, `IN_PROGRESS`,
  `PENDING_PAYMENT`, `PAUSED`, `STREAM_PAUSED`), and
- it has a cadence — the occurrence's own `frequencyDays` when it overrides,
  otherwise the service's.

Cadence is the **membership test, not a filter**. A one-off has nothing to
hold: you do it or you cancel it. There is no toggle to include one-offs,
because a one-off on this screen would have no action.

The cadence fallback is why this cannot be a `where` clause on the Job alone,
and why the filtering happens in the service after the read.

## States, and which can be acted on

| Status | Shown as | Action |
|---|---|---|
| `SCHEDULED` | Scheduled | **Pause** |
| `STREAM_PAUSED` | Held | **Resume**, **Edit pause** |
| `PENDING_PAYMENT` | Awaiting payment | none — blocked |
| `IN_PROGRESS` | On site | none — blocked |
| `PAUSED` | Timer paused | none — blocked |

`pauseStream` refuses anything but `SCHEDULED` with a 409, and that refusal
is the product rule, not an implementation limit: **settle the money first,
then hold the visit that replaces it.** A blocked row is shown with its
reason stated on the row and a **disabled** checkbox — it cannot be ticked.
Letting it be ticked and refused at commit time teaches nothing.

### The `PENDING_PAYMENT` trap, stated out loud

An unpaid visit holds the chain by itself: the next visit is only created when
the payment is approved. So nothing runs away today — and it is **not held
either**. Settle that payment in December and a fresh visit is scheduled in
the dead of winter.

Twelve of the live book's 57 streams were in this state in November 2026, and
before this screen existed nothing said so. The summary strip states the count
("N cannot be held yet"), the row names the blocker, and the row offers a jump
to Money → Payments. Resolving it closes that visit and generates a new
`SCHEDULED` one, which then appears here as pausable — **the end-of-season
flow is deliberately two passes**: clear the blocked ones, then hold the rest.

## Capabilities

| | |
|---|---|
| Open the tab, read the table | `schedule.view-all` |
| Every action on it | `schedule.manage` |

**The read is wider than the write, on purpose.** `schedule.view-all` is "see
every visit, not only the ones you are on" — the oversight read, for somebody
who watches the operation without working it. The live book has a role
(`Auditor`) holding it *without* `schedule.manage`, so "table with no buttons"
is a real rendered state and is covered by a spec.

`TAB_REQUIREMENTS.repeating` is `["schedule.view-all"]` and nothing else:

- **not** `schedule.view` — that is the baseline every field worker holds, and
  a book-wide list of which customers are on hold is not a field screen;
- **not** `schedule.manage` as an alternative — a custom role may hold the
  write without the oversight read (the live `Coordinator` role does), and an
  any-of row would open the tab for them onto a 403 from the only endpoint it
  calls. A tab names the capability of the endpoint it reads.

> **Operator note.** A role holding `schedule.manage` without
> `schedule.view-all` does not see this tab. Granting `schedule.view-all` in
> the role builder is the fix, and it is arguably owed anyway: a role that
> manages the whole schedule but is not declared able to see every visit is
> leaning on field clearance it does not have.

## Portfolio scoping

The read uses `occurrencePortfolioWhere` — the **property's current
membership**, one join out through `job.property`. Not the occurrence's own
frozen portfolio rows: a property that moved into somebody's district last
week is their work to hold this autumn, and the frozen basis is the one that
was deleted for having no referent (see `project_portfolio_money_basis`).

The selection writes scope on **`schedule.manage`**, not on the read's
capability — a territorial grant of the write must bound what a selection can
touch even where the holder's `schedule.view-all` is wider.

**`withinScope` in `repeatingStreams.ts` is the security boundary of the
selection path.** `pauseStream` has no idea who is calling: every other caller
reaches it with one occurrence id the operator had on screen, and this one
takes a list from the request body. Ids outside the caller's scope are
refused by name — `"Not found."` — rather than failing the whole call.

## Endpoints

| | | |
|---|---|---|
| `GET` | `/repeating-streams` | `schedule.view-all` |
| `POST` | `/repeating-streams/pause` | `schedule.manage` |
| `POST` | `/repeating-streams/resume` | `schedule.manage` |

Selections are capped at `MAX_SELECTION` (200). The live book is 57 streams,
so that is headroom, not a limit anybody meets — it is there because the
handler loops, and a loop whose length comes from the request body is a loop
the caller sizes.

### Reason labels are resolved server-side

Every other surface renders a pause reason by fetching the taxonomy from
`/pause-reasons`, which requires **`schedule.manage`**. The read-only reader
does not hold it, so for them that fetch 403s and caches an empty list.

So `GET /repeating-streams` returns `pauseReasonLabel` alongside the code,
resolved from the Setting, and the tab's reason **filter options are derived
from the rows** rather than from the taxonomy. The read-only reader sees
"Season over", not `season_over`, and the table needs no capability it does
not already have. Retired reasons are included in the resolution — not
offered for new pauses, but a stream held under one last year must still
render a label.

### The row speaks the occurrence's field names

`GET /repeating-streams` returns `id`, `streamPauseReasonCode`,
`streamPauseReason`, `streamPausedAt`, `streamResumeReminderAt` — the
occurrence's own names, not tidier local ones.

**This is load-bearing, and it shipped wrong once.** The row originally used
`occurrenceId` / `pauseReasonCode` / `pauseNote`, while the shared helpers
every surface uses — `passesPauseFilter`, `StreamPauseActions` — read
`streamPauseReasonCode`. `passesPauseFilter` marks its fields optional, so
the mismatch type-checked perfectly and matched nothing: **filtering by a
named pause reason returned zero rows for every reason**, while "any reason"
kept working, because that branch returns before it reads the field. The
failure read as missing data rather than a bug.

An `as any` at the `StreamPauseActions` callsite was what let the two shapes
look compatible. The row is now passed **uncast**, which is the standing
proof that it really is a `StreamPauseOcc` — if the names drift again it
stops compiling. The gate asserts the cast stays gone.

### Open takes the job id

A row's **Open** passes `(jobId, occurrenceId)` and goes through
`goToServiceOccurrence`, which narrows Services to that job, expands it,
shows all its occurrences and highlights the one.

It deliberately does **not** reuse `goToStreamPauseReminders`. That one
resolves the job by looking the occurrence up in `/stream-pauses/reminders`
— held occurrences whose check-back is already **due** — and switches on the
held-only filter. Correct for the alert it was built for; wrong here, where
most rows are scheduled, awaiting payment, or held until spring. Every one of
those missed the lookup, got hidden by the filter, and landed the operator on
"No jobs match current filters", which reads as a broken tab.

### Per-row outcomes, not one toast

Both writes are **per-row independent**. One transaction around all of them
would mean a single row whose status moved under the operator — a visit
started while they were choosing — rolls back twenty-eight good pauses.

Each row gets its own transaction (`pauseStream` opens one) and its own
outcome. The response is `{ applied, refused, outcomes[] }`, and the UI
reports it as "Paused 21 of 23. 2 not done: …" naming up to three.

**A selection that reports one toast is a selection that lies.** If two rows
were refused and the message says "Done", those two are invisible until next
spring.

Writes are **sequential**, not parallel: these are write transactions against
a serverless Postgres, and a selection is a twice-a-year action where being
right matters more than being quick.

## Resume — the spring pile-up

`POST /repeating-streams/resume` takes an optional `startAt`:

- **omitted (the default)** — each stream steps forward from its own last
  date by its own cadence until it lands today-or-later, via
  `computeResumeStartAt`, the same function the single-row path uses.
- **set** — every selected stream restarts on that one date.

The default is not a tidiness preference. **Give thirty held streams one
shared date in April and thirty visits land in the same week** — a book-wide
pile-up created by the control meant to undo a book-wide hold. The live book
has cadences of 5, 7, 10, 14, 16, 21 and 28 days; stepping each forward by its
own interval puts them back on the rhythm they already had.

The table shows each held row's `suggestedResumeAt`, computed by that same
function, so the date shown before committing is the date written. The dialog
states the consequence of the one-date option with the live count in it.

## Frontend

| | |
|---|---|
| Tab | [`apps/web/src/ui/tabs/RepeatingTab.tsx`](../../apps/web/src/ui/tabs/RepeatingTab.tsx) |
| Shared actions + both controllers | [`StreamPauseControls.tsx`](../../apps/web/src/ui/components/StreamPauseControls.tsx) |
| The one dialog, five modes | [`StreamPauseDialog.tsx`](../../apps/web/src/ui/dialogs/StreamPauseDialog.tsx) |

**One implementation of the pause.** `RepeatingTab`, `ServicesTab` and
`JobsTab` all mount `StreamPauseActions`, render `streamControls.dialogs`, use
`passesPauseFilter`, and **none of them wires `StreamPauseDialog` directly**.
That rule is gated; hand-rolling the dialog is how Services and Jobs drifted
the first time.

The selection controller (`useStreamPauseSelection`) lives in the same module
as the single-row one, because the two must agree about what pausing means:
the same mandatory reason, the same reminder horizon, the same dialog. The
only difference is that one is handed a list.

`StreamPauseDialog` grew two modes rather than gaining a sibling —
`pause-many` and `resume-many` — specifically so the **reason field** is not
copied. It is mandatory and it pre-fills the reminder from that reason's own
horizon; a second copy of that logic is a second set of pauses that are hard
to find again.

### Layout

**One row implementation, responsive by CSS grid** — `auto 1fr` on a phone,
seven columns at `md`. Not a table for desks plus a card list for phones:
that is two copies of every cell, and two copies of one decision is the drift
class this feature's own neighbourhood has already produced (a teal timing
band on a grey card). Column headers render at `md` and up; below that each
cell names itself.

The operator edits on a desktop and reads on a phone, which is why selection
is offered at both widths rather than hidden on small screens.

### Sorting

Every column title is the sort control for its column: click to sort, click
again to reverse. The active column is the only one carrying an arrow — an
arrow on every header says nothing about which order the rows are in.

Three rules the gate holds:

- **Blanks sort last in BOTH directions.** "No check-back date" is the
  commonest value in that column, so letting blanks fall out of the
  comparator naturally would float every one of them to the top the moment
  the column is reversed, burying the dates the operator reversed it to see.
- **State sorts in work order, not alphabetical order** — `SCHEDULED`,
  `STREAM_PAUSED`, `PENDING_PAYMENT`, `IN_PROGRESS`, `PAUSED`. Alphabetically
  "Awaiting payment" leads and "Timer paused" trails, which tells nobody
  anything. An unrecognised status sorts last: a status no one has seen
  before appearing at the top of the list would read as urgent.
- **Every sort breaks ties on the next-visit date**, so repeated clicks never
  reshuffle rows that compare equal.

The headers only render at `md` and up, so below that the same sort is
offered as a picker plus a direction toggle. Both write one `sortKey` /
`sortDir`, and both render their column list from one `SORTABLE` constant —
a second hand-written list is how a column ends up sortable on a desk and
missing on a phone. The sort is not persisted, same reasoning as the day
map's mode: it is how you are reading the list this minute.

### Selection

- A blocked row's checkbox is **disabled**.
- "Select these N" names the count and operates on the **filtered** set — a
  select-all over a filtered table is the one place a selection can quietly be
  bigger than it looks.
- The footer bar is **sticky** and carries **a count per button** ("Pause 21",
  "Resume 2"). A mixed selection is normal in spring, and "Pause" over 23 rows
  when only 21 can be paused is the quiet arithmetic this screen removes.
- Any successful write clears the selection: a write moves rows between the
  filters the table is showing, so the selection it was made from is no longer
  meaningful.

### Links out, never a second editor

A row's **Open** jumps to that occurrence's card in Services, expanded and
highlighted, through the existing `goToStreamPauseReminders` deep link. The
table never edits a cadence, a price or an assignment — a second place to
change one is a second place for the two to disagree.

## Staying in sync

Every pause write in the app fires `seedlings:stream-pauses-changed`. This
tab listens, so a pause made from Services or Work → Jobs is reflected here
without a reload, and a selection made here updates the alerts badge and the
Tasks card.

## Testing

- **Backend gate** — `repeating-build-gate.test.ts`, registered in
  `test:build-gate`. Asserts the no-new-state rules, the capability split, the
  scope check on the selection path, per-row outcomes, and that the three tabs
  share one pause implementation.
- **Route map** — `npm run routemap:check`; G5 fails the build if a guard and
  the map disagree.
- **API authz** — `--project=api` derives from the route map, so all three
  endpoints are driven both ways automatically.
- **Playwright** — `repeating-table.spec.ts` (owner: the table, the filters,
  a blocked row, a single pause) and `repeating-readonly.spec.ts` (auditor:
  table renders, no action controls). Run:
  `cd apps/web && npx playwright test --project=owner repeating`

### Personas that matter

| Persona | `schedule.view-all` | `schedule.manage` | Expectation |
|---|---|---|---|
| `owner` | ✓ | ✓ | full table, selection, actions |
| `auditor` | ✓ | — | table renders, no checkboxes, no action buttons |
| `coordinator` | — | ✓ | **no tab** — see the operator note above |
| `employee` | — | — | no tab |

Both halves of the capability split are real grants in the live book, which
is why both are asserted rather than assumed.

## Non-goals

- **No deferred pause.** "Hold this stream when it next becomes schedulable"
  would mean recording an intent against an occurrence that does not exist
  yet — a second source of truth, which is the thing that got the previous
  version deleted. The blocked rows are made *visible* instead. If a December
  visit actually surprises the operator, that is the evidence for whether a
  second mechanism earns its cost.
- **No client-level or portfolio-level pause.** Pausing is a per-service
  decision. This screen makes thirty of them quickly; it does not infer one.
- **No editing beyond pause state.** Cadence, price, assignment and archive
  all stay in Services.
- **No one-offs.** Nothing to hold.
