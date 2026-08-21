---
name: project-auth-plugin-must-await-recordsignin
description: "apps/api/src/plugins/auth.ts MUST await recordSignInIfNew — fire-and-forget strands \"idle in transaction\" and hangs all authenticated requests"
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-16T04:50:26.332Z
---

The two `recordSignInIfNew(...)` calls in
[apps/api/src/plugins/auth.ts](apps/api/src/plugins/auth.ts) MUST be
`await`ed, never `void`ed.

**Why:** `recordSignInIfNew` runs `prisma.$transaction(...)` inside. On
Vercel Fluid compute, if the HTTP response is sent before the
transaction commits, the container can be recycled mid-transaction.
The session ends up "idle in transaction" on the Neon side, holding a
row-level lock on the User row. Every subsequent authenticated request
for that same user tries to UPDATE the same lastSignInAt column and
blocks on that lock until Neon eventually times out the abandoned
session (many minutes). Symptom: all the operator's devices hang
simultaneously, then all recover simultaneously, on a duty cycle.

Diagnosed 2026-08-16 after ~2 days of production instability. Confirmed
by querying `pg_stat_activity` and seeing 4 concurrent
"UPDATE User SET lastSignInAt..." queries all blocked on the same
"idle in transaction" backend PID.

**Cost of awaiting:** ~30-50ms per authenticated request (the audit
transaction time). In practice usually near-zero because the function
early-returns when `sid === knownSid` (the common case — most JWTs
from a live session reuse a sid across silent refreshes).

**How to apply:**
- Do not change these two `await` back to `void`, ever, without an
  actual verified alternative (like Vercel's `waitUntil()`).
- If a future edit adds ANY new fire-and-forget prisma call in a
  request-handler path, apply the same reasoning — Fluid does NOT
  guarantee background work completes.
- Diagnostic tool: `apps/api/scripts/_neon-locks.ts` prints active
  connections + blocked queries + long-running transactions. Run when
  the same pattern is suspected.
- Recovery tool: `apps/api/scripts/_kill-stuck-tx.ts` terminates any
  "idle in transaction" older than 10s — kills stranded sessions and
  releases their locks.
