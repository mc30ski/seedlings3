---
name: feedback-e2e-localstorage-stamp-race
description: "E2E specs that stamp seedlings_topTab must waitForLoadState BEFORE the stamp, or the app's own mount clobbers it and the run silently lands on the wrong role."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-09-10T18:01:24.595Z
---

Every Playwright spec that navigates by stamping `localStorage` (`seedlings_topTab`, `seedlings_superTab`, `seedlings_superCategory` — the `gotoWorkerHome` / `gotoSuperCompliance` pattern in `apps/web/tests/e2e/helpers/nav.ts`) must `await page.waitForLoadState("networkidle")` after the FIRST `goto`, before `page.evaluate`. Then assert the role actually landed:

```ts
await expect(page.getByRole("button", { name: /Acting as Super/ })).toBeVisible();
```

**Why:** `page.goto` resolves on `load`, which is before React mounts. `usePersistedState` then writes its own defaults, and the tab router's "jump to Home on the first open of the day" writes `topTab` too — both AFTER the stamp if you don't wait. The spec then runs as Worker against the Super tab it asked for, and fails on a locator that looks wrong for a completely unrelated reason.

**How to apply:** the tell is a failure whose page snapshot says `Acting as Worker` (or a suspiciously small alert count) when the spec stamped `"super"`. That is not a locator bug — don't go rewrite the locator. It is also DAY-DEPENDENT, because the auto-jump only fires on the first open of an ET day, so the same spec passes in the morning and fails in the afternoon. A "flaky" nav spec is usually this.

The older claim in [[project-forecast-tool]] that "Playwright nav kept failing" for the Forecast tab was this race, not a Playwright limitation. Related: [[feedback-never-ship-a-red-spec]], [[reference-playwright-setup]].

Two locator traps hit in the same session, worth knowing because they waste a full 1-minute run each:

- `page.locator("div").filter({ has: <title text> }).last()` resolves to the tightest wrapper around the TEXT, which contains neither the card's content nor its buttons. Filter on an intersection instead — `.filter({ has: badge }).filter({ has: editButton }).last()` — so the tightest match is the card body.
- A Chakra `Select.Root` renders its full option list in a closed popover, so `getByText("Workers comp")` matches a HIDDEN `<option>` and proves nothing about what is selected. Assert on the trigger: `page.locator('[data-part="value-text"]')`.
