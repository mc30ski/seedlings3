---
name: reference-feature-specs
description: "Where per-feature canonical specs live in the repo, and the triple pattern (doc + backend gate + Playwright e2e) they follow"
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:27.245Z
---

`docs/features/<feature-name>.md` is the canonical per-feature spec — plain-English "how it works", state machine, edge cases, user copy, testing paths. Load-bearing enough to be referenced from CLAUDE.md.

Each feature spec binds to two enforcement mechanisms:
- **Backend invariants**: `apps/api/src/services/<feature>-build-gate.test.ts` (runs on every API build, ~ms fast)
- **UI/UX invariants**: `apps/web/tests/e2e/specs/<feature>-*.spec.ts` (Playwright, ~1-4min per feature)

**How to apply**: When touching a feature that has a `docs/features/*.md` spec, read it first. If a change alters user-visible behavior, update the doc in the same PR — the doc and code must not drift. When authoring a new feature spec, mirror the structure of [`docs/features/compliance.md`](file:///Users/michaelwanderski/dev/seedlings3/docs/features/compliance.md): data model, enforcement levels, worker actions, lifecycle, UI paths, copy/color rules, events, exceptions, edge cases, where invariants are enforced, known limitations.

**Playwright auth pattern** for e2e tests: use Clerk sign-in tokens (`clerkClient.signInTokens.createSignInToken({ userId })`) + `@clerk/testing`'s `clerk.signIn({ strategy: 'ticket', ticket })`. See [[reference-playwright-setup]] for details.

**Existing feature specs**:
- Compliance — `docs/features/compliance.md` (this session, June 2026)

Related: [[reference-playwright-setup]], [[financial-system-doc]], [[date-handling-reference]], [[feedback-run-tests-trigger]].
