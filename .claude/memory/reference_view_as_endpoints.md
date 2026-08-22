---
name: reference-view-as-endpoints
description: "/me GET routes must be view-as-aware or annotated `// view-as-allow: <reason>` — enforced by build gate. Canonical doc + shipped-bug history at docs/VIEW_AS_ENDPOINTS.md."
metadata: 
  node_type: memory
  type: reference
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:24:42.764Z
---

`docs/VIEW_AS_ENDPOINTS.md` is the canonical policy for the view-as
endpoint pattern. Read before adding any `GET /me/*` route.

The rule: every `GET /me/*` route must EITHER accept `?viewAsUserId=<id>`
with an ADMIN/SUPER role gate, OR carry a `// view-as-allow: <reason>`
comment within 12 lines above the route header.

Enforcement: [`apps/api/src/services/view-as-endpoints-build-gate.test.ts`](apps/api/src/services/view-as-endpoints-build-gate.test.ts).
Wired via `test:build-gate` script + `turbo.json` build.dependsOn test.

Two blessed patterns for adding view-as support:
- **`resolveWorkdayTarget(req, { allowImpersonationFor: "read" })`** — the
  shared helper used across the workday routes in
  `apps/api/src/routes/worker.ts`.
- **Inline `viewAsUserId` + role check** — see `/me/policies` in
  `worker.ts`. Copy the shape for one-off routes.

Client side: when a component renders in view-as mode (e.g. `HomeTab`
mounts `<ComplianceBanner>`), the URL for any `/me/*` GET must include
`?viewAsUserId=<id>`. See `ComplianceBanner.tsx`'s `viewAsUserId` prop
and `workday.ts`'s `asQuery()` helper for the canonical patterns.

Class-of-bug history (three shipped instances motivate the gate):

1. Client view-as My Properties tab hidden — `/api/me` returned Super's roles.
2. Workday-start spinner hang — `/me/policies` returned Super's compliance,
   which didn't match the target's pending policy IDs, and `api.ts`'s
   POLICIES_REQUIRED interception hung waiting for a wizard that never opened.
3. ComplianceBanner disabled in view-as (`disabled={isViewingOther}`) rather
   than made view-as-aware.

**Sibling to** [[date-handling-reference]] — same scan-and-annotate build-gate
shape. Also related: [[reference-tab-blend-pattern]] (view-as UI convention on blended tabs), [[feedback-run-build-gate-after-changes]].
