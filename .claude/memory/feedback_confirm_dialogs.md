---
name: feedback-confirm-dialogs
description: "Every action button needs a confirm dialog before firing — mobile-first app, accidental taps are common."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:20:08.710Z
---

Every mutating action in the seedlings3 web app (admin or worker) must show a confirm dialog before firing. Approve, Reject, Adjust, Write off, Delete, Revert, Reschedule, Cancel — all of them. Single-tap fire-and-go is **not acceptable**.

**Why:** The app is used heavily on phones in the field. Accidental taps from a swipe gesture, a thumb at the wrong angle, or a sleepy worker tapping the wrong row are common. A confirm dialog adds one tap of friction but prevents an entire class of mistakes that are otherwise hard to undo (especially on Approve/Reject/Write off paths that touch real money).

**How to apply:**
- New action buttons → wire through `ConfirmDialog` (or an inline confirm view in the same dialog when stacking is weird).
- Audit existing buttons before shipping any change to a payment/job-state mutating surface — if any are bare, add a confirm before merge.
- The confirm dialog should state what's about to happen and the consequences. Use realistic examples (not invented "wrote $100 on a check" nonsense — see [[project-payment-math]] for accurate language patterns).
- Related: [[feedback-never-push-without-explicit-permission]] — same "reversible-by-design beats faster-because-we-skipped" stance.
- For low-impact admin actions (filter changes, view toggles) confirm is overkill. The rule is for *mutations*.

**User has called this out multiple times — drop the surface-level "this is destructive" reflex and just always confirm.**
