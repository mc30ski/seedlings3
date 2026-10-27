---
name: feedback-ui-gate-must-match-its-endpoint
description: "A control gated on the wrong capability fires a guaranteed 403 its catch block hides. The persona sweep is what finds them; fixing one reveals the next."
metadata:
  node_type: memory
  type: feedback
---

A tab gated on one capability that calls an endpoint guarded on another is a
silent 403 on every load for anyone holding the first and not the second.
Both instances found on 2026-10-19 were invisible in the UI because the call
site swallowed the error:

- `VehiclesTab` → `GET /routes/operations` (`routes.plan`) while the tab and
  its Insights strip were gated on `equipment.manage`. A scheduler saw four
  zeroed tiles. Fixed by threading `canPlanRoutes` and dropping only the two
  tiles that endpoint feeds — the other two come from the loaded vehicle
  list and need nothing.
- `UsersTab` → `GET /policies/user-compliance` (`compliance.view`) while the
  tab is gated on `people.view`. This one was DELIBERATE — the comment said
  "tolerate a 403 by falling back to an empty map". Ask for the capability
  instead; the screen is identical and the refusal is gone.

**How to find them:** `persona-sweep` (`--project=persona-sweep`) walks every
tab as every persona and fails on a refusal, naming the tab, the URL and the
entitlement. Run one persona with `-g "persona: scheduler"` (~3 min) instead
of the whole project (~14 min) while iterating. **It reports one refusal at a
time, so fixing one can reveal the next** — re-run until clean rather than
assuming the first fix was the only one.

**GATED SINCE 2026-10-22 — G46**, in
`apps/api/src/services/ui-capability-build-gate.test.ts` beside G15. G15
covers MUTATIONS and stops there; G46 covers the GETs, which is where every
one of these actually lived. Rule: a tab file that `apiGet`s a guarded route
must name that entitlement somewhere, unless its `TAB_REQUIREMENTS` row
already demands it. `PENDING_READS` is shrink-only and its six entries are
drift surface, not live bugs — the tab's gate implies the endpoint for every
role that exists TODAY, which is a fact about the current roles and not
about the code. Negative control run: reverting the `/holdings` fix makes
G46 fail by name.

**Seven were found in all**, four by the sweep and three by a static audit.
The audit: parse `requires("…")` out of `apps/api/src/routes/*.ts`, map each
tab's GETs to their guard, diff against `TAB_REQUIREMENTS`, then — the step
that matters — ask which REAL role can open the tab but not call the
endpoint, using the flattened role sets from the database. That cut 93
candidates to 24 to 3. Without the last filter it is a lead list, not a bug
list.

The two methods are complementary: the sweep only sees calls that fire for a
persona it walks, the audit only sees what is statically visible but covers
every tab against every role.

Related: [[reference-tab-blend-pattern]], [[reference-capabilities-model]],
[[feedback-names-carry-meaning]].
