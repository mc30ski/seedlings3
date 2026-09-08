---
name: feedback-never-ship-a-red-spec
description: A failing spec in the final pre-deploy run is a blocker, not noise — one was dismissed and took production down.
metadata:
  type: feedback
---

A failing e2e spec in the final pre-deploy run BLOCKS the report. Never
summarize a run as "50 e2e tests pass" when one failed, and never assume a
lone failure is flakiness without reproducing the assertion it made.

**2026-09-08:** `supplies-and-ledger-link-admin.spec.ts:96` ("clicking a
ledger row actually writes the breadcrumb") failed in the last run before the
user deployed. It was reported as a green run. It was a real 500 —
`GET /admin/business-expenses` had a stale Prisma `include` naming
`supplyPurchase` after the relation became `supplyPurchases` — and it took
down the entire Ledger tab plus the owner-equity panel the moment production
came up. The user found it in the first screen they looked at.

**Why:** the user does every commit and deploy themselves ([[feedback-never-push-without-permission]]),
so the pre-deploy report is the ONLY gate between a bug and production. A
softened test result removes the last check they have.

**How to apply:** state failures verbatim with the spec name; reproduce
before calling anything flaky; if a re-run is needed because the dev server
was rebuilding or `tsx watch` reloaded mid-run, say that explicitly and
re-run rather than discounting the result. Related:
[[feedback-test-tier-by-change-size]], [[feedback-dont-inflate-findings]].
