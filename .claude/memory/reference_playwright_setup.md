---
name: reference-playwright-setup
description: How Playwright + Clerk auth are wired for e2e tests in apps/web/tests/e2e/
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:37.092Z
---

E2E tests live at [`apps/web/tests/e2e/`](file:///Users/michaelwanderski/dev/seedlings3/apps/web/tests/e2e/). Playwright config at [`apps/web/playwright.config.ts`](file:///Users/michaelwanderski/dev/seedlings3/apps/web/playwright.config.ts).

**Auth strategy**: Clerk sign-in tokens (tickets) via `@clerk/testing`. The `auth-setup` Playwright project mints a fresh ticket per seed user via `clerkClient.signInTokens.createSignInToken({ userId })`, redeems it in a Playwright browser with `clerk.signIn({ page, signInParams: { strategy: 'ticket', ticket } })`, and saves the resulting storage state to `playwright/.auth/<user>.json`. All subsequent projects load that storage state so tests start pre-authenticated. No passwords stored anywhere.

Depends on `pk_test_` Clerk instance (dev mode) — production keys would need a different approach.

**Seed users** (Clerk IDs in [`tests/e2e/auth/auth.setup.ts`](file:///Users/michaelwanderski/dev/seedlings3/apps/web/tests/e2e/auth/auth.setup.ts)):
**NINE**, not five, and none of them is a role — the `Role` enum is deleted,
so each is a person holding a `CustomRole`. The key list is `SeedUserKey` in
`apps/web/tests/e2e/helpers/db.ts`; database ids resolve at run time from
`playwright/.auth/user-ids.json` and are never hardcoded.

- `employee` · `contractor` · `trainee` — field personas, differing by
  `workerType` and by which starter role they hold
- `scheduler` — runs the schedule
- `owner` — Michael; holds everything
- `coordinator` — office staff, paid, no field work
- `bookkeeper` — books without payroll, 1099
- `payroll` — payroll without books (the other half of that split)
- `unpaid` — entitlements but NO payroll: the case that proves an unpaid
  person never reaches a split, a wage or an export

The last four were added 2026-10-12 and exist to be CLICKED THROUGH as, which
is the only way to verify a non-field persona.

**Helpers** at `tests/e2e/helpers/`:
- `db.ts` — direct Prisma access with a `jolly-wildflower` safety guard (dev DB only). Helpers to reset compliance state, create scratch `E2E_`-prefixed policies, grant exceptions, insert direct signatures. `cleanupScratchPolicies` handles the FK cascade properly (null currentVersion → drop sigs → drop versions → drop docs).
- `nav.ts` — `gotoWorkerHome(page)` stamps `seedlings_topTab`/`seedlings_workerTab` in localStorage before goto, because the app defaults `topTab` to `"client"` and the "auto-jump to Home" only fires on a fresh ET day.

**Run** with `cd apps/web && npx playwright test --project=employee`.

**Artifacts** (all gitignored):
- `playwright/.auth/*.json` — session cookies, 5 files
- `test-results/` — per-failed-test screenshots, videos, traces, error contexts (auto-cleared per run)
- `tests/e2e/report/` — HTML reporter output
- `tests/e2e/screenshots/` — intentional screenshots taken by tests

**Data-testid convention**: components under test expose `data-testid="<component-name>"` plus behavior-relevant `data-*` attributes so tests can select without brittle CSS selectors. Example: `ComplianceBanner` exposes `data-severity`, `data-blocking-count`, `data-recommended-count`.

Related: [[reference-feature-specs]], [[feedback-run-tests-trigger]].
