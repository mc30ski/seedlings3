---
name: feedback_mutation_test_every_gate
description: "A build gate that passes the moment you write it proves nothing - plant violations and watch them fail, because the usual defect is a gate scoped too narrowly to see its own subject"
metadata:
  node_type: memory
  type: feedback
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-11-09T18:01:23.900Z
---

# A gate that passes on first write has proved nothing

Every new build gate, and every new assertion added to one, gets
**mutation-tested**: plant the violation it claims to catch, confirm the gate
goes red, restore. One mutation per assertion, not one per gate.

**Why:** the failure mode is not "the rule is wrong", it is **"the scan never
reaches the thing"** — and that is indistinguishable from success. Four found
in this repo, all in gates whose first run was green:

- `us-spelling` capped a JSX text node at **400 characters**. A node runs
  tag-to-tag, so an explainer paragraph between two `<Em>` tags is routinely
  longer — the cap excluded precisely the long-form prose worth proofreading.
  Widening it surfaced a real `colour` and a real `licence`.
- The same gate's JSX pattern had earlier excluded **newlines**, so it only
  saw text sharing a line with both its tags. Prose long enough to matter
  wraps.
- `repeating-build-gate` asserted the selection confirm lists its rows with a
  **single** `toMatch`. Deleting the row list from the *pause* dialog still
  passed, because the *resume* dialog satisfied it. Count the matches when a
  rule applies to more than one site.
- `alert-ordering` originally compared each file against the gate's own
  mapping table rather than the other file's real source; deleting a dropdown
  entry left it green.

**How to apply:**

- Prefer **counting** matches over `toMatch` when a rule covers N callsites.
- Suspect every bound you wrote — a length cap, a character class, a search
  window, `.slice(0, n)`. State in a comment why the bound is where it is.
- Assert the scan **found something at all** ("reads the files it guards",
  "the route map parsed to nothing — the format changed"). A gate whose
  inputs moved passes vacuously.
- When an assertion fails on first run, check whether the **assertion** is
  wrong before changing the code. Comment-stripping, CSS `text-transform`
  and polymorphic props have all made a correct implementation look guilty.
- Mutating real source while `npm run dev` is up has its own hazard — see
  [[feedback_never_mutate_source_while_dev_server_runs]], and force a
  recompile afterwards.

Related: [[reference_build_gates_roster]],
[[feedback_run_build_gate_after_changes]], [[feedback_never_ship_a_red_spec]].
