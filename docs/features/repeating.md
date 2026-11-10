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
   that records that a sweep happened. The only writes are the ordinary
   per-occurrence pause and resume.
2. **No cascade.** The operator ticks rows they can see. Nothing is inferred
   from a customer, a portfolio or a date range.
3. **The confirm names every row.** A count alone is what "sorta hid what was
   happening" last time.
4. **The AuditEvent trail is the record of a sweep** — N rows, one actor, one
   second. That is what the removed feature's own schema comment said it was
   relying on anyway.

## Every stream is listed, with or without a visit (2026-11-11)

**THE BUG THAT COST A CUSTOMER.** This table listed live *occurrences*, so a
stream appeared only while it happened to have one. The moment its last visit
closed, was cancelled, or was never created, the customer dropped silently
off the board — no row, no count, nothing to filter to. **Nine streams in
production were invisible that way.**

One of them was a customer whose repeating was cancelled in September while
her job stayed an `ACCEPTED` fortnightly. Her phone contact had been blocked
by accident, so she could not reach the business, and the business could not
see that she was going unserved. **73 days and five missed visits later, the
bad review arrived before the realisation did.**

So the list now answers two questions, not one:

| | Rooted in | Finds |
|---|---|---|
| live visits | occurrence | what it always found — unchanged |
| **streams with none** | **job** | stopped, cancelled, never started |

**ADDITIVE, NOT A REWRITE.** Every row that existed before still exists,
identically — the occurrence pass is untouched. The job pass only *adds* rows
for streams the first pass could not see. Production went 53 → 61.

### What may disappear

The operator's rule: **a thing may vanish only if somebody deliberately
archived it.**

- archived **customer** or **property** → excluded
- archived **job** → excluded (also deliberate, and the narrower act)
- `PROPOSED` job → excluded; a quote is not yet a customer being served
- **everything else is listed**, whatever state it is in

### Three kinds of nothing — and ONE status

`status` carries a real `JobOccurrenceStatus` on every other row. A stream
with no occurrence has none to take one from, so it carries the single
synthetic **`NO_VISIT`**, and **`dormancy`** says which kind of absence it is:
`"never-ran"` (accepted, has a cadence, never produced a visit),
`"cancelled"` (most recent visit cancelled, nothing since), `"stopped"`
(last visit finished, no next one created).

> **Why not three statuses.** The first cut put `"STOPPED"` and
> `"CANCELLED"` straight into `status` — invented strings in a field that
> otherwise holds the enum. **`"CANCELLED"` has two Ls; the enum's
> `CANCELED` has one.** A `status === "CANCELED"` check would silently skip
> these rows and a `=== "CANCELLED"` check would silently skip the real ones,
> and nothing anywhere would fail. One field, one job: `status` says whether
> there is a visit, `dormancy` says what kind of nothing. Gated on BOTH the
> service and the tab — a tab-only check passed while the service went
> straight back to emitting the enum-alike.

`NO_VISIT` ranks **first** in `STATE_ORDER`, above every working state. These
are the only rows on the screen where *nobody has decided anything*. The
label and the filter are keyed on `dormancy`, never on a status string.

### Measured in missed visits, not days

`missedCycles` = days since last served ÷ this stream's own cadence. "73 days"
means nothing without knowing whether somebody is weekly or monthly; **"5.2
missed" is the same sentence for both**, and it is what makes the list
sortable across a mixed book. Within a state, worst neglect sorts first —
they share no date, so without that tiebreak eleven-missed and two-missed
arrive in database order.

**Last *served*, not last scheduled.** A cancelled or still-future visit is
not work done, and counting it would reset the clock on the very silence
being measured.

### Two rootings, one capability

An occurrence reaches its portfolio through `job.property`; a job through
`property`. The route passes **both fragments together**, built from
`schedule.view-all`, so a caller cannot scope one and leave the other open.
Gated, including that both name the same capability.

### Gotchas

- **A dormant row has no occurrence.** Its key is `` `job:${jobId}` `` and
  `occurrenceId` is null. **Open passes `occurrenceId`, never `id`** — handing
  the synthetic key over as an occurrence id sends Services hunting for a row
  that does not exist.
- **Repeating is tested either way round.** The cadence usually sits on the
  job, but one production stream carries it only on its occurrences; a
  job-only test drops exactly the kind of row this pass exists to save.
- `StreamPauseActions` renders nothing for these states, so no action is
  offered that would refuse.

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

### …but cadence alone is not enough (fixed 2026-11-10)

A row must **also** be `workflow === "STANDARD"` and not carry the legacy
`isOneOff` flag. Cadence resolves *through the job*, so a `ONE_OFF`
occurrence carrying no cadence of its own, sitting on a job that still has
`frequencyDays: 14` from when it did repeat, resolved to 14 and was listed as
a repeating stream. **Production had five of them** — on a screen whose first
paragraph tells the operator one-off visits are not listed.

`listNextOccurrenceGhosts` carries a comment about the identical trap: it
advertised next visits for one-offs for exactly this reason, and excludes
every non-`STANDARD` workflow for exactly this fix. The dev database is all
`STANDARD`, which is why no test and no amount of local clicking found it —
it was found by counting production rows by workflow. Gated.

## States, and which can be acted on

| Status | Shown as | Action |
|---|---|---|
| `SCHEDULED` | Scheduled | **Pause** |
| `STREAM_PAUSED` | Paused repeating | **Resume**, **Edit pause** |
| `PENDING_PAYMENT` | Awaiting payment | none — blocked |
| `IN_PROGRESS` | On site | none — blocked |
| `PAUSED` | Timer paused | none — blocked |

`pauseStream` refuses anything but `SCHEDULED` with a 409, and that refusal
is the product rule, not an implementation limit: **settle the money first,
then pause the visit that replaces it.** A blocked row carries **no pause
control at all**, and the State cell states the reason. Offering a control
whose every click refuses teaches nothing.

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

## The two clocks (added 2026-11-10)

"Awaiting payment" reads the same at two days and at forty-five, and
forty-five is the one that has already cost the stream its visits. Two numbers
fix that, and they are **two halves of one story, not two features**.

Both numbers come from **one rule in one file**,
[`apps/api/src/lib/paymentWait.ts`](../../apps/api/src/lib/paymentWait.ts),
and are drawn by **one component**,
`apps/web/src/ui/components/PaymentWaitBadges.tsx`. Money → Awaiting payment
and Work → Repeating both call both. That is not tidiness: the two screens
asked the same question about the same rows and answered it differently, and
a second copy is how they got there.

### How long the money has been waiting

`awaitingPaymentSince` / `awaitingPaymentDays`, `PENDING_PAYMENT` rows only.
Rendered as "Waiting 23 days" (or "Finished today" at zero, because "Waiting
0 days" is not a sentence).

**Anchored on `completedAt`, not on the invoice.** The money clock starts when
the work was finished: that is the moment the visit became a receivable,
whether or not anybody got round to asking for the money.
`paymentRequestFirstSentAt` reads like the truer anchor — the schema even
documents it as powering an "originally requested N days ago" display, and
nothing on the web had ever read it — but it is **null on 10 of the 12 pending
rows in dev**. A clock hung on it shows nothing across most of the list, and
nothing at all on the worst row in it: the visit nobody ever invoiced.
`completedAt` is non-null on every pending row in both databases, and
`updateOccurrence` keeps it that way on purpose (it stamps it on any
transition into a completion state, because a null one hid finished work from
the customer's own service history).

Fallback order for a legacy row, in the order they would have been written:
`completedAt ?? paymentRequestFirstSentAt ?? paymentRequestSentAt ?? startAt`.

### …and when we last asked (2026-11-10)

`paymentRequestedDays` / `paymentFirstRequestedDays` / `paymentResendCount` /
`paymentNeverRequested`. Rendered beside the waiting badge as "Requested 2
days ago".

**The waiting badge is drawn first, deliberately.** A re-send moves
"Requested" back to today while the visit has been unpaid for six weeks, so
reading the resettable number first makes an old receivable look fresh. That
is exactly what Money → Awaiting payment did when it showed only the invoice
clock.

**"Never requested" is its own state, not a missing number.** "Asked, no
answer" is the client's move; "never asked" is yours. Nine of the twelve
pending rows in dev are in this state, and **Money → Awaiting payment cannot
show them at all** — `listOutstanding` selects on `paymentRequestSentAt != null`,
so a visit nobody invoiced is invisible there by construction. Work →
Repeating is the only screen that surfaces it.

### What changed on the Money side

`listOutstanding` gained `waitingSince` / `waitingDays`, and **lost its
`date-handling-allow: elapsed-time` exemption**. It floored a millisecond
difference, which is a different number from the calendar one: a request sent
at 11pm yesterday was "0 days" by milliseconds and "1 day" by the calendar,
so the operator read "Requested today" the following morning — and it
disagreed with this screen, which counts calendar days. Both now use
`describePaymentWait`.

### When the repeating has expired

`nextVisitDueOn` / `expiredDays` / `expirySuppressed`.

**"Expired" is the app's existing word, borrowed whole from the next-visit
ghost**: the stream's next visit came due and was never created, so the stream
has silently stopped. It is a **stall, not a configuration** — no job carries
an end date, so there is nothing else the word could mean here.

This is the *consequence* of the clock above. The next visit is only created
when the current one closes, so a payment left sitting past one cadence period
**is** the stream stopping. In production on 2026-11-10: 9 expired streams,
the oldest 31 days, **8 of the 9 awaiting payment**. The pending number says
how long nobody acted; this one says what it cost.

Three conditions, each load-bearing:

| Condition | Why |
|---|---|
| **Not `STREAM_PAUSED`** | A paused stream stopped *on purpose*, with a reason and a reminder date. Calling that expired paints the operator's own decision as a failure — and it is the one thing this whole screen exists to do. |
| **This row is the stream's latest visit** | A stream can briefly show two rows (a payment reverted after the next visit had already been started, so it survived the revert's cleanup). Projecting from the older one dates the stall from the wrong visit. Decided by one `groupBy` over *all* of the job's occurrences, `CANCELED`/`ARCHIVED` excluded — a cancelled future visit is not a visit. |
| **That latest visit is in the past** | If anything is still ahead, the stream is running. A 29-day unpaid visit on a stream that kept going is *not* expired, and dev has exactly that row. |

Projected with `computeNextOccurrenceStart` and read off **`rawStartAt`, never
`startAt`** — `startAt` is a display date that snaps an overdue visit forward
to today so it is not invisible in a forward-looking view, so measured against
it nothing is ever late. That field's own doc comment reserves it for this
question.

### A silenced stall is carried, not obeyed

`nextVisitWarningSuppressedAt` is what buys silence from the header alert and
the Today chip. Re-shouting it here would undo a deliberate decision; dropping
the row would hide it from the one screen built for reviewing the whole book.
So it is **still shown, and shown quietly**: muted instead of red, and out of
the "N expired" summary count.

### Rendering

**Expired wears the house sign.** Work → Jobs already marks expired next
visits with a near-black chip on the Today group, and that is the *same
stall* seen from the other end — the visit that never got made, versus the
visit that blocked it. Two colours for one condition is how an operator ends
up believing they have two problems.

- Next visit cell: a solid near-black `Expired 9d` pill under the date, due
  date in the `title`. `subtle` instead of `solid` when silenced.
- Row: a **3px left stripe** in `fg` — the chip's own ink, so the two read as
  one signal — `border.emphasized` when silenced, `transparent` otherwise.
  The width is **unconditional**: a border that appears only on some rows
  moves those rows' contents 3px right, and columns that do not line up is
  the exact failure the `COLS` constant exists to prevent, reintroduced on
  precisely the rows that most need reading.
- Summary strip: a near-black `N expired` chip.

**Why `solid` on the gray palette and not the Jobs chip's `gray.600` /
`gray.50`.** Those are raw ramp values, which the theming rules here forbid:
a raw ramp number is the same wash in all fourteen themes, including the four
built on a dark ground, where a `gray.600` chip sits on a near-black card and
stops being the obvious thing. The semantic step resolves per theme. (The
Jobs chip still pins them — a latent soft spot there, not copied here.)

**The two money badges are orange on this screen and purple on the Money
card**, which is the one axis where "the same badge" is not literally the
same. Order, wording, size and the rule for which one goes loud are
identical and gated. The hue cannot be: the Money card's own comment records
that orange there "read as a different feature dropped inside this one", and
purple means **Held** in this very column.

## Vocabulary: "Paused repeating", never "Held" (fixed 2026-11-10)

The state badge read **"Held"** — a word invented for this tab and used
nowhere else in the product. Work → Jobs filters on "Paused repeating",
Customers on "Paused repeating only", Services alerts on "Paused repeating to
review", Settings owns "Repeating Job Occurrence Pause Reasons" — and the
button **on this very row** says "Pause repeating". A row whose action and
whose state use different words for one thing teaches the operator they are
two things. Same failure class as the role-named boolean that hid customers'
completed jobs in production; see `feedback_names_carry_meaning`.

**The full two-word label, not a bare "Paused".** `PAUSED` is a *worker's
timer* stopped mid-visit and renders as "Timer paused" in this same column.
Shortening it would put two unrelated states one word apart. Internally the
predicate is `isPausedRepeating` for the same reason — `isPaused` is one
careless rename away from the timer state.

Gated: the badge label, the "Timer paused" distinction, and a scan of every
operator-facing string in the tab and the service for residual hold-language
(comment-stripped, so the comments explaining the change don't trip it).

### The reminder queue: "to review", not "a check-back"

Same problem, second invented word. The chip read **"2 due a check-back"**,
while the header alert and the Tasks page section both read **"Paused
repeating to review"** and both navigate to *exactly this set* — so an
operator clicking that alert landed on a screen giving the same two rows a
third name.

The chip is now **"N to review"** and the filter button **"To review"**.

**Two words legitimately survive, in their right places.** The *date* is a
**"Reminder date"** — the pause dialog's own field label, and what the row
states ("reminder Mar 15" / "no reminder date"). The *work item* its arrival
creates is a **review**. That is a distinction, not a contradiction, which is
why the internal names (`dueOnly`, and `reminderDue` off the wire) say the
reminder is due and stay as they are.

### A dead sort key fell out of this

`SortKey` carried `"checkBack"` with a live `case` in the comparator, and it
was **not in `SORTABLE`** — the one list both the headers and the phone
picker render from — so nothing could ever select it. `tsc` is perfectly
happy with an unreachable union member. Removed, and a gate now asserts every
`SortKey` appears in `SORTABLE`.

## The summary strip is also the filter (2026-11-10)

Each chip shows a count and filters to that slice; clicking the lit one
clears back to everything, the same toggle the Due button already had.

**Each chip resolves to ONE piece of state.** Two of the six name a filter
that already had its own control — "paused" is `pausedOnly` and "due" is
`dueOnly` — so those chips **write that existing state** and read their lit
flag back out of it (`activeLens`). Only "scheduled" / "blocked" / "expired"
needed new state (`View`). Both of those separate controls have since been
folded into their chips (below), so each filter now has one control *and* one
piece of state.

This is not fussiness. Giving the chips their own booleans would be the
deleted bulk-pause bug in miniature: two switches for one question, which
drift, and then clearing the button leaves the table filtered with nothing on
screen saying why. Click "paused" and the StreamPauseFilter button lights up
with it, because there is only one `pausedOnly`.

Two further rules, both gated:

- **The near-black fill means EXPIRED and nothing else on the strip.** The
  "N repeating" chip sat on the gray palette and went `solid` when active —
  near-black, the expired colour exactly, on a chip with nothing to do with
  expiry. It is `tone="neutral"`, which is excluded from the **fill** and
  takes a darker grey (`gray.emphasized`) instead.

  **Excluded from the fill, not from the emphasis.** The first fix dropped
  its ring too, which overcorrected: the one chip that clears every filter
  then gave no sign it had been used. Three rungs now — `subtle` at rest,
  `emphasized` + ring when it is the active lens, `solid` reserved for
  expiry.
- **A chip's count and a chip's filter are the same expression.** The four
  predicates (`isScheduled` / `isPausedRepeating` / `isBlocked` /
  `isExpired`) are
  module-level and used by both. Counted one way and filtered another, a chip
  reads "6 expired" and then shows a different six.
- **Changing the lens used to drop the selection**, so a footer could never
  offer to pause twelve streams you can no longer see. Moot since the
  multi-select went; the rule is recorded because it is the first thing a
  rebuild has to put back.

### The strip is every filter on the screen

Two buttons used to sit under it, each repeating what a chip already said.
Both are folded in:

- **"To review"** → the chip. `dueOnly` has exactly one writer again.
- **The pause-reason icon button** → the **"N paused" chip is the menu**. It
  counted the paused rows while a separate purple icon narrowed them to a
  reason, and neither control mentioned the other.

**The chip body filters; only the caret opens the menu.** The whole chip was
the menu trigger at first, so clicking it did not filter — you had to open the
menu and then pick "Paused — any reason", a second step with nothing on screen
to suggest it, while the five chips beside it all filtered on the first click.
The operator's words: *"that isn't obvious."*

So: one click on the body filters to every paused row and clicks again to
clear, exactly like its neighbours; the caret narrows to one reason. Because
the Badge **is** the Select trigger (`asChild`), a click anywhere in it
reaches the menu — the body therefore stops the event at **`pointerdown`**,
which is where Ark actually opens, and stopping only `click` is too late. The
caret is left unwrapped and still bubbles through.

The body click is a **plain toggle**, not "widen to all paused". Widening was
the other candidate and it loses: it makes this one chip answer a click
differently depending on its own state, which is the thing that sent the
operator hunting through a menu in the first place. "All repeating job
occurrences" at the top of the menu also clears it.

The menu is the shared `StreamPauseFilter` with a `trigger` prop: a prop and
not a second component, because what must stay single is the **item list** and
the rule that switching off drops the reason. Jobs and Services pass no
trigger and keep the icon; a gate asserts that.

**The chip's count follows the reason** (`passesPauseFilter(r, true,
reasonCode)`), and the label becomes "1 paused · Season over". Counting every
paused row while showing only one reason's would be the same
count-says-one-thing, table-shows-another failure the other five chips are
held to.

One setter, `setLens(target, reason)`, takes the target outright; the chips
compute their own toggle on top of it. Both entry points still land in one
statement of what a lens change does to the other filters.

#### The invisible-chip bug this produced

Handing the chip to `Select.Trigger asChild` let Chakra's trigger recipe
override the badge's `solid` **background** while leaving its `solid`
**foreground** alone — white text on the page's white ground. The chip was
not ugly, it was **absent**, and the e2e read the right string out of the DOM
the whole time because the text was present and painted in white.

A chip now names **both halves of the pair** (`{palette}.solid` /
`{palette}.contrast` — themeTokens tunes them together per theme) and pins
back the height, border and font size the recipe imposes. Measured, not
eyeballed: all six chips are 20px tall, 12px text, no border. Gated.

## Multi-select was REMOVED (2026-11-10)

Work → Repeating could tick many rows and pause or resume them together. It
worked: one reason, one note, one reminder written as N ordinary
per-occurrence pauses, each reported back individually, with the shared-date
resume warning about its own pile-up.

It went because **the book is not big enough to need it** — about forty
pausable streams, one screenful. The operator: *"we don't have enough that
make it worth it for now. I can rethink it when there are many more
clients."*

**Removed in every layer, not hidden**, and a gate asserts it stays that way:

| Layer | Gone |
|---|---|
| Service | `pauseSelection`, `resumeSelection`, `withinScope`, `MAX_SELECTION` |
| Routes | `POST /repeating-streams/pause`, `POST /repeating-streams/resume` |
| Shared controls | `useStreamPauseSelection`, `StreamSelectionRow` |
| Dialog | `pause-many` / `resume-many` modes, `selectionCount`, `summaryNode` |
| Tab | checkboxes, "Select these N", the selection bar |

The feature *this* module replaced left `Job.clientBulkPausedAt` behind, and
two dead columns became a second way to pause that had to stay in step with
the first. Dead routes, an unreachable dialog mode and an unused hook are the
same debt in a different shape — and each one is individually harmless, which
is exactly how all four come back one at a time. **If it is rebuilt
deliberately, the gate is the thing to delete, and deleting it is a decision
somebody makes on purpose.**

### What it was (for whoever rebuilds it)

Bulk was never "do 40 things" — it was **one decision applied to 40 rows**.
End of season *is* one decision, so one reason + one note + one reminder was
the shape of the thought, not a compromise. The reminder came from the
reason's own horizon (`season_over` carries 150 days in production), so the
operator never typed a date. Resume defaulted to **each stream on its own
cadence**, which is the half you cannot practically do by hand — doing 29
individually means computing 29 dates, and a human reaches for one shared
date, which piles the book into one week in April.

The boundary that made it coherent: **bulk = one decision, N rows; single =
N decisions.** A customer-specific pause ("they're redoing the patio, call in
three weeks") has a per-customer note and date, and was always a single-row
action.

## Messaging the customer from a row (2026-11-10)

Pausing somebody's service is a thing they should hear about, and telling
them meant a trip to Customers, a search and a copy-pasted phone number — far
enough away that it would not happen. Each row now carries a message icon
(`ClientContactMenu`) offering **Text / Email / Call**, plus a **draft keyed
to what the row is about to do**:

- a pausable row drafts *"we're pausing your ⟨service⟩ after ⟨date⟩"*
- a paused row drafts *"we're restarting your ⟨service⟩ starting ⟨date⟩"*
- an awaiting-payment row drafts **nothing** — Money → Payments owns that
  message because it carries the invoice link and records the handoff, and a
  cheerier second version written from here would reach the customer with
  neither

**The trigger is a full-width button, not an icon.** It lives in the row's
actions column, whose rule is that every control there shares a width, size
and alignment — a stack, not a wrapped row, because three buttons at three
widths on three alignments is what that column originally shipped as and
could not be read. A square icon dropped into a stack of stretched buttons
broke the same rule from the other side: it was the one thing in the column
that did not line up. Order is **the decision, then telling them, then
navigating away** — Pause/Resume, Message, Open. Gated, and measured: all
three are 176px wide on the same left edge.

**It drafts, it never sends.** Every item opens the operator's own SMS or
mail client with the text filled in, through the same `buildSmsHref` /
`buildMailtoHref` / `fetchCommsCc` the job cards use — so a message from here
carries the same CC list as one from Work → Jobs. That is the only version
safe to offer beside a pause: the message stays theirs to read, edit or
abandon, and nothing is recorded as sent that a person did not send.

**Contact details ride on `clients.view`, not on this tab's own capability.**
The table opens on `schedule.view-all` — an oversight *read* over the
calendar — and seeing every visit is not the same trust as holding every
customer's phone number; the live book has a role in exactly that position.
The server **omits** the fields rather than the UI hiding them, because a
field the client never receives cannot be read out of a network tab. A
customer with neither phone nor email gets **no icon at all** — a disabled
one teaches the operator to ignore the control. (Production: all 53 rows have
a phone, none have an email.)

### Historical: the selection bar (removed with the multi-select)

The operator's report: *"You have a 'Select these' button, which it does. But
there is no place to take a collective action on those things. So what is the
point of selecting them?"*

**The bar existed the whole time**, sticky at the bottom of the viewport, two
inches below where they were looking. It rendered on the page's own
background behind a hairline rule, with **outline** buttons identical to the
per-row "Pause repeating" ones — so it read as more page, not as a place to
act. `toBeVisible()` passed throughout; the e2e now asserts
`toBeInViewport()` and that the bar offers at least one button.

Fixed by making it look like what it is: its own surface (`bg.panel`), lifted
off the list with a shadow and a purple border, and **solid** buttons. Solid
is the commit rung everywhere in this app, and it is what separates "do this
to the 40 rows I picked" from the outline button that does one row.

**One Clear, not two.** A "Clear selection" sat beside "Select these N" at
the top while the bar carried its own "Clear" at the bottom — two controls
for one action at opposite ends of the screen. The top row is the
**selector**; the bar is the **actor**. Gated.

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

The tab makes no scoped write of its own. Every pause and resume is an
ordinary per-occurrence call on its existing endpoint, already scoped there —
which is the point of the tab being a lens. (`withinScope` was the security
boundary of the removed selection path: it took a LIST of ids from a request
body, which the per-row endpoints never do.)

## Endpoints

| | | |
|---|---|---|
| `GET` | `/repeating-streams` | `schedule.view-all` |

**One route.** The two selection writes went with the multi-select on
2026-11-10; everything this screen writes goes through the per-occurrence
pause endpoints that Services and Jobs already use.

Contact details on the row are a **second capability** — `clients.view` —
checked in the handler with `callerCan` and omitted from the payload when
absent. See "Messaging the customer from a row".

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
— paused occurrences whose reminder is already **due** — and switches on the
held-only filter. Correct for the alert it was built for; wrong here, where
most rows are scheduled, awaiting payment, or held until spring. Every one of
those missed the lookup, got hidden by the filter, and landed the operator on
"No jobs match current filters", which reads as a broken tab.

## Resume — the date, and why it is suggested

A resume takes one date, from the row's own **Resume repeating** dialog. It
opens pre-filled with this stream's own cadence stepped forward
(`defaultResumeStartAt` = today + its interval), so the commonest next action
is "confirm" rather than "now change it". The table shows the same
`suggestedResumeAt`, computed server-side by `computeResumeStartAt`, so the
date shown on the row is the date the dialog offers.

**The date is read with `parseUserDate`, never `new Date`.** It arrives from
an `<input type="date">` as a bare `YYYY-MM-DD`, and `new Date("2026-11-24")`
is UTC midnight — the *twenty-third* in ET. Every resume from a card put the
visit back **one day early**, silently, until this was fixed on 2026-11-10;
the pause reminder had the same flaw, which also moved the "N to review"
count at the boundary. Found by an e2e asserting a 14-day service restarts
one cadence on and getting 13. Gated.

> The removed multi-select resume could instead step **every** selected
> stream forward on its own cadence in one pass — the half you cannot
> practically do by hand, since resuming 29 individually means computing 29
> dates and a human reaches for one shared date, piling the book into one
> April week. That is the strongest argument for rebuilding it if the book
> grows; see "Multi-select was REMOVED".

## Frontend

| | |
|---|---|
| Tab | [`apps/web/src/ui/tabs/RepeatingTab.tsx`](../../apps/web/src/ui/tabs/RepeatingTab.tsx) |
| Shared actions + the controller | [`StreamPauseControls.tsx`](../../apps/web/src/ui/components/StreamPauseControls.tsx) |
| The one dialog, three modes | [`StreamPauseDialog.tsx`](../../apps/web/src/ui/dialogs/StreamPauseDialog.tsx) |
| Both money clocks | [`PaymentWaitBadges.tsx`](../../apps/web/src/ui/components/PaymentWaitBadges.tsx) |
| Message the customer | [`ClientContactMenu.tsx`](../../apps/web/src/ui/components/ClientContactMenu.tsx) |

**One implementation of the pause.** `RepeatingTab`, `ServicesTab` and
`JobsTab` all mount `StreamPauseActions`, render `streamControls.dialogs`, use
`passesPauseFilter`, and **none of them wires `StreamPauseDialog` directly**.
That rule is gated; hand-rolling the dialog is how Services and Jobs drifted
the first time.

The dialog's three modes are `pause`, `update` and `resume` — one per thing
you can do to one stream. It carried `pause-many` and `resume-many` too, so
the **reason field** was not copied; those went with the multi-select, and
the reason logic they were protecting is unchanged.

### Layout

**One row implementation, responsive by CSS grid** — one track on a phone,
six columns at `md` (the seventh was the checkbox). Not a table for desks plus a card list for phones:
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

- **Blanks sort last in BOTH directions.** A blank Reason is the
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

### The actions column

Every control in it is the **same width, size and alignment**, in a fixed
order: **Pause/Resume → Message → Open**. A stack rather than a wrapped row,
because three buttons at three widths on three alignments is what this column
originally shipped as and it could not be read; a square icon dropped into a
stack of stretched buttons broke the same rule from the other side. Measured,
not eyeballed: 176px wide, same left edge.

A **blocked** row simply has no pause control, and the State cell says why.
(It used to carry a disabled checkbox beside that sentence; with the
multi-select gone the rule is just "absent, and explained".)

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

**Verified 2026-11-10 — the names below are the files that exist.**

- **Backend gate** — [`repeating-build-gate.test.ts`](../../apps/api/src/services/repeating-build-gate.test.ts),
  registered in the `test:build-gate` filter list (an unregistered gate
  shrinks the run silently). It asserts the no-new-state rules, the
  capability split, the membership test including the one-off exclusion, both
  money clocks and their shared rule, the expiry rules, the chip/filter
  invariants, the vocabulary, the ET date parsing, **and that the
  multi-select stays removed in all five layers.**
- **Route map** — `npm run routemap:check`; G5 fails the build if a guard and
  the map disagree. This tab now contributes **one** route.
- **API authz** — `--project=api` derives from the route map, so
  `GET /repeating-streams` is driven both ways automatically.
- **Playwright** — two files, both `--project=owner`:
  - [`repeating-table-owner.spec.ts`](../../apps/web/tests/e2e/specs/repeating-table-owner.spec.ts)
    — the table, a blocked row offering no pause, a per-row pause written to
    the database and read back, the reason filter, messaging, the chips, and
    the paused chip's reason menu.
  - [`repeating-mobile-owner.spec.ts`](../../apps/web/tests/e2e/specs/repeating-mobile-owner.spec.ts)
    — renders narrow and measures; no sideways scroll.
  - `cd apps/web && npx playwright test --project=owner repeating`

### Personas that matter

| Persona | `schedule.view-all` | `schedule.manage` | Expectation |
|---|---|---|---|
| `owner` | ✓ | ✓ | full table and actions |
| `coordinator` | — | ✓ | **no tab** — see the operator note above |
| `employee` | — | — | no tab |

Which personas see the tab at all is asserted by `persona-sweep`, which
parses `TAB_REQUIREMENTS` rather than hard-coding a list.

> **THE READ-ONLY TIER HAS NO PLAYWRIGHT PERSONA.** The live book's `Auditor`
> role holds `schedule.view-all` *without* `schedule.manage`, but no seeded
> dev role does — the seed's examples are Coordinator, Bookkeeper and
> Payroll. So "table renders, no action controls" is a real production state
> that **cannot be driven by a spec today**; the build gate asserts the
> affordances sit behind `canManage` instead. Adding an Auditor example role
> plus a Clerk account would make it drivable, and is the single most
> valuable test this feature is missing.

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
