---
name: project_e2e_preexisting_failures
description: "RESOLVED — full e2e run green 2026-10-22. Historical triage of the 10 deterministic failures kept below; one environmental flake remains in money-flow-variations."
metadata:
  node_type: memory
  type: project
  modified: 2026-10-22T00:00:00.000Z
---

## STATUS 2026-10-22 — ALL OF THIS IS RESOLVED. Full run is GREEN.

Keep the triage below as history; do not chase it as open work. A full run
on 2026-10-22 (read-only projects + all 9 mutation personas, reseeded
between each):

```
api 67 · persona-sweep 18 · employee 79 · employee-mobile 6
scheduler 13 · owner 127 passed / 15 skipped / 0 failed
mutation rounds: 9/9 personas clean
```

Cause A (client view-as), display-pairing, parcel-owner and the
persona-sweep failure all pass now.

**The ONE remaining red is environmental, not deterministic.**
`money-flow-variations-owner` dies on `page.waitForLoadState("networkidle")`
at its FIRST `page.goto("/")`, before asserting anything — and on a
different scenario each run (06 in the morning, 11 in the afternoon). It
passes 17/17 standalone after a reseed. Treat a single failure in that file
as a flake; treat two consecutive failures on the SAME scenario as real.

**`/Read-only preview: viewing as/i` has now broken twice, for different
reasons.** Cause A below was the first. The second was 2026-10-22: folding
that banner into a shared `ViewBar` dropped the words "Read-only preview"
and split the contact and client names onto separate lines, so the locator
found nothing and then found the wrong text. Three specs depend on that one
string being a single sentence containing BOTH names. It is load-bearing
copy — change it and you are changing a contract.

**Triaged 2026-10-13 against a freshly seeded dev DB, each confirmed failing
on BOTH of two warm repeats** (`--repeat-each=2`), so none of these is the
cold-compile artefact described in [[feedback_e2e_cold_compile_race]].

Clean full run: **285 passed / 15 failed / 16 skipped**. Of the 15, ten are
deterministic (below), one is flaky, and four were races or order-dependence.

**None of the four causes is from the capabilities/permissions work.** In
three of the four I drove the backend directly and it answered correctly — the
failures are in the UI or the environment.

## A — Client view-as (3 specs). UI does not start the session. HIGH
`client-view-as-owner-flow:49`, `client-view-as-owner-only-completed:36`,
`client-view-as-header-no-earnings-pill-admin:35`.

All three fail on the SAME locator: `/Read-only preview: viewing as/i` never
appears. One bug, three symptoms.

**The backend is fine — verified twice.** `GET /api/me` with
`X-Impersonate-Client-Contact` returns **200 with `isClientImpersonating:
true`** for BOTH a Clerk-backed contact (Sofia Martinez) and a synthetic
scratch contact with no `User` row (the shape the test helper creates). So
`plugins/clientImpersonation.ts` and `users.me()` both behave.

Therefore the UI never sends the header: the "View as" control on the client
card is not starting the session. Start at `gotoSuperClients` → the client
card's view-as button.

Gotcha when reproducing: only **1 of 18** seeded ClientContacts has a
`clerkUserId`. Picking an arbitrary contact gets a correct
`400 IMPERSONATION_TARGET_INVALID`, which looks like a bug and is not — I
fooled myself with exactly that before using a linked contact.

## B — Display photos 500. ENVIRONMENT, not code. MEDIUM
`display-stale-links-admin:28` and `:59`, both `expected 200, received 500`.

The **`photos` R2 bucket holds 0 objects** while `property-photos` holds 55.
The seed creates 22 job-photo DB ROWS with no corresponding R2 objects, so
fetching one 500s. This is the last unresolved item from the R2 audit — every
other bucket now has content. Fix the bucket, not the handler.

## C — Guidance pulse on a finished visit. LOGIC. LOW-MEDIUM
`job-guidance-pulse-admin:84` — "more guidance pulses on screen than there are
unfinished visits with a note (1 > 0) — a finished visit is still pulsing".
A real condition bug in the pulse predicate.

(`job-guidance-pulse-admin:148` is NOT in this list: it passed one repeat and
failed the other. Genuinely flaky/order-dependent.)

## D — Route planner button fires nothing. UI. HIGH
`route-planner-admin:55`, `:104`, `:128`, `:150` — all four
`page.waitForResponse` timeouts at 60s. One bug, four symptoms.

Driven directly: the Routes tab RENDERS, the `Plan route` button EXISTS
(count 1), the click succeeds — and **zero `/route-suggestions` responses
arrive in 12s**. The endpoint itself is healthy:
`GET /api/preview/route-suggestions?date=…` returns 200 with a real plan.
So the click handler does not issue its request.

## How to re-triage quickly
`npx playwright test --project=owner --no-deps --repeat-each=2 <files>` and
read `test-results/*/error-context.md`. Two repeats is what separates a real
failure from a warm/cold artefact.

See also [[feedback_never_ship_a_red_spec]], [[reference_api_e2e_suite]].
