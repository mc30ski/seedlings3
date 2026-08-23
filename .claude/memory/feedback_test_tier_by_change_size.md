---
name: feedback-test-tier-by-change-size
description: Match verification depth to the change — tsc for UI-only, build gate for API/money, full Playwright only for schema/auth/cross-cutting and pre-push.
metadata:
  type: feedback
---

**Don't run the full Playwright suite after every change.** It's ~10
minutes, and for a styling or copy edit it usually tests nothing about
what actually changed.

**Why:** on 2026-08-23 I ran the whole 68-spec suite after a CSS
spacing fix and a chevron icon in `PromotionsTab.tsx`. **Zero of the 22
spec files touch promotions at all** — the run could not have caught a
regression in that file even in principle. Ten minutes, no signal, and
the user (rightly) called it out.

**How to apply — pick the tier:**

| Change | Run | Cost |
|---|---|---|
| UI-only: styling, layout, copy, icons | `npx tsc --noEmit` | ~40s |
| Component logic that HAS e2e coverage | `tsc` + those spec files by name | ~1–2 min |
| API / service / money / audit | `tsc` + `npm run test:build-gate` | seconds |
| Schema, migration, auth, Clerk, cross-cutting refactor | full `npx playwright test` | ~10 min |
| Immediately before the user pushes | full suite, once | ~10 min |

**Check coverage before assuming a suite is relevant:**
```bash
cd apps/web/tests/e2e/specs && grep -ln "<feature>" *.spec.ts
```
No hits means e2e cannot speak to that change — say so rather than
running it for reassurance.

**The build gate is the high-value cheap one.** ~439 tests in seconds,
and it guards the genuinely dangerous classes: payment invariants, date
handling, audit coverage, view-as endpoints, promotions/CAN-SPAM. Run
it after ANY `apps/api/` edit (see
[[feedback-run-build-gate-after-changes]]) — that rule stands
unchanged; this one only scopes the *Playwright* suite.

**Targeted Playwright runs DO work.** I previously concluded that
`--project=super` broke Clerk setup and that subsets were unusable.
That was wrong: `auth-setup` runs fine as a dependency — the Clerk
errors in that run were downstream of a dev server I'd killed with a
concurrent `next build` (see
[[feedback-never-build-while-dev-server-runs]]). Don't repeat that
misdiagnosis and fall back to full runs because of it.

See also [[feedback-run-tests-trigger]], [[reference-playwright-setup]],
[[reference-build-gates-roster]].
