---
name: feedback-always-seed-dev
description: "When adding a new Setting (or any seed-affecting change), automatically run the dev reseed without asking. The user always handles prod themselves via Neon UI."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:19:14.868Z
---

When I add or modify a Setting row (or any other dev-DB-affecting seed
change), I should run the reseed against dev myself, not just edit
`seed.ts` and report "ready to reseed."

**Why:** the user has corrected this multiple times. Every change I make
that touches `seed.ts` needs to be live in dev before the user opens
their browser to verify. Stopping at "edited seed.ts, you can reseed
now" wastes a round-trip and reads as me not finishing the task.

**How to apply:**
- Reseed split by responsibility: **I always seed dev. The user always
  seeds prod** (via the Neon UI / copy-from-dev pattern). Don't ask
  which env — dev is mine.
- After any `seed.ts` edit, run `cd apps/api && npm run db:seed` (or
  the appropriate variant per the trigger phrases in
  [[feedback-reseed-phrases]]) before reporting the task done.
- See also [[feedback-settings-dev-then-neon]] — the dev-then-Neon flow
  for getting changes into prod. My side of that flow is the dev half.
