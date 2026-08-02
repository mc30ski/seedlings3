// Nightly full-database snapshot uploaded to Google Drive.
//
// Reuses the same `driveClient` wrapper + Drive-parent-folder env var
// (GOOGLE_DRIVE_ROOT_FOLDER_ID) as the CompanyDocuments sync feature.
// Sits in a sibling folder named "CompanyClients":
//
//   [GOOGLE_DRIVE_ROOT_FOLDER_ID]/
//     ├── CompanyDocuments/    (existing per-doc backup — see documentSyncWorker.ts)
//     └── CompanyClients/      (this — daily JSON snapshots)
//         ├── 2026-08-02.json
//         ├── 2026-08-03.json
//         └── ...
//
// Rolling backup — every day gets its own file; nothing is ever
// deleted or overwritten. If the cron fires twice on the same ET
// day (manual retry, deploy re-run), the second file is suffixed
// with `-HHMM` so both are preserved.
//
// Payload is the shared snapshot from services/dataExport.ts —
// identical to what "Export All Data" in Admin → Actions produces,
// so any human-triggered download and the nightly Drive file are
// guaranteed to match for a given DB state.
//
// Kill switch: setting `CLIENT_BACKUP_ENABLED` ("true" | "false").
// Off in dev by default; on in prod. Distinct from
// DOCUMENT_SYNC_ENABLED because a Super may want one on and the
// other off.
//
// Called by:
//   - `/cron/client-backup` (Vercel cron, ~2-3 AM ET daily)
//   - (potentially) a Super "Backup Now" button — not shipped yet.

import { prisma } from "../db/prisma";
import { ensureFolder, findFileByName, uploadFile } from "../lib/driveClient";
import { etFormatDate } from "../lib/dates";
import { buildDataSnapshot } from "./dataExport";

const ROOT_CHILD_NAME = "CompanyClients";

export type ClientBackupResult =
  | { skipped: true; reason: "disabled" }
  | {
      skipped: false;
      fileId: string;
      fileName: string;
      byteSize: number;
      durationMs: number;
    };

/** Setting-backed on/off switch. Off = cron short-circuits, returns
 *  { skipped: true, reason: "disabled" }. */
export async function isClientBackupEnabled(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: "CLIENT_BACKUP_ENABLED" } });
  return row?.value === "true";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function ensureClientsRoot(): Promise<string> {
  const rootId = requireEnv("GOOGLE_DRIVE_ROOT_FOLDER_ID");
  return ensureFolder(ROOT_CHILD_NAME, rootId);
}

/** Compute the filename for today's snapshot. If a file with the base
 *  name already exists in the folder (same-day re-run), append `-HHMM`
 *  from the current wall clock so neither snapshot overwrites the
 *  other. Uses a name-scoped Drive query (findFileByName), NOT
 *  listChildren — the folder grows one file per day forever, so a
 *  paginated listing would silently miss the base file once the
 *  folder crosses ~100 rows and let us upload a duplicate. */
async function decideFileName(parentFolderId: string, now: Date): Promise<string> {
  const dateKey = etFormatDate(now);
  const baseName = `${dateKey}.json`;
  const clash = await findFileByName(baseName, parentFolderId);
  if (!clash) return baseName;
  // date-handling-allow: same-day dedup suffix uses wall-clock HHMM
  // from a fresh Date. Not a calendar-date computation — it's a
  // filename disambiguator, so the ET-vs-UTC distinction is moot.
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${dateKey}-${hh}${mm}.json`;
}

/**
 * Run one backup cycle. Idempotent per calendar day only in the sense
 * that a second run same day produces a SECOND file with a HHMM
 * suffix — deliberate, so re-triggers don't clobber the earlier
 * snapshot.
 */
export async function runClientBackup(now: Date = new Date()): Promise<ClientBackupResult> {
  const t0 = Date.now();
  if (!(await isClientBackupEnabled())) {
    return { skipped: true, reason: "disabled" };
  }
  const parentFolderId = await ensureClientsRoot();
  const snapshot = await buildDataSnapshot(null); // full snapshot — no BSD filter
  const name = await decideFileName(parentFolderId, now);
  // Serialize once — passing bytes directly to uploadFile lets us
  // report the true uploaded size and avoids a second stringify pass
  // over what may be a multi-MB payload.
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
  const uploaded = await uploadFile({
    parentFolderId,
    name,
    contentType: "application/json",
    bytes,
  });
  return {
    skipped: false,
    fileId: uploaded.id,
    fileName: uploaded.name,
    byteSize: bytes.byteLength,
    durationMs: Date.now() - t0,
  };
}
