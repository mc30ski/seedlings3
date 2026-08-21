---
name: project-documents-gdrive-backup
description: "Design + open state of the \"CompanyDocument → Google Drive backup\" feature — tabled 2026-07-14 to fix a prod bug; pick up mid-Google-Cloud-setup."
metadata: 
  node_type: memory
  type: project
  originSessionId: d1686705-f7d7-47c4-8f20-2cd1389e185a
  modified: 2026-08-21T19:23:43.699Z
---

**Status as of 2026-07-14**: design fully spec'd, no code written yet, Google Cloud setup not started (previous "Steps 1-3 done" note was aspirational — user confirmed nothing was actually done).

**Why:** durable, human-browsable off-site backup of company records so a Neon/R2 outage or corruption doesn't lose them.

**How to apply:** when the user resumes ("let's pick up the Google Drive backup thing"), open this file first. Everything below is settled. Continue the Google setup at Step 4, then begin the build in the order listed at the bottom.

**Canonical doc**: `docs/features/documents-gdrive-backup.md` mirrors this design (created 2026-07-14). Keep both in sync during the build. Once code ships, that doc becomes canonical and this memory gets slimmed.

**Chosen names (2026-07-14)**: project = `seedlings-documents-backup`, service account = `documents-backup@seedlings-documents-backup.iam.gserviceaccount.com`. Update earlier references in this file that used the `-sync` naming.

## Scope

- MVP: **`CompanyDocument` + `CompanyDocumentVersion` + `DOCUMENT_TYPES` taxonomy** only.
- Architecture designed to extend later to receipts (`BusinessExpense.receiptR2Key`), policy uploads (`PolicySignature.uploadR2Key`), etc. — each future content domain gets its own top-level folder in Drive.
- One-way sync only, **app → Drive**. Backup, not sync. Edits made in Drive don't flow back. No conflict resolution.

## Drive folder layout

```
[Configured Root]                       ← env var GOOGLE_DRIVE_ROOT_FOLDER_ID
├── CompanyDocuments/                   ← this MVP
│   ├── _taxonomy.json                  ← snapshot of DOCUMENT_TYPES setting
│   ├── _manifest.json                  ← documentId → folder path index
│   ├── Articles of Organization/       ← per taxonomy-type folder
│   │   └── {documentId}/               ← per-document folder (cuid)
│   │       ├── _document.json          ← title/desc/expiresAt/adminHidden/etc.
│   │       ├── v1_2026-05-15_articles.pdf
│   │       └── v1.metadata.json        ← uploader/size/contentType/uploadedAt/isCurrent
│   └── _deleted/                       ← only used when app hard-deletes a doc
│       └── 2026-07/{documentId}_{title}/
├── (future) Receipts/
└── (future) PolicyUploads/
```

## Cadence

- **Daily background job** drains the sync queue.
- **Super-only "Force Sync Now" button** on Records → Documents page for on-demand runs.
- Every mutation writes a queue task **in the same DB transaction** as the app change. Atomic — sync tasks can't be lost between runs.

## Backend architecture

Two new Prisma models:

- `DocumentSyncQueue` — pending tasks: `id`, `taskType`, `documentId`, `versionId?`, `payload JSONB`, `state` (PENDING|IN_PROGRESS|DONE|FAILED), `attempts`, `lastError`, `nextAttemptAt`
- `DocumentSyncState` — durable "what's in Drive now" map: `documentId → driveFolderId`, `versionId → driveFileId`, `lastSyncedAt`

**Task types**: `SYNC_DOCUMENT_METADATA`, `UPLOAD_DOCUMENT_VERSION`, `DELETE_DOCUMENT_VERSION`, `MOVE_TO_DELETED`, `SYNC_TAXONOMY`.

**Worker behavior**:
- **Coalesce metadata tasks per document** at start of each run — multiple `SYNC_DOCUMENT_METADATA` for the same doc collapse to one, reads current DB state at process time, one write to Drive.
- **Verify current DB state before running version tasks** — `UPLOAD_VERSION` checks that the version still exists in DB (was it deleted before sync ran?); if not, skip cleanly.
- Exponential backoff on failure. `attempts` bumps each retry.

**Initial backfill**: single script inserts one sync task per existing document + version, worker drains it. Reuses the normal sync path. No separate migration code.

## Auth

**OAuth 2.0 as admin@seedlingslawncare.com** — pivoted from SA on 2026-07-14 after discovering the GCP project has no parent Workspace org, so `iam.disableServiceAccountKeyCreation` (Google's Secure-by-Default) can't be overridden. OAuth-as-admin-user is a cleaner fit anyway for a single-admin business: files land natively in admin@'s Drive.

Config via env vars:

- `GOOGLE_OAUTH_CLIENT_ID` — from OAuth 2.0 Client ID in Cloud Console → Credentials
- `GOOGLE_OAUTH_CLIENT_SECRET` — pairs with client ID
- `GOOGLE_OAUTH_REFRESH_TOKEN` — obtained once via local consent flow; persists indefinitely as long as admin@ doesn't revoke
- `GOOGLE_DRIVE_ROOT_FOLDER_ID` — target folder inside admin@'s Drive, different value per environment

OAuth scope: `https://www.googleapis.com/auth/drive` (full Drive access). Pivoted 2026-07-14 from `drive.file` after connectivity verification failed: `drive.file` can't see folders the operator created manually in the Drive UI, only files the app itself created or that were opened via a file picker. For a single-admin business backing up its own docs to its own Drive, full `drive` is a fine tradeoff.

## Deletion policy

**App-dictated. Sync mirrors what the app does; there's no separate retention concept.**

- Today the app soft-deletes (archive) → `_deleted/` folder stays empty.
- When/if the app grows a hard-delete path, sync moves to `_deleted/YYYY-MM/{documentId}_{title}/`.
- Nothing in Drive is auto-purged. Operator manually cleans `_deleted/` when they choose. App never touches historical Drive state.

## Config-change guardrail (Option 1 — locked)

If the operator changes `GOOGLE_DRIVE_ROOT_FOLDER_ID` after ANY document has synced:

- Setting field is **locked in the UI**.
- A "**Reset sync state**" button appears. Confirmation dialog explains: wipes `DocumentSyncState`, enqueues fresh backfill against new folder, **the old folder becomes an untouched frozen snapshot** — app will never modify it again, manual cleanup in Drive is on the operator.
- Requires typing `DELETE` to confirm.

## Alerting

**Timeline event on repeated failure.** Threshold: 3 consecutive failed attempts of the same task. Reuses existing Timeline + alerts-dropdown infrastructure. Push notifications ruled out as too loud for a backup service.

## Dev vs Prod

- **Same OAuth client + refresh token** works across environments (simplest).
- **Different `GOOGLE_DRIVE_ROOT_FOLDER_ID`** per environment — prod points at real folder in admin@'s Drive, dev at a scratch folder in the same Drive.
- **Sync disabled by default in dev** via `DOCUMENT_SYNC_ENABLED` Setting flag. Prevents dev reseeds from spamming Drive. Opt-in per developer via toggling that Setting on.
- Dev reseed behavior when sync IS enabled: old Drive folders become orphaned (no `DocumentSyncState` pointing at them), new docs upload to new folders. Occasional manual cleanup by developer. Fine — it's a scratch folder.

## Sync Status panel

Located on **Records → Documents tab**. Shows: queue depth, last successful sync time, failed tasks with reasons, "Force Sync Now" button. Health color: green (drained) / amber (backlog growing) / red (repeated failures).

## Google Cloud + OAuth setup — where we are (post-pivot 2026-07-14)

**Done**:
- ✅ Project `seedlings-documents-backup` created.
- ✅ Google Drive API enabled.
- ✅ Service account `documents-backup@seedlings-documents-backup.iam.gserviceaccount.com` created — **now unused, pending delete**.

**Steps remaining (OAuth path)**:

1. Delete the unused service account (`IAM & Admin → Service Accounts`).
2. Configure OAuth consent screen (`APIs & Services → OAuth consent screen`): External user type, "Seedlings Documents Backup", support email admin@seedlingslawncare.com, scope `.../auth/drive.file`. Publish to "In production" (no verification needed for single-user internal use; user will see "unverified app" warning once during consent).
3. Create OAuth 2.0 Client ID (`APIs & Services → Credentials → Create credentials → OAuth client ID`): type = **Desktop app**, name `seedlings-drive-backup`. Save the Client ID + Client secret.
4. One-time consent flow: `npx tsx apps/api/scripts/oauth-drive-consent.ts <path-to-client_secret.json>` — opens browser, admin@ approves, script prints the refresh token. Save `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` into `apps/api/.env` (dev) + Vercel (prod). Script has zero dependencies (Node built-ins only).
5. Create target Drive folder in admin@'s Drive (a folder named e.g. "Seedlings Company Documents Backup"), grab its folder ID from the URL, set `GOOGLE_DRIVE_ROOT_FOLDER_ID`. Create a separate `dev` scratch folder for local dev.
6. Verify connectivity with a small script that lists the folder using the refresh token, THEN start on code.

## Build order when we finally start coding

1. Two Prisma models (`DocumentSyncQueue`, `DocumentSyncState`) + migration.
2. Sync-queue enqueue helper called from every mutation in `companyDocuments.ts` — in-transaction with each DB change.
3. Google Drive client wrapper — thin auth + basic operations (upload, delete, list, folder create).
4. Worker function — poll queue, coalesce metadata tasks, verify version-task pre-conditions, retry with backoff.
5. Backfill script — enqueue task per existing doc + version.
6. Documents tab: Sync Status panel + Force Sync button.
7. Config-change guardrail UI in Settings (lock + Reset).
8. Timeline event on 3 consecutive failures.
9. Playwright coverage: end-to-end doc-create → wait for sync → verify Drive state.

## Notes for future me

- Do **NOT** rewrite the backfill as inline SQL — same lesson as [[feedback-names-carry-meaning]]. UUIDs generated in JS inside a per-group loop; SQL variants risk per-row UUID generation. (There was an older `project-recurrence-series-id` memory with the same lesson; if you can't find it, the pattern is: JS-side UUID gen, then bulk insert.)
- **Refresh-token invalidation is the operational risk**. Google can revoke the token if: admin@ actively revokes at `myaccount.google.com/permissions`; admin@ changes their password (sometimes); the token goes unused for 6+ months; Google detects abnormal activity. Worker MUST surface `invalid_grant` errors as a Timeline alert with reissue instructions — don't just silently retry.
- **Refresh-token expiry in Testing mode**: apps in the OAuth "Testing" state expire refresh tokens after 7 days for sensitive scopes. Must publish to "In production" state (unverified is fine for single-user apps; user sees "unverified" warning once) to get a persistent token.
- The Google Drive MCP connector (claude.ai settings → Connectors) is optional for me to inspect Drive during development. Not required for the feature. User asked about it earlier.
- **Historical**: originally designed with a service account + domain-wide delegation. Pivoted 2026-07-14 when `iam.disableServiceAccountKeyCreation` couldn't be overridden (GCP project has no parent Workspace org). Old SA email `documents-backup@seedlings-documents-backup.iam.gserviceaccount.com` is being deleted; do not resurrect this path unless the org situation changes.
