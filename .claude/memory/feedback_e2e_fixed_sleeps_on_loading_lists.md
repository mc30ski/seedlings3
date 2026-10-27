---
name: feedback-e2e-fixed-sleeps-on-loading-lists
description: "A list that renders its empty state while loading turns waitForTimeout into a lie — wait for the list to settle, not for a number of seconds."
metadata:
  node_type: memory
  type: feedback
---

`JobsTab` renders **"No job occurrences match current filters."** while the
fetch is still in flight (the empty branch is `dayGroups.length === 0`, and
the spinner is a separate overlay). Six specs did
`waitForLoadState("networkidle")` + `waitForTimeout(4000)` and then read the
page, so under load they asserted against a half-loaded list and failed with
things like "did not land on a jobs surface", "found no payout line", "no
Edit Charges button", "a worker should see the parcel icon".

**Why:** `networkidle` fires before React has even mounted the tab, so the
4 s is the whole budget for mount + two `/api/occurrences` round trips. It
passes on an idle machine and fails in a full run — the classic
"deterministic failure that is really a timing artefact".

**How to apply:** use `waitForJobsListSettled(page)` from
`apps/web/tests/e2e/helpers/nav.ts`. It waits for the toolbar's refresh
button (`aria-label="Refresh jobs"`, added for this) to be enabled — that
button carries `loading={loading}`, the same flag the list reads, so enabled
means settled. Before blaming data, check the DB: on 2026-10-18 the
"empty" list belonged to a worker who had 6 occurrences in the window.

Same shape, different overlay: `waitForSplashGone(page)` in the same file.
`toBeVisible()` does not hit-test, so an element under AppSplash (up to
`HARD_MAX_MS` = 15 s plus fade) asserts fine and the next click times out.
A bare `waitFor({ state: "detached" })` is not enough — straight after a
reload the overlay has not mounted yet, so it returns on the gap before it
appears; require it to stay away.

Related: [[feedback-e2e-cold-compile-race]],
[[feedback-e2e-localstorage-stamp-race]], [[feedback-never-ship-a-red-spec]].
