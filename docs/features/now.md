# Work → Now

The operation as it stands this minute: who is out, what they are on, what
is left, and what is in somebody's hands. One button on it, to join in.

- Tab: [`apps/web/src/ui/tabs/NowTab.tsx`](../../apps/web/src/ui/tabs/NowTab.tsx)
- Payload types: [`apps/web/src/lib/nowBoard.ts`](../../apps/web/src/lib/nowBoard.ts) (mirrored — see below)
- Route: `GET /board/now` in [`apps/api/src/routes/occurrences.ts`](../../apps/api/src/routes/occurrences.ts)
- Builder: `buildPrivateBoard` in [`apps/api/src/services/displays.ts`](../../apps/api/src/services/displays.ts)
- Specs: [`now-board-owner.spec.ts`](../../apps/web/tests/e2e/specs/now-board-owner.spec.ts)
  (`--project=owner --no-deps now-board`) and
  [`scheduler-now-board-withheld.spec.ts`](../../apps/web/tests/e2e/specs/scheduler-now-board-withheld.spec.ts)
  (`--project=scheduler --no-deps now-board`)
- Gated by: G50 in `permissions-build-gate.test.ts` ("Work → Now actually
  narrows, in the route and in the builder")

## It is the wall display's board, signed in

`buildPrivateBoard` already answered this question — it drives the paired
screen in the shop. It was simply unreachable without a device token. The
Now tab calls the same builder with the caller's portfolio scope; nothing
here re-derives "today".

That is the whole design decision. A second query answering the same
question is how two screens come to disagree about how much work is left,
and this codebase has paid for that shape before: the Take Payment preview
re-derived a payout that `reconcileApproval` owned, drifted, and quoted an
employee $52.50 against the $105 actually paid.

Two fields are dropped on the way out. `mode` has nothing to discriminate —
this endpoint has one payload. `photos` is unusable: every URL points at
`/api/public/display/photo/:id`, which requires a *display* token and 401s
for a signed-in user, so shipping them would render as broken tiles.

### A held stream is not today's work

`OFF_BOARD_STATUSES` is what today's query excludes: `CANCELED`, `ARCHIVED`,
`REJECTED`, `PROPOSAL_SUBMITTED` — and `STREAM_PAUSED`.

The last one is the one that is easy to miss, and it shipped missing.
Pausing a repeating stream **keeps the occurrence where it is** rather than
moving or deleting it — that is the stated design, so that resume can pick a
fresh date deliberately. The consequence is that a held visit stays dated,
keeps its assignees, and looks to any careless query exactly like work
somebody owes you this morning. On the board that read as: the visit listed
under *Still to do*, counted in *Left* and *Visits today*, both its assignees
listed under *Has work today, not clocked in*, and an amber **2 not clocked
in** alert naming two people who had nothing to turn up for.

The schema already states the contract — *"When status = STREAM_PAUSED:
worker feeds hide the row (no dispatch)"* — and the private board **is** the
dispatch board, so hiding it is the contract, not a new policy.

Worth knowing why it went unnoticed: the sibling overdue query is written as
an **inclusion** list (`SCHEDULED` + the active statuses), so it never
admitted a held row and was right all along. One query excluding a list and
its neighbour including one means the two cannot be read against each other
by eye. `display-recovery-build-gate` now checks **every** status filter in
the builder, in either shape, so a third query cannot be added with the hole
re-opened.

### Visits, and the office's own day

The board carries two kinds of row and shows both. `STANDARD`, `ONE_OFF`
and `ESTIMATE` are field work — **visits**. `TASK`, `REMINDER`, `FOLLOWUP`,
`EVENT` and `ANNOUNCEMENT` are the office's own day.

Both belong here: an overseer who is not shown today's reminders is being
told the day is emptier than it is. What they must not be told is that a
reminder is a visit, and that is what the screen used to say — one list
served both, under a heading reading *Today's visits*, beneath a tile
labelled the same, and a titleless reminder rendered as the literal word
"Visit". The counts now cover field work only; the office rows sit under
**Also today — not visits**. Same information, fewer lies.

`unclaimed` counts field work only too. An unclaimed reminder is not a
staffing problem, and alerting on one teaches people to ignore the strip.

**The partition is gated against the enum, not hand-kept.** There used to be
one list — `NON_JOB_WORKFLOWS`, four entries — and `OccurrenceWorkflow` had
grown an eighth value, `ANNOUNCEMENT`, that was in nobody's list. So an
announcement counted as completed field work on the **public** waiting-room
wall, directly under a comment promising a client could believe the number.
A single list cannot notice a value nobody added to it, so there are now two
and `mirror-types-build-gate` fails the build unless they cover the enum
exactly once each.

## Photos of today's finished work

Each finished visit carries up to four thumbnails of what the crew actually
photographed. This is the one thing on the board that is *evidence* rather
than status: a row says "completed" because somebody tapped a button; a
picture of the lawn cannot be tapped into existence.

They hang on the visit rather than in a strip of their own, so there is
never a question of which visit a photo came from.

**The URLs are presigned R2 links, and only the signed-in board gets them.**
A paired wall display keeps using `/public/display/photo/:id`, which
re-checks five things on every single image — the token, the screen's mode,
revocation, the photo's opt-out, and whether the visit is finished. A
presigned URL answers to none of that: it is a bearer credential good for an
hour to anyone who reads it, and unpairing the screen does not invalidate
it. Sending those to a TV in a shop would trade five live checks for a link
that outlives the device's authorisation. So `BoardScope.signedPhotoUrls` is
off by default, the Now route is the only caller that sets it, and
`photo-visibility-build-gate` fails the build if the display ever asks.

**The row shows three; the viewer holds the visit.** Three thumbnails and a
`+N` chip, and clicking either opens the shared `PhotoLightbox` — arrow keys,
Escape, swipe, and an `n / total` counter, which is the part that makes the
viewer honest about how many there are.

The whole visit's photos ride in the board payload rather than being fetched
on click, which is the opposite of what the jobs card does. The jobs card
calls `GET /occurrences/:id/photos` for the full set, and that route is
guarded on `schedule.contribute` — which the **read-only oversight tier does
not hold**. A board built on that second fetch would quietly show an Auditor
three photos and no way to the rest. This board's own guard already covers
the whole book, so the photos travel with the row. The cap is 16 per visit
against production's heaviest visit of 14 (median 3), and 240 for the day.

The viewer is read-only on purpose: the jobs card's own viewer carries Delete
and a public-visibility toggle, and neither belongs on a tab that opens for
people who hold neither capability.

## Rows open the visit

Every row — visits and office rows alike — opens that occurrence on Jobs,
narrowed to it. "Open in Jobs" at the top of the panel already goes to the
tab; a row that did the same would be the worse version of itself, dropping
the reader into their own default filters to hunt for the thing they had just
pointed at.

It uses JobsTab's documented handoff, copied from HomeTab's row click rather
than reinvented: write `<occId>|<startAt>` to
`seedlings_jobs_pendingHighlight`, then navigate with `remount: true`. Both
halves matter — the effect that consumes the key runs once per mount, so
without the remount a reader already on Jobs gets nothing; and the anchor
date pins the date filter to that day instead of leaving the row filtered out
of the reader's own window. JobsTab then filters to the single occurrence and
shows a **Filtered to 1 occurrence** badge, which is what the e2e asserts on.

The *selection* is unchanged and still deliberately narrow — `hiddenFromPublicAt: null`
and finished visits only — because the display photo route refuses anything
else, and a board that selected more broadly would emit URLs that 404 and
render as dead tiles.

## Now is not Home

| | Home | Now |
|---|---|---|
| Subject | **my** day | **the business's** day |
| Gate | `schedule.view` — baseline | `schedule.view-all` — oversight |
| Audience | everybody who works | whoever watches the operation |

A list of where every person in the business is standing is an oversight
screen. A field worker's own day is Home, and they do not get this tab.

`schedule.view-all` and nothing else, for the three reasons the `repeating`
row carries: not `schedule.view` (that is the baseline); not
`schedule.manage` as an alternative, because the tab's one endpoint is
guarded on the *read* and an any-of row would open the tab onto a 403; and
the read is deliberately wider than the write, so an oversight reader gets
the whole board and no buttons. Production's **Auditor** role holds exactly
this and no schedule write at all.

## The timeclock is a separate grant, withheld on the server

Who is on the clock is attendance, which is `time.view` — a rung
`schedule.view-all` does not imply. The route omits `onTheClock` and
`assignedNotClockedIn` for a caller without it, and filters the matching
`not_clocked_in` row out of `attention`, which names the same people in its
`detail`.

**Withheld, not hidden.** A panel the browser declines to draw over data the
server already sent is not a gate; the payload is one `curl` away.

Proven by `scheduler-now-board-withheld.spec.ts`, which asserts on the
**response body** rather than the page — the claim is that the data does not
travel, and a page-only assertion would pass just as happily against the
broken version. Mutation-tested: removing the server-side gate fails it.
Three dev personas sit on this side of the line — scheduler, coordinator and
districtLead — all holding `schedule.view-all` without `time.view`.

The web type keeps both fields **optional**, and the tab distinguishes the
two cases on screen: `[]` is "nobody is clocked in", `undefined` is "you may
not see this", and it says so. Those must never look alike — an absent panel
with no explanation reads as an empty yard.

## What the portfolio filter reaches

The **visits** narrow, through `occurrencePortfolioWhere` like every other
occurrence-rooted surface, and so does everything counted from them —
including each worker's rows, because a worker's rows on this board *are*
the visits they are on.

**Vehicles out and equipment out do not narrow, and say so on their face.**
A truck and a backpack blower belong to the business, not to a territory,
and there is no honest filter for them. Inventing one would *under*-report
what is out, which is the opposite of what the panel is for. The two panels
carry a "business-wide" badge rather than leaving a reader with a filter on
to assume the whole screen moved.

`TAB_NARROWING` therefore lists `now` as `{ grant: true, lens: true }`, not
the `{ part }` shape. `{ part }` means "company-wide APART FROM one panel",
which is the opposite of what is true here — and it would put the strip back
to calling this a whole-business screen over a job list the filter had
already shortened, the exact sentence the `repeating` entry was added to
stop.

## It does not poll

Hard rule in this repo. The one granted exception is `/display`, precisely
because nobody is standing at it. Somebody *is* standing at this one, so it
gets what the display cannot have: a **Refresh** control. It also re-reads
when the document becomes visible again — an event, not a timer.

A local 30-second tick moves the elapsed figures ("2h 14m" → "2h 15m") and
touches no network. The rule is about traffic.

**And it says how old it is.** Once a board updates quietly, a frozen one
looks exactly like a working one — same layout, same rows, nothing moving.
The "as of" line turns amber past three minutes. That line is the only thing
between live and lying.

## Start working

The one action on the tab, and it is a **link to Home** — which is the
intended place to start a day, and where a person's own day lives: the hero
that starts the workday, the hours, the next stop. The board does not clock
anybody in, and the card says so: *"Go to Home, where you clock in and start
your first stop."* Somebody already on the clock gets a quieter card to the
same place.

### It is gated on a capability, and asking for a pay class was wrong

`scope.can("work.claim")` — clearance to do field work, the same capability
`POST /occurrences/:id/claim` is guarded on and the same one `isFieldCleared`
asks.

It shipped gated on `me?.workerType` being set, which asks *is this person on
the payroll*. That is a different question, and the gap is a real account:
**an UNPAID observer has a worker type**, so the live book's read-only
Auditor was offered a button to start her working day.

The pay-class check is not lost, it is subsumed — `can()` refuses a null
`workerType` **before** it walks any roles (G31), so the capability cannot be
held without one.

It additionally requires `canSeeTab("home", scope.can)`, because the card
navigates to Home and a door to a tab you do not have is not an action. That
reads the same `TAB_REQUIREMENTS` row the tab strip does rather than this
file keeping its own idea of what Home costs.

**An oversight reader therefore gets this tab with no action on it at all.**
That is what the read-only tier is.

Gated by an unnumbered rule in `tab-requirements-build-gate.test.ts` — the
card must name `work.claim`, must check Home is reachable, and `NowTab.tsx`
must not read `workerType` in live code at all. Scoped to the one file on
purpose: a pay class legitimately decides a great deal of what the app
*draws*, and a general rule would be wrong more often than right. What is
never legitimate is a pay class deciding whether an **action** is offered.

> Home's own begin-workday hero was wired to `onLaunchWorkflow={() => {}}`
> and had been armed — cursor, hover, action row — while doing nothing at all
> when clicked. Fixed in the same change.

## Where you land in the morning

The staff tab is persisted, so every ordinary load returns you where you
left off. The **only** thing that overrides it is the first-open-of-the-ET-day
takeover in `pages/index.tsx`, and that now lands on `now` when
`canSeeTab("now", scopeCan)` says the person can open it, else `home`.

**That is a capability question, not a role one.** A role → tab table has to
answer for a role nobody anticipated — a bookkeeper, an auditor, an observer
— and it answers by falling to whichever bucket it sits nearest, which is
how ~500 role-named booleans decided questions they had no business
deciding. There is no role here and there does not need to be.

## Mirrored types, and what is *not* checked

`apps/web/src/lib/nowBoard.ts` declares that it mirrors
`apps/api/src/services/displays.ts`, so the mirror gate compares
`BoardWorker` and `BoardJob` field for field.

`NowBoard` itself is **not** compared: its API counterpart is
`Omit<PrivateBoard, …>` and the gate only reads literal `export type X = {}`
declarations. That was a deliberate trade. Restating ten fields beside
`PrivateBoard` would buy a check on the web side and create an unguarded
drift pair in the API, between two literals in the same file with nothing
comparing them. One copy with a known gap beats two copies with none — and
the gap is narrow, because every nested row shape *is* checked.
