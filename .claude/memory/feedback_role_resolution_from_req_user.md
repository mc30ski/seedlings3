---
name: feedback-role-resolution-from-req-user
description: Resolve a caller's role from req.user, never a fresh prisma lookup — a DB read silently bypasses view-as
metadata:
  type: feedback
---

Any route helper that decides "is this caller a worker / admin / super"
must read `req.user.roles`, which `requireApproved` populates with the
**impersonation-adjusted** roles. Never re-query `prisma.user` for roles.

**Why:** a fresh DB lookup returns the caller's *real* roles, so a Super
using "view as Worker" keeps every super power on that surface while every
other surface correctly demotes them — the view-as feature then lies about
exactly the thing it exists to test. Guides shipped this bug in
`guideViewer` (2026-08-27); it also crashed outright because the helper
read a `req.dbUser` field nothing sets. This is the fourth appearance of
the view-as class of bug in this repo.

**How to apply:** `const me = req.user as { id, roles }` → build the viewer
from `me.roles`. If you catch yourself writing `prisma.user.findUnique`
inside a role helper, stop. Locked for guides by the "view-as honesty"
block in `guides-build-gate.test.ts`; the general policy lives in
`docs/VIEW_AS_ENDPOINTS.md`.

See [[reference-view-as-endpoints]], [[feature-education-guides]].
