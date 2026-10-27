---
name: feedback-e2e-localstorage-stamp-race
description: "E2E specs that stamp seedlings_topTab must ALSO stamp seedlings_lastAppOpenedAt, or the first-open-of-the-day takeover drags the run to Work -> Home."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-10T18:01:24.595Z
---

Every Playwright spec that navigates by stamping `localStorage` (`seedlings_topTab`, `seedlings_staffTab`, `seedlings_staffCategory` — the `gotoWorkerHome` / `gotoGuides` pattern in `apps/web/tests/e2e/helpers/nav.ts`) must stamp **`seedlings_lastAppOpenedAt`** in the same `page.evaluate`:

```ts
localStorage.setItem("seedlings_lastAppOpenedAt", new Date().toISOString());
```

**Why:** `pages/index.tsx` has an "auto-show Home on the first open of the ET day" effect. It fires when `seedlings_lastAppOpenedAt` is absent or from another day — which is every fresh Playwright context — and sets topTab/staffTab/staffCategory to staff / home / Work, discarding whatever the spec just stamped. It is gated on `me?.workerType`, so it only ever bit the worker-typed personas: on 2026-10-18 it was the single cause of **14 of 14** `employee`-project failures (all of `guides-worker`, plus `payroll-worker`, `job-role-gating`, `compliance-nav`), while `scheduler` and most `owner` specs were untouched. 27 specs already stamped the key; `nav.ts` did not.

The two-`goto` dance does NOT protect you: the first load only writes `lastAppOpenedAt` if `me` resolves before the second navigation, so the bug appears exactly when the machine is busy — i.e. in a full run, not when you re-run the one spec.

**How to apply:** the tell is a failure screenshot showing **Work → Home** when the spec stamped another tab. That is not a locator bug and not a timing bug in the assertion — don't rewrite the locator and don't raise the timeout.

The older claim in [[project-forecast-tool]] that "Playwright nav kept failing" for the Forecast tab was this race, not a Playwright limitation. Related: [[feedback-never-ship-a-red-spec]], [[reference-playwright-setup]].

The perspective chip is `Viewing as <name> — click to change perspective`. Specs that want "the app has loaded in the staff shell" should match `/click to change perspective/i`, which survives whichever perspective is active. `Acting as Super` is gone with the Role enum.

Two locator traps hit in the same session, worth knowing because they waste a full 1-minute run each:

- `page.locator("div").filter({ has: <title text> }).last()` resolves to the tightest wrapper around the TEXT, which contains neither the card's content nor its buttons. Filter on an intersection instead — `.filter({ has: badge }).filter({ has: editButton }).last()` — so the tightest match is the card body.
- A Chakra `Select.Root` renders its full option list in a closed popover, so `getByText("Workers comp")` matches a HIDDEN `<option>` and proves nothing about what is selected. Assert on the trigger: `page.locator('[data-part="value-text"]')`.
