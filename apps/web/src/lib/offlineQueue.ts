/**
 * Offline Action Queue — stores pending actions in IndexedDB and replays them when online.
 *
 * Each action has: id, type, occurrenceId, payload, status, createdAt, retries, error.
 * Queue processes in chronological order per occurrence.
 * If an action fails, subsequent actions for the same occurrence are paused.
 * 3 retries with backoff on server-side failures, then marked as failed.
 */

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "seedlings-offline";
const DB_VERSION = 1;
const STORE_NAME = "queue";
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000]; // ms

export type QueuedActionType =
  | "START_JOB"
  | "COMPLETE_JOB"
  | "PAUSE_JOB"
  | "RESUME_JOB"
  | "ADD_PHOTO"
  | "ADD_EXPENSE"
  | "POST_COMMENT"
  | "SET_REMINDER"
  | "CLEAR_REMINDER"
  | "PIN"
  | "UNPIN"
  | "LIKE"
  | "UNLIKE"
  | "DISMISS_REMINDER";

export type QueuedActionStatus = "pending" | "syncing" | "synced" | "failed";

export type QueuedAction = {
  id: string;
  type: QueuedActionType;
  occurrenceId: string;
  label: string; // Human-readable description e.g., "Started: Harrington Estate"
  payload: Record<string, unknown>;
  status: QueuedActionStatus;
  createdAt: number; // timestamp ms
  retries: number;
  error?: string;
};

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("status", "status");
          store.createIndex("occurrenceId", "occurrenceId");
          store.createIndex("createdAt", "createdAt");
        }
      },
    });
  }
  return dbPromise;
}

// Generate unique ID
function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Public API ──

export async function enqueueAction(
  type: QueuedActionType,
  occurrenceId: string,
  label: string,
  payload: Record<string, unknown>
): Promise<QueuedAction> {
  const action: QueuedAction = {
    id: uid(),
    type,
    occurrenceId,
    label,
    payload,
    status: "pending",
    createdAt: Date.now(),
    retries: 0,
  };
  const db = await getDB();
  await db.put(STORE_NAME, action);
  notifyListeners();
  return action;
}

export async function getAllActions(): Promise<QueuedAction[]> {
  const db = await getDB();
  const all = await db.getAll(STORE_NAME);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPendingCount(): Promise<number> {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, "status", "pending");
  return all.length;
}

export async function getFailedCount(): Promise<number> {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, "status", "failed");
  return all.length;
}

export async function getSyncingCount(): Promise<number> {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, "status", "syncing");
  return all.length;
}

export async function deleteAction(id: string): Promise<void> {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
  notifyListeners();
}

export async function clearAllActions(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE_NAME);
  notifyListeners();
}

export async function clearSyncedActions(): Promise<void> {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, "status", "synced");
  const tx = db.transaction(STORE_NAME, "readwrite");
  for (const a of all) {
    await tx.store.delete(a.id);
  }
  await tx.done;
  notifyListeners();
}

export async function retryAction(id: string): Promise<void> {
  const db = await getDB();
  const action = await db.get(STORE_NAME, id);
  if (action) {
    action.status = "pending";
    action.retries = 0;
    action.error = undefined;
    await db.put(STORE_NAME, action);
    notifyListeners();
  }
}

// ── Queue Processor ──

type ActionExecutor = (action: QueuedAction) => Promise<void>;

let executor: ActionExecutor | null = null;
let processing = false;

export function setActionExecutor(fn: ActionExecutor) {
  executor = fn;
}

export async function processQueue(): Promise<{ synced: number; failed: number }> {
  if (processing || !executor) return { synced: 0, failed: 0 };
  processing = true;

  let synced = 0;
  let failed = 0;

  try {
    const db = await getDB();
    const pending = await db.getAllFromIndex(STORE_NAME, "status", "pending");
    pending.sort((a, b) => a.createdAt - b.createdAt);

    // Track failed occurrence IDs to skip dependent actions
    const failedOccurrences = new Set<string>();

    for (const action of pending) {
      // Skip if a previous action for this occurrence failed
      if (failedOccurrences.has(action.occurrenceId)) continue;

      // Mark as syncing
      action.status = "syncing";
      await db.put(STORE_NAME, action);
      notifyListeners();

      let success = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          await executor(action);
          action.status = "synced";
          action.error = undefined;
          await db.put(STORE_NAME, action);
          synced++;
          success = true;
          break;
        } catch (err: any) {
          action.retries = attempt + 1;

          // Non-retryable errors (client errors 4xx)
          const status = err?.status;
          if (status && status >= 400 && status < 500) {
            action.status = "failed";
            action.error = err?.message ?? "Request rejected by server.";
            await db.put(STORE_NAME, action);
            failed++;
            failedOccurrences.add(action.occurrenceId);
            break;
          }

          // Retryable: wait before next attempt (but not after the last)
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] ?? 5000));
          } else {
            action.status = "failed";
            action.error = err?.message ?? "Failed after retries.";
            await db.put(STORE_NAME, action);
            failed++;
            failedOccurrences.add(action.occurrenceId);
          }
        }
      }

      notifyListeners();

      // Pause between actions so the user can see the count tick down
      if (pending.indexOf(action) < pending.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  } finally {
    processing = false;
    // Clean up synced actions after a delay
    setTimeout(() => void clearSyncedActions(), 3000);
  }

  notifyListeners();
  return { synced, failed };
}

// ── Listener pattern for UI reactivity ──

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeQueue(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners() {
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
}
