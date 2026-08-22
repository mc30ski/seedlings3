---
name: feedback-run-build-gate-after-changes
description: "After any code change in apps/api (and any payments-touching change anywhere), run `npm run test:build-gate` from apps/api before reporting the task done. Don't skip even when the edit looks unrelated."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:22:56.290Z
---

After making ANY code change in `apps/api/` — and any change that touches payments/payroll/exports anywhere in the repo — run the build gate before reporting the work as done:

```
cd apps/api && npm run test:build-gate
```

That executes **416 tests across 15 files in ~630ms** (verified 2026-08-21) — seven build gates plus their companion unit suites. Full roster in [[reference-build-gates-roster]]. If anything fails, fix it before declaring the task complete.

The date-handling test also fires on `apps/web/` changes — it scans every `.ts`/`.tsx` file under `apps/web/src/` and `apps/web/pages/`. So a web-only edit that introduces `.toISOString().slice(0,10)` or `setDate(getDate()+n)` fails the API build gate, not just web TS. Run the gate after web edits too.

**Why:** User is now running real payroll with state + federal withholding in production. Payment math is load-bearing. The whole point of [[feedback-payments-build-gate]] is to catch mis-counts before they ship. Running it manually after each batch of edits — not just hoping CI catches it later — guarantees the user can trust each "done" report.

**How to apply:**
- After ANY edit in `apps/api/src/`, run the gate before reporting done.
- After edits to `apps/web/` that touch payments/payroll/exports surfaces (PaymentsTab, ExportsTab, payment-related dialogs, ProfileTab earnings rendering, etc.), also run the gate — frontend changes can still expose a wrong invariant if they consume new fields.
- For purely cosmetic edits (CSS tokens, copy changes, comments, memory files, README), skip — the gate has no signal to add.
- If a gate test breaks, do NOT relax it. Either: fix the code (default), or, if the policy genuinely changed, surface that to the user and update `[[project-payment-math]]` / `[[project-tax-export-integrity]]` alongside the test change.
- Don't batch the gate run into a single "I'll run it at the end." Run it after each substantive change — that way you isolate which edit broke the invariant.

Related: [[feedback-payments-build-gate]], [[project-payment-math]], [[project-tax-export-integrity]], [[date-handling-reference]] — the sibling date-handling scan wired through the same build-gate script.
