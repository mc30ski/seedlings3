// Sync Status panel for the Documents tab — Super-only.
//
// Shows: enabled/disabled state, health rollup, queue depth, last
// successful sync timestamp, recent failures. Provides:
//   - Enable / Disable toggle (updates DOCUMENT_SYNC_ENABLED setting)
//   - Force Sync Now button
//   - Backfill button (enqueue tasks for every existing doc + version)
//
// See docs/features/documents-gdrive-backup.md.

import { useCallback, useEffect, useState } from "react";
import { Box, Button, HStack, Text, VStack, Badge, IconButton, Spinner } from "@chakra-ui/react";
import { RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { fmtDate, fmtTimeOpts } from "@/src/lib/lib";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

type Props = {
  // Bump this from the parent to force a status re-fetch — e.g. after
  // any doc create/update/delete/version-upload that would enqueue tasks.
  refreshNonce?: number;
};

type PendingTask = {
  id: string;
  taskType: string;
  documentId: string | null;
  versionId: string | null;
  state: "PENDING" | "IN_PROGRESS";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  documentTitle: string | null;
  documentType: string | null;
  documentArchived: boolean;
  documentDescription: string | null;
  documentAdminHidden: boolean | null;
  documentExpiresAt: string | null;
  documentCurrentVersionId: string | null;
  documentVersionCount: number | null;
  versionOriginalFilename: string | null;
  versionSizeBytes: number | null;
  versionContentType: string | null;
  versionUploadedAt: string | null;
  payloadTitle: string | null;
  payloadVersionCount: number | null;
};

type SyncStatus = {
  enabled: boolean;
  health: "green" | "amber" | "red";
  counts: { pending: number; inProgress: number; failing: number; terminated: number };
  oldestPendingAt: string | null;
  lastSuccessAt: string | null;
  recentFailures: Array<{
    id: string;
    taskType: string;
    documentId: string | null;
    attempts: number;
    lastError: string | null;
    nextAttemptAt: string;
  }>;
};

type FailedTask = Omit<PendingTask, "nextAttemptAt" | "state"> & {
  state: "FAILED";
  updatedAt: string;
};

const HEALTH_COLORS = {
  green: { bg: "green.100", label: "Healthy" },
  amber: { bg: "yellow.100", label: "Backlog" },
  red: { bg: "red.100", label: "Failing" },
};

function friendlyTaskType(t: string): string {
  switch (t) {
    case "SYNC_DOCUMENT_METADATA": return "Sync metadata";
    case "UPLOAD_DOCUMENT_VERSION": return "Upload version";
    case "DELETE_DOCUMENT_VERSION": return "Delete version";
    case "MOVE_TO_DELETED": return "Move to _deleted";
    case "SYNC_TAXONOMY": return "Sync taxonomy";
    default: return t;
  }
}

function fmtBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Task-type-specific detail line rendered under the header/badges row.
 * Metadata task = current state snapshot (title, hidden, expiresAt, version count).
 * Upload/Delete = version filename + size.
 * Move to deleted = payload-captured title (doc is gone from DB).
 * Sync taxonomy = static.
 */
function TaskDetail({ task }: { task: PendingTask | FailedTask }) {
  const parts: string[] = [];
  switch (task.taskType) {
    case "SYNC_DOCUMENT_METADATA": {
      if (task.documentArchived) parts.push("archived");
      if (task.documentAdminHidden) parts.push("admin-hidden");
      if (task.documentExpiresAt) parts.push(`expires ${fmtDate(task.documentExpiresAt)}`);
      if (task.documentVersionCount != null) {
        parts.push(`${task.documentVersionCount} version${task.documentVersionCount === 1 ? "" : "s"}`);
      }
      if (task.documentDescription) parts.push(`"${task.documentDescription.slice(0, 60)}${task.documentDescription.length > 60 ? "…" : ""}"`);
      break;
    }
    case "UPLOAD_DOCUMENT_VERSION": {
      if (task.versionOriginalFilename) parts.push(task.versionOriginalFilename);
      if (task.versionSizeBytes != null) parts.push(fmtBytes(task.versionSizeBytes));
      if (task.versionContentType) parts.push(task.versionContentType);
      if (task.versionUploadedAt) parts.push(`uploaded ${fmtDate(task.versionUploadedAt)}`);
      if (task.documentCurrentVersionId === task.versionId) parts.push("current version");
      break;
    }
    case "DELETE_DOCUMENT_VERSION": {
      if (task.versionOriginalFilename) parts.push(task.versionOriginalFilename);
      if (task.versionSizeBytes != null) parts.push(fmtBytes(task.versionSizeBytes));
      break;
    }
    case "MOVE_TO_DELETED": {
      if (task.payloadTitle) parts.push(`was "${task.payloadTitle}"`);
      if (task.payloadVersionCount != null) parts.push(`had ${task.payloadVersionCount} version${task.payloadVersionCount === 1 ? "" : "s"}`);
      break;
    }
    case "SYNC_TAXONOMY": {
      parts.push("rewrites _taxonomy.json at Drive root");
      break;
    }
  }
  if (parts.length === 0) return null;
  return (
    <Text fontSize="2xs" color="fg.muted" lineClamp={2}>
      {parts.join(" · ")}
    </Text>
  );
}

export default function DocumentSyncStatusPanel({ refreshNonce = 0 }: Props) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"toggle" | "sync" | "backfill" | null>(null);
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  // Backlog disclosure — lazy-load the full pending list only when
  // the operator expands it. Cached across nonce bumps until close.
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [backlog, setBacklog] = useState<PendingTask[] | null>(null);
  const [backlogLoading, setBacklogLoading] = useState(false);
  // Same for the terminal-failed section.
  const [failedOpen, setFailedOpen] = useState(false);
  const [failedList, setFailedList] = useState<FailedTask[] | null>(null);
  const [failedLoading, setFailedLoading] = useState(false);
  // Per-task in-flight action so we can disable a row while its
  // Retry/Dismiss request is round-tripping.
  const [taskBusyId, setTaskBusyId] = useState<string | null>(null);
  // Dismiss uses a confirmation dialog. Different message per task
  // type — UPLOAD is red (actual backup data loss); the rest are amber
  // (cosmetic drift only).
  const [dismissTarget, setDismissTarget] = useState<PendingTask | FailedTask | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await apiGet<SyncStatus>("/api/super/documents/sync/status");
      setStatus(s);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load sync status.", err),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on mount + whenever the parent bumps the nonce (i.e. any
  // successful doc mutation over on the DocumentsTab, which enqueues
  // tasks that we want to reflect immediately).
  useEffect(() => { void load(); }, [load, refreshNonce]);

  // Auto-poll while the server is actively processing tasks. Covers
  // the case where the operator refreshed the browser mid-sync — local
  // `busy` state is gone, but the worker is still churning server-side.
  // Stops as soon as inProgress drops to 0.
  const serverInProgress = status?.counts.inProgress ?? 0;
  useEffect(() => {
    if (serverInProgress === 0) return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [serverInProgress, load]);

  const loadBacklog = useCallback(async () => {
    setBacklogLoading(true);
    try {
      const rows = await apiGet<PendingTask[]>("/api/super/documents/sync/pending");
      setBacklog(rows);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load backlog.", err),
      });
    } finally {
      setBacklogLoading(false);
    }
  }, []);

  const loadFailed = useCallback(async () => {
    setFailedLoading(true);
    try {
      const rows = await apiGet<FailedTask[]>("/api/super/documents/sync/failed");
      setFailedList(rows);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load failed tasks.", err),
      });
    } finally {
      setFailedLoading(false);
    }
  }, []);

  // Keep the open backlog + failed lists AND the status header in sync
  // with the same nonce — all three come from the same DB snapshot so
  // an operator never sees a mismatch (e.g. header says "13 pending"
  // but the expanded list is empty because the worker finished between
  // the two fetches).
  useEffect(() => {
    if (backlogOpen && failedOpen) {
      void Promise.all([load(), loadBacklog(), loadFailed()]);
    } else if (backlogOpen) {
      void Promise.all([load(), loadBacklog()]);
    } else if (failedOpen) {
      void Promise.all([load(), loadFailed()]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce, backlogOpen, failedOpen]);

  async function retryTask(taskId: string) {
    setTaskBusyId(taskId);
    try {
      await apiPost(`/api/super/documents/sync/tasks/${taskId}/retry`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: "Task queued for immediate retry — hit Force sync to run it now.",
      });
      await load();
      if (backlogOpen) await loadBacklog();
      if (failedOpen) await loadFailed();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Retry failed.", err),
      });
    } finally {
      setTaskBusyId(null);
    }
  }

  async function dismissTask(taskId: string) {
    setTaskBusyId(taskId);
    try {
      await apiPost(`/api/super/documents/sync/tasks/${taskId}/dismiss`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: "Task dismissed (moved to Failed). It won't be retried unless you click Retry on it.",
      });
      await load();
      if (backlogOpen) await loadBacklog();
      if (failedOpen) await loadFailed();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Dismiss failed.", err),
      });
    } finally {
      setTaskBusyId(null);
      setDismissTarget(null);
    }
  }

  // Confirm dialog copy varies by task type — see the dependency-model
  // discussion above the file for why UPLOAD is treated as data-loss
  // and the rest as cosmetic drift.
  function dismissDialogCopy(task: PendingTask | FailedTask): {
    title: string;
    message: string;
    warning?: string;
    palette: string;
  } {
    const docLabel = task.documentTitle ? ` (${task.documentTitle})` : "";
    switch (task.taskType) {
      case "UPLOAD_DOCUMENT_VERSION":
        return {
          title: "Dismiss upload — backup data loss?",
          message: `This is an UPLOAD_DOCUMENT_VERSION task${docLabel}. Dismissing means this specific version's file will NEVER reach Google Drive.`,
          warning:
            "If the underlying issue is fixed, use Retry instead. If you truly need this version dismissed, you can later re-sync it by clicking Sync everything (which re-queues uploads for any version missing from Drive).",
          palette: "red",
        };
      case "SYNC_DOCUMENT_METADATA":
        return {
          title: "Dismiss metadata sync?",
          message: `This is a SYNC_DOCUMENT_METADATA task${docLabel}. Drive's _document.json for this doc will stay at its last-synced snapshot until the next edit re-enqueues a metadata sync.`,
          palette: "orange",
        };
      case "DELETE_DOCUMENT_VERSION":
        return {
          title: "Dismiss version delete?",
          message: `This is a DELETE_DOCUMENT_VERSION task${docLabel}. The version's file will stay in Drive even though it's been deleted from the app. Cosmetic clutter; no app-side data loss.`,
          palette: "orange",
        };
      case "MOVE_TO_DELETED":
        return {
          title: "Dismiss doc-deleted move?",
          message: `This is a MOVE_TO_DELETED task${docLabel}. The doc's folder will stay in the live taxonomy tree in Drive instead of moving to _deleted/. Cosmetic; no app-side data loss.`,
          palette: "orange",
        };
      case "SYNC_TAXONOMY":
        return {
          title: "Dismiss taxonomy sync?",
          message:
            "This is a SYNC_TAXONOMY task. Drive's _taxonomy.json will stay stale until the next DOCUMENT_TYPES settings save re-enqueues it.",
          palette: "orange",
        };
      default:
        return {
          title: "Dismiss task?",
          message: `Dismiss ${task.taskType}. This task will move to Failed and never retry unless you Restore it.`,
          palette: "orange",
        };
    }
  }

  async function toggleEnabled() {
    if (!status) return;
    setBusy("toggle");
    try {
      const next = status.enabled ? "false" : "true";
      await apiPatch("/api/admin/settings/DOCUMENT_SYNC_ENABLED", { value: next });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Drive sync ${next === "true" ? "enabled" : "disabled"}.`,
      });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to update sync setting.", err),
      });
    } finally {
      setBusy(null);
    }
  }

  async function forceSync() {
    setBusy("sync");
    try {
      const result = await apiPost<{
        processed: number;
        succeeded: number;
        failed: number;
        skipped: number;
        errors: Array<{ taskId: string; taskType: string; error: string }>;
      }>("/api/super/documents/sync/run", { maxTasks: 100 });
      const parts = [
        `${result.succeeded} succeeded`,
        result.skipped ? `${result.skipped} skipped` : null,
        result.failed ? `${result.failed} failed` : null,
      ].filter(Boolean).join(", ");
      publishInlineMessage({
        type: result.failed > 0 ? "WARNING" : "SUCCESS",
        text: result.processed === 0
          ? "Nothing to sync — queue is empty."
          : `Processed ${result.processed} task${result.processed === 1 ? "" : "s"}: ${parts}.`,
      });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Force sync failed.", err),
      });
    } finally {
      setBusy(null);
    }
  }

  async function runBackfill() {
    // Close the confirm dialog immediately — the two API calls below
    // can take many seconds if there's a lot to push. Leaving the
    // dialog open with no loading indicator makes the whole thing look
    // hung. Panel button's loading={busy === "backfill"} + the info
    // toast below carry the feedback from here.
    setConfirmBackfill(false);
    setBusy("backfill");
    publishInlineMessage({
      type: "INFO",
      text: "Syncing — checking every document, then pushing missing ones to Drive…",
    });
    try {
      // Two-step under the hood: enqueue every missing task, then
      // immediately drain the queue. From the operator's POV it's a
      // single "Sync everything" action.
      const backfill = await apiPost<{ enqueued: number; docCount: number }>(
        "/api/super/documents/sync/backfill",
        {},
      );
      const sync = await apiPost<{
        processed: number;
        succeeded: number;
        failed: number;
        skipped: number;
      }>("/api/super/documents/sync/run", { maxTasks: 500 });
      const parts = [
        `${sync.succeeded} succeeded`,
        sync.skipped ? `${sync.skipped} skipped` : null,
        sync.failed ? `${sync.failed} failed` : null,
      ].filter(Boolean).join(", ");
      publishInlineMessage({
        type: sync.failed > 0 ? "WARNING" : "SUCCESS",
        text: backfill.enqueued === 0
          ? "Everything is already in sync — nothing to do."
          : `Queued ${backfill.enqueued} task${backfill.enqueued === 1 ? "" : "s"} across ${backfill.docCount} document${backfill.docCount === 1 ? "" : "s"}, then processed: ${parts}.`,
      });
      await load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Sync everything failed.", err),
      });
    } finally {
      setBusy(null);
    }
  }

  if (!status) {
    return loading ? (
      <Box p={3} mb={3} borderRadius="md" bg="gray.50" borderWidth={1}>
        <Text fontSize="sm" color="fg.muted">Loading sync status…</Text>
      </Box>
    ) : null;
  }

  const health = HEALTH_COLORS[status.health];
  const totalPending = status.counts.pending + status.counts.inProgress;
  // "Something is actively syncing right now" — combines local action
  // state (this browser fired a Sync everything / Force sync) with
  // server-reported in-progress tasks (a different browser / an earlier
  // pre-refresh session may have started work that's still running).
  const isSyncing = busy === "sync" || busy === "backfill" || serverInProgress > 0;

  return (
    <>
      <Box p={3} mb={3} borderRadius="md" bg="gray.50" borderWidth={1}>
        <HStack justify="space-between" wrap="wrap" gap={2}>
          <HStack gap={3} wrap="wrap">
            <HStack gap={2}>
              <Text fontSize="sm" fontWeight="semibold">Drive backup</Text>
              {isSyncing ? (
                <Badge bg="blue.100" px={2}>
                  <HStack gap={1}>
                    <Spinner size="xs" borderWidth="2px" />
                    <Text as="span">Syncing…</Text>
                  </HStack>
                </Badge>
              ) : (
                <Badge bg={health.bg} px={2}>
                  {status.enabled ? health.label : "Disabled"}
                </Badge>
              )}
            </HStack>
            <Text fontSize="xs" color="fg.muted">
              {totalPending === 0
                ? (status.counts.terminated > 0 ? "Pending drained" : "Queue drained")
                : `${totalPending} pending${status.counts.inProgress > 0 ? ` (${status.counts.inProgress} in progress)` : ""}`}
              {status.counts.failing > 0 ? ` · ${status.counts.failing} retrying` : ""}
              {status.counts.terminated > 0 ? ` · ${status.counts.terminated} failed` : ""}
            </Text>
            {status.lastSuccessAt && (
              <Text fontSize="xs" color="fg.muted">
                Last sync {fmtDate(status.lastSuccessAt)}
              </Text>
            )}
          </HStack>
          <HStack gap={2}>
            <IconButton
              aria-label="Refresh sync status"
              size="xs"
              variant="ghost"
              onClick={() => void load()}
              loading={loading}
              disabled={isSyncing || busy !== null}
            >
              <RefreshCw size={12} />
            </IconButton>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void toggleEnabled()}
              loading={busy === "toggle"}
              disabled={isSyncing || busy !== null}
              title={isSyncing ? "Wait for the current sync to finish" : undefined}
            >
              {status.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setConfirmBackfill(true)}
              // Show the spinner whenever ANY sync is running — local
              // action or server-side (post-refresh, cron, etc.). Both
              // action buttons share the indicator so an operator who
              // clicked Force sync sees Sync-everything spin too.
              loading={isSyncing}
              loadingText="Syncing…"
              disabled={isSyncing || !status.enabled}
              title={!status.enabled
                ? "Enable sync first"
                : "Queue every document + version that isn't already in Drive, then push them"}
            >
              Sync everything
            </Button>
            <Button
              size="xs"
              onClick={() => void forceSync()}
              loading={isSyncing}
              loadingText="Syncing…"
              disabled={isSyncing || !status.enabled || totalPending === 0}
            >
              Force sync
            </Button>
          </HStack>
        </HStack>
        {status.recentFailures.length > 0 && (
          <VStack align="stretch" gap={1} mt={2} pt={2} borderTopWidth={1} borderColor="gray.200">
            <Text fontSize="xs" fontWeight="semibold" color="red.700">
              Recent failures ({status.recentFailures.length}):
            </Text>
            {status.recentFailures.slice(0, 3).map((f) => (
              <Text key={f.id} fontSize="xs" color="fg.muted" lineClamp={1}>
                {f.taskType} · attempts {f.attempts} · {f.lastError ?? "(no error message)"}
              </Text>
            ))}
          </VStack>
        )}
        {status.counts.terminated > 0 && (
          <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.200">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setFailedOpen((v) => !v)}
              px={1}
              css={{ color: "var(--chakra-colors-red-700)" }}
            >
              {failedOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              <Text as="span" ml={1} fontSize="xs" fontWeight="semibold">
                {failedOpen ? "Hide" : "Show"} {status.counts.terminated} failed task{status.counts.terminated === 1 ? "" : "s"}
              </Text>
            </Button>
            {failedOpen && (
              <VStack align="stretch" gap={1} mt={2}>
                {failedLoading && <Text fontSize="xs" color="fg.muted">Loading…</Text>}
                {!failedLoading && failedList && failedList.length === 0 && (
                  <Text fontSize="xs" color="fg.muted">No failed tasks.</Text>
                )}
                {!failedLoading && failedList?.map((task) => (
                  <HStack
                    key={task.id}
                    justify="space-between"
                    align="start"
                    gap={2}
                    p={1.5}
                    borderWidth={1}
                    borderColor="red.200"
                    borderRadius="sm"
                    bg="red.50"
                  >
                    <VStack align="start" gap={0} flex={1} minW={0}>
                      <HStack gap={2} wrap="wrap">
                        <Text fontSize="xs" fontWeight="semibold">
                          {friendlyTaskType(task.taskType)}
                        </Text>
                        <Badge size="xs" bg="red.100">
                          {task.attempts} attempt{task.attempts === 1 ? "" : "s"}
                        </Badge>
                      </HStack>
                      <Text fontSize="2xs" color="fg.muted" lineClamp={1}>
                        {task.documentTitle
                          ? `${task.documentTitle}${task.documentArchived ? " (archived)" : ""}`
                          : task.taskType === "SYNC_TAXONOMY"
                            ? "(document types taxonomy)"
                            : "(no document)"}
                      </Text>
                      <TaskDetail task={task} />
                      {task.lastError && (
                        <Text fontSize="2xs" color="red.700" lineClamp={3}>
                          {task.lastError}
                        </Text>
                      )}
                      <Text fontSize="2xs" color="fg.muted">
                        Failed {fmtDate(task.updatedAt)}
                      </Text>
                    </VStack>
                    <HStack gap={1} flexShrink={0}>
                      <Button
                        size="2xs"
                        variant="outline"
                        onClick={() => void retryTask(task.id)}
                        disabled={taskBusyId !== null}
                        loading={taskBusyId === task.id}
                        title="Restore to Pending — worker will retry from scratch"
                      >
                        Restore
                      </Button>
                    </HStack>
                  </HStack>
                ))}
              </VStack>
            )}
          </Box>
        )}
        {totalPending > 0 && (
          <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.200">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setBacklogOpen((v) => !v)}
              px={1}
              css={{ color: "var(--chakra-colors-fg-muted)" }}
            >
              {backlogOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              <Text as="span" ml={1} fontSize="xs">
                {backlogOpen ? "Hide" : "Show"} {totalPending} pending task{totalPending === 1 ? "" : "s"}
              </Text>
            </Button>
            {backlogOpen && (
              <VStack align="stretch" gap={1} mt={2}>
                {backlogLoading && (
                  <Text fontSize="xs" color="fg.muted">Loading…</Text>
                )}
                {!backlogLoading && backlog && backlog.length === 0 && (
                  <Text fontSize="xs" color="fg.muted">Queue is empty.</Text>
                )}
                {!backlogLoading && backlog?.map((task) => {
                  const nextAttempt = new Date(task.nextAttemptAt);
                  const isBackedOff = nextAttempt.getTime() > Date.now();
                  return (
                    <HStack
                      key={task.id}
                      justify="space-between"
                      align="start"
                      gap={2}
                      p={1.5}
                      borderWidth={1}
                      borderColor="gray.200"
                      borderRadius="sm"
                      bg={task.state === "IN_PROGRESS" ? "blue.50" : "white"}
                    >
                      <VStack align="start" gap={0} flex={1} minW={0}>
                        <HStack gap={2} wrap="wrap">
                          <Text fontSize="xs" fontWeight="semibold">
                            {friendlyTaskType(task.taskType)}
                          </Text>
                          {task.state === "IN_PROGRESS" && (
                            <Badge size="xs" bg="blue.100">running</Badge>
                          )}
                          {task.attempts > 0 && (
                            <Badge size="xs" bg={task.attempts >= 3 ? "red.100" : "yellow.100"}>
                              {task.attempts} attempt{task.attempts === 1 ? "" : "s"}
                            </Badge>
                          )}
                        </HStack>
                        <Text fontSize="2xs" color="fg.muted" lineClamp={1}>
                          {task.documentTitle
                            ? `${task.documentTitle}${task.documentArchived ? " (archived)" : ""}`
                            : task.taskType === "SYNC_TAXONOMY"
                              ? "(document types taxonomy)"
                              : "(no document)"}
                        </Text>
                        <TaskDetail task={task} />
                        {task.lastError && (
                          <Text fontSize="2xs" color="red.700" lineClamp={2}>
                            Last error: {task.lastError}
                          </Text>
                        )}
                        {isBackedOff && (
                          <Text fontSize="2xs" color="orange.700">
                            Backed off until {fmtDate(task.nextAttemptAt)} {fmtTimeOpts(task.nextAttemptAt, { hour: "numeric", minute: "2-digit" })}
                          </Text>
                        )}
                      </VStack>
                      <HStack gap={1} flexShrink={0}>
                        {task.state === "PENDING" && task.attempts >= 1 && (
                          <Button
                            size="2xs"
                            variant="outline"
                            onClick={() => void retryTask(task.id)}
                            disabled={taskBusyId !== null}
                            loading={taskBusyId === task.id}
                            title="Reset attempts and clear backoff so the next worker run picks it up"
                          >
                            Retry now
                          </Button>
                        )}
                        {task.state === "PENDING" && (
                          <Button
                            size="2xs"
                            variant="outline"
                            colorPalette="red"
                            onClick={() => setDismissTarget(task)}
                            disabled={taskBusyId !== null}
                            title={task.attempts === 0
                              ? "Cancel this task before it runs"
                              : "Move to Failed — worker won't retry unless you Restore"}
                          >
                            {task.attempts === 0 ? "Cancel" : "Dismiss"}
                          </Button>
                        )}
                      </HStack>
                    </HStack>
                  );
                })}
              </VStack>
            )}
          </Box>
        )}
      </Box>
      <ConfirmDialog
        open={confirmBackfill}
        title="Sync everything?"
        message="This makes sure every document and version currently in the app is also in Drive — pushing anything that's missing. Skips items that are already synced. Safe to run anytime."
        confirmLabel="Sync everything"
        onConfirm={() => void runBackfill()}
        onCancel={() => setConfirmBackfill(false)}
      />
      {dismissTarget && (() => {
        const copy = dismissDialogCopy(dismissTarget);
        return (
          <ConfirmDialog
            open={true}
            title={copy.title}
            message={copy.message}
            warning={copy.warning}
            confirmLabel="Dismiss"
            confirmColorPalette={copy.palette}
            onConfirm={() => void dismissTask(dismissTarget.id)}
            onCancel={() => setDismissTarget(null)}
          />
        );
      })()}
    </>
  );
}
