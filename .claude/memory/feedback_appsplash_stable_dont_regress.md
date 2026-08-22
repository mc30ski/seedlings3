---
name: feedback-appsplash-stable-dont-regress
description: "AppSplash vertical-drop layout is finally correct after long fight; don't touch it without a design pass first"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:19:41.964Z
---

`apps/web/src/ui/helpers/AppSplash.tsx` reached a working state on 2026-08-15 after
many attempts: the logo no longer jumps vertically on iOS PWA load, which was the
user's #1 complaint through the entire splash-rewrite arc. A tiny residual flash
still occurs (not text, not the logo — likely a paint before the overlay covers
everything) but the user has explicitly said they can live with it.

**Rule:** Do NOT modify AppSplash to chase the residual flash unless the user
explicitly asks. If they do, treat it like a multi-domain change: full design pass
first, present hypothesis, get sign-off, then change one thing. See
[[feedback-multi-domain-design-first]].

**Why:** The vertical-drop bug survived many attempts because each patch touched
overlay sizing / positioning / timing and introduced new subtle regressions. The
current combination (dvh/dvw overlay, portal to body, body-paint-white gating,
phase state machine) is load-bearing — small changes to any one piece have
historically re-broken the drop. The user's frustration when it regressed cost
real money in redeploys.

**2026-08-15/16 addendum — pause tweaks did NOT cause the /me hang
(RESOLVED).** The intermittent "Couldn't load your profile" saga that
happened around the pause-tweak deploy was ultimately traced to
[[project-neon-pipelineconnect-workaround]] (@neondatabase/serverless
issue #209), completely unrelated to AppSplash. The pause revert
"fixed" it by coincidence — the fix was reverting the deploy, not
reverting the pause values specifically. So AppSplash pause values are
NOT known to be load-bearing. HOWEVER, the layout/positioning
constants (dvh/dvw, portal, phase state machine) STILL are — the
"don't touch without a design pass" rule still stands for those. If
someone wants to speed up the animation later, that's fine, but stay
away from the layout/positioning code.

**How to apply:** If tempted to "just tweak one thing" in AppSplash — stop. Ask
the user first. If they want the flash fixed, propose the diagnosis in writing
before editing. Never assume a small css/timing tweak is safe here.
