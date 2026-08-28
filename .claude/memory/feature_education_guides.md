---
name: feature-education-guides
description: Education guides feature — Draft→Pending→Published workflow, Super-only video, immutable assets, R2 setup still pending
metadata:
  type: project
---

Education guides (Records → Guides, all three roles). Canonical spec:
`docs/features/education.md`. Shipped 2026-08-27, uncommitted at time of
writing.

**Still needs setup before media works**: a Cloudflare R2 bucket plus
`R2_GUIDE_MEDIA_BUCKET_NAME` in dev `.env` and in Vercel Preview +
Production. Until then `presignAssetUpload` returns a 503 naming the
variable; everything else (authoring, approval, reading) works without it.

Two rules that are easy to undo by accident:

- **Visibility is `currentVersionId is not null` in the WHERE clause**,
  not a status flag. A worker's query cannot return an unapproved guide.
- **Assets are immutable and video is Super-only.** No replace-in-place,
  because swapping an image under an approved page would change published
  content with no approver in the loop.

`guides-build-gate.test.ts` (18 tests) locks both, plus the confirm-dialog
and view-as rules below. E2E: `guides-worker.spec.ts`,
`guides-workflow-admin.spec.ts`, `adminrole-guides.spec.ts` (21 specs).

See [[reference-view-as-endpoints]], [[feedback-confirm-dialogs]],
[[reference-build-gates-roster]].
