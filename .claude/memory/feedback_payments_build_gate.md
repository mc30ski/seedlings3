---
name: feedback-payments-build-gate
description: Payment-correctness invariants MUST run on every build of @repo/api — file is apps/api/src/services/payments-build-gate.test.ts; relaxing a test requires updating project_payment_math too.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:21:56.042Z
---

Every build of `@repo/api` MUST run the payment-correctness invariant suite. The wiring:

1. `apps/api/package.json` `build` script: `npm run test:build-gate && tsup ... && npm run prisma:generate`. The `test:build-gate` script runs three files: `payments-build-gate.test.ts`, `payments.test.ts`, `exports.test.ts` (74 tests as of 2026-06-04).
2. `turbo.json` `build.dependsOn` now includes `test` (sibling-level), so `turbo build` for any app also runs the api test task first.

**Why:** User stated they are now running payroll with state and federal withholding in production. Payment math correctness is load-bearing — a regression silently mis-pays a contractor's 1099 or under-withholds an employee. The build gate is the last automated line of defense before code ships.

**How to apply:**
- Treat `payments-build-gate.test.ts` as the source-of-truth for payment INVARIANTS (not scenarios). The four describe blocks lock in:
  - A: `computeBreakdown` conservation laws (penny-residual, no negatives, per-worker rates, single-worker 100%)
  - B: worker-classification policy (EMPLOYEE+TRAINEE vs CONTRACTOR+null; underpay/overpay/write-off)
  - C: payment-row aggregate identity, fuzzed across (collected, expenses, crew) — formula is `amountPaid = sum(splits) + platformFee + businessMargin + overage − shortfall + expenses`
  - D: tax-export source-of-truth (1099 = advances + unflagged splits; QB Income sources only raw `amountPaid`/`rentalCost`)
  - E: GP reconciliation flag (non-GP contractor splits stay `null`; advance + flagged split = single counting)
- If one of these tests breaks, the fix is almost never to relax the test. Legitimate reasons:
  - Documented policy change → also update `[[project-payment-math]]` and/or `[[project-tax-export-integrity]]`
  - A deeper invariant replaces a narrower one
  Either case needs a PR review note.
- When adding new payment behavior, add an invariant here too — bar is "would breaking this cost money?"
- Pre-existing tsup config issue (`tsup.config.ts` is missing in `apps/api`) is separate; don't fix it as part of test-gate work.

Related: [[project-payment-math]], [[project-tax-export-integrity]], [[feature-guaranteed-payout]], [[feedback-run-build-gate-after-changes]] — the "run this gate after every edit" companion rule.
