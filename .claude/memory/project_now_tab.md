---
name: project_now_tab
description: "Work → Now (built 2026-11-16, three fixes 2026-11-21): the wall display's PRIVATE board, signed in. Reuses buildPrivateBoard — no second derivation of 'today'. Gated schedule.view-all; timeclock withheld SERVER-side on time.view. 11-21: STREAM_PAUSED visits were dispatched as today's work; counts now cover FIELD WORK only (ANNOUNCEMENT was missing from NON_JOB_WORKFLOWS and counted on the PUBLIC wall); finished visits carry presigned photo thumbnails + carousel and rows open the visit; the dev photos R2 bucket was EMPTY, which was the old display-photo-404."
metadata:
  node_type: memory
  type: project
  modified: 2026-11-21T00:00:00.000Z
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

## 2026-11-21: a HELD stream was dispatched as today's work

`OFF_BOARD_STATUSES` in `displays.ts` omitted `STREAM_PAUSED`. Because
pausing a stream **keeps the occurrence in place** (by design — resume picks
a fresh date deliberately), a held visit stays dated and keeps its
assignees, so it looked to the today-query exactly like work due now.
Reported from the screen: a "stream paused"-badged visit under *Still to
do*, counted in *Left* and *Visits today*, both assignees under *Has work
today, not clocked in*, and an amber **2 not clocked in** naming two people
with nothing to turn up for. The schema already stated the contract —
"worker feeds hide the row (no dispatch)" — and the private board IS the
dispatch board, so this was a missed implementation of an existing rule, not
a policy change. Fix: one constant. Also fixes the paired wall display,
which shares the builder.

**Why it hid:** the sibling overdue query is an INCLUSION list and was
correct all along. One query excluding a list beside one including a list
cannot be reconciled by eye. The gate in
`display-recovery-build-gate.test.ts` now resolves every named status list
from source and checks **each** status filter in `buildPrivateBoard` in
either shape — mutation-tested 6/6 (drop the value, inline the filter, add a
third leaky query, spread an unknown list, widen overdue, empty the
constant).

**Verified against dev data, not just the diff.** Current dev had no paused
occurrence dated today, so the condition was recreated (moved a
STREAM_PAUSED row to today, attached two paid assignees) and the real
builder run twice — old constant reproduced the screenshot exactly
(`left 1 · visits today 1`, both names, the amber alert), fixed constant
gave `0 / 0 / none`. Dev row restored to `2026-10-31`, 0 assignees.

**Still unexamined, deliberately:** the private board does NOT apply
`NON_JOB_WORKFLOW_EXCLUSION`, so a TASK/REMINDER/FOLLOWUP/EVENT dated today
does count in its tiles — unlike the public board, which excludes them. That
may well be right for a dispatch board, but it has never been decided out
loud. See [[project_repeating_tab]] for the pause model itself.

## 2026-11-21 (same day): visits vs the office's day, and photos

**The board always DID show non-job rows** — my first note here said only
that they inflated the count, which was wrong and sent the question down the
wrong path. `jobs` is built from the same unfiltered array, so tasks and
reminders were listed too. The defect was never inclusion, it was the
LABELS: tile "Visits today", heading "Today's visits", and `titleOf`
falling back to the literal word "Visit" for a titleless reminder.

Fix: `BoardJob.workflow` now ships; counts and `unclaimed` are computed over
`FIELD_WORK_WORKFLOWS` (STANDARD/ONE_OFF/ESTIMATE) only; the rest render
under **"Also today (n) — not visits"** with a kind badge. Nothing hidden,
number stops lying.

**A second, pre-existing bug fell out of it: `NON_JOB_WORKFLOWS` was missing
`ANNOUNCEMENT`.** The enum has EIGHT values and the list had four, so an
announcement counted as completed field work on the PUBLIC waiting-room
wall. Now a gated PARTITION — `mirror-types-build-gate` fails the build
unless the two lists cover `OccurrenceWorkflow` exactly once each. One
hand-kept list cannot notice a value nobody added to it.

**Photos: finished visits carry up to 4 presigned R2 thumbnails.** The
top-level `photos` strip was always there but its URLs are the
display-token route, which 401s for a signed-in user — that is why the Now
route dropped it. New `BoardScope.signedPhotoUrls` (default OFF) attaches
per-visit presigned URLs; the Now route is the only caller that sets it.
**The wall display must never get these** — `/public/display/photo/:id`
re-checks token, mode, revocation, opt-out and finished-ness on every image,
and a presigned URL is an unrevocable hour-long bearer link. Gated in
`photo-visibility-build-gate`; the SELECTION (hidden-null + DONE) is
unchanged. Layout: own line on mobile, inline right-hand column from `md`.

All new rules mutation-tested **8/8**. My own gate regexes had two bugs
worth remembering: a type annotation (`: OccurrenceWorkflow[]`) between the
name and `=` broke `\bNAME\s*=`, and `\bNAME[^=]*=` matched the name where
it appears in PROSE in a comment and walked forward to the NEXT
declaration's `=`, silently reading the wrong list. Anchor on `const NAME`
and forbid newlines before the `=`.

## THE DEV PHOTO BUCKET WAS EMPTY — this closes the old "display photo 404"

`seedlings-photos-dev` held **0 keys** while 22 `JobOccurrencePhoto` rows
pointed at `seed/landscaping/*.jpg`. That is the whole of the long-open
"Display photo 404, cause UNKNOWN" from the 2026-10-31 and 2026-11-13 e2e
runs — see [[project_e2e_full_run_2026_11_13]], which guessed at credentials.
**Credentials are fine**: presigning works and returns a signed **404**, not
a 403. The objects simply were never uploaded.

`apps/api/scripts/seed-photo-objects.ts` exists for exactly this and takes a
directory of JPEGs named `00..05,07.jpg`; the repo ships no such images, so
it had evidently never been run here. **The 7 objects now in the bucket are
SYNTHETIC placeholders I generated** (striped-turf JPEGs, 900x600) — they
read as a mowed lawn at thumbnail size and nothing more. To replace them
with real photographs: drop 7 jpgs in a folder and re-run that script; keys
outlive a reseed, so no reseed is needed afterwards.

## 2026-11-21 (third pass): rows open the visit, photos open a carousel

- **Every row navigates**, visits and office rows alike, via JobsTab's
  documented handoff: `seedlings_jobs_pendingHighlight` = `<occId>|<startAt>`
  then `navigate:staffTab` with **`remount: true`**. Both halves are
  load-bearing — the consuming effect runs once per MOUNT, so without the
  remount a reader already on Jobs gets nothing; the anchor date pins the
  date filter to that day. Copied from HomeTab's row click. JobsTab then
  FILTERS to the one occurrence (badge: "Filtered to 1 occurrence") rather
  than scrolling — so that badge is the thing to assert on, and it only
  appears once the `includeOccId` fetch has returned.
- **Photos: 3 thumbs + a `+N` chip, opening the shared `PhotoLightbox`.**
  Not the jobs card's viewer — that one carries Delete and a public-visibility
  toggle, which the read-only tier must not see.
- **The whole visit's photos ride in the BOARD payload, deliberately unlike
  the jobs card**, which fetches `GET /occurrences/:id/photos` on click. That
  route is `schedule.contribute`, which **Auditor does not hold** — a board
  built on that fetch would show the read-only tier 3 photos and no way to
  the rest. Caps: 16/visit (prod max is 14, median 3 — measured), 240/day.
- **The wall display's flat `photos` strip is still sliced to 40** even
  though the query now takes 240. Ordering is `createdAt desc`, so it is the
  same 40 it always got. Don't "simplify" that slice away.
- **Seed now gives today's finished visits 2–5 photos each** (older ones keep
  1, for the wall's breadth). With one apiece the `+N` chip never rendered
  and the viewer opened on a single frame — the feature looked done and was
  untested by eye.

A click on a thumbnail MUST `stopPropagation()`: the row navigates, so
without it the click does both and the viewer unmounts as it opens.
