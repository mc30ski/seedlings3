---
name: feedback-run-tests-trigger
description: "When the user asks to run tests, run both the API build gate and the Playwright e2e suite without asking which one — same pattern as reseed triggers"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:22:29.267Z
---

**When the user says "run the test suite", "run the tests", "run e2e", or similar, just run them.** Don't ask which suite, which scope, or whether they want a subset. Same operational pattern as [[feedback-reseed-phrases]].

**Why:** The user shouldn't have to remember command syntax or think about which subset to run. Their intent is "verify nothing regressed" and the answer is the same both gates every time.

**How to apply:**

1. Run the API build gate first (fast, ~500ms, 181 tests):
   ```bash
   cd apps/api && npm run test:build-gate
   ```
2. Then run the Playwright e2e suite (~1.5–4 min):
   ```bash
   cd apps/web && npm run test:e2e
   ```
3. Report the results concisely: passed/failed counts + any failures with brief context.
4. If the user specifies scope ("just the build gate" / "just e2e" / "just the compliance tests"), honor that. Otherwise run both.
5. The Next.js dev server must be running for Playwright; check with `lsof -i :3000` before running. If not up, tell the user rather than trying to start it yourself (they run their own dev server via VSCode).

Related: [[reference-playwright-setup]], [[reference-feature-specs]], [[feedback-run-build-gate-after-changes]].
