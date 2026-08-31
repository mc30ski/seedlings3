---
name: feedback-reseed-phrases
description: Trigger phrases for reseeding the dev database — map each phrase to the right template.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:22:50.589Z
---

When the user asks to reseed the dev database, map the phrasing to a template (no follow-up questions unless genuinely ambiguous):

| Phrase | Template | Command |
|---|---|---|
| "reseed the development database" / "reseed dev" / "reseed" | default | `npx prisma db seed -- --template=default` |
| "reseed payment" / "reseed payments" | payments-active | `npx prisma db seed -- --template=payments-active` |
| "reseed payment clean" / "reseed payments clean" | payments-clean | `npx prisma db seed -- --template=payments-clean` |

**Why:** The user wants short, predictable triggers. Don't second-guess or read intent into adjectives — match the phrase pattern. If a phrase is genuinely ambiguous (e.g. "reseed something different"), ask which template.

**How to apply:** Run from `apps/api/`. Don't ask which environment — the user means dev. Don't confirm before running — these are reversible. Just run and report what was seeded.

**Where the templates live:** `apps/api/prisma/seed.ts`. Function names: `seedDatabase()`, `seedPaymentsClean()`, `seedPaymentsActive()`. The `payments` alias also maps to `seedPaymentsActive()` for backward compat with older muscle memory.

Related: [[feedback-always-seed-dev]] — I always run the reseed after touching seed.ts. [[feedback-run-tests-trigger]] — same trigger-phrase pattern for tests.
