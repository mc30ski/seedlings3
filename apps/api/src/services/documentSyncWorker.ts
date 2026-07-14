// ─────────────────────────────────────────────────────────────────────────────
// Sync worker for the CompanyDocument → Google Drive backup feature.
//
// Called by:
//   - Daily cron (/api/cron/document-sync)
//   - Super-only Force Sync endpoint
//   - (Future) Backfill script
//
// Task types (see documentSyncQueue.ts for enqueue helpers):
//   SYNC_DOCUMENT_METADATA — mkdir doc folder (idempotent) + write _document.json
//   UPLOAD_DOCUMENT_VERSION — fetch bytes from R2, upload to Drive as a new file
//   DELETE_DOCUMENT_VERSION — delete the version's file from Drive
//   MOVE_TO_DELETED — move a hard-deleted doc's folder into _deleted/YYYY-MM/
//   SYNC_TAXONOMY — rewrite _taxonomy.json (snapshot of DOCUMENT_TYPES setting)
//
// Design guarantees:
//   - EACH task runs in its own transaction chunk; failures don't block
//     other tasks.
//   - Metadata tasks are COALESCED per document at the start of each run:
//     multiple SYNC_DOCUMENT_METADATA rows for the same doc collapse to
//     one, reading current DB state at process time.
//   - Version tasks re-verify DB state before writing to Drive: if the
//     row was deleted between enqueue and now, the task no-ops.
//   - Exponential backoff on failure. `attempts` bumps each retry.
//   - Auth is anchored to admin@'s Drive via env vars — the worker uses
//     the shared driveClient wrapper.
//
// See docs/features/documents-gdrive-backup.md for the full spec.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/prisma";
import {
  ensureFolder,
  deleteFile,
  uploadFile,
  uploadJson,
  getFile,
  listChildren,
  moveAndRenameFile,
  DriveApiError,
} from "../lib/driveClient";
import { getObjectBuffer } from "../lib/r2";
import { isSyncEnabled } from "./documentSyncQueue";

const ROOT_CHILD_NAME = "CompanyDocuments";
const DELETED_CHILD_NAME = "_deleted";

// Max tasks to process in a single worker run. Cron-scoped upper bound
// so a huge backlog doesn't run for hours; the next cron picks up the
// remainder. Force-Sync-Now callers can override.
const DEFAULT_MAX_TASKS = 100;

// After this long, an IN_PROGRESS row is presumed dead — worker
// crashed, deploy killed the process mid-task, serverless function
// timed out, etc. — and gets swept back to PENDING so the next run
// picks it up. Legit tasks finish in seconds; 15 minutes is a
// generous "definitely dead" margin.
const STUCK_IN_PROGRESS_MS = 15 * 60 * 1000;

export type SyncRunResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: Array<{ taskId: string; taskType: string; error: string }>;
};

/**
 * Drain the queue up to `maxTasks`, one task at a time. Returns a
 * summary the Force Sync UI and cron logs can display.
 *
 * If sync is globally disabled (DOCUMENT_SYNC_ENABLED setting != "true"),
 * this returns immediately with an all-zero summary. Enqueue helpers
 * also skip creation when disabled, so a disabled worker mostly sees an
 * empty queue anyway.
 */
export async function runSync(opts: { maxTasks?: number } = {}): Promise<SyncRunResult> {
  const maxTasks = opts.maxTasks ?? DEFAULT_MAX_TASKS;
  const result: SyncRunResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };
  if (!(await isSyncEnabled())) {
    return result;
  }

  await reapStuckInProgress();
  await coalesceMetadataTasks();

  for (let i = 0; i < maxTasks; i++) {
    const task = await claimNextTask();
    if (!task) break;
    result.processed++;
    try {
      const outcome = await runOneTask(task);
      if (outcome === "SKIPPED") {
        result.skipped++;
      } else {
        result.succeeded++;
      }
      await prisma.documentSyncQueue.update({
        where: { id: task.id },
        data: { state: "DONE", lastError: null },
      });
    } catch (err) {
      result.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ taskId: task.id, taskType: task.taskType, error: msg });
      await handleTaskFailure(task.id, task.attempts, msg);
    }
  }
  return result;
}

// ─── Reaping ─────────────────────────────────────────────────────────────

/**
 * Rescue tasks that got stuck in IN_PROGRESS — the worker claimed them
 * (set state to IN_PROGRESS) but never wrote a terminal state because
 * the process crashed / was killed / hit a serverless timeout /
 * deployed mid-run. Without this reaper such tasks would sit forever,
 * counted as "1 in progress" in the panel but never actually running.
 *
 * We reap based on `updatedAt` because the claim step sets it to now
 * via `updatedAt @updatedAt`. Any row older than
 * STUCK_IN_PROGRESS_MS is presumed dead.
 *
 * Reaped tasks go back to PENDING with attempts++ + a diagnostic note
 * so the terminal-fail mechanism eventually kicks in if the same task
 * keeps dying (prevents zombie retries).
 */
async function reapStuckInProgress(): Promise<void> {
  const threshold = new Date(Date.now() - STUCK_IN_PROGRESS_MS);
  const stuck = await prisma.documentSyncQueue.findMany({
    where: { state: "IN_PROGRESS", updatedAt: { lt: threshold } },
    select: { id: true, attempts: true },
  });
  if (stuck.length === 0) return;
  // updateMany won't let us increment per-row; loop is fine — this is
  // an exceptional path (0 rows most of the time, and even during an
  // outage we'd expect a handful, not thousands).
  for (const row of stuck) {
    await prisma.documentSyncQueue.update({
      where: { id: row.id },
      data: {
        state: "PENDING",
        attempts: row.attempts + 1,
        lastError: "Reaped from IN_PROGRESS — worker likely crashed or was killed mid-task.",
        nextAttemptAt: new Date(),
      },
    });
  }
}

// ─── Coalescing ──────────────────────────────────────────────────────────

/**
 * Metadata tasks (SYNC_DOCUMENT_METADATA) are idempotent — running one
 * task reads the current DB state and writes it. So if there are 10
 * pending metadata tasks for the same document, we mark 9 as DONE
 * ("coalesced") and let the 10th represent them all.
 *
 * Version tasks are NOT coalesced — each represents a distinct file
 * to upload or delete. Only metadata benefits.
 */
async function coalesceMetadataTasks(): Promise<void> {
  const pending = await prisma.documentSyncQueue.findMany({
    where: {
      taskType: "SYNC_DOCUMENT_METADATA",
      state: "PENDING",
    },
    select: { id: true, documentId: true, createdAt: true },
    orderBy: [{ documentId: "asc" }, { createdAt: "asc" }],
  });
  const seen = new Set<string>();
  const toCoalesce: string[] = [];
  // For each documentId, keep the LATEST task (most recent createdAt)
  // and mark the earlier ones as DONE with a coalescedAt marker. The
  // "keep latest" is arbitrary but consistent — either would work since
  // they all read current DB state.
  const grouped = new Map<string, { id: string; createdAt: Date }[]>();
  for (const t of pending) {
    if (!t.documentId) continue;
    const arr = grouped.get(t.documentId) ?? [];
    arr.push({ id: t.id, createdAt: t.createdAt });
    grouped.set(t.documentId, arr);
  }
  for (const [_docId, tasks] of grouped) {
    if (tasks.length <= 1) continue;
    // Keep the last one (latest createdAt), coalesce the rest.
    tasks.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 0; i < tasks.length - 1; i++) {
      toCoalesce.push(tasks[i].id);
    }
  }
  if (toCoalesce.length === 0) return;
  await prisma.documentSyncQueue.updateMany({
    where: { id: { in: toCoalesce } },
    data: { state: "DONE", lastError: "coalesced" },
  });
  void seen; // silence unused
}

// ─── Task claiming ───────────────────────────────────────────────────────

async function claimNextTask() {
  // Prisma doesn't expose SKIP LOCKED elegantly — but this worker is
  // single-run (no parallel workers), so a simple "pick oldest PENDING
  // whose nextAttemptAt has passed" is sufficient.
  const task = await prisma.documentSyncQueue.findFirst({
    where: {
      state: "PENDING",
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!task) return null;
  await prisma.documentSyncQueue.update({
    where: { id: task.id },
    data: { state: "IN_PROGRESS" },
  });
  return task;
}

// Move to terminal FAILED state after this many consecutive attempts.
// Prevents zombie tasks from retrying forever every hour. Operator can
// manually retry a FAILED task from the panel if they've fixed the
// underlying issue.
const MAX_ATTEMPTS_BEFORE_TERMINAL = 10;

async function handleTaskFailure(taskId: string, currentAttempts: number, errorMsg: string) {
  const nextAttempts = currentAttempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS_BEFORE_TERMINAL) {
    // Give up — mark as FAILED (terminal). Task stays visible in the
    // "Failed tasks" section of the Sync Status panel so the operator
    // can inspect and either retry or dismiss.
    await prisma.documentSyncQueue.update({
      where: { id: taskId },
      data: {
        state: "FAILED",
        attempts: nextAttempts,
        lastError: errorMsg.slice(0, 2000),
      },
    });
    return;
  }
  // Exponential backoff, capped at 1 hour.
  const backoffMs = Math.min(60_000 * 60, 5_000 * Math.pow(2, nextAttempts));
  await prisma.documentSyncQueue.update({
    where: { id: taskId },
    data: {
      state: "PENDING",
      attempts: nextAttempts,
      lastError: errorMsg.slice(0, 2000),
      nextAttemptAt: new Date(Date.now() + backoffMs),
    },
  });
}

// ─── Task dispatch ───────────────────────────────────────────────────────

type Task = Awaited<ReturnType<typeof claimNextTask>>;
type TaskOutcome = "OK" | "SKIPPED";

async function runOneTask(task: NonNullable<Task>): Promise<TaskOutcome> {
  switch (task.taskType) {
    case "SYNC_DOCUMENT_METADATA":
      return syncMetadata(task.documentId!);
    case "UPLOAD_DOCUMENT_VERSION":
      return uploadVersion(task.documentId!, task.versionId!);
    case "DELETE_DOCUMENT_VERSION":
      return deleteVersion(task.documentId!, task.versionId!);
    case "MOVE_TO_DELETED":
      return moveToDeleted(task.documentId!, (task.payload ?? {}) as any);
    case "SYNC_TAXONOMY":
      return syncTaxonomy();
    default:
      throw new Error(`Unknown taskType: ${task.taskType}`);
  }
}

// ─── Root + document folder plumbing ─────────────────────────────────────

/**
 * The root of everything in Drive is:
 *   [GOOGLE_DRIVE_ROOT_FOLDER_ID]/CompanyDocuments/
 * We ensure that "CompanyDocuments" subfolder on every operation so a
 * fresh install / new root doesn't require any manual setup in Drive.
 */
async function ensureCompanyDocsRoot(): Promise<string> {
  const rootId = requireEnv("GOOGLE_DRIVE_ROOT_FOLDER_ID");
  return ensureFolder(ROOT_CHILD_NAME, rootId);
}

async function ensureDeletedRoot(): Promise<string> {
  const companyDocs = await ensureCompanyDocsRoot();
  return ensureFolder(DELETED_CHILD_NAME, companyDocs);
}

/**
 * Human-readable folder name for a document. Format:
 *   `<title> (<shortId>)`
 * The short-id suffix (last 8 chars of the cuid) makes two docs with the
 * same title distinguishable in the Drive UI — Google Drive allows
 * duplicate folder names but the operator wouldn't be able to tell
 * them apart at a glance.
 */
function documentFolderName(doc: { id: string; title: string }): string {
  const shortId = doc.id.slice(-8);
  const safeTitle = doc.title.replace(/[\/\\]/g, "_").trim().slice(0, 120) || "untitled";
  return `${safeTitle} (${shortId})`;
}

/**
 * Human-readable Drive filename for a document version. Format:
 *   `<stem> (<versionId>).<ext>`
 * so the operator's eye lands on the filename first and the id sits
 * quietly in parens. Extension is preserved (or "no ext" gracefully
 * handled). Slashes stripped for Drive safety.
 */
function versionFileName(originalFilename: string, versionId: string): string {
  const safe = (originalFilename || "file").replace(/[\/\\]/g, "_");
  const lastDot = safe.lastIndexOf(".");
  // No extension, or dotfile ("_.gitignore"-style) → append id at end.
  if (lastDot <= 0 || lastDot === safe.length - 1) {
    return `${safe} (${versionId})`;
  }
  const stem = safe.slice(0, lastDot);
  const ext = safe.slice(lastDot);
  return `${stem} (${versionId})${ext}`;
}

/**
 * Ensure the per-document folder exists inside its taxonomy-type
 * bucket. Persist the resulting folder id in DocumentSyncState so
 * future tasks don't have to re-look-up.
 */
async function ensureDocumentFolder(doc: { id: string; title: string; type: string }): Promise<string> {
  const existing = await prisma.documentSyncState.findUnique({
    where: { entityId: doc.id },
  });
  if (existing) return existing.driveId;

  const companyDocs = await ensureCompanyDocsRoot();
  const typeFolder = await ensureFolder(doc.type || "Uncategorized", companyDocs);
  const docFolder = await ensureFolder(documentFolderName(doc), typeFolder);

  await prisma.documentSyncState.create({
    data: {
      kind: "DOCUMENT",
      entityId: doc.id,
      driveId: docFolder,
      lastSyncedAt: new Date(),
    },
  });
  return docFolder;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

// ─── Handlers ────────────────────────────────────────────────────────────

/**
 * Handler for SYNC_DOCUMENT_METADATA. Idempotent — reads current DB
 * state each time. If the document no longer exists (was hard-deleted),
 * the MOVE_TO_DELETED task will have been enqueued alongside; this
 * metadata task then becomes a no-op skip.
 */
async function syncMetadata(documentId: string): Promise<TaskOutcome> {
  const doc = await prisma.companyDocument.findUnique({
    where: { id: documentId },
    include: { currentVersion: true },
  });
  if (!doc) return "SKIPPED";

  const folderId = await ensureDocumentFolder(doc);

  // Ensure the folder's Drive name reflects the CURRENT title. Existing
  // pre-rename folders (created before this helper existed) will still
  // be named after the raw cuid, and any post-create title edit would
  // also drift. Cheap round-trip to check + rename only when needed.
  const expectedName = documentFolderName(doc);
  const folderMeta = await getFile(folderId, "id,name");
  if (folderMeta.name !== expectedName) {
    await moveAndRenameFile({ fileId: folderId, newName: expectedName });
  }

  // Look up whether we've already uploaded a _document.json for this
  // doc — if yes, we PATCH it in place; if not, POST a new one.
  const metaFileName = "_document.json";
  const metaFile = await findChildByName(folderId, metaFileName);
  await uploadJson({
    parentFolderId: folderId,
    name: metaFileName,
    existingFileId: metaFile?.id ?? null,
    data: {
      documentId: doc.id,
      type: doc.type,
      title: doc.title,
      description: doc.description,
      expiresAt: doc.expiresAt,
      adminHidden: doc.adminHidden,
      archivedAt: doc.archivedAt,
      currentVersionId: doc.currentVersionId,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    },
  });

  await prisma.documentSyncState.update({
    where: { entityId: documentId },
    data: { lastSyncedAt: new Date() },
  });
  return "OK";
}

async function findChildByName(
  folderId: string,
  name: string,
): Promise<{ id: string } | null> {
  const kids = await listChildren(folderId, { pageSize: 200 });
  return kids.find((k) => k.name === name) ?? null;
}

/**
 * Handler for UPLOAD_DOCUMENT_VERSION. Verifies the version still
 * exists in the DB (race: deletion between enqueue and now), fetches
 * bytes from R2, uploads to Drive, records the Drive file id in
 * DocumentSyncState.
 */
async function uploadVersion(documentId: string, versionId: string): Promise<TaskOutcome> {
  const version = await prisma.companyDocumentVersion.findUnique({
    where: { id: versionId },
    include: { document: true },
  });
  if (!version || version.documentId !== documentId) return "SKIPPED";

  const expectedName = versionFileName(version.originalFilename, version.id);

  // Already uploaded? Don't re-upload the bytes — but check the
  // current Drive filename against the expected one and rename if it
  // drifted (e.g. an older sync used the pre-rename convention). This
  // is what makes "Sync everything" self-heal legacy filenames.
  const existing = await prisma.documentSyncState.findUnique({
    where: { entityId: versionId },
  });
  if (existing) {
    try {
      const meta = await getFile(existing.driveId, "id,name");
      if (meta.name !== expectedName) {
        await moveAndRenameFile({ fileId: existing.driveId, newName: expectedName });
        await prisma.documentSyncState.update({
          where: { entityId: versionId },
          data: { lastSyncedAt: new Date() },
        });
      }
    } catch (err) {
      // File went missing on Drive side (manual delete etc.) — drop
      // the stale state row so a subsequent sync re-uploads fresh.
      if (err instanceof DriveApiError && err.status === 404) {
        await prisma.documentSyncState.delete({ where: { entityId: versionId } });
        // Fall through to the upload path below.
      } else {
        throw err;
      }
    }
    // Refetch state — if we deleted it above, we need to know so we
    // fall into the upload path. Otherwise we're done.
    const stillExists = await prisma.documentSyncState.findUnique({
      where: { entityId: versionId },
    });
    if (stillExists) return "SKIPPED";
  }

  const folderId = await ensureDocumentFolder(version.document);

  const { bytes, contentType } = await getObjectBuffer(version.r2Key, "docs");
  const driveFile = await uploadFile({
    parentFolderId: folderId,
    name: expectedName,
    contentType: contentType ?? version.contentType,
    bytes,
  });

  await prisma.documentSyncState.create({
    data: {
      kind: "VERSION",
      entityId: versionId,
      documentId,
      driveId: driveFile.id,
      lastSyncedAt: new Date(),
    },
  });

  // A new version implies a metadata change (currentVersionId may have
  // moved). Enqueue a follow-up metadata sync so _document.json stays
  // fresh.
  await prisma.documentSyncQueue.create({
    data: {
      taskType: "SYNC_DOCUMENT_METADATA",
      documentId,
    },
  });
  return "OK";
}

/**
 * Handler for DELETE_DOCUMENT_VERSION. Deletes the corresponding Drive
 * file if we have state for it; otherwise noop.
 */
async function deleteVersion(documentId: string, versionId: string): Promise<TaskOutcome> {
  const state = await prisma.documentSyncState.findUnique({
    where: { entityId: versionId },
  });
  if (!state) return "SKIPPED";
  try {
    await deleteFile(state.driveId);
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 404) {
      // Already gone on Drive side — remove our state row.
    } else {
      throw err;
    }
  }
  await prisma.documentSyncState.delete({ where: { entityId: versionId } });
  // Metadata sync follow-up in case currentVersionId shifted on the app side.
  await prisma.documentSyncQueue.create({
    data: {
      taskType: "SYNC_DOCUMENT_METADATA",
      documentId,
    },
  });
  return "OK";
}

/**
 * Handler for MOVE_TO_DELETED. The doc + all versions are gone from
 * the DB. We move the Drive folder into `_deleted/YYYY-MM/` and clear
 * DocumentSyncState rows for the doc + its versions.
 *
 * "Move" in Drive = update the parents field. We rename the folder to
 * include the human title so `_deleted/` is browsable.
 */
async function moveToDeleted(
  documentId: string,
  payload: { title?: string; versionCount?: number },
): Promise<TaskOutcome> {
  const state = await prisma.documentSyncState.findUnique({
    where: { entityId: documentId },
  });
  if (!state) return "SKIPPED";

  const deletedRoot = await ensureDeletedRoot();
  // Bucket by year-month so `_deleted/` doesn't grow unbounded and is
  // easy to skim (`_deleted/2026-07/{docId}_{title}/`).
  const now = new Date();
  const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const monthFolder = await ensureFolder(yearMonth, deletedRoot);

  const safeTitle = (payload.title ?? "untitled").replace(/[\/\\]/g, "_").slice(0, 120);
  const newFolderName = `${documentId}_${safeTitle}`;

  // Fetch the current folder to know its existing parent, then swap
  // parents + rename in a single PATCH via the driveClient helper.
  const folder = await getFile(state.driveId, "id,name,parents");
  const currentParents = (folder.parents ?? []).join(",");

  await moveAndRenameFile({
    fileId: state.driveId,
    newName: newFolderName,
    addParentId: monthFolder,
    removeParentId: currentParents,
  });

  // Clear all state for the doc + its versions.
  await prisma.documentSyncState.deleteMany({
    where: { OR: [{ entityId: documentId }, { documentId }] },
  });

  return "OK";
}

/**
 * Handler for SYNC_TAXONOMY. Writes the current DOCUMENT_TYPES setting
 * snapshot to `_taxonomy.json` at the root of the backup folder so an
 * operator browsing Drive knows what the type keys mean.
 */
async function syncTaxonomy(): Promise<TaskOutcome> {
  const setting = await prisma.setting.findUnique({
    where: { key: "DOCUMENT_TYPES" },
  });
  if (!setting?.value) return "SKIPPED";
  let parsed: unknown;
  try {
    parsed = JSON.parse(setting.value);
  } catch {
    return "SKIPPED";
  }
  const companyDocs = await ensureCompanyDocsRoot();
  const existing = await findChildByName(companyDocs, "_taxonomy.json");
  await uploadJson({
    parentFolderId: companyDocs,
    name: "_taxonomy.json",
    existingFileId: existing?.id ?? null,
    data: { snapshotAt: new Date().toISOString(), types: parsed },
  });
  return "OK";
}
