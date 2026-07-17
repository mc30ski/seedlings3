"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Clock, Pause, Play, Check, X, AlertTriangle, Edit3, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { apiPost } from "@/src/lib/api";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  type WorkdayState,
  type WorkdayTodayPayload,
  type WorkdaySummary,
  type JobBlockingSummary,
  type EquipmentCheckoutSummary,
  type OpenMileageSummary,
  fetchWorkdayToday,
  startWorkday,
  pauseWorkday,
  resumeWorkday,
  reopenWorkday,
  endWorkday,
  cancelWorkday,
  editWorkdayTimes,
  activeMs,
  totalPausedMsLive,
  fmtDuration,
  fmtClockTime,
  fmtWorkdayDate,
  isoToLocal,
  localToIso,
} from "@/src/lib/workday";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { bizInstantFromEtParts, bizToday } from "@/src/lib/lib";
import { useOffline } from "@/src/lib/offline";
import { enqueueAction, type QueuedActionType } from "@/src/lib/offlineQueue";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";
import MileageStrip from "@/src/ui/components/MileageStrip";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

// ─────────────────────────────────────────────────────────────────────────
// Workday Hero strip + lifecycle dialogs.
//
// Mounts on Worker Home. Renders state-driven button row + the timestamped
// status line, and owns the Start / End / Edit / Forgot-yesterday dialog
// modals. Refetches on:
//   • initial mount
//   • window focus + visibility change (no polling — on-focus only)
//   • after every successful mutation
//
// Dialogs all share `ImpersonationWarningBlock` so an admin viewing-as a
// worker sees a callout before any action lands. The page-level
// ImpersonationBanner is separate and covers the rest of the UI; this
// inline block is for the moment-of-action context.
// ─────────────────────────────────────────────────────────────────────────

type DialogMode =
  // Pre-flight confirmation shown when the worker taps Start with zero
  // jobs scheduled today. Confirm → opens the regular { kind: "start" }
  // datetime-picker dialog; cancel → bails out. Skipped entirely when at
  // least one job is on today's docket.
  | { kind: "confirmNoJobs" }
  | { kind: "start" }
  | { kind: "pause"; workday: WorkdaySummary }
  | { kind: "resume"; workday: WorkdaySummary }
  | { kind: "reopen"; workday: WorkdaySummary }
  | { kind: "end"; workday: WorkdaySummary; activeJobs: JobBlockingSummary[]; activeCheckouts: EquipmentCheckoutSummary[]; openMileageEntries: OpenMileageSummary[] }
  | { kind: "edit"; workday: WorkdaySummary }
  | { kind: "forgotPrior"; workday: WorkdaySummary }
  | { kind: "cancel"; workday: WorkdaySummary }
  | null;

/**
 * Props:
 *   viewAsUserId       — when set, the strip renders the workday for the
 *                        named worker instead of the caller's own data
 *                        (Admin / Super "viewing-as" on the Worker Home tab).
 *   viewAsDisplayName  — shown in the in-dialog warning so the actor sees
 *                        whose record they're about to mutate.
 *   canImpersonate     — true when the caller is Super. Server-side gate
 *                        is the source of truth (mutations 403 otherwise);
 *                        this prop hides the action buttons preemptively
 *                        so a non-Super admin sees a clean read-only view.
 */
// ─────────────────────────────────────────────────────────────────────────
// Cross-tab optimistic sync (offline).
// WorkdayStrip mounts on every Worker → Work tab (Home / Reminders / Jobs
// / Routes). When the worker mutates their workday offline, the active
// strip applies the change to its local React state — but switching to a
// sibling tab remounts that tab's strip and re-fetches from the SW cache,
// which still has the OLD state. To prevent a flicker back to the stale
// view, we mirror the optimistic payload to sessionStorage + dispatch a
// same-tab event. The mirror clears the moment a fresh online fetch
// lands (server is authoritative again).
//
// Scoped to the self-service path only — admin "view-as another worker"
// mutations are blocked offline anyway, so we never persist someone
// else's data under this key.
// ─────────────────────────────────────────────────────────────────────────
const OPTIMISTIC_PAYLOAD_KEY = "seedlings_workdayOptimisticPayload";
const OPTIMISTIC_EVENT = "seedlings:workday-optimistic";

function readOptimisticPayload(): WorkdayTodayPayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(OPTIMISTIC_PAYLOAD_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WorkdayTodayPayload;
  } catch {
    return null;
  }
}

function writeOptimisticPayload(payload: WorkdayTodayPayload) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(OPTIMISTIC_PAYLOAD_KEY, JSON.stringify(payload));
    window.dispatchEvent(new CustomEvent(OPTIMISTIC_EVENT, { detail: payload }));
  } catch {
    // quota / disabled storage — fail silently. The active strip still
    // has the optimistic update in React state; only cross-tab sync is
    // lost, which degrades gracefully to "stale until reconnect".
  }
}

function clearOptimisticPayload() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(OPTIMISTIC_PAYLOAD_KEY);
  } catch {
    // ignore
  }
}

type Props = {
  viewAsUserId?: string | null;
  viewAsDisplayName?: string | null;
  canImpersonate?: boolean;
  /** Suppress the default `mb={3}` on each state card. Use when the
   *  parent already provides spacing (e.g. a VStack with `gap`), to
   *  avoid doubling up the visual gap. */
  noBottomMargin?: boolean;
  /** Optional slot rendered INSIDE the workday card body when the card
   *  is expanded. Used by HomeTab to inject the MileageStrip content
   *  so workday + mileage feel like one integrated card — one border,
   *  one collapse gesture, one visual container. Hidden along with the
   *  rest of the body when the worker collapses the card. */
  mileageSlot?: React.ReactNode;
};

// ─────────────────────────────────────────────────────────────────────────
// Offline support: optimistic local state update for queued workday
// mutations. When a user starts/pauses/etc. their workday while offline,
// we apply the same state transition the server would do, so the UI
// reflects the change immediately. The action is then enqueued and
// replays against the real server when the device reconnects.
//
// The local IDs use a `local-<workdayDate>` prefix to make it obvious in
// audit logs and easy to grep for in case of bugs. They get replaced by
// the real server IDs on the next successful `fetchWorkdayToday`.
// ─────────────────────────────────────────────────────────────────────────

type WorkdayMutationType =
  | "START_WORKDAY"
  | "PAUSE_WORKDAY"
  | "RESUME_WORKDAY"
  | "END_WORKDAY"
  | "REOPEN_WORKDAY"
  | "CANCEL_WORKDAY";

function applyOptimisticWorkdayUpdate(
  payload: WorkdayTodayPayload,
  type: WorkdayMutationType,
  workdayDate: string,
  input?: { startedAt?: string | null; endedAt?: string | null; totalPausedMs?: number | null },
): WorkdayTodayPayload {
  const now = new Date().toISOString();
  switch (type) {
    case "START_WORKDAY": {
      const localWorkday: WorkdaySummary = {
        id: `local-${workdayDate}`,
        userId: "local",
        workdayDate,
        startedAt: input?.startedAt ?? now,
        endedAt: null,
        pausedAt: null,
        totalPausedMs: 0,
        approvedAt: null,
      };
      return { ...payload, today: { state: "IN_PROGRESS", workday: localWorkday } };
    }
    case "PAUSE_WORKDAY": {
      if (payload.today.state !== "IN_PROGRESS") return payload;
      return {
        ...payload,
        today: { state: "PAUSED", workday: { ...payload.today.workday, pausedAt: now } },
      };
    }
    case "RESUME_WORKDAY": {
      if (payload.today.state !== "PAUSED") return payload;
      const wd = payload.today.workday;
      const pauseStart = wd.pausedAt ? Date.parse(wd.pausedAt) : Date.now();
      const additionalPaused = Math.max(0, Date.now() - pauseStart);
      return {
        ...payload,
        today: {
          state: "IN_PROGRESS",
          workday: { ...wd, pausedAt: null, totalPausedMs: wd.totalPausedMs + additionalPaused },
        },
      };
    }
    case "END_WORKDAY": {
      if (payload.today.state === "NOT_STARTED") return payload;
      const wd = payload.today.workday;
      return {
        ...payload,
        today: {
          state: "COMPLETED",
          workday: {
            ...wd,
            startedAt: input?.startedAt ?? wd.startedAt,
            endedAt: input?.endedAt ?? now,
            pausedAt: null,
            totalPausedMs: input?.totalPausedMs ?? wd.totalPausedMs,
          },
        },
      };
    }
    case "REOPEN_WORKDAY": {
      if (payload.today.state !== "COMPLETED") return payload;
      const wd = payload.today.workday;
      const endTime = wd.endedAt ? Date.parse(wd.endedAt) : Date.now();
      const gap = Math.max(0, Date.now() - endTime);
      return {
        ...payload,
        today: {
          state: "IN_PROGRESS",
          workday: { ...wd, endedAt: null, totalPausedMs: wd.totalPausedMs + gap },
        },
      };
    }
    case "CANCEL_WORKDAY":
      return { ...payload, today: { state: "NOT_STARTED" } };
  }
}

export default function WorkdayStrip({
  viewAsUserId = null,
  viewAsDisplayName = null,
  canImpersonate = false,
  noBottomMargin = false,
  mileageSlot = null,
}: Props = {}) {
  // Stable opts object passed to every API call. `undefined` when not
  // viewing as someone else — the lib falls through to the self-service
  // path. The whole component re-derives these from the prop, no need
  // to memo for correctness; included for tidy referential equality.
  const asOpts = useMemo(
    () => (viewAsUserId ? { viewAsUserId } : undefined),
    [viewAsUserId],
  );
  const isViewingAs = !!viewAsUserId;
  const { isOffline } = useOffline();
  // Offline workday mutations only run for the self-service path (not
  // view-as). Admin "view as a worker" while offline is a niche flow and
  // the offline executor talks to the self-service endpoints, which would
  // mutate the WRONG user. Force online for that case.
  const canQueueOffline = isOffline && !isViewingAs;
  // Whether the actor is authorized to mutate. False for admin viewing
  // as a worker; they get a read-only view. The server is the actual
  // gate — this just trims confusing UI for them.
  const canAct = !isViewingAs || canImpersonate;

  // Seed initial payload from sessionStorage when present (self-service
  // only — view-as never reads cross-tab optimistic state). Survives
  // remounts triggered by Worker→Work tab switches so an offline
  // mutation made on Home doesn't flash back to NOT_STARTED when the
  // user navigates to Reminders/Jobs/Routes.
  const [payload, setPayload] = useState<WorkdayTodayPayload | null>(() => {
    return viewAsUserId ? null : readOptimisticPayload();
  });
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<DialogMode>(null);
  // Drives the live "X active" / "X paused" tick on the status line. We
  // don't recompute everything — just bump a counter that the render
  // reads through Date.now(). 1s cadence is enough; bumps stop when the
  // workday is completed.
  const [, setTick] = useState(0);

  // isOffline read via ref so `load` doesn't have to depend on it (the
  // ref always reflects current state; depending on the value would
  // re-fire every tab switch). When offline, the SW falls back to a
  // cached response if any; if it returns the 503 "offline" envelope,
  // we silently swallow the error — toast spam from 4 simultaneous
  // strip mounts (Home/Reminders/Jobs/Routes) is worse than no signal.
  const isOfflineRef = useRef(isOffline);
  isOfflineRef.current = isOffline;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchWorkdayToday(asOpts);
      // Offline-and-self-service: the SW likely served a stale cache.
      // If we have an optimistic payload from a prior offline mutation
      // in this tab, prefer it over the cache — otherwise the user sees
      // their just-tapped Start "reverse" on tab switch. View-as never
      // consumes the optimistic key (it belongs to a different worker).
      if (isOfflineRef.current && !viewAsUserId) {
        const opt = readOptimisticPayload();
        setPayload(opt ?? r);
      } else {
        // Online (or view-as): server response is authoritative. Clear
        // any leftover optimistic state — the queue has by now drained
        // (or will shortly) and the server reflects reality.
        setPayload(r);
        if (!viewAsUserId) clearOptimisticPayload();
      }
    } catch (err) {
      if (!isOfflineRef.current) {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Failed to load workday.", err),
        });
      }
    } finally {
      setLoading(false);
    }
  }, [asOpts, viewAsUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch on visibility/focus — covers the multi-device case without
  // polling.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  // Refetch when any workday mutation fires the bus event — covers the
  // start-job gate dialog (separate React tree, can't call our `load`
  // directly). Without this, the strip kept showing NOT_STARTED until a
  // hard refresh after the gate dialog started the workday.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("seedlings:workday-changed", onChanged);
    return () =>
      window.removeEventListener("seedlings:workday-changed", onChanged);
  }, [load]);

  // Same-tab optimistic broadcast — when another mounted WorkdayStrip
  // applies an offline mutation, it dispatches the new payload via
  // `seedlings:workday-optimistic`. Currently-mounted siblings (e.g. the
  // Home strip + the Jobs strip both visible briefly during a swipe)
  // update in lock-step. Late-mounters get the same data from
  // sessionStorage via the useState initializer above.
  useEffect(() => {
    if (viewAsUserId) return; // view-as never consumes self-service state
    const onOptimistic = (e: Event) => {
      const detail = (e as CustomEvent<WorkdayTodayPayload>).detail;
      if (detail) setPayload(detail);
    };
    window.addEventListener(OPTIMISTIC_EVENT, onOptimistic);
    return () => window.removeEventListener(OPTIMISTIC_EVENT, onOptimistic);
  }, [viewAsUserId]);

  // 1s tick while IN_PROGRESS or PAUSED so the duration text updates live.
  // Stops once the workday is COMPLETED to avoid a no-op render loop.
  const today = payload?.today;
  const needsTick = today?.state === "IN_PROGRESS" || today?.state === "PAUSED";
  useEffect(() => {
    if (!needsTick) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [needsTick]);

  // Cross-component event: other tabs can request the End Workday dialog
  // without duplicating its equipment / mileage cleanup logic. Currently
  // dispatched by the JobsTab "all jobs done for today — end your
  // workday?" nudge (see JobsTab CompleteJobDialog onCompleted). Only
  // fires the dialog when the workday is actually endable — silently
  // ignored otherwise so a stale event can't force an invalid state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      if (!payload) return;
      const today = payload.today;
      // Narrow to the two states that carry a `workday` in the union.
      if (today.state !== "IN_PROGRESS" && today.state !== "PAUSED") return;
      setDialog({
        kind: "end",
        workday: today.workday,
        activeJobs: payload.activeJobs,
        activeCheckouts: payload.activeCheckouts,
        openMileageEntries: payload.openMileageEntries ?? [],
      });
    };
    window.addEventListener("workdayStrip:openEndDialog", handler);
    return () => window.removeEventListener("workdayStrip:openEndDialog", handler);
  }, [payload]);

  // ── Action wrappers — all refetch after success. Inline-message errors
  // bubble through getErrorMessage so the user sees the server's reason
  // text (e.g. "End time can't be in the future"). ─────────────────────

  // ── Action wrappers — all close + refetch on success and PROPAGATE
  // errors to the dialog's local catch. We deliberately do NOT call
  // publishInlineMessage on error here: a toast over a centered dialog
  // is hidden on mobile. The dialog catches the throw and renders the
  // failure reason inline via DialogShell's inlineError strip. Success
  // toasts are still fine — at that point the dialog is gone.
  //
  // When offline + self-service path, the same handlers enqueue the
  // mutation through `enqueueAction` and apply an optimistic state
  // transition locally so the UI updates immediately. The queue replays
  // against the real server when the device reconnects. ────────

  // Synthetic per-day "entity id" used to group same-day workday
  // mutations in the offline queue. Matches the queue's failedOccurrences
  // skip semantic — if e.g. START_WORKDAY fails server-side, queued
  // PAUSE/END for the same day will be skipped instead of fanning out
  // confusing errors.
  const workdayEntityId = `workday:${bizToday()}`;

  async function enqueueWorkdayLocally(
    type: WorkdayMutationType,
    label: string,
    payloadBody: Record<string, unknown>,
    input?: { startedAt?: string | null; endedAt?: string | null; totalPausedMs?: number | null },
  ) {
    await enqueueAction(type as QueuedActionType, workdayEntityId, label, payloadBody);
    // Apply locally + mirror to sessionStorage + broadcast same-tab
    // event so any sibling WorkdayStrip (other Worker→Work tab) picks
    // up the change. Without this, navigating away and back showed the
    // stale SW-cached state.
    if (!payload) return;
    const next = applyOptimisticWorkdayUpdate(payload, type, bizToday(), input);
    setPayload(next);
    writeOptimisticPayload(next);
  }

  async function handleStart(input: { startedAt?: string | null }) {
    if (canQueueOffline) {
      await enqueueWorkdayLocally("START_WORKDAY", "Start workday", input, input);
      setDialog(null);
      publishInlineMessage({ type: "INFO", text: "Workday started (queued for sync)." });
      return;
    }
    await startWorkday(input, asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday started." });
  }

  async function handlePause() {
    if (canQueueOffline) {
      await enqueueWorkdayLocally("PAUSE_WORKDAY", "Pause workday", {});
      setDialog(null);
      publishInlineMessage({ type: "INFO", text: "Workday paused (queued for sync)." });
      return;
    }
    await pauseWorkday(asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday paused." });
  }

  async function handleResume() {
    if (canQueueOffline) {
      await enqueueWorkdayLocally("RESUME_WORKDAY", "Resume workday", {});
      setDialog(null);
      publishInlineMessage({ type: "INFO", text: "Workday resumed (queued for sync)." });
      return;
    }
    await resumeWorkday(asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday resumed." });
  }

  async function handleReopen() {
    if (canQueueOffline) {
      await enqueueWorkdayLocally("REOPEN_WORKDAY", "Continue workday", {});
      setDialog(null);
      publishInlineMessage({ type: "INFO", text: "Workday continued (queued for sync)." });
      return;
    }
    await reopenWorkday(asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday continued." });
  }

  async function handleEnd(input: {
    workdayId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  }) {
    if (canQueueOffline) {
      await enqueueWorkdayLocally("END_WORKDAY", "End workday", input as Record<string, unknown>, input);
      setDialog(null);
      publishInlineMessage({ type: "INFO", text: "Workday ended (queued for sync)." });
      return;
    }
    await endWorkday(input, asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday ended." });
  }

  async function handleEdit(
    workdayId: string,
    input: {
      startedAt?: string | null;
      endedAt?: string | null;
      totalPausedMs?: number | null;
    },
  ) {
    // Edit times intentionally NOT offline-queueable. The endpoint takes
    // a server-assigned `workdayId`; offline we may only have the
    // synthetic `local-…` placeholder. Falls back to the inline error
    // ("Failed to update") which the dialog renders.
    await editWorkdayTimes(workdayId, input, asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday times updated." });
  }

  async function handleCancel() {
    if (canQueueOffline) {
      await enqueueWorkdayLocally("CANCEL_WORKDAY", "Cancel workday", {});
      setDialog(null);
      publishInlineMessage({ type: "INFO", text: "Workday cancelled (queued for sync)." });
      return;
    }
    await cancelWorkday(asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday cancelled." });
  }

  // ── Render ────────────────────────────────────────────────────────────

  // While the first load is in flight, show a skeleton so the slot doesn't
  // pop in jarringly. Subsequent loads keep showing the prior state.
  const cardMb = noBottomMargin ? 0 : 3;
  if (!payload && loading) {
    return (
      <Card.Root variant="outline" mb={cardMb}>
        <Card.Body p={3}>
          <HStack gap={2}>
            <Spinner size="sm" />
            <Text fontSize="sm" color="fg.muted">Loading workday…</Text>
          </HStack>
        </Card.Body>
      </Card.Root>
    );
  }
  if (!payload) return null;

  return (
    <>
      {/* Cards wrapper — VStack owns the between-card spacing so the
          strip's trailing external spacing is fully controlled by
          `noBottomMargin`. Prior to this refactor each card had its
          own `mb={cardMb}` which double-counted with the parent
          VStack's gap on HomeTab, producing a visibly larger gap
          before the next sibling. Kept gap={3} internally to match
          the historic mb=3 look between forgot-yesterday + workday. */}
      <VStack align="stretch" gap={3} mb={cardMb}>
      {/* Forgot-yesterday — its own card so it doesn't inherit today's
          state-themed background. Workers MUST address this before
          starting today, so it gets its own attention-getting orange
          card above the workday strip. */}
      {payload.openPrior.length > 0 && (
        <Card.Root
          variant="outline"
          bg="orange.50"
          borderColor="orange.400"
          borderWidth="2px"
        >
          <Card.Body p={3}>
            <ForgotPriorRow
              openPrior={payload.openPrior}
              onOpen={(w) => setDialog({ kind: "forgotPrior", workday: w })}
            />
          </Card.Body>
        </Card.Root>
      )}

      {/* Today's workday card — visually distinct by state. NOT_STARTED
          gets the loudest treatment (it's the one thing the worker must
          do); IN_PROGRESS is blue (the "time / active work" color —
          green is reserved for money); PAUSED is amber to remind them
          the clock is stopped; COMPLETED dims back to a subtle gray
          (the work is done). Always noBottomMargin — the wrapping VStack
          above handles both internal spacing and trailing external mb. */}
      <WorkdayCard
        today={payload.today}
        viewAsName={viewAsDisplayName}
        canAct={canAct}
        noBottomMargin={true}
        mileageSlot={mileageSlot}
        // Defensive default — a pre-deploy cached `/api/me/workday/today`
        // response (served by the service worker when offline or stale)
        // will lack `todayJobs` since the field was added recently. Without
        // this fallback, accessing `payload.todayJobs.scheduled` in
        // WorkdayCard would crash. Safe to default to 0/0 — the pulse
        // logic just won't fire until the cache refreshes.
        todayJobs={payload.todayJobs ?? { scheduled: 0, remaining: 0 }}
        onStart={() => {
          // Pre-flight: if the worker has nothing scheduled today, surface
          // a confirm dialog so accidental morning taps don't silently
          // clock them in on a day off. Confirming drops through to the
          // regular Start datetime-picker dialog.
          const scheduled = payload.todayJobs?.scheduled ?? 0;
          if (scheduled === 0) {
            setDialog({ kind: "confirmNoJobs" });
            return;
          }
          setDialog({ kind: "start" });
        }}
        onPause={(w) => setDialog({ kind: "pause", workday: w })}
        onResume={(w) => setDialog({ kind: "resume", workday: w })}
        onReopen={(w) => setDialog({ kind: "reopen", workday: w })}
        onEnd={(w) =>
          setDialog({
            kind: "end",
            workday: w,
            activeJobs: payload.activeJobs,
            activeCheckouts: payload.activeCheckouts,
            openMileageEntries: payload.openMileageEntries ?? [],
          })
        }
        onEdit={(w) => setDialog({ kind: "edit", workday: w })}
        onCancel={(w) => setDialog({ kind: "cancel", workday: w })}
      />
      </VStack>

      {/* Dialogs — only one of these renders at a time. Each gets the
          viewAs name so the in-dialog impersonation block can call out
          whose record is about to be mutated. */}
      {/* Pre-flight: only fires when the worker has zero jobs scheduled
          today. Confirming drops through to the regular Start dialog so
          the worker can still backdate their start time if they want. */}
      {dialog?.kind === "confirmNoJobs" && (
        <ConfirmDialog
          open
          title="No jobs scheduled today"
          message={
            viewAsDisplayName
              ? `${viewAsDisplayName} has no jobs scheduled for today. Start the workday anyway?`
              : "You don't have any jobs scheduled for today. Start your workday anyway?"
          }
          warning="Workdays still need admin approval — this is just a quick check so you don't accidentally clock in on a day off."
          confirmLabel="Start workday"
          confirmColorPalette="orange"
          cancelLabel="Cancel"
          onConfirm={() => setDialog({ kind: "start" })}
          onCancel={() => setDialog(null)}
          viewAsName={viewAsDisplayName}
        />
      )}
      {dialog?.kind === "start" && (
        <StartWorkdayDialog
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={handleStart}
        />
      )}
      {dialog?.kind === "pause" && (
        <PauseWorkdayDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={handlePause}
        />
      )}
      {dialog?.kind === "resume" && (
        <ResumeWorkdayDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={handleResume}
        />
      )}
      {dialog?.kind === "reopen" && (
        <ReopenWorkdayDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={handleReopen}
        />
      )}
      {dialog?.kind === "end" && (
        <EndWorkdayDialog
          openMileageEntries={dialog.openMileageEntries}
          isViewingAs={isViewingAs}
          workday={dialog.workday}
          activeJobs={dialog.activeJobs}
          activeCheckouts={dialog.activeCheckouts}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={handleEnd}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditWorkdayDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={(input) => handleEdit(dialog.workday.id, input)}
        />
      )}
      {dialog?.kind === "forgotPrior" && (
        <ForgotPriorDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={(input) => handleEnd({ workdayId: dialog.workday.id, ...input })}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelWorkdayDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={handleCancel}
        />
      )}
    </>
  );
}

// ── Status / button rows ────────────────────────────────────────────────

function WorkdayCard({
  today,
  onStart,
  onPause,
  onResume,
  onReopen,
  onEnd,
  onEdit,
  onCancel,
  viewAsName,
  canAct,
  noBottomMargin = false,
  todayJobs,
  mileageSlot = null,
}: {
  today: WorkdayState;
  onStart: () => void;
  onPause: (w: WorkdaySummary) => void;
  onResume: (w: WorkdaySummary) => void;
  onReopen: (w: WorkdaySummary) => void;
  onEnd: (w: WorkdaySummary) => void;
  onEdit: (w: WorkdaySummary) => void;
  onCancel: (w: WorkdaySummary) => void;
  viewAsName?: string | null;
  canAct: boolean;
  noBottomMargin?: boolean;
  todayJobs: { scheduled: number; remaining: number };
  /** Rendered inside the card body of every expanded state so mileage
   *  lives inside the same border/background as the workday. Hidden on
   *  the collapsed row. */
  mileageSlot?: React.ReactNode;
}) {
  const cardMb = noBottomMargin ? 0 : 3;
  // Conditional pulse:
  //   NOT_STARTED → orange pulse only when the worker actually has work
  //     scheduled today. No pulse on days off so the card recedes.
  //   IN_PROGRESS → blue pulse only when they've completed everything
  //     scheduled today — a "you can clock out now" cue. Blue matches
  //     the state theme (see the state-color comment above).
  const pulseNotStarted = todayJobs.remaining > 0;
  const pulseInProgress = todayJobs.scheduled > 0 && todayJobs.remaining === 0;
  const orangePulseStyle = { animation: "seedlings-pulse-orange 2.5s ease-in-out infinite" } as const;
  // Renamed from `bluePulseStyle` — see globals.css and pages/index.tsx
  // header comment for the "money = green, time/work = blue" semantic.
  const bluePulseStyle = { animation: "seedlings-pulse-blue 2.5s ease-in-out infinite" } as const;
  // Collapse pref — persisted per-viewer (not per-worker) so it survives
  // reloads. Default expanded; the user opts in to compact mode.
  const [collapsed, setCollapsed] = usePersistedState<boolean>("workdayStripCollapsed", false);
  const toggleButton = (
    <Button
      size="xs"
      variant="ghost"
      aria-label={collapsed ? "Show full workday details" : "Collapse workday card"}
      title={collapsed ? "Expand" : "Collapse"}
      onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
      px={1}
      minW="auto"
    >
      {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
    </Button>
  );
  // Card-body-level click target: tapping any non-button surface inside
  // the card toggles collapse. Buttons + icon quick-action use
  // stopPropagation so the action fires WITHOUT also flipping collapse.
  const bodyClickProps = {
    cursor: "pointer" as const,
    onClick: () => setCollapsed(!collapsed),
  };
  // For expanded cards: pin the toggle to the top-right corner so it
  // doesn't get pushed to a new row when the action buttons wrap on
  // narrow screens. Each expanded Card.Root must be `position="relative"`
  // for this to anchor correctly.
  const cornerToggle = (
    <Box position="absolute" top="6px" right="6px" zIndex={1}>
      {toggleButton}
    </Box>
  );
  // Read-only banner — shown when the caller is viewing-as a worker
  // (Admin only; Super gets canAct = true). The card itself still
  // renders in full so admin can see the worker's current state for
  // review, but every action button is suppressed.
  const readOnlyBanner = !canAct && viewAsName ? (
    <Box
      mb={2}
      p={2}
      bg="gray.100"
      borderLeftWidth="3px"
      borderColor="gray.500"
      borderRadius="md"
    >
      <Text fontSize="xs" color="gray.800">
        <b>Read-only view.</b> Only Super can act on {viewAsName}'s workday on this tab.
      </Text>
    </Box>
  ) : null;

  // ── COLLAPSED ────────────────────────────────────────────────────────
  // One compact row per state: icon chip + summary text + the primary
  // quick action + a chevron to expand. Sub-actions (Pause, Cancel, Edit
  // times, etc.) are hidden behind the chevron so the card matches the
  // size of a job-card row.
  if (collapsed) {
    let bg = "gray.50", borderColor = "gray.300", iconBg = "gray.500";
    let icon: React.ReactNode = <CheckCircle2 size={18} />;
    let summary: React.ReactNode = "";
    let primary: React.ReactNode = null;
    // The icon doubles as a quick-tap target for the same default
    // action exposed by the primary button. Set both together so they
    // stay in sync. `null` = no default action (e.g. COMPLETED, or
    // read-only view).
    let primaryAction: (() => void) | null = null;
    let primaryActionLabel = "";
    if (today.state === "NOT_STARTED") {
      bg = "orange.50"; borderColor = "orange.400"; iconBg = "orange.500";
      icon = <Clock size={18} />;
      summary = viewAsName ? `${viewAsName} hasn't started` : "Start your workday";
      if (canAct) {
        primaryAction = onStart;
        primaryActionLabel = "Start workday";
      }
      // No explicit Start button on the collapsed row — tapping the
      // orange clock icon starts the workday. Keeps the row at
      // job-card height.
    } else if (today.state === "IN_PROGRESS") {
      bg = "blue.50"; borderColor = "blue.400"; iconBg = "blue.500";
      icon = <Clock size={18} />;
      const active = activeMs(today.workday);
      const allDone = pulseInProgress; // same condition that drives the pulse
      summary = `${viewAsName ? `${viewAsName} on the clock` : "On the clock"} · ${fmtDuration(active)}${allDone ? " · all jobs completed" : ""}`;
      if (canAct) {
        primaryAction = () => onEnd(today.workday);
        primaryActionLabel = "End workday";
      }
      // No explicit End button on the collapsed row — tapping the blue
      // clock icon ends the workday. Keeps the row at job-card height.
    } else if (today.state === "PAUSED") {
      bg = "yellow.50"; borderColor = "yellow.400"; iconBg = "yellow.500";
      icon = <Pause size={18} />;
      const pausedMs = totalPausedMsLive(today.workday);
      summary = `Paused · ${fmtDuration(pausedMs)}`;
      if (canAct) {
        primaryAction = () => onResume(today.workday);
        primaryActionLabel = "Resume workday";
      }
      // PAUSED collapsed row shows BOTH Resume (primary yellow) and End
      // (secondary blue outline) — the "take a break then decide to call
      // it a day" flow shouldn't require expanding the card. The End
      // dialog itself surfaces the paused-time warning so the worker
      // understands what gets counted before confirming.
      const pausedWorkday = today.workday;
      primary = primaryAction ? (
        <HStack gap={1} flexShrink={0}>
          <Button size="xs" colorPalette="yellow" onClick={(e) => { e.stopPropagation(); primaryAction!(); }}>
            <Play size={12} /> <Text ml={1}>Resume</Text>
          </Button>
          {canAct && (
            <Button
              size="xs"
              variant="outline"
              colorPalette="blue"
              onClick={(e) => { e.stopPropagation(); onEnd(pausedWorkday); }}
              title="End workday now (see warning about paused time)"
            >
              <Check size={12} /> <Text ml={1}>End</Text>
            </Button>
          )}
        </HStack>
      ) : null;
    } else if (today.state === "COMPLETED") {
      bg = "gray.50"; borderColor = "gray.300"; iconBg = "gray.500";
      icon = <CheckCircle2 size={18} />;
      const active = activeMs(today.workday);
      summary = `Workday complete · ${fmtDuration(active)}`;
      // Tap the icon to Edit times — the common case (worker realizing
      // their end-of-day time was off). The "Continue" mistake-recovery
      // action stays accessible via expand.
      if (canAct) {
        primaryAction = () => onEdit(today.workday);
        primaryActionLabel = "Edit times";
      }
    }
    const collapsedPulseStyle =
      today.state === "NOT_STARTED" && pulseNotStarted ? orangePulseStyle :
      today.state === "IN_PROGRESS" && pulseInProgress ? bluePulseStyle :
      undefined;
    return (
      <Card.Root
        variant="outline"
        bg={bg}
        borderColor={borderColor}
        mb={cardMb}
        style={collapsedPulseStyle}
      >
        <Card.Body p={2} {...bodyClickProps}>
          {readOnlyBanner}
          <HStack gap={2} align="center" wrap="nowrap">
            <Box
              bg={iconBg}
              color="white"
              p={1}
              borderRadius="full"
              flexShrink={0}
              cursor={primaryAction ? "pointer" : "default"}
              transition="all 0.15s"
              _hover={primaryAction ? { opacity: 0.85, transform: "scale(1.08)" } : undefined}
              onClick={primaryAction ? (e: React.MouseEvent) => {
                e.stopPropagation();
                primaryAction!();
              } : undefined}
              role={primaryAction ? "button" : undefined}
              tabIndex={primaryAction ? 0 : undefined}
              aria-label={primaryAction ? primaryActionLabel : undefined}
              title={primaryAction ? primaryActionLabel : undefined}
              onKeyDown={primaryAction ? (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  primaryAction!();
                }
              } : undefined}
            >
              {icon}
            </Box>
            <Text fontSize="sm" fontWeight="medium" flex="1" minW="0" lineClamp={1}>
              {summary}
            </Text>
            {primary}
            {/* Compact vehicle-quick-action button — a small car icon
                that opens a start/stop picker so a worker can toggle
                mileage tracking without expanding. Self-hides when the
                worker has no assigned vehicles + no open sessions.
                Suppressed while an admin is viewing another worker
                (viewAsName set) since the /me/vehicles endpoint returns
                the current viewer's vehicles, not the viewed worker's.

                stopPropagation wrapper: the compact picker Dialog uses
                a Portal, but React events STILL bubble through the
                React tree (not the DOM). Without this Box, clicking
                Cancel or a picker row inside the modal bubbles up to
                Card.Body's collapse-toggle onClick, silently expanding
                the workday section. */}
            {!viewAsName && (
              <Box onClick={(e) => e.stopPropagation()}>
                <MileageStrip compact />
              </Box>
            )}
            {toggleButton}
          </HStack>
          {/* Keep the mileage strip mounted even when collapsed — hidden
              via display:none rather than unmounted — so its fetched
              vehicles + open sessions survive the collapse/expand cycle.
              Matched-key Box wrappers in the expanded returns keep this
              same MileageStrip instance across state transitions. */}
          <Box key="mileage-slot" display="none">{mileageSlot}</Box>
        </Card.Body>
      </Card.Root>
    );
  }

  // ── NOT_STARTED ─────────────────────────────────────────────────────
  // The loudest state — orange card with a thicker border, larger icon
  // and CTA button so the worker can't miss the one thing they have to
  // do first.
  if (today.state === "NOT_STARTED") {
    return (
      <Card.Root
        variant="outline"
        bg="orange.50"
        borderColor="orange.400"
        borderWidth="2px"
        mb={cardMb}
        shadow="sm"
        position="relative"
        style={pulseNotStarted ? orangePulseStyle : undefined}
      >
        <Card.Body p={3} pr={9} {...bodyClickProps}>
          {readOnlyBanner}
          <VStack align="stretch" gap={2}>
            <HStack gap={3} align="center">
              <Box bg="orange.500" color="white" p={1.5} borderRadius="full" flexShrink={0}>
                <Clock size={18} />
              </Box>
              <VStack align="start" gap={0} flex="1" minW="0">
                <Text fontSize="sm" fontWeight="bold" color="orange.900">
                  {viewAsName ? `${viewAsName} hasn't started their workday` : "Start your workday"}
                </Text>
                <Text fontSize="xs" color="orange.800">
                  {viewAsName
                    ? "Required before they can begin any jobs. Start when they reach their first location."
                    : "Required before you can begin any jobs. Start when you reach your first location."}
                </Text>
              </VStack>
            </HStack>
            {canAct && (
              <HStack>
                <Button size="xs" colorPalette="orange" onClick={(e) => { e.stopPropagation(); onStart(); }}>
                  <Play size={12} /> <Text ml={1}>Start</Text>
                </Button>
              </HStack>
            )}
          </VStack>
          <Box key="mileage-slot" onClick={(e) => e.stopPropagation()}>{mileageSlot}</Box>
        </Card.Body>
        {cornerToggle}
      </Card.Root>
    );
  }

  // ── IN_PROGRESS ──────────────────────────────────────────────────────
  // Blue card with a soft pulse on the live indicator so the worker can
  // see at a glance "I'm on the clock right now." Blue (not green) to
  // preserve the "money = green, time/work = blue" semantic split.
  // Cancel sits to the right as a small ghost-link affordance for "I
  // tapped Start by mistake."
  if (today.state === "IN_PROGRESS") {
    const active = activeMs(today.workday);
    const paused = totalPausedMsLive(today.workday);
    return (
      <Card.Root
        variant="outline"
        bg="blue.50"
        borderColor="blue.400"
        borderWidth="2px"
        mb={cardMb}
        position="relative"
        style={pulseInProgress ? bluePulseStyle : undefined}
      >
        <Card.Body p={3} pr={9} {...bodyClickProps}>
          {readOnlyBanner}
          <VStack align="stretch" gap={2}>
            <HStack gap={3} align="center">
              <Box bg="blue.500" color="white" p={1.5} borderRadius="full" flexShrink={0}>
                <Clock size={18} />
              </Box>
              <VStack align="start" gap={0} flex="1" minW="0">
                <Text fontSize="sm" fontWeight="bold" color="blue.900">
                  {viewAsName ? `${viewAsName} is on the clock` : "On the clock"} · {fmtDuration(active)} active
                  {pulseInProgress && " · all jobs completed"}
                </Text>
                <Text fontSize="xs" color="blue.800">
                  Started at {fmtClockTime(today.workday.startedAt)}
                  {paused > 0 && ` · ${fmtDuration(paused)} paused so far`}
                </Text>
              </VStack>
            </HStack>
            {canAct && (
              <HStack gap={2} wrap="wrap">
                <Button size="xs" colorPalette="blue" onClick={(e) => { e.stopPropagation(); onEnd(today.workday); }}>
                  <Check size={14} strokeWidth={3} /> <Text ml={1}>Complete</Text>
                </Button>
                <Button size="xs" colorPalette="yellow" onClick={(e) => { e.stopPropagation(); onPause(today.workday); }}>
                  <Pause size={12} /> <Text ml={1}>Pause</Text>
                </Button>
                <Button size="xs" colorPalette="red" onClick={(e) => { e.stopPropagation(); onCancel(today.workday); }}>
                  <X size={12} /> <Text ml={1}>Cancel</Text>
                </Button>
              </HStack>
            )}
          </VStack>
          <Box key="mileage-slot" onClick={(e) => e.stopPropagation()}>{mileageSlot}</Box>
        </Card.Body>
        {cornerToggle}
      </Card.Root>
    );
  }

  // ── PAUSED ───────────────────────────────────────────────────────────
  // Yellow/amber card — visually distinct from green so the worker can
  // see at a glance the clock is paused. Resume is the primary CTA;
  // Cancel still available.
  if (today.state === "PAUSED") {
    const active = activeMs(today.workday);
    const paused = totalPausedMsLive(today.workday);
    return (
      <Card.Root
        variant="outline"
        bg="yellow.50"
        borderColor="yellow.400"
        borderWidth="2px"
        mb={cardMb}
        position="relative"
      >
        <Card.Body p={3} pr={9} {...bodyClickProps}>
          {readOnlyBanner}
          <VStack align="stretch" gap={2}>
            <HStack gap={3} align="center">
              <Box bg="yellow.500" color="white" p={1.5} borderRadius="full" flexShrink={0}>
                <Pause size={18} />
              </Box>
              <VStack align="start" gap={0} flex="1" minW="0">
                <Text fontSize="sm" fontWeight="bold" color="yellow.900">
                  {viewAsName ? `${viewAsName}'s workday paused` : "Workday paused"} · {fmtDuration(paused)} paused
                </Text>
                <Text fontSize="xs" color="yellow.800">
                  Paused at {fmtClockTime(today.workday.pausedAt!)} · {fmtDuration(active)} active so far
                </Text>
              </VStack>
            </HStack>
            {canAct && (
              <HStack gap={2} wrap="wrap">
                <Button size="xs" colorPalette="blue" onClick={(e) => { e.stopPropagation(); onEnd(today.workday); }}>
                  <Check size={14} strokeWidth={3} /> <Text ml={1}>Complete</Text>
                </Button>
                <Button size="xs" colorPalette="yellow" onClick={(e) => { e.stopPropagation(); onResume(today.workday); }}>
                  <Play size={12} /> <Text ml={1}>Resume</Text>
                </Button>
                <Button size="xs" colorPalette="red" onClick={(e) => { e.stopPropagation(); onCancel(today.workday); }}>
                  <X size={12} /> <Text ml={1}>Cancel</Text>
                </Button>
              </HStack>
            )}
          </VStack>
          <Box key="mileage-slot" onClick={(e) => e.stopPropagation()}>{mileageSlot}</Box>
        </Card.Body>
        {cornerToggle}
      </Card.Root>
    );
  }

  // ── COMPLETED ───────────────────────────────────────────────────────
  // Subtle gray — the work is done. Smaller / less prominent so it
  // recedes into the background.
  const active = activeMs(today.workday);
  const paused = today.workday.totalPausedMs;
  return (
    <Card.Root variant="outline" bg="gray.50" mb={cardMb} position="relative">
      <Card.Body p={3} pr={9} {...bodyClickProps}>
        {readOnlyBanner}
        <VStack align="stretch" gap={2}>
          <HStack gap={3} align="center">
            <Box bg="gray.500" color="white" p={1.5} borderRadius="full" flexShrink={0}>
              <CheckCircle2 size={18} />
            </Box>
            <VStack align="start" gap={0} flex="1" minW="0">
              <Text fontSize="sm" fontWeight="medium">
                {viewAsName ? `${viewAsName}'s workday complete` : "Workday complete"} · {fmtDuration(active)} active
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {fmtClockTime(today.workday.startedAt)}
                {today.workday.endedAt && ` – ${fmtClockTime(today.workday.endedAt)}`}
                {paused > 0 && ` · ${fmtDuration(paused)} paused`}
              </Text>
            </VStack>
          </HStack>
          {canAct && (
            <HStack gap={2} wrap="wrap">
              <Button size="xs" bg="gray.400" color="white" _hover={{ bg: "gray.500" }} onClick={(e) => { e.stopPropagation(); onEdit(today.workday); }}>
                <Edit3 size={12} /> <Text ml={1}>Edit times</Text>
              </Button>
              {/* "Continue" — for ending the workday by mistake. Server adds
                  the gap between endedAt and now to totalPausedMs so the
                  off-the-clock interval doesn't count as payable hours. */}
              <Button size="xs" colorPalette="blue" onClick={(e) => { e.stopPropagation(); onReopen(today.workday); }}>
                <Play size={12} /> <Text ml={1}>Continue</Text>
              </Button>
            </HStack>
          )}
        </VStack>
        <Box key="mileage-slot">{mileageSlot}</Box>
      </Card.Body>
      {cornerToggle}
    </Card.Root>
  );
}

function ForgotPriorRow({
  openPrior,
  onOpen,
}: {
  openPrior: WorkdaySummary[];
  onOpen: (w: WorkdaySummary) => void;
}) {
  const oldest = openPrior[0];
  return (
    <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
      <HStack gap={2} align="center" wrap="wrap">
        <AlertTriangle size={16} color="var(--chakra-colors-orange-600)" />
        <Text fontSize="sm" color="orange.900" flex="1" minW={0}>
          You didn't end your workday on <b>{fmtWorkdayDate(oldest.workdayDate)}</b>.
          {openPrior.length > 1 && (
            <Text as="span" color="orange.700">
              {" "}({openPrior.length - 1} more after this)
            </Text>
          )}
        </Text>
        <Button size="sm" colorPalette="orange" onClick={() => onOpen(oldest)}>
          Set end time
        </Button>
      </HStack>
    </Box>
  );
}

// ── Dialogs ─────────────────────────────────────────────────────────────

// Local alias — keeps existing usages working while sharing the
// implementation with the rest of the app via ImpersonationWarning.
const ImpersonationWarningBlock = ImpersonationWarning;

function DialogShell({
  open,
  title,
  children,
  footer,
  onClose,
  viewAsName,
  inlineError,
  onDismissInlineError,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
  viewAsName?: string | null;
  /** Inline error from the dialog's own confirm action. Renders as a red
   *  alert strip between the body and the footer, so on mobile (where a
   *  bottom-anchored toast would be hidden behind a centered dialog) the
   *  user still sees the failure reason without leaving the dialog. */
  inlineError?: string | null;
  /** Optional close-x on the error strip — pass when the error is
   *  recoverable (most cases). Omit if the only path is to dismiss the
   *  dialog. */
  onDismissInlineError?: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => { if (!e.open) onClose(); }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ImpersonationWarningBlock viewAsName={viewAsName} />
              {children}
            </Dialog.Body>
            {inlineError && (
              <Box
                mt={2}
                mb={1}
                p={2}
                bg="red.50"
                borderWidth="1px"
                borderColor="red.300"
                borderRadius="md"
                role="alert"
              >
                <HStack gap={2} align="start">
                  <Box color="red.600" flexShrink={0} mt="2px">
                    <AlertTriangle size={14} />
                  </Box>
                  <Text fontSize="sm" color="red.900" flex="1">
                    {inlineError}
                  </Text>
                  {onDismissInlineError && (
                    <Button
                      size="xs"
                      variant="ghost"
                      colorPalette="red"
                      onClick={onDismissInlineError}
                      px={2}
                      minW="auto"
                    >
                      ×
                    </Button>
                  )}
                </HStack>
              </Box>
            )}
            <Dialog.Footer>{footer}</Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function StartWorkdayDialog({
  onClose,
  onConfirm,
  viewAsName,
}: {
  onClose: () => void;
  onConfirm: (input: { startedAt?: string | null }) => Promise<void>;
  viewAsName?: string | null;
}) {
  const [startedAt, setStartedAt] = useState(() => isoToLocal(new Date().toISOString()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      // Empty input → server uses "now". Allows the simple case of "just
      // start me right now" without the worker needing to confirm the
      // pre-filled timestamp.
      const iso = localToIso(startedAt);
      await onConfirm({ startedAt: iso ?? null });
    } catch (err) {
      setError(getErrorMessage("Failed to start.", err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell
      open
      title="Start workday"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button colorPalette="orange" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Start workday"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={2}>
        <Text fontSize="sm">
          When did you start? You can backdate to earlier today if you forgot to check in.
        </Text>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Started at</Text>
          <input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
      </VStack>
    </DialogShell>
  );
}

const MILEAGE_DEFAULT_NOTE = "Using vehicle to service lawns";

function EndWorkdayDialog({
  workday,
  activeJobs,
  activeCheckouts,
  openMileageEntries,
  isViewingAs,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  activeJobs: JobBlockingSummary[];
  activeCheckouts: EquipmentCheckoutSummary[];
  openMileageEntries: OpenMileageSummary[];
  /** True when Admin/Super is viewing-as another worker. Mileage stop
   *  is worker-side (`/me/mileage/...`), so we can't close the
   *  worker's sessions on their behalf from here — we show a warning
   *  instead. */
  isViewingAs: boolean;
  onClose: () => void;
  viewAsName?: string | null;
  onConfirm: (input: {
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  }) => Promise<void>;
}) {
  const initialPausedMin = useMemo(() => {
    const paused = totalPausedMsLive(workday);
    return Math.round(paused / 60000);
  }, [workday]);
  const [startedAt, setStartedAt] = useState(isoToLocal(workday.startedAt));
  const [endedAt, setEndedAt] = useState(isoToLocal(new Date().toISOString()));
  const [pausedMin, setPausedMin] = useState(initialPausedMin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-open-session inputs. Keys are the mileage entry id.
  // Only used in the self-service path — for view-as we display a
  // warning without inputs.
  // Track which open sessions have been canceled inline. Canceling
  // deletes the session server-side and drops it from `visibleOpen`
  // below — the End Workday flow then no longer requires an ending
  // odometer for it. Handles the "picked wrong vehicle, want to cancel
  // and just end my workday" case without forcing the worker to
  // out-of-band navigate to the Mileage strip first.
  const [canceledIds, setCanceledIds] = useState<Set<string>>(() => new Set());
  const [canceling, setCanceling] = useState<string | null>(null);
  const visibleOpen = openMileageEntries.filter((e) => !canceledIds.has(e.id));
  async function cancelMileageInline(entryId: string, vehicleName: string) {
    if (!window.confirm(
      `Cancel the ${vehicleName} session? This deletes the session — no miles will be recorded.`,
    )) return;
    setCanceling(entryId);
    try {
      await apiPost(`/api/me/mileage/${entryId}/cancel`, {});
      setCanceledIds((prev) => {
        const next = new Set(prev);
        next.add(entryId);
        return next;
      });
    } catch (err) {
      setError(getErrorMessage("Couldn't cancel session.", err));
    } finally {
      setCanceling(null);
    }
  }

  const [mileageInputs, setMileageInputs] = useState<Record<string, { endOdometer: string; notes: string }>>(
    () => {
      const seed: Record<string, { endOdometer: string; notes: string }> = {};
      for (const e of openMileageEntries) {
        seed[e.id] = { endOdometer: "", notes: MILEAGE_DEFAULT_NOTE };
      }
      return seed;
    },
  );

  const canCloseMileage = !isViewingAs && visibleOpen.length > 0;
  const mileageValid = !canCloseMileage
    ? true
    : visibleOpen.every((e) => {
        const raw = mileageInputs[e.id]?.endOdometer ?? "";
        if (!/^\d+$/.test(raw.trim())) return false;
        return Number(raw) >= e.startOdometer;
      });

  const liveActive = useMemo(() => {
    const startMs = Date.parse(localToIso(startedAt) ?? workday.startedAt);
    const endMs = Date.parse(localToIso(endedAt) ?? new Date().toISOString());
    const ms = endMs - startMs - pausedMin * 60000;
    return Math.max(0, ms);
  }, [startedAt, endedAt, pausedMin, workday.startedAt]);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      // Close every open mileage session first. If any fail, bail out
      // before ending the workday so the worker can retry.
      if (canCloseMileage) {
        const stopCalls = await Promise.allSettled(
          visibleOpen.map((e) =>
            apiPost(`/api/me/mileage/${e.id}/stop`, {
              endOdometer: Number(mileageInputs[e.id]?.endOdometer),
              notes: mileageInputs[e.id]?.notes || null,
            }),
          ),
        );
        const stopFailed = stopCalls.filter((s) => s.status === "rejected");
        if (stopFailed.length > 0) {
          throw new Error(
            `${stopFailed.length} mileage session${stopFailed.length === 1 ? "" : "s"} couldn't be closed. Check the odometer values and try again.`,
          );
        }
      }
      await onConfirm({
        startedAt: localToIso(startedAt),
        endedAt: localToIso(endedAt),
        totalPausedMs: pausedMin * 60000,
      });
    } catch (err) {
      setError(getErrorMessage("Failed to end.", err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell
      open
      title="End workday"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button
            colorPalette="blue"
            onClick={() => void submit()}
            disabled={saving || !mileageValid}
            title={
              !mileageValid
                ? "Enter valid ending odometer for every open mileage session"
                : undefined
            }
          >
            {saving
              ? <Spinner size="xs" />
              : canCloseMileage
                ? "Stop mileage & end workday"
                : "End anyway"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={3}>
        {/* Paused-when-ending warning — surfaces the semantics of
            ending mid-pause so workers don't lose track of what
            counts. The server closes the open pause segment into
            totalPausedMs at end time (endWorkday in services/workdays
            handles this), which for a mid-pause end means the entire
            paused-since → end-time window is unpaid. Workers arriving
            here from the "I'll just call it a day" flow need to see
            that in plain English before confirming. */}
        {workday.pausedAt && (
          <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.400" borderRadius="md">
            <Text fontSize="xs" color="orange.900" fontWeight="semibold" mb={1}>
              Your workday is currently paused.
            </Text>
            <Text fontSize="xs" color="orange.900">
              You paused at <b>{fmtClockTime(workday.pausedAt)}</b>. Ending now
              will lock in that pause — the time between
              {" "}<b>{fmtClockTime(workday.pausedAt)}</b> and the end time below
              will count as <b>unpaid pause</b>, not active work.
            </Text>
            <Text fontSize="xs" color="orange.900" mt={1}>
              If you meant to keep working, tap <b>Cancel</b> and hit <b>Resume</b> first.
            </Text>
          </Box>
        )}
        {/* Soft warnings — never block, just inform. */}
        {activeJobs.length > 0 && (
          <Box p={2} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" borderRadius="md">
            <Text fontSize="xs" color="yellow.900" mb={1} fontWeight="semibold">
              You still have these jobs active:
            </Text>
            <VStack align="stretch" gap={0.5}>
              {activeJobs.map((j) => (
                <Text key={j.occurrenceId} fontSize="xs" color="yellow.900">
                  • {j.title || j.propertyName || "(untitled)"}
                  {j.clientName && ` — ${j.clientName}`}
                  {" "}<Badge size="xs" colorPalette={j.status === "PAUSED" ? "orange" : "blue"} variant="subtle">{j.status.toLowerCase()}</Badge>
                </Text>
              ))}
            </VStack>
            <Text fontSize="xs" color="yellow.800" mt={1} fontStyle="italic">
              End or pause those before ending your workday so the job times stay accurate.
            </Text>
          </Box>
        )}

        {activeCheckouts.length > 0 && (
          <Box p={2} bg="blue.50" borderWidth="1px" borderColor="blue.300" borderRadius="md">
            <Text fontSize="xs" color="blue.900" mb={1} fontWeight="semibold">
              You still have equipment checked out:
            </Text>
            <VStack align="stretch" gap={0.5}>
              {activeCheckouts.map((c) => (
                <Text key={c.checkoutId} fontSize="xs" color="blue.900">
                  • {[c.brand, c.model].filter(Boolean).join(" ") || c.shortDesc || "(unnamed)"}
                </Text>
              ))}
            </VStack>
            <Text fontSize="xs" color="blue.800" mt={1} fontStyle="italic">
              That's fine if you're keeping it across days. Otherwise return it before ending.
            </Text>
          </Box>
        )}

        {/* Open mileage sessions — worker enters end odometer per
            vehicle before the workday can end. Each row corresponds
            to a MileageEntry; submit closes them in parallel via the
            existing per-entry stop endpoint. When the actor is
            viewing-as another worker (admin/super), we can only warn
            — the stop endpoint is worker-side (`/me/mileage/...`)
            and doesn't accept impersonation. */}
        {openMileageEntries.length > 0 && isViewingAs && (
          <Box p={2} bg="orange.50" borderWidth="1px" borderColor="orange.300" borderRadius="md">
            <Text fontSize="xs" color="orange.900" mb={1} fontWeight="semibold">
              {viewAsName ?? "They"} still {openMileageEntries.length === 1 ? "has" : "have"} {openMileageEntries.length} open mileage session{openMileageEntries.length === 1 ? "" : "s"}:
            </Text>
            <VStack align="stretch" gap={0.5}>
              {openMileageEntries.map((e) => (
                <Text key={e.id} fontSize="xs" color="orange.900">
                  • {e.vehicleName} (started at {e.startOdometer.toLocaleString()} mi)
                </Text>
              ))}
            </VStack>
            <Text fontSize="xs" color="orange.800" mt={1} fontStyle="italic">
              Have {viewAsName ?? "the worker"} close these on their MileageStrip, or edit them on the Vehicles tab.
            </Text>
          </Box>
        )}
        {visibleOpen.length > 0 && !isViewingAs && (
          <Box p={2} bg="teal.50" borderWidth="1px" borderColor="teal.300" borderRadius="md">
            <Text fontSize="xs" color="teal.900" mb={2} fontWeight="semibold">
              Record ending odometer{visibleOpen.length === 1 ? "" : "s"}:
            </Text>
            <Text fontSize="2xs" color="teal.800" mb={2} fontStyle="italic">
              Picked the wrong vehicle? Tap "Cancel session" below to delete it — you can then end the workday and start a new mileage session with the right vehicle.
            </Text>
            <VStack align="stretch" gap={2}>
              {visibleOpen.map((e) => {
                const state = mileageInputs[e.id] ?? { endOdometer: "", notes: MILEAGE_DEFAULT_NOTE };
                const num = Number(state.endOdometer);
                const isValid =
                  /^\d+$/.test(state.endOdometer.trim()) && num >= e.startOdometer;
                const showErr = state.endOdometer.trim().length > 0 && !isValid;
                return (
                  <Box
                    key={e.id}
                    p={2}
                    bg="white"
                    borderWidth="1px"
                    borderColor="teal.200"
                    borderRadius="md"
                  >
                    <Text fontSize="xs" fontWeight="semibold" color="teal.900" mb={1}>
                      {e.vehicleName}
                    </Text>
                    <Text fontSize="2xs" color="fg.muted" mb={1}>
                      Started at {e.startOdometer.toLocaleString()} mi
                    </Text>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder={`≥ ${e.startOdometer.toLocaleString()}`}
                      value={state.endOdometer}
                      onChange={(ev) =>
                        setMileageInputs((prev) => ({
                          ...prev,
                          [e.id]: {
                            ...state,
                            endOdometer: ev.target.value.replace(/[^\d]/g, ""),
                          },
                        }))
                      }
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        fontSize: "14px",
                        border: showErr
                          ? "1px solid var(--chakra-colors-red-400)"
                          : "1px solid var(--chakra-colors-gray-200)",
                        borderRadius: "6px",
                        marginBottom: 4,
                      }}
                    />
                    {showErr && (
                      <Text fontSize="2xs" color="red.600" mb={1}>
                        Must be a whole number, at least {e.startOdometer.toLocaleString()}.
                      </Text>
                    )}
                    <input
                      type="text"
                      placeholder={MILEAGE_DEFAULT_NOTE}
                      value={state.notes}
                      onChange={(ev) =>
                        setMileageInputs((prev) => ({
                          ...prev,
                          [e.id]: {
                            ...state,
                            notes: ev.target.value,
                          },
                        }))
                      }
                      style={{
                        width: "100%",
                        padding: "6px 8px",
                        fontSize: "13px",
                        border: "1px solid var(--chakra-colors-gray-200)",
                        borderRadius: "6px",
                      }}
                    />
                    {isValid && (
                      <Text fontSize="2xs" color="teal.800" mt={1}>
                        {(num - e.startOdometer).toLocaleString()} mi this session
                      </Text>
                    )}
                    <HStack justify="flex-end" mt={1}>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => void cancelMileageInline(e.id, e.vehicleName)}
                        loading={canceling === e.id}
                        disabled={saving}
                        title="Cancel this session — deletes it without recording miles"
                      >
                        <X size={12} />
                        <Text ml={1} fontSize="2xs">Cancel session</Text>
                      </Button>
                    </HStack>
                  </Box>
                );
              })}
            </VStack>
          </Box>
        )}

        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Started at</Text>
          <input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Ended at</Text>
          <input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Paused (minutes)</Text>
          <input
            type="number"
            min={0}
            value={pausedMin}
            onChange={(e) => setPausedMin(Math.max(0, Number(e.target.value) || 0))}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <HStack justify="space-between" pt={1} borderTopWidth="1px" borderColor="gray.200">
          <Text fontSize="sm" fontWeight="semibold">Active total</Text>
          <Text fontSize="sm" fontWeight="semibold">{fmtDuration(liveActive)}</Text>
        </HStack>
      </VStack>
    </DialogShell>
  );
}

function EditWorkdayDialog({
  workday,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  viewAsName?: string | null;
  onClose: () => void;
  onConfirm: (input: {
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  }) => Promise<void>;
}) {
  const initialPausedMin = useMemo(
    () => Math.round((workday.totalPausedMs ?? 0) / 60000),
    [workday.totalPausedMs],
  );
  const [startedAt, setStartedAt] = useState(isoToLocal(workday.startedAt));
  const [endedAt, setEndedAt] = useState(isoToLocal(workday.endedAt));
  const [pausedMin, setPausedMin] = useState(initialPausedMin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveActive = useMemo(() => {
    const startMs = Date.parse(localToIso(startedAt) ?? workday.startedAt);
    const endMs = Date.parse(localToIso(endedAt) ?? workday.endedAt ?? new Date().toISOString());
    const ms = endMs - startMs - pausedMin * 60000;
    return Math.max(0, ms);
  }, [startedAt, endedAt, pausedMin, workday.startedAt, workday.endedAt]);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      await onConfirm({
        startedAt: localToIso(startedAt),
        endedAt: localToIso(endedAt),
        totalPausedMs: pausedMin * 60000,
      });
    } catch (err) {
      setError(getErrorMessage("Failed to update.", err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell
      open
      title="Edit workday times"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button colorPalette="blue" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Save"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={3}>
        <Text fontSize="xs" color="fg.muted">
          Same-day edits only. Tomorrow this goes through admin approval.
        </Text>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Started at</Text>
          <input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Ended at</Text>
          <input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Paused (minutes)</Text>
          <input
            type="number"
            min={0}
            value={pausedMin}
            onChange={(e) => setPausedMin(Math.max(0, Number(e.target.value) || 0))}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <HStack justify="space-between" pt={1} borderTopWidth="1px" borderColor="gray.200">
          <Text fontSize="sm" fontWeight="semibold">Active total</Text>
          <Text fontSize="sm" fontWeight="semibold">{fmtDuration(liveActive)}</Text>
        </HStack>
      </VStack>
    </DialogShell>
  );
}

function ForgotPriorDialog({
  workday,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  viewAsName?: string | null;
  onClose: () => void;
  onConfirm: (input: {
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  }) => Promise<void>;
}) {
  // Default endedAt to 5 PM ET on the workday's date — sensible "normal
  // end of day" placeholder; worker edits if it was different. Uses the
  // canonical helper so the DST offset is computed correctly regardless
  // of the operator's device timezone.
  const defaultEndIso = useMemo(
    () => bizInstantFromEtParts(workday.workdayDate, "17:00"),
    [workday.workdayDate],
  );

  const initialPausedMin = useMemo(
    () => Math.round((workday.totalPausedMs ?? 0) / 60000),
    [workday.totalPausedMs],
  );
  const [startedAt, setStartedAt] = useState(isoToLocal(workday.startedAt));
  const [endedAt, setEndedAt] = useState(isoToLocal(defaultEndIso));
  const [pausedMin, setPausedMin] = useState(initialPausedMin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveActive = useMemo(() => {
    const startMs = Date.parse(localToIso(startedAt) ?? workday.startedAt);
    const endMs = Date.parse(localToIso(endedAt) ?? defaultEndIso);
    const ms = endMs - startMs - pausedMin * 60000;
    return Math.max(0, ms);
  }, [startedAt, endedAt, pausedMin, workday.startedAt, defaultEndIso]);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      await onConfirm({
        startedAt: localToIso(startedAt),
        endedAt: localToIso(endedAt),
        totalPausedMs: pausedMin * 60000,
      });
    } catch (err) {
      setError(getErrorMessage("Failed to end.", err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell
      open
      title={`End workday for ${fmtWorkdayDate(workday.workdayDate)}`}
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button colorPalette="orange" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Save end time"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={3}>
        <Text fontSize="xs" color="fg.muted">
          You didn't end your workday on {fmtWorkdayDate(workday.workdayDate)}. Set the end time so
          we can close it out. Default is 5:00 PM — edit if you ended at a different time.
        </Text>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Started at</Text>
          <input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Ended at</Text>
          <input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <Box>
          <Text fontSize="xs" color="fg.muted" mb={1}>Paused (minutes)</Text>
          <input
            type="number"
            min={0}
            value={pausedMin}
            onChange={(e) => setPausedMin(Math.max(0, Number(e.target.value) || 0))}
            style={{
              width: "100%",
              padding: "6px 8px",
              fontSize: "14px",
              border: "1px solid var(--chakra-colors-gray-200)",
              borderRadius: "6px",
            }}
          />
        </Box>
        <HStack justify="space-between" pt={1} borderTopWidth="1px" borderColor="gray.200">
          <Text fontSize="sm" fontWeight="semibold">Active total</Text>
          <Text fontSize="sm" fontWeight="semibold">{fmtDuration(liveActive)}</Text>
        </HStack>
      </VStack>
    </DialogShell>
  );
}

function CancelWorkdayDialog({
  workday,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  viewAsName?: string | null;
}) {
  const startedDuration = useMemo(
    () => fmtDuration(activeMs(workday)),
    [workday],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setError(null);
    setSaving(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(getErrorMessage("Cancel failed.", err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogShell
      open
      title="Cancel this workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Keep workday</Button>
          <Button colorPalette="red" onClick={() => void confirm()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Cancel workday"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={2}>
        <Text fontSize="sm">
          This will <b>delete</b> your workday started at {fmtClockTime(workday.startedAt)}
          {" "}({startedDuration} so far). The record won't be saved.
        </Text>
        <Box p={2} bg="blue.50" borderWidth="1px" borderColor="blue.300" borderRadius="md">
          <Text fontSize="xs" color="blue.900">
            <b>If you meant to start at a different time</b>, end the workday instead and use Edit
            times to fix it — you'll keep the record.
          </Text>
        </Box>
      </VStack>
    </DialogShell>
  );
}

function PauseWorkdayDialog({
  workday,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  viewAsName?: string | null;
}) {
  const activeSoFar = useMemo(
    () => fmtDuration(activeMs(workday)),
    [workday],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setError(null);
    setSaving(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(getErrorMessage("Pause failed.", err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogShell
      open
      title="Pause workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Keep going</Button>
          <Button colorPalette="yellow" onClick={() => void confirm()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Pause workday"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={2}>
        <Text fontSize="sm">
          The clock will stop until {viewAsName ? "they" : "you"} resume.{" "}
          {activeSoFar} active so far.
        </Text>
        <Text fontSize="xs" color="fg.muted">
          Use Pause for breaks, lunch, or interruptions. Use End workday when {viewAsName ? "they're" : "you're"} done for the day.
        </Text>
      </VStack>
    </DialogShell>
  );
}

function ResumeWorkdayDialog({
  workday,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  viewAsName?: string | null;
}) {
  const pausedSoFar = useMemo(
    () => fmtDuration(totalPausedMsLive(workday)),
    [workday],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setError(null);
    setSaving(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(getErrorMessage("Resume failed.", err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogShell
      open
      title="Resume workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Stay paused</Button>
          <Button colorPalette="yellow" onClick={() => void confirm()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Resume workday"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={2}>
        <Text fontSize="sm">
          The clock will start again from this moment. Paused for {pausedSoFar} so far.
        </Text>
      </VStack>
    </DialogShell>
  );
}

function ReopenWorkdayDialog({
  workday,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  viewAsName?: string | null;
}) {
  // Live gap between the bad endedAt and now — what the server will add to
  // totalPausedMs so the off-the-clock interval doesn't count toward hours.
  // Cheap useState + interval; this dialog only renders for a moment so a
  // re-render-per-second is fine.
  const [now, setNow] = useState<number>(() => Date.parse(workday.endedAt!));
  useEffect(() => {
    setNow(Date.parse(new Date().toISOString()));
    const id = setInterval(
      () => setNow(Date.parse(new Date().toISOString())),
      1000,
    );
    return () => clearInterval(id);
  }, []);
  const gapMs = Math.max(0, now - Date.parse(workday.endedAt!));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setError(null);
    setSaving(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(getErrorMessage("Couldn't continue workday.", err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <DialogShell
      open
      title="Continue workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      inlineError={error}
      onDismissInlineError={() => setError(null)}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Stay ended</Button>
          <Button colorPalette="blue" onClick={() => void confirm()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "Continue workday"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={2}>
        <Text fontSize="sm">
          You ended at <b>{fmtClockTime(workday.endedAt!)}</b>. If that was a mistake,
          continue your workday now — the <b>{fmtDuration(gapMs)}</b> between then and
          now will be recorded as a pause so it doesn't count toward your hours.
        </Text>
        <Text fontSize="xs" color="fg.muted">
          Once an admin has approved this workday, or the same-day edit window has
          closed, you'll have to ask an admin to re-open it.
        </Text>
      </VStack>
    </DialogShell>
  );
}
