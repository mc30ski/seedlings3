---
name: feedback-no-polling
description: "HARD RULE — the app does not poll. One granted exception: the wall display at /display, and only once paired. Gated."
metadata:
  type: feedback
---

# The app does not poll

Not "avoid polling where practical" — **does not poll.** Data arrives when
someone asks for it, or when an action causes it. A screen that wants fresher
numbers gets a **refresh control**, not a timer.

**Why:** a `setInterval` refetch costs a Neon connection per tick on a
serverless backend, forever, on every open tab, whether or not anyone is
looking at it. It is invisible in development and expensive in production.

## The one exception

**`/display`, and only once paired.** A wall display has nobody standing at it
and no way to ask for a refresh — polling is the entire mechanism by which it
works. Granted explicitly by the user 2026-09-20. An *unpaired* display
(showing a pairing code) polls the pairing endpoint only, never the board.

Nothing else. If something seems to need it, ask first.

## Why this is written down

It was broken within an hour of being agreed. `DisplaysTab` shipped with a
15-second `setInterval` refetch, justified in a code comment as convenience
during pairing — the user caught it by asking *"The Display tab is not polling
right?"*. Nobody would have noticed until it was live on every operator's open
tab.

**Local timers are NOT polling.** A clock tick (`setNow(Date.now())`), a
carousel rotation, a countdown — these touch no network and are fine. The rule
is about traffic.

## Enforcement

[`apps/api/src/services/no-polling-build-gate.test.ts`](apps/api/src/services/no-polling-build-gate.test.ts)
fails the build on any `setInterval` whose body hits the network, outside a
short `ALLOWED` list that carries a written reason per entry. It also asserts
the display's board poll returns early without a token, so the exception stays
"once paired" rather than widening to "/display".

One pre-existing entry is on that list rather than hidden:
`DocumentSyncStatusPanel` polls every 3s **while a sync is running**
(`serverInProgress`), which is a progress bar rather than an idle tab. Left in
place and flagged so it stays visible.

Related: [[feedback-run-build-gate-after-changes]], [[project-neon-pipelineconnect-workaround]].
