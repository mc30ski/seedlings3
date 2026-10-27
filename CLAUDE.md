# Seedlings3 — project rules for Claude Code sessions

This file is loaded into every Claude Code session for this repo. The
rules below are LOAD-BEARING — they encode hard-won lessons from
production incidents. Don't relax them without surfacing the policy
change to the user.

## Date handling — the hardest rule

**Every date manipulation in the codebase MUST route through a canonical
helper.** No exceptions outside the ones documented in
`docs/DATE_HANDLING.md`.

- **API canonical helpers**: [`apps/api/src/lib/dates.ts`](apps/api/src/lib/dates.ts)
- **Web canonical helpers**: [`apps/web/src/lib/dates.ts`](apps/web/src/lib/dates.ts) (search for `bizDateKey` onward)
- **Full policy + decision tables + forbidden patterns**: [`docs/DATE_HANDLING.md`](docs/DATE_HANDLING.md)

### Mechanical enforcement (you cannot bypass this)

The build gate at [`apps/api/src/services/date-handling-build-gate.test.ts`](apps/api/src/services/date-handling-build-gate.test.ts)
scans every `.ts`/`.tsx` file under `apps/api/src`, `apps/api/prisma`,
`apps/web/src`, and `apps/web/pages` against the `FORBIDDEN_PATTERNS` array
(28 entries as of 2026-10-18 — count it, don't trust this number). It runs
on every API build (wired via `test:build-gate` + `turbo.json`
`build.dependsOn test`). A failing scan blocks the merge.

The unit-test suite at [`apps/api/src/lib/dates.test.ts`](apps/api/src/lib/dates.test.ts) and
[`apps/api/src/lib/web-date-helpers.test.ts`](apps/api/src/lib/web-date-helpers.test.ts) locks in DST,
leap-year, month-overflow, and invalid-input behavior for every
exported helper.

### When you write date code in this repo

1. **Search the helper files first** — there is almost certainly an
   existing helper for what you need. Check the decision table in
   `docs/DATE_HANDLING.md`.
2. **If no helper fits**, ADD a new one to the canonical file (with a
   clear name + doc comment + unit test), then use it from the
   callsite.
3. **If you find a forbidden pattern that the gate doesn't catch**,
   add a new entry to `FORBIDDEN_PATTERNS` in
   `date-handling-build-gate.test.ts` so it can never be reintroduced.
4. **Never** disable the build gate test or remove a regex without
   surfacing it to the user. The patterns encode real bugs we've shipped.

### When you run the build gate

After any edit in `apps/api/` OR any edit anywhere that touches dates,
run:

```bash
cd apps/api && npm run test:build-gate
```

This runs the whole gate roster — the date-handling scan, helper unit tests,
payment invariants, export integrity and the rest — in a few seconds
(2065 tests / ~3.3 s on 2026-10-18). If anything fails, fix it before
reporting the task as done.

## Feature specs

The `docs/features/` directory holds canonical per-feature specs. Each
one describes how the feature is supposed to work in plain English:
state machine, edge cases, user-visible copy, testing paths. Bind these
docs to the corresponding Playwright e2e suite at
`apps/web/tests/e2e/specs/<feature>-*.spec.ts` — if code and doc
disagree, one of them is wrong; fix both in the same PR.

- **Compliance** → [`docs/features/compliance.md`](docs/features/compliance.md)
  (policy documents, versions, signatures, exceptions, banner, wizard).
  Enforced by [`apps/api/src/services/policies-build-gate.test.ts`](apps/api/src/services/policies-build-gate.test.ts)
  + Playwright specs under [`apps/web/tests/e2e/specs/compliance-banner-*.spec.ts`](apps/web/tests/e2e/specs/).
  Run with `cd apps/web && npx playwright test --project=employee compliance-banner`.
- **Client View-As** → [`docs/features/client-view-as.md`](docs/features/client-view-as.md)
  (read-only impersonation of a specific ClientContact, gated on
  `clients.view-as`, for
  support/debugging). Enforced at the plugin layer in
  [`apps/api/src/plugins/clientImpersonation.ts`](apps/api/src/plugins/clientImpersonation.ts)
  + Playwright specs at `apps/web/tests/e2e/specs/client-view-as-*.spec.ts`.

## Other load-bearing rules

- **Prisma migrations are required** for schema changes — never use
  `db push`. See [`memory/feedback_prisma_migrations.md`](file:///Users/michaelwanderski/.claude/projects/-Users-michaelwanderski-dev-seedlings3/memory/feedback_prisma_migrations.md).
- **Confirm dialogs are mandatory for mutations** — every Approve /
  Reject / Adjust / Write off / Delete / Revert button needs a
  `ConfirmDialog`. Mobile-first; accidental taps cause real problems.
- **Never use native `<select>`** — always Chakra `Select.Root` +
  `createListCollection`. See the existing patterns in the codebase.
- **Payments build gate invariants must not be relaxed** — see
  `apps/api/src/services/payments-build-gate.test.ts` and the
  documentation in `docs/FINANCIAL_SYSTEM.md`.
- **There are no roles — only capabilities.** The `Role` enum
  (WORKER/ADMIN/SUPER/STAFF) and the `UserRole` table are **deleted**. A role
  is a `CustomRole` row: a name, an entitlement set, and a parent to inherit
  from. Authorization is:
  - **Routes** — `requires(entitlement)` from
    [`apps/api/src/lib/routeGuards.ts`](apps/api/src/lib/routeGuards.ts).
    There is no flag and no legacy branch. `approvedUser` is for the ~100
    OWNERSHIP routes, which need an approved caller and then scope their own
    query; it is NOT an entitlement, because one every person holds is not a
    check. **No guard may be named for a role** (G24b), and `approvedUser` on
    a route the map does not call ownership is a privilege escalation (G24c).
  - **Inside a handler** — `callerCan(req, entitlement)`, which reads
    `req.principal` and therefore honours the active perspective. For
    somebody ELSE use `userCan(db, id, …)` / `capabilitiesForUsers(db, ids)`.
    Never resolve the CALLER with a fresh read: it bypasses their lens, and
    that bug has shipped three times here.
  - **The web** — `scope.can(capability)`, and nothing else. `Scope` has
    ONE field. There is **one tab per feature**: which tabs exist comes from
    `TAB_REQUIREMENTS` in
    [`apps/web/src/lib/tabRequirements.ts`](apps/web/src/lib/tabRequirements.ts),
    and what is on each comes from entitlements, read from the
    perspective-narrowed set the server returns.
  - **Never name a flag after a role.** A boolean standing in for a role is
    the deleted model rebuilt — ~500 of them decided whether a control should
    EXIST, which is a different question from which layout to draw, and a
    custom role that matched none of them (a bookkeeper) got whichever bucket
    it fell nearest. Naming one after a capability it does not hold is the
    same bug, quieter. Name it for the capability it asks for, and take that
    capability from
    [`docs/features/permissions-ROUTE-MAP.md`](docs/features/permissions-ROUTE-MAP.md)
    — the one the control's own endpoint is guarded on.
  - **Initial setup** is `apps/api/scripts/install-starter-roles.ts`, keyed on
    an immutable `key` so re-running preserves ids and every grant. Re-run it
    against the database to recover — there is no in-app break-glass, and no
    env var that grants anything.
  - **Perspectives** are a named SUBSET of what someone holds, offered only
    if they hold the role or one inheriting it — so no value of the
    `X-Perspective` header can grant anything. Route map:
    [`docs/features/permissions-ROUTE-MAP.md`](docs/features/permissions-ROUTE-MAP.md),
    and G5 fails the build if a guard and the map disagree.
- **A customer is kept out of the staff app by the PAYROLL GATE, not by a
  client flag.** There is no "client" kind of capability and no client branch
  in authorization. A client contact's login is an ordinary `User` row with no
  `workerType`, and `can()` returns false for a null `workerType` **before** it
  walks their roles (`packages/permissions/permissions.ts`; G31 asserts that
  ordering). Their portal is gated on `isClientContact` — an ACTIVE
  `ClientContact` for their Clerk id — which never consults roles.
  - **A customer may also work for you.** Give them a `workerType` and grant
    them roles; they then pass the gate like anyone else. The rule is NOT
    "customers hold no roles", and don't write one.
  - **The ORDER is what is protected.** A grant landing on a customer who has
    no worker type yet resolves to nothing today, so it looks harmless. It is
    **dormant, not void**: set a worker type on that account later and every
    grant on it activates at once, silently, with no approval step in between.
    Set the worker type FIRST, then grant.
  - **The database refuses the dormant state** — migration
    `20261020140000_client_grants_require_a_worker_type` installs the schema's
    only triggers, guarding all three ways in (granting to an unclassified
    customer, clearing a worker type off a grantee, attaching a customer
    contact to an unclassified grantee). G45 fails the build if the migration
    or its triggers go missing. Never catch the `check_violation` and grant
    anyway — fix the order.
- **Worker class is decided in ONE place, and never by negation** (G30).
  Every pay-class question goes through
  [`packages/money/workerClass.ts`](packages/money/workerClass.ts):
  `classify`, `isW2`, `isFeeable`, `isPaid`, `rateFor` (throws for
  non-paid — a payout must refuse rather than guess) and
  `rateForProjection` (returns 0 — a dashboard must still render).
  **`!isW2(x)` is forbidden**: it reads as "therefore a contractor" but
  is also false for UNPAID and for an untyped worker, so both land in
  the fee branch. That one shape charged unclassified workers a
  contractor fee on every split, put them in QuickBooks Contract Labor,
  and swept them into the employer payroll-tax base. A callsite that
  must reproduce the OLD pricing rule (the legacy re-derivation path in
  `payments.ts`) marks itself `// worker-class-allow: <reason>`.
- **`prisma/` is typechecked** — it is in `apps/api/tsconfig.json`
  `include` because it was not, and `seed.ts` went on importing a
  deleted constant. The seed CLEARS the database before it reaches the
  line that crashes, so running it wiped jobs, occurrences and payments.
  Don't remove it from `include`.
- **Two assignee invariants, one chokepoint.** Any function writing
  `JobOccurrenceAssignee` must end by awaiting `enforceAssigneeInvariants`
  ([`apps/api/src/lib/claimerInvariant.ts`](apps/api/src/lib/claimerInvariant.ts))
  or carry a `// claimer-invariant-allow: <reason>` comment above the
  write. Enforced by
  [`apps/api/src/services/claimer-invariant-build-gate.test.ts`](apps/api/src/services/claimer-invariant-build-gate.test.ts).
  1. **An occurrence is UNCLAIMED or has exactly one claimer** — never
     "has workers, has no claimer". That third state makes the visit
     unstartable for everyone below admin, with no button and no
     explanation on the card. Existing bad rows are repaired with
     `npm run repair:claimers` (dry run; `-- --apply` writes). Four
     separate write paths produced this state in production — don't add
     a fifth.
  2. **Only a paid person takes a paid seat** (G33). A non-observer
     assignee is someone the money system will try to pay, so they must
     satisfy `isPaid()` — EMPLOYEE or CONTRACTOR. An UNPAID helper or
     anyone with no worker type can only be an *observer*. This is not
     cosmetic: `rateFor` refuses to price a worker with no pay class, so
     an unpaid person in a paid seat makes `computeBreakdown` throw and
     the visit impossible to complete for everyone on it. The demotion
     runs BEFORE the claimer repair, because demoting someone can remove
     the claimer.
- **View-as endpoints must be view-as-aware or explicitly annotated** —
  every `GET /me/*` route in `apps/api/src/routes/` either accepts
  `?viewAsUserId=<id>`, gated on a CAPABILITY (`people.manage`, or the
  narrower `time.manage` / `payroll.view` the shared helpers apply), OR
  carries a `// view-as-allow: <reason>` comment above the route. Enforced by
  [`apps/api/src/services/view-as-endpoints-build-gate.test.ts`](apps/api/src/services/view-as-endpoints-build-gate.test.ts).
  Policy + shipped-bug history at
  [`docs/VIEW_AS_ENDPOINTS.md`](docs/VIEW_AS_ENDPOINTS.md). This class of
  bug has shipped three times — don't ship a fourth.

## Working style for this repo

- Run the build gate after edits, not at the end of the session.
- When the user says "this is broken", investigate the root cause
  rather than patching the surface symptom — there have been multiple
  cases where a "fix" introduced new bugs because the underlying
  pattern wasn't understood.
- Prefer editing existing files to creating new ones.
- Documentation files (.md) only on explicit request, EXCEPT
  `docs/DATE_HANDLING.md` and similar canonical references which are
  meant to be updated as policy evolves.
