---
name: feedback_e2e_cold_compile_race
description: "A Playwright spec with a fixed waitForTimeout can lose to Next.js dev on-demand compilation — it looks exactly like a product bug"
metadata:
  node_type: memory
  type: feedback
  modified: 2026-10-13T00:00:00.000Z
---

**A spec that waits a FIXED number of milliseconds after `networkidle` can
fail purely because the Next dev server was still compiling that route.** It
presents as a product bug: the page renders its chrome, the list shows an
empty state, and the assertion reads like missing data.

**Why:** `next dev` compiles routes on demand. `networkidle` settles before
the chunk is ready, and a `waitForTimeout(4000)` then measures an
unfinished page.

**How it was proven** (2026-10-13, `job-role-gating.spec.ts:12`):
- Failed **3/3** with `worker page chars: 81` — looked deterministic.
- A byte-identical COPY of the same file passed (`md5` equal, 3528 chars).
- Then the ORIGINAL passed too, once the route had been warmed by other runs.
- Failing runs took 17–18s, passing ones 23–33s: the failures gave up EARLY,
  they did not do more work.

**What triggers it:** editing anything under `apps/web/` forces
recompilation. A big comment sweep or a type rename counts. Running a suite
shortly after touching web source is how you buy this failure. Related:
[[feedback_never_mutate_source_while_dev_server_runs]] and
[[feedback_never_build_while_dev_server_runs]].

**How to tell it apart from a real failure, cheaply:**
1. Re-run the ONE spec in isolation. Passing alone ⇒ not deterministic.
2. Copy the file to a new name and run the copy. If the copy passes and the
   original does not, you are looking at warm-vs-cold, not content.
3. Compare durations. A fast failure next to a slow pass means an early
   give-up, not extra work.

**Do not "fix" the app for this.** The fix is in the spec: wait for a real
anchor (`expect(locator).toBeVisible({ timeout: 30_000 })`) rather than a
fixed sleep. `guides-worker.spec.ts` already carries that lesson in a comment
— "A fixed sleep here was a guess that got shorter as the machine got busier."

See also [[feedback_never_ship_a_red_spec]] — this does NOT license calling a
red spec flaky. It licenses one specific, cheap experiment before believing a
failure, and recording which answer you got.
