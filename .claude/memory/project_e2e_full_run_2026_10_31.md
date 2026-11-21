---
name: project_e2e_full_run_2026_10_31
description: "Full Playwright run 2026-10-31: 321 passed / 24 failed in 1.9h. FIVE root causes, none from the money-basis work (proven by stashing). FOUR fixed the same day — and two of those turned out to be TEST DRIFT reported as product bugs. One left unexplained."
metadata:
  node_type: memory
  type: project
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-21T00:00:00.000Z
---

First full-suite run since the Area → Portfolio rename. Supersedes the
"GREEN as of 2026-10-22" claim in [[project_e2e_preexisting_failures]].

**321 passed · 24 failed · 16 skipped · 1.9 hours**, 361 tests over 8
projects.

## 24 failures, 5 root causes — none from the new work

Attribution was **proven, not argued**: every change was stashed and a
representative of each cause re-run against HEAD. All reproduced.

| Cause | Specs | Status |
|---|---|---|
| Theme chip sits behind an unopened header drawer | 18 | **FIXED** |
| `/operations`: UI gated `reports.view`, route guards `reports.business` | 2 | **FIXED** |
| Display photo 404 | 2 | **SOLVED 2026-11-21 — empty dev R2 bucket; see below** |
| Unpaid persona gets a shell | 1 | **FIXED — was test drift, not a bug** |
| Role → perspective does not persist | 1 | **FIXED — was test drift, not a bug** |

## Fix 1 — the drawer (18 of 24)

`ThemeChip` renders only inside `headerDrawerOpen`, a persisted preference
that **defaults false**. Three spec files went looking for `theme-chip` and
timed out. Deliberate product design — as a strip item the chip cost 20px
that every other control gave up on every screen — so the **specs** were
wrong, not the app.

`openHeaderDrawer(page)` in `tests/e2e/helpers/nav.ts`, idempotent, called
by `theme-chip-sync`, `mobile-theme-chip` and
`theme-header-dropdowns-owner`. All 18 now pass.

## Fix 2 — the `/operations` gate

`pages/index.tsx` gated the unclaimed-count badge on `reports.view`; the
route is `requires("reports.business")`, and the route map agrees. The
badge loads on EVERY page, so anyone holding the first and not the second
403'd everywhere — measured: the scheduler on eight tabs, the bookkeeper on
two.

**Wrong twice over**: originally a schedule flag, "fixed" to `reports.view`
— right shape, wrong capability. The rule it keeps breaking is
[[feedback_ui_gate_must_match_its_endpoint]]: take the capability from the
route map, not from a neighbour that reads plausibly.

## A trap worth remembering

`persona-sweep` reported `districtLead: "portfolios: Invalid or unexpected
token"` — a JS parse error that looked like a real regression. It was
**not**: source files were being edited while that run was in flight, so
`next dev` served half-built chunks. Re-ran on stable source: 2/2 green.

This is [[feedback_never_mutate_source_while_dev_server_runs]] arriving
from the other direction — not a restored file serving a stale chunk, but
a *live edit* poisoning a run in progress. **Do not edit source while a
suite is running**, and re-run before believing any parse error from one.

For the same reason `tests/e2e/inventory/persona-sweep.json` was REVERTED
rather than committed: its ~950 lines of churn were measured during that
corruption and are not trustworthy.


## TWO OF THESE WERE NOT BUGS, AND I CALLED THEM BUGS

Both were diagnosed from test output without driving the product, reported
to the operator as production defects, and turned out to be specs that had
drifted from deliberate decisions. Worth recording because the mistake is
repeatable: **a red spec is evidence about the spec OR the product, and
which one costs five minutes to establish.**

**"Role → perspective does not persist."** It persists. The spec ticked the
checkbox and read the database, which only works if the editor autosaves.
It does not, on purpose: saving goes through a confirm dialog naming the
role and listing what moves, added after a silent save rewrote the WRONG
role's entire grant — the baseline role picked up sixteen capabilities
including the company P&L. The test was asserting the absence of a safety
feature. Fixed by clicking Save and confirming.

**"Unpaid persona gets a shell."** It should. `unpaid` deliberately holds
Trainee — an UNPAID helper may look but is never paid, and with no role it
could not be put on a visit to exercise that. The grant-less persona is
`newhire`, and the seed's roster comment says so explicitly. Repointed the
test; then it STILL failed, because the page copy had changed from
"nothing has been shared" to "no access has been assigned yet" and the
regex had not. Both fixed, plus a positive assertion that `unpaid` DOES
get a shell so the two personas cannot collapse back into one.

`persona-mutations` is now 14/14.

## ~~Still unexplained~~: display-stale-links — SOLVED 2026-11-21, and the
## answer was the one this section told you to stop considering

`/api/public/display/photo/:photoId` returned 404 for a photo the board
just listed. **The cause was the empty dev R2 bucket** —
`seedlings-photos-dev` held zero objects against 22 `JobOccurrencePhoto`
rows. Fixed by running `apps/api/scripts/seed-photo-objects.ts <dir>`; all
five specs pass.

**READ THIS BEFORE DISMISSING A DIAGNOSIS.** What this section said was:
"An early guess that dev was missing R2 objects was wrong — the board
returns relative `/api/public/display/photo/<id>` paths, not signed R2
URLs." Both halves of that sentence are true and the conclusion does not
follow. The board serving a relative path says nothing about where the
ROUTE behind it gets its bytes — it reads R2, so a missing object 404s
exactly as if the URL had been signed. A true premise was used to retire a
correct hypothesis, the note then instructed later sessions not to revisit
it, and [[project_e2e_full_run_2026_11_13]] duly spent its effort on a
credentials theory instead.

The correct answer was already written down in
[[project_e2e_preexisting_failures]] section B, nine days before this note
overruled it. The cost of "do not repeat X without checking" is that nobody
checks X.
