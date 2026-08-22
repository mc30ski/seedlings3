---
name: feedback-multi-domain-design-first
description: "For multi-touchpoint auth/domain changes, do a full design pass upfront — don't ship incremental patches that create tech debt"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:28:09.083Z
---

For any auth flow, multi-domain, or Clerk configuration change, do a complete design pass BEFORE writing code. Map every affected file, every redirect, every security consideration, every touchpoint in the existing codebase. Present the design. Get sign-off. THEN implement in one focused pass.

**Why:** During the 2026-08-13 Clerk satellite setup for `seedlings.pro`, I made a chain of reactive patches instead of designing first. Started by saying "just add seedlings.pro to Clerk's allowed origins" (that concept doesn't exist in Clerk). Then added satellite mode to ClerkProvider without checking the custom sign-in page would break under it. Then patched the sign-in page to redirect to primary. Then discovered the primary's post-signin hardcoded `/` and didn't honor redirect_url — patched that. Then discovered the allowlist needed to exist for open-redirect defense — patched that. Every step was a small correction to the previous one. User (correctly) lost confidence and called out the pattern: "you're chasing your own mistakes and making it seem like this is business as usual. It's not." They also incurred real cost (domain purchase, possibly plan-tier bump on Clerk) on the path I recommended.

**How to apply:** When the user asks for a change that touches auth, multi-domain routing, or Clerk config:

1. **Before writing any code**, read the ENTIRE relevant path in the codebase. For auth changes specifically: read the ClerkProvider setup, the sign-in page(s), every place that reads `window.location`, every place that calls `signIn.create` / `setActive` / `useAuth`, every redirect (`Link`, `router.push`, `window.location.href`).
2. **Trace the full user journey through OUR code**, not just the vendor's happy path. Ask: what happens on satellite? What happens on primary? What happens on localhost? What if the user is already signed in? What if they land via a bookmark vs. an in-app link vs. a share?
3. **Present a complete design doc** listing every file that changes, every redirect, every security consideration (open redirect, XSS, session fixation), every configuration surface (code, env, DB Setting).
4. **Get explicit sign-off on the design** before touching code.
5. **Implement in one focused pass** — not incrementally as issues surface.
6. **If mid-implementation a hidden constraint appears** (e.g., "oh, this API doesn't work on satellites"), STOP, add it to the design, re-align with the user. Do not silently patch and move on.

Also relevant: [[project-clerk-satellite-hardcoded-hostnames]] is the tech debt from this failure mode — hostnames hardcoded in the client bundle instead of env-var driven. Fix planned. [[feedback-never-push-without-explicit-permission]] — the same "overreach under pressure" pattern from the same time period.
