# Documents → Google Drive Backup — Feature Reference

> **Status: design phase — no code yet.** Google Cloud + OAuth setup
> in progress. Full design lives in the memory file
> `project_documents_gdrive_backup.md`; this doc is where implementation
> notes + operational config land as they materialize. Keep this
> and the memory file in sync during the build; once the code ships,
> this doc becomes canonical and the memory file gets slimmed.

## What this feature does

One-way sync from the app's `CompanyDocument` + `CompanyDocumentVersion`
tables into a folder inside `admin@seedlingslawncare.com`'s Google
Drive. Backup only — edits made in Drive do not flow back. Runs on a
daily cadence with an operator-triggered "Force Sync Now" button on the
Records → Documents tab.

## Auth model — OAuth 2.0 as the admin user

The app authenticates to Google Drive **as `admin@seedlingslawncare.com`**
using an OAuth 2.0 refresh token, not a service account. This means:

- Files land in admin@'s personal Drive natively — no service-account
  ownership indirection. The operator can browse / share / download
  them through the normal Drive UI.
- Storage counts against admin@'s Drive quota.
- The API keeps a long-lived **refresh token** as its credential; it
  exchanges that for short-lived access tokens on each sync run.
- The operator can revoke the app's access at any time via
  `https://myaccount.google.com/permissions`.

**Why not a service account?** Google's default org policy
(`iam.disableServiceAccountKeyCreation`) blocks SA JSON key creation
for projects without a Workspace organization. `seedlingslawncare.com`
is a Google Workspace domain but the Google Cloud project is not
attached to an org, so there is no Org Policy Administrator we can be
to override the constraint. OAuth-as-admin-user sidesteps the whole
issue and is arguably a cleaner architectural fit for a single-admin
business: files are natively owned by the human, not by a phantom
identity.

### Why full `drive` scope and not `drive.file`?

`drive.file` restricts the app to files it created itself or that were
explicitly opened via Google's file picker. Since we designate the
target root folder as a pre-existing folder (created manually in
admin@'s Drive UI), `drive.file` can't see it — the app has to
"discover" the folder for the first time and `drive.file` refuses.

The alternatives are:
- **Full `drive` scope** (chosen) — app sees all of admin@'s Drive.
  Simplest. For a single-admin business backing up its own docs to
  its own Drive, the narrow-scope security benefit is mostly
  theoretical.
- **Bootstrap flow with `drive.file`** — the sync worker creates the
  root folder on first run and stashes the resulting folder ID. More
  code complexity and the folder lands at Drive root instead of a
  chosen location. Reserved as a fallback if we ever need to tighten
  scope.

## Google Cloud configuration

| Setting | Value |
| --- | --- |
| Google Cloud project | `seedlings-documents-backup` |
| Enabled API | Google Drive API |
| OAuth consent screen user type | External, published to Production (no verification — single-user use case) |
| OAuth scope | `https://www.googleapis.com/auth/drive` (full Drive access) — see rationale below |
| OAuth client type | Desktop app (used for one-time refresh-token acquisition; the token is then reused server-side) |

### Environment variables (planned)

- `GOOGLE_OAUTH_CLIENT_ID` — from the OAuth 2.0 Client ID created in
  Google Cloud Console → APIs & Services → Credentials.
- `GOOGLE_OAUTH_CLIENT_SECRET` — pairs with the client ID.
- `GOOGLE_OAUTH_REFRESH_TOKEN` — obtained once via the local consent
  flow (see build order below); persists indefinitely as long as
  admin@ doesn't revoke access.
- `GOOGLE_DRIVE_ROOT_FOLDER_ID` — target folder inside admin@'s Drive.
  Different value per environment (prod points at a real folder; dev
  points at a scratch folder in the same account, or is left off with
  sync disabled).
- `DOCUMENT_SYNC_ENABLED` — Setting row (not env). Defaults **off in
  dev** to prevent dev reseeds from spamming Drive; **on in prod**.

## Drive folder layout (planned)

```
[GOOGLE_DRIVE_ROOT_FOLDER_ID]                ← inside admin@seedlingslawncare.com's Drive
└── CompanyDocuments/
    ├── _taxonomy.json                       ← snapshot of DOCUMENT_TYPES setting
    ├── _manifest.json                       ← documentId → folder path index
    ├── <TaxonomyType>/                      ← e.g. "Articles of Organization"
    │   └── {documentId}/                    ← per-document folder (cuid)
    │       ├── _document.json               ← title/desc/expiresAt/etc.
    │       ├── v1_2026-05-15_articles.pdf
    │       └── v1.metadata.json             ← uploader/size/uploadedAt/isCurrent
    └── _deleted/                            ← reserved for future hard-delete path
        └── YYYY-MM/{documentId}_{title}/
```

Future content domains (receipts, policy uploads) each get their own
top-level folder under `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

## Design decisions locked in

- **OAuth as admin user, not service account** (see rationale above).
- **One-way, backup semantics** — no conflict resolution, no Drive→app.
- **Daily cron + on-demand "Force Sync Now"** button (Super only).
- **Queue + worker architecture** — every mutation writes a
  `DocumentSyncQueue` row **in the same DB transaction** as the app
  change, so sync tasks can't be lost.
- **Coalesce metadata tasks per document** at the start of each worker
  run — many small edits collapse to one Drive write.
- **Verify current DB state before running version tasks** — an
  `UPLOAD_VERSION` task checks the version still exists before uploading.
- **App-dictated deletion policy** — no separate retention concept;
  hard-deletes move to `_deleted/YYYY-MM/…`, `_deleted/` is never
  auto-purged.
- **Config-change guardrail** — changing `GOOGLE_DRIVE_ROOT_FOLDER_ID`
  after any doc has synced requires a "Reset sync state" confirmation
  (type `DELETE`); the old folder becomes a frozen snapshot.
- **Timeline alert** on 3 consecutive failed attempts of the same task.
- **Refresh-token rotation** — refresh tokens are typically long-lived
  but can be revoked by the user, invalidated by Google (security
  event), or expire if unused for 6+ months. Worker surfaces
  `invalid_grant` errors as a Timeline alert with reissue instructions.

## Build order (planned)

1. **One-time OAuth setup** (before code):
   1. Configure OAuth consent screen (External, Production, `drive.file` scope, add admin@ as test user during draft).
   2. Create Desktop OAuth 2.0 Client ID + client secret.
   3. Run a local Node script that opens the browser, walks admin@ through the consent flow, and prints the refresh token to stdout.
   4. Save `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` into `apps/api/.env` (dev) and Vercel env (prod).
2. Prisma models: `DocumentSyncQueue`, `DocumentSyncState` + migration.
3. Enqueue helper called from every mutation in `companyDocuments.ts`,
   in-transaction with the DB change.
4. Google Drive client wrapper — thin auth + upload/delete/list/mkdir.
   Handles access-token refresh from the stored refresh token.
5. Worker function: poll queue, coalesce, verify preconditions, retry
   with exponential backoff.
6. Backfill script — enqueue one task per existing doc + version.
7. Documents tab: Sync Status panel + Force Sync button.
8. Config-change guardrail in Settings (lock + Reset).
9. Timeline event on 3 consecutive failures + `invalid_grant` handling.
10. Playwright coverage: doc-create → wait for sync → verify Drive state.
