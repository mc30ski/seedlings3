// ─────────────────────────────────────────────────────────────────────────────
// Enqueue helpers for the CompanyDocument → Google Drive backup feature.
// Every mutation in `companyDocuments.ts` calls one of these functions
// FROM WITHIN the same Prisma transaction, so a sync task can't be lost
// between DB commit and the next worker run.
//
// See docs/features/documents-gdrive-backup.md for the full spec.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";

export type SyncTaskType =
  | "SYNC_DOCUMENT_METADATA"
  | "UPLOAD_DOCUMENT_VERSION"
  | "DELETE_DOCUMENT_VERSION"
  | "MOVE_TO_DELETED"
  | "SYNC_TAXONOMY";

export type PrismaClientOrTx = Prisma.TransactionClient | typeof prisma;

/**
 * Global on/off switch for sync. Defaults OFF in dev to prevent test
 * runs from spamming Drive; ON in prod. Stored in the `Setting` table
 * as key `DOCUMENT_SYNC_ENABLED` with value `"true"` or `"false"`.
 *
 * This is checked at ENQUEUE time (not just at worker time) so we don't
 * accumulate a queue backlog while sync is turned off — the tasks
 * simply don't get created. Worker also short-circuits when off, as
 * defense in depth.
 */
export async function isSyncEnabled(client: PrismaClientOrTx = prisma): Promise<boolean> {
  const row = await client.setting.findUnique({ where: { key: "DOCUMENT_SYNC_ENABLED" } });
  return row?.value === "true";
}

async function enqueue(
  client: PrismaClientOrTx,
  task: {
    taskType: SyncTaskType;
    documentId?: string | null;
    versionId?: string | null;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!(await isSyncEnabled(client))) return;
  await client.documentSyncQueue.create({
    data: {
      taskType: task.taskType,
      documentId: task.documentId ?? null,
      versionId: task.versionId ?? null,
      payload: (task.payload ?? null) as any,
    },
  });
}

// ─── Public enqueue API — one function per mutation shape ────────────────

/**
 * A CompanyDocument's metadata changed: title, description, expiresAt,
 * adminHidden, archivedAt, currentVersionId. The worker coalesces all
 * pending SYNC_DOCUMENT_METADATA tasks per document into one write, so
 * spamming this call across a rapid-fire batch of edits is cheap.
 */
export async function enqueueSyncMetadata(
  client: PrismaClientOrTx,
  documentId: string,
): Promise<void> {
  await enqueue(client, { taskType: "SYNC_DOCUMENT_METADATA", documentId });
}

/**
 * A new CompanyDocumentVersion was confirmed (bytes are in R2). Worker
 * fetches the bytes and uploads them to Drive under the document's folder.
 */
export async function enqueueUploadVersion(
  client: PrismaClientOrTx,
  documentId: string,
  versionId: string,
): Promise<void> {
  await enqueue(client, {
    taskType: "UPLOAD_DOCUMENT_VERSION",
    documentId,
    versionId,
  });
}

/**
 * A CompanyDocumentVersion was hard-deleted. Worker deletes the Drive
 * file. The DocumentSyncState row for the version tells us the Drive
 * file id; if there's no state row, the version never made it to
 * Drive and the task is a no-op.
 *
 * `payload.originalFilename` is captured at enqueue time so the sync
 * panel can still label the row after the DB row is gone.
 */
export async function enqueueDeleteVersion(
  client: PrismaClientOrTx,
  documentId: string,
  versionId: string,
  payload: { originalFilename: string; sizeBytes: number },
): Promise<void> {
  await enqueue(client, {
    taskType: "DELETE_DOCUMENT_VERSION",
    documentId,
    versionId,
    payload,
  });
}

/**
 * A CompanyDocument was hard-deleted. Worker moves the Drive folder
 * into `_deleted/YYYY-MM/{documentId}_{title}/`. Payload captures the
 * title + version count because they're gone from the DB by the time
 * the worker runs.
 */
export async function enqueueMoveToDeleted(
  client: PrismaClientOrTx,
  documentId: string,
  payload: { title: string; versionCount: number },
): Promise<void> {
  await enqueue(client, {
    taskType: "MOVE_TO_DELETED",
    documentId,
    payload,
  });
}

/**
 * DOCUMENT_TYPES Setting changed. Worker rewrites `_taxonomy.json` at
 * the root of the backup folder.
 */
export async function enqueueSyncTaxonomy(
  client: PrismaClientOrTx,
): Promise<void> {
  await enqueue(client, { taskType: "SYNC_TAXONOMY" });
}
