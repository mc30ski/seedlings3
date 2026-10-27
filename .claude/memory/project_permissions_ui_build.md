---
name: project-permissions-ui-build
description: "Permissions UI phase — built 2026-10-16 in one pass. Tabs/actions/help all capability-driven; roles + areas builders shipped; 3 items left, one blocked on Clerk accounts."
metadata:
  node_type: memory
  type: project
---

**The UI half of the capabilities migration was built on 2026-10-16, all at
once, at the user's explicit instruction ("this is an all or nothing effort
that I need to test when complete comprehensively — I don't want to
piece-wise deploy").** Plan and per-item status:
[`docs/features/permissions-UI-BUILD.md`](../../../dev/seedlings3/docs/features/permissions-UI-BUILD.md)
— 32 items done, 3 open.

**Verify counts against the repo; they rot.** At the end of the session:
build gate 60 files / 2059 tests, both typechecks clean.

## What shipped

- **Perspectives work at all.** The web was still sending `X-Impersonate-As`
  with deleted role literals while the API reads `x-perspective` with a
  `CustomRole.id` — no lens had worked since the enum came out. Picker,
  banner and the confirm-dialog warning read `me.perspectives` /
  `me.activePerspectiveRoleId`: the SERVER says which lens ran, never
  localStorage. A display-only name cache exists for `ImpersonationWarning`,
  which renders in dialogs that have no access to `me`.
- **`TAB_REQUIREMENTS`** (`apps/web/src/lib/tabRequirements.ts`) — 35 rows,
  any-of. Each row was derived from the routes that tab's component actually
  calls, resolved against the route map. `ALWAYS` is a word, not `[]`,
  because `[]` reads as both "needs nothing" and "nobody".
- **The no-access page renders.** `NoRoleNotice` existed and had NEVER fired:
  gated on `topTab !== "client"`, and the redirect sends a surface-less
  person to the client shell. Needed a new **`isClientContact`** on
  `/api/me` — a customer and an ungranted staff account both arrive with an
  empty capability set.
- **Refusals name the capability.** `requires()` throws
  `ServiceError("NOT_AUTHORIZED", …, 403, { entitlement })`; the web builds
  the sentence from **`refusalPhrase()`** in `@repo/permissions`, the same
  phrasebook the help text uses. A 403 also logs a dev console error — a
  reachable 403 means the UI and the route disagree.
- **Role granting works.** It posted `{role:"ADMIN"}` at an endpoint reading
  `customRoleId` — dead, not merely outdated. Now a picker off `GET /roles`.
- **`RolesTab`** (role builder + generated entitlement matrix) and
  **`AreasTab`** (tree, assignments, no reparent — G14). Both are ordinary
  rows in `TAB_REQUIREMENTS`; there is no special placement rule.
- **Per-person effective permissions with provenance**, on the Users row.
- **Help copy names no role.** `RoleSection` (prop: a role NAME) →
  `CapabilitySection`, which gates on the capability and labels itself from
  it. 31 sites in 21 files.

## Gates added
`G44` tab-requirements (+ self-testing negative controls), `G15`
ui-capability (shrink-only `PENDING`, 71 files), `G36` folded into the tab
gate. Both registered in the `test:build-gate` filter list — see
[[reference-build-gates-roster]] for the silent-shrink hazard.

## The personas are seeded (2026-10-17)

**The Clerk accounts were never the blocker** — they were created 2026-10-12
and `auth.setup.ts` has authenticated all ten since 2026-10-13. Saying they
blocked anything on 2026-10-16 was a stale index line repeated without
opening the detail file.

What was actually missing: coordinator / bookkeeper / payroll were
**PENDING, no worker type, no role**, so signing in as one landed on
"awaiting approval" — not even the no-access page. `seed.ts` now approves
and types them and grants three EXAMPLE CUSTOM ROLES (Coordinator,
Bookkeeper, Payroll) — deliberately not starter roles, because the starter
set is what the product ships with and "coordinator" is one company's idea
of a job. Each exists because the ladder cannot express it: Coordinator runs
the schedule with no field clearance (Admin inherits Worker, so it cannot),
and Bookkeeper / Payroll are the two halves of a split Super keeps together.

`admin+unpaid` stays at zero capabilities on purpose — it is the no-access
page's only live subject.

**Watch for near-duplicate roles.** Dev already had a keyless "May charge
business expenses" with a live grant; a starter role called "Can charge
business expenses" would have made two rows meaning one thing with the grant
on the wrong one. `installStarterRoles` adopts an existing row BY NAME, so
the starter entry must match the name already in use.

## Eight bugs the read-only persona sweep found (2026-10-17)

**Seven were one shape:** a surface flag — or no gate at all — standing in
for the capability a route requires. The server was correct in every case;
the UI was the half that disagreed.

| # | Where | Was gated on | Route needs |
|---|---|---|---|
| 1 | shell derivation (bookkeeper/payroll stranded) | 3 surface caps | any tab inside |
| 2 | weather strip + announcements badge | `hasAnyRole` | `schedule.view` |
| 3 | unclaimed header badge | a role flag | `reports.view` |
| 4 | timeline header badge | a role flag | `timeline.view` |
| 5 | Jobs tab pause-reasons | nothing | `schedule.manage` |
| 6 | Ledger tab equipment picker | nothing | `equipment.view` |
| 7 | Home "All Workers" aggregate | picker default | `reports.view` |
| 8 | "Upload payroll" on Reconcile | nothing | `payroll.manage` |

**#3, #4 and #7 all stem from one role flag standing for `schedule.manage`.** A
coordinator runs the schedule and does not read the rollup, the timeline or
the team aggregate — every badge that assumed otherwise refused on every
page load. Whenever a surface flag guards a fetch, name the route's own
capability instead.

**#8 came from READING THE INVENTORY, not from the walk.** Nothing automated
catches a control that is merely VISIBLE and should not be: a wrongly-shown
button and a legitimately-hidden one are indistinguishable until pressed.
That is the whole argument for the control inventory, and for a human pass.

**A ninth was my own TAB_REQUIREMENTS.** `workdays` listed `time.approve` as
an any-of alternative on the reasoning that "an approver needs the screen".
They do not — the tab reads `/workdays/by-date` (`time.view`) and approving
lives in the Tasks overlay on `time.approve` routes. **An any-of row is only
honest when each entitlement in it can actually drive the page.**

## The first two, in detail

Both were invisible to the API suite, because the server was behaving
correctly in each — the UI was the half that disagreed.

1. **STRANDED PERSONAS.** The tab table made tabs capability-driven, but the
   three SHELLS were still derived from `schedule.view` / `schedule.manage` /
   `settings.manage` alone. A bookkeeper or payroll clerk lights none of
   those, so they had tabs the table granted and no door to reach them: the
   redirect effect bounced them to the client shell, which has nothing for
   them either, and the no-access page did not fire because they DO hold
   capabilities. Fixed by making a shell visible when it holds any tab the
   person can open (`anyTabVisible`), and by landing them on it. This is
   the homeless-role problem the plan predicted and the first pass missed.
2. **THE APP SHELL 403'd ON EVERY PAGE LOAD** for anyone not field-shaped.
   The announcements badge and the weather strip were gated on `hasAnyRole`
   — "holds anything" — while `/api/occurrences` and `/api/weather/location`
   need `schedule.view`. Two refusals per load for a bookkeeper. Both now
   ask for the capability the route asks for.

**The detector that found #2 is the dev-only `[permissions]` console error**
added with the §1 work. It fires exactly when the UI offered something the
route denies, which makes the whole drift class findable by walking pages
rather than by enumerating buttons. The sweep lives at
`apps/web/tests/e2e/sweep/persona-sweep.spec.ts`, project `persona-sweep`,
and is READ-ONLY by design — the API project already proves authorization
both ways, and clicking mutations would rewrite the seed data later runs
depend on. It also writes a per-persona, per-tab inventory of visible
controls to `tests/e2e/report/persona-sweep.json`, because the one thing it
cannot detect is a control that SHOULD be there and is not.

## Mutation round (2026-10-17)

`apps/web/tests/e2e/mutations/persona-mutations.spec.ts`, project
`persona-mutations`, driven one persona per run by
`apps/web/scripts/mutation-round.sh`, which reseeds dev between each so no
persona inherits another's writes. **9 personas, 11 tests, all green.**

Proved end-to-end for the first time: the **role builder** and the **area
builder** write correctly (asserted against the DB, not a toast), the
books/payroll split holds both ways, someone with `schedule.manage` cannot grant roles, and
`work.claim` decides the claim control — employee has it, trainee and
coordinator do not, on the same tab of the same shell.

**A tenth bug, which I caused.** `isFieldCleared` read
`privileges.canPullInventory` — `inventory.pull` — while the claim route
needs `work.claim`. Harmless while the starter Field Clearance role granted
all three together; the grantable "May pull inventory" role separates them
deliberately, so an office person who fetches supplies would have been
shown a claim button the route refuses. Fixed in BOTH halves: the web's
`isFieldCleared` and `people.ts`'s `fieldCleared` for view-as, which agreed
with each other and were wrong the same way.

**Shell labels are now My Work / Operations / Business.** The VALUES stay
`worker`/`admin`/`super` — they key persisted state, and renaming them
would strand every stored tab.

## Still open
1. **Empty-room gate** — G44 proves the table, not that something inside each
   tab is reachable with each entitlement that opens it.
2. **`/users` redaction** — pre-emptive only; every current consumer is an
   admin surface that holds `people.manage`.
3. **G15's 71-file backlog.** Not a hole — the server checks every request and
   fails closed — but a drift surface: move one of those components and its
   gate does not travel with it.
4. **`install-starter-roles.ts` is still UNTRACKED in git** and `seed.ts`
   imports it, so a fresh clone cannot seed. Needs `git add`.

Related: [[project-permissions-build-state]], [[reference-capabilities-model]],
[[project-ui-plan-from-backend-changes]], [[reference-tab-blend-pattern]].
