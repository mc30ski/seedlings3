---
name: feedback-e2e-inventory-measurement
description: "An e2e measurement that counts what is on screen must prove the page rendered first — networkidle does not, and a cold `next dev` chunk reads as an empty page."
metadata:
  node_type: memory
  type: feedback
---

**Before trusting any e2e measurement of what is on screen, check whether the
numbers correlate with position in the run.** If they improve as the run
proceeds, you measured compilation, not the app.

**Why:** 2026-10-17, the read-only persona sweep produced a per-tab control
inventory. It reported eight "empty" tabs for the 2nd persona, six for the
5th, four for the 6th, three for the 7th — monotonically falling with run
order. The same tab (`jobs`) read 0 controls for one persona and 6 for
another. Those were not empty rooms; `page.waitForLoadState("networkidle")`
resolves while `next dev` is still building the route, so the inventory
counted an unmounted page. Nearly reported eight UI bugs that did not exist.

Related and already known: [[feedback-e2e-cold-compile-race]] — a spec
failing 3/3 can still be a warm/cold artefact.

**A third instance, 2026-10-17 (mutation round).** Navigating by stamping
`seedlings_<shell>Tab` landed on Home every time, because the app jumps
anyone with a `workerType` to worker/Home **on the first open of a new ET
day** — and every Playwright context is fresh, so that condition is always
true. Three "is not offered the claim control" assertions passed on a page
that has no claim control for anybody. Two fixes, both now in
`sweep/persona-sweep.spec.ts` and `mutations/persona-mutations.spec.ts`:

- Stamp `seedlings_lastAppOpenedAt` so the app sees a RETURNING user.
- Stamp `seedlings_<shell>Category` too — the breadcrumb is two levels and
  they persist separately.
- Verify arrival by reading `seedlings_<shell>Tab` back AFTER the load.
  Seeing the tab's label is not enough: the breadcrumb renders a chip per
  tab in the category, so the label proves the category resolved. Reading
  the key back is not circular *after a reload* — the app rewrites it when
  it redirects. (Reading it back immediately after writing it, with no
  reload, IS circular, and that was the second instance.)

**How to apply:**
- `networkidle` is not "rendered". Add an explicit readiness wait — for this
  app, `document.querySelectorAll("button").length >= 3` catches the shell
  chrome, which every mounted page has.
- **Warm the routes first.** One pass as the most privileged persona before
  measuring makes every later measurement comparable.
- **Never conflate "did not render" with "is empty."** Record a third state.
  An inventory that cannot tell them apart is unreadable, and the failure
  mode is inventing bugs.
- Subtract what is common to every row (here the shell chrome) or each row
  reports the frame rather than its own contents.
- PASS/FAIL from event-driven signals — console errors, page errors — stayed
  trustworthy throughout, because they fire whenever they happen. It was only
  the point-in-time count that was contaminated. Separate the two when
  reporting.
- A reporting bug of my own in the same pass: "never reached: guides,
  profile, tools-*" on every persona was the summariser comparing against a
  list that included the tabs the walk deliberately skips. Check that the
  report's own expectations match what the test actually did.
