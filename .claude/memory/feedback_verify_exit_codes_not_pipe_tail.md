---
name: feedback-verify-exit-codes-not-pipe-tail
description: Piping a check through `tail`/`head` reports the pager's exit code, not the tool's — several "0 errors" verifications were measuring nothing.
metadata:
  type: feedback
---

**`npx tsc --noEmit 2>&1 | tail -4; echo "exit=$?"` prints `tail`'s exit
code, which is always 0.** Every "api tsc 0 errors" reported this way was
worthless. Use `${PIPESTATUS[0]}`, redirect to a file and check `$?`, or run
the command bare.

**Why:** on 2026-10-18 `apps/api` turned out not to typecheck AT ALL —
`tsc` was dying with an internal compiler error (`Debug Failure… Parameter
symbol already has a cached type`), deterministically, on both TS 5.9.3 and
5.4.5. It had been doing so for long enough to hide four duplicated function
definitions, one of which (`deleteInvoiceCharge`) called itself forever and
another of which dropped the only authorization check on removing someone
from a visit. The pipe had been reporting success the whole time.

A crash is not a pass. Distinguish three outcomes, never two: clean, type
errors, and *the checker did not run*. `grep -c "error TS"` returning 0 also
looks like success when the process died before emitting any.

**How to apply:** when a verification underpins a claim to the user, confirm
the tool itself exited 0 and produced the output shape you expected. If a
whole category of problem has been invisible for a while, suspect the
measurement before concluding the code is clean — this is the second time
blind verification bit here, after the e2e suite turned out to be excluded
from `tsconfig.json` (see [[feedback-never-ship-a-red-spec]] and
[[feedback-run-build-gate-after-changes]]).
