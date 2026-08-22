---
name: project-neon-pipelineconnect-workaround
description: "apps/api/src/db/prisma.ts requires neonConfig.pipelineConnect=false due to open Neon serverless issue #209"
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:23:54.833Z
---

`apps/api/src/db/prisma.ts` sets `neonConfig.pipelineConnect = false`.
This is a workaround for [@neondatabase/serverless issue
#209](https://github.com/neondatabase/serverless/issues/209) — open bug
reported 2026-04-28 where `pipelineConnect: "password"` (the default)
silently hangs when the serialized query payload lands in a specific
~32-42KB range on a pool reconnection.

**Symptom without the workaround:** intermittent hangs across
DIFFERENT endpoints on DIFFERENT requests — /me works, workday hangs,
next refresh /me hangs, workday works. Whichever query happens to
serialize into the bad size range on a reconnection loses. Client-side
12s timeouts fire → "Couldn't load your profile" banner.

**Why:** With pipelineConnect enabled, the driver bundles startup +
auth + first query into a single pipelined burst. A buffer boundary
condition in that specific size window causes the client to wait
forever for a response Neon never sends.

**Cost of the workaround:** one extra network round-trip on
connection setup (~20-50ms per fresh connection). Negligible vs random
12s hangs.

**Do NOT** remove `pipelineConnect = false` until issue #209 is
resolved AND the fix version is confirmed installed. If someone wants
to remove it "to reduce latency", point them here first.

**Related mistakes to avoid** — see
[[feedback-check-current-docs-before-diagnosing]]:
- Do NOT add aggressive pool config (short `idleTimeoutMillis`,
  short `maxLifetimeSeconds`, low `max`) — these FORCE more
  reconnects, which triggers #209 MORE often. Was tried and reverted.
- Do NOT switch `webSocketConstructor` to native `globalThis.WebSocket`
  — Neon docs recommend `ws`. Was tried and reverted.

Related: [[project-auth-plugin-must-await-recordsignin]] — a separate root cause from the same debugging saga (fire-and-forget prisma transactions strand on Vercel Fluid).
