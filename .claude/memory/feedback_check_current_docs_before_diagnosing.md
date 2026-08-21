---
name: feedback-check-current-docs-before-diagnosing
description: "For infra/framework/DB hang bugs, WebFetch current docs + GitHub issues BEFORE forming hypotheses. Do not extrapolate from training data on fast-moving packages."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:19:48.469Z
---

**Rule:** For any bug involving infra (Vercel, serverless runtimes),
frameworks (Next.js, Fastify), or fast-moving DB packages (Neon
serverless, Prisma adapters), the FIRST diagnostic step is:

1. WebFetch the current docs for the relevant packages.
2. WebFetch or grep the GitHub issue tracker for the specific symptom
   ("hang", "intermittent", "vercel", "serverless", etc.).
3. THEN form hypotheses.

**Why:** On 2026-08-15/16 I spent ~2 days chasing a DB hang on this
project. I formed 7 wrong hypotheses in sequence and shipped
mitigations for each, some of which actively made the problem worse
(aggressive pool config triggered more reconnects, which triggered
the actual underlying bug MORE often). The real cause was
[@neondatabase/serverless issue #209](https://github.com/neondatabase/serverless/issues/209),
open since 2026-04. A GitHub issue search on the actual package would
have found it immediately. My training data didn't cover it, and my
reasoning kept extrapolating from stale mental models (Vercel Fluid
compute was also post-training and changed the freeze/thaw semantics
I was reasoning from).

Cost to the user: hundreds of dollars in deployment fees, ~2 days of
production instability, significant erosion of trust.

**How to apply:**

- When the user says "something in the framework/infra is broken",
  BELIEVE THEM and go read current sources. Do NOT default to
  "must be app-level code."
- Reading node_modules README + CHANGELOG is NOT sufficient — those
  don't contain open issues. WebFetch the actual GitHub issue tracker.
- Symptom pattern → search term mapping:
  - "intermittent hang across different endpoints" → search
    "hang" + package name on GitHub
  - "works sometimes fails sometimes" → search "intermittent",
    "flaky", or "race" on the relevant tracker
  - "worked yesterday, broken today" → check the affected
    package's very recent commits + open issues from the last 30 days
- Do NOT chain hypotheses without verification. If your first
  hypothesis "explains" the symptom, that's a starting point, not a
  fix to deploy. Ask the user to test before writing more code.
- Do NOT deploy speculative fixes to production. The user pays for
  every deploy in Vercel fees AND in emotional cost when the "fix"
  makes things worse.
- Spawn parallel Explore agents on infrastructure/framework
  investigations from the START, not as a last resort. Their fresh
  perspective is more valuable than more inline grepping.

**Related:** [[feedback-appsplash-stable-dont-regress]] — a related
"don't touch what's working, don't extrapolate from stale info"
lesson. [[project-neon-pipelineconnect-workaround]] — the concrete bug this
saga traced to; a GitHub-issue search would have found it in minutes.
