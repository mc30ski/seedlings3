---
name: project-compliance-banner-specs-dead
description: RESOLVED 2026-08-23 — the 33 compliance specs that silently tested nothing since 049b7ae are green again; CompactBanner now carries the testid/data-* hooks.
metadata:
  type: project
---

**Status: RESOLVED 2026-08-23.** Kept as history because the failure
mode is worth recognizing again.

**What had happened:** commit `049b7ae` ("fixes", 2026-08-20) rewrote
`apps/web/src/ui/tabs/HomeTab.tsx` (−587/+170) and dropped the
`<ComplianceBanner>` mount, replacing it with `CompliancePromptBanner`
(`apps/web/src/ui/tabs/JobsTab.parts.tsx`, mounted from
`MyDashboard.tsx`). The new banner carried **no `data-testid`**, so 33
specs asserting `data-testid="compliance-banner"` all failed. Neither
`docs/features/compliance.md` nor the specs were updated — a direct
violation of the CLAUDE.md rule that code and doc get fixed in the
same PR.

**How it was resolved:** kept the compact banner (it matches the
MyDashboard pattern) but restored everything it had silently lost:

- `CompactBanner` gained `testId` + `dataAttrs` props.
- `CompliancePromptBanner` emits `data-testid="compliance-banner"`,
  `data-severity`, `data-blocking-count`, `data-recommended-count`.
- Restored the **view-as third-person copy** ("X has N required
  documents…") and the **"Manage in Compliance"** CTA, plus the
  `Sign now` / `View profile` labels the doc specifies — so
  `compliance.md` needed no edit.
- **Real app bug fixed:** `HomeTab` hid `MyDashboard` (and with it the
  compliance banner) whenever an admin was in aggregate/subset mode.
  An admin parked in Team overview never saw their own BLOCK-level
  items. Now renders a standalone self-scoped
  `<CompliancePromptBanner>` in those modes.

**Three test bugs found in the process — all were passing-by-accident
or failing-for-the-wrong-reason:**

1. `compliance-banner-view-as-admin` set
   `seedlings_adminhome_workers`, a key **nothing reads**. HomeTab uses
   `usePersistedState("homeTab_viewAsIds")` →
   `seedlings_homeTab_viewAsIds`. The spec had been running in SELF
   mode and never covered view-as at all.
2. `compliance-exception-date-picker-admin` hardcoded `2026-08-15`,
   which rotted into the past. `grantException` rejects past expiry
   with `INVALID_EXPIRY` (and >90 days out), so the grant 400'd and the
   row never appeared. Now derives a date +30d from today in ET.
3. `reconcile-capex-subtotal-admin` **and**
   `ledger-recurrence-series-id-admin` read
   `window.Clerk.session.getToken()` right after `networkidle`, which
   does **not** imply Clerk has hydrated. Token came back `""`, request
   went out unauthenticated, and surfaced as `{"message":"Missing
   auth"}` — reading like a server bug. Both now
   `waitForFunction(() => !!window.Clerk?.session)` first. The ledger
   one had never failed; it was luck.

**The lesson worth keeping:** a green e2e suite is not evidence the
feature works. Two of these specs asserted on a path their title
claimed but never reached. When a spec is the only thing guarding a
feature, check that it actually exercises the path — a localStorage
key typo or a rotted date literal turns a test into decoration.

See also [[feedback-never-build-while-dev-server-runs]],
[[reference-worker-compliance-ui]], [[reference-feature-specs]],
[[reference-playwright-setup]].
