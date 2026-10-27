---
name: feature-education-guides
description: Education guides feature — Draft→Pending→Published workflow, video gated on `content.approve`, immutable assets; R2 configured in dev, Vercel unverified
metadata:
  type: project
---

Education guides (Records → Guides, all three roles). Canonical spec:
`docs/features/education.md`. Shipped 2026-08-27, uncommitted at time of
writing.

**DEV IS NOW CONFIGURED** (verified 2026-10-13): `R2_GUIDE_MEDIA_BUCKET_NAME`
is set in `apps/api/.env` and the bucket holds 11 objects, so guide media
works locally. **Vercel Preview + Production remain UNVERIFIED** — check there
before calling the feature done. Where the var is missing
`presignAssetUpload` returns a 503 naming the
variable; everything else (authoring, approval, reading) works without it.

Two rules that are easy to undo by accident:

- **Visibility is `currentVersionId is not null` in the WHERE clause**,
  not a status flag. A worker's query cannot return an unapproved guide.
- **Assets are immutable and video needs `content.approve`.** No replace-in-place,
  because swapping an image under an approved page would change published
  content with no approver in the loop.

`guides-build-gate.test.ts` (18 tests) locks both, plus the confirm-dialog
and view-as rules below. E2E: `guides-worker.spec.ts`,
`guides-workflow-owner.spec.ts`, `scheduler-guides.spec.ts` (21 specs).

See [[reference-view-as-endpoints]], [[feedback-confirm-dialogs]],
[[reference-build-gates-roster]].
