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
- **Web canonical helpers**: [`apps/web/src/lib/lib.ts`](apps/web/src/lib/lib.ts) (search for `bizDateKey` onward)
- **Full policy + decision tables + forbidden patterns**: [`docs/DATE_HANDLING.md`](docs/DATE_HANDLING.md)

### Mechanical enforcement (you cannot bypass this)

The build gate at [`apps/api/src/services/date-handling-build-gate.test.ts`](apps/api/src/services/date-handling-build-gate.test.ts)
scans every `.ts`/`.tsx` file under `apps/api/src`, `apps/web/src`, and
`apps/web/pages` against ~16 forbidden-pattern regexes. It runs on
every API build (wired via `test:build-gate` + `turbo.json`
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

This runs ~150 tests in ~400 ms including the date-handling scan + helper
unit tests + payment invariants + export integrity. If anything fails,
fix it before reporting the task as done.

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
  (Super-only read-only impersonation of a specific ClientContact for
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
