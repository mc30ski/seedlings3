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
import { Clock, Pause, Play, AlertTriangle, Edit3 } from "lucide-react";
import {
  type WorkdayState,
  type WorkdayTodayPayload,
  type WorkdaySummary,
  type JobBlockingSummary,
  type EquipmentCheckoutSummary,
  fetchWorkdayToday,
  startWorkday,
  pauseWorkday,
  resumeWorkday,
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
import { bizInstantFromEtParts } from "@/src/lib/lib";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";

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
  | { kind: "start" }
  | { kind: "pause"; workday: WorkdaySummary }
  | { kind: "resume"; workday: WorkdaySummary }
  | { kind: "end"; workday: WorkdaySummary; activeJobs: JobBlockingSummary[]; activeCheckouts: EquipmentCheckoutSummary[] }
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
type Props = {
  viewAsUserId?: string | null;
  viewAsDisplayName?: string | null;
  canImpersonate?: boolean;
};

export default function WorkdayStrip({
  viewAsUserId = null,
  viewAsDisplayName = null,
  canImpersonate = false,
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
  // Whether the actor is authorized to mutate. False for admin viewing
  // as a worker; they get a read-only view. The server is the actual
  // gate — this just trims confusing UI for them.
  const canAct = !isViewingAs || canImpersonate;

  const [payload, setPayload] = useState<WorkdayTodayPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<DialogMode>(null);
  // Drives the live "X active" / "X paused" tick on the status line. We
  // don't recompute everything — just bump a counter that the render
  // reads through Date.now(). 1s cadence is enough; bumps stop when the
  // workday is completed.
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchWorkdayToday(asOpts);
      setPayload(r);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load workday.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [asOpts]);

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

  // 1s tick while IN_PROGRESS or PAUSED so the duration text updates live.
  // Stops once the workday is COMPLETED to avoid a no-op render loop.
  const today = payload?.today;
  const needsTick = today?.state === "IN_PROGRESS" || today?.state === "PAUSED";
  useEffect(() => {
    if (!needsTick) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [needsTick]);

  // ── Action wrappers — all refetch after success. Inline-message errors
  // bubble through getErrorMessage so the user sees the server's reason
  // text (e.g. "End time can't be in the future"). ─────────────────────

  async function handleStart(input: { startedAt?: string | null }) {
    await startWorkday(input, asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday started." });
  }

  async function handlePause() {
    await pauseWorkday(asOpts);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday paused." });
  }

  async function handleResume() {
    await resumeWorkday(asOpts);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday resumed." });
  }

  async function handleEnd(input: {
    workdayId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    totalPausedMs?: number | null;
  }) {
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
    await editWorkdayTimes(workdayId, input, asOpts);
    setDialog(null);
    void load();
    publishInlineMessage({ type: "SUCCESS", text: "Workday times updated." });
  }

  async function handleCancel() {
    try {
      await cancelWorkday(asOpts);
      setDialog(null);
      void load();
      publishInlineMessage({ type: "SUCCESS", text: "Workday cancelled." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Cancel failed.", err) });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  // While the first load is in flight, show a skeleton so the slot doesn't
  // pop in jarringly. Subsequent loads keep showing the prior state.
  if (!payload && loading) {
    return (
      <Card.Root variant="outline" mb={3}>
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
          mb={3}
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
          do); IN_PROGRESS is reassuring green; PAUSED is amber to remind
          them the clock is stopped; COMPLETED dims back to a subtle gray
          (the work is done). */}
      <WorkdayCard
        today={payload.today}
        viewAsName={viewAsDisplayName}
        canAct={canAct}
        onStart={() => setDialog({ kind: "start" })}
        onPause={(w) => setDialog({ kind: "pause", workday: w })}
        onResume={(w) => setDialog({ kind: "resume", workday: w })}
        onEnd={(w) =>
          setDialog({
            kind: "end",
            workday: w,
            activeJobs: payload.activeJobs,
            activeCheckouts: payload.activeCheckouts,
          })
        }
        onEdit={(w) => setDialog({ kind: "edit", workday: w })}
        onCancel={(w) => setDialog({ kind: "cancel", workday: w })}
      />

      {/* Dialogs — only one of these renders at a time. Each gets the
          viewAs name so the in-dialog impersonation block can call out
          whose record is about to be mutated. */}
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
          onConfirm={() => {
            setDialog(null);
            void handlePause();
          }}
        />
      )}
      {dialog?.kind === "resume" && (
        <ResumeWorkdayDialog
          workday={dialog.workday}
          viewAsName={viewAsDisplayName}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            void handleResume();
          }}
        />
      )}
      {dialog?.kind === "end" && (
        <EndWorkdayDialog
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
          onConfirm={() => void handleCancel()}
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
  onEnd,
  onEdit,
  onCancel,
  viewAsName,
  canAct,
}: {
  today: WorkdayState;
  onStart: () => void;
  onPause: (w: WorkdaySummary) => void;
  onResume: (w: WorkdaySummary) => void;
  onEnd: (w: WorkdaySummary) => void;
  onEdit: (w: WorkdaySummary) => void;
  onCancel: (w: WorkdaySummary) => void;
  viewAsName?: string | null;
  canAct: boolean;
}) {
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
        mb={3}
        shadow="sm"
      >
        <Card.Body p={4}>
          {readOnlyBanner}
          <HStack gap={3} align="center" wrap="wrap">
            <Box bg="orange.500" color="white" p={2} borderRadius="full" flexShrink={0}>
              <Clock size={22} />
            </Box>
            <VStack align="start" gap={0} flex="1" minW="180px">
              <Text fontSize="md" fontWeight="bold" color="orange.900">
                {viewAsName ? `${viewAsName} hasn't started their workday` : "Start your workday"}
              </Text>
              <Text fontSize="xs" color="orange.800">
                {viewAsName
                  ? "Their workday must be started before they can begin any jobs."
                  : "You need to start your workday before you can begin any jobs."}
              </Text>
            </VStack>
            {canAct && (
              <Button size="md" colorPalette="green" onClick={onStart}>
                <Play size={16} /> <Text ml={1}>Start workday</Text>
              </Button>
            )}
          </HStack>
        </Card.Body>
      </Card.Root>
    );
  }

  // ── IN_PROGRESS ──────────────────────────────────────────────────────
  // Green card with a soft pulse on the live indicator so the worker can
  // see at a glance "I'm on the clock right now." Cancel sits to the
  // right as a small ghost-link affordance for "I tapped Start by
  // mistake."
  if (today.state === "IN_PROGRESS") {
    const active = activeMs(today.workday);
    const paused = totalPausedMsLive(today.workday);
    return (
      <Card.Root
        variant="outline"
        bg="green.50"
        borderColor="green.400"
        borderWidth="2px"
        mb={3}
      >
        <Card.Body p={4}>
          {readOnlyBanner}
          <HStack gap={3} align="center" wrap="wrap">
            <Box position="relative" flexShrink={0}>
              <Box bg="green.500" color="white" p={2} borderRadius="full">
                <Clock size={22} />
              </Box>
              {/* Pulse dot — "live" affordance, only animates when the
                  workday is actively ticking (not paused/completed). */}
              <Box
                position="absolute"
                top="-2px"
                right="-2px"
                w="10px"
                h="10px"
                borderRadius="full"
                bg="red.500"
                borderWidth="2px"
                borderColor="green.50"
                css={{
                  animation: "wd-pulse 1.6s ease-in-out infinite",
                  "@keyframes wd-pulse": {
                    "0%, 100%": { opacity: 1 },
                    "50%": { opacity: 0.35 },
                  },
                }}
              />
            </Box>
            <VStack align="start" gap={0} flex="1" minW="180px">
              <Text fontSize="md" fontWeight="bold" color="green.900">
                {viewAsName ? `${viewAsName} is on the clock` : "On the clock"} · {fmtDuration(active)} active
              </Text>
              <Text fontSize="xs" color="green.800">
                Started at {fmtClockTime(today.workday.startedAt)}
                {paused > 0 && ` · ${fmtDuration(paused)} paused so far`}
              </Text>
            </VStack>
            {canAct && (
              <HStack gap={1} wrap="wrap">
                <Button size="sm" variant="ghost" onClick={() => onCancel(today.workday)}>
                  Cancel
                </Button>
                <Button size="sm" variant="outline" colorPalette="yellow" onClick={() => onPause(today.workday)}>
                  <Pause size={14} /> <Text ml={1}>Pause</Text>
                </Button>
                <Button size="sm" colorPalette="red" onClick={() => onEnd(today.workday)}>
                  End workday
                </Button>
              </HStack>
            )}
          </HStack>
        </Card.Body>
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
        mb={3}
      >
        <Card.Body p={4}>
          {readOnlyBanner}
          <HStack gap={3} align="center" wrap="wrap">
            <Box bg="yellow.500" color="white" p={2} borderRadius="full" flexShrink={0}>
              <Pause size={22} />
            </Box>
            <VStack align="start" gap={0} flex="1" minW="180px">
              <Text fontSize="md" fontWeight="bold" color="yellow.900">
                {viewAsName ? `${viewAsName}'s workday paused` : "Workday paused"} · {fmtDuration(paused)} paused
              </Text>
              <Text fontSize="xs" color="yellow.800">
                Paused at {fmtClockTime(today.workday.pausedAt!)} · {fmtDuration(active)} active so far
              </Text>
            </VStack>
            {canAct && (
              <HStack gap={1} wrap="wrap">
                <Button size="sm" variant="ghost" onClick={() => onCancel(today.workday)}>
                  Cancel
                </Button>
                <Button size="sm" colorPalette="green" onClick={() => onResume(today.workday)}>
                  <Play size={14} /> <Text ml={1}>Resume</Text>
                </Button>
                <Button size="sm" variant="outline" colorPalette="red" onClick={() => onEnd(today.workday)}>
                  End workday
                </Button>
              </HStack>
            )}
          </HStack>
        </Card.Body>
      </Card.Root>
    );
  }

  // ── COMPLETED ───────────────────────────────────────────────────────
  // Subtle gray — the work is done. Smaller / less prominent so it
  // recedes into the background.
  const active = activeMs(today.workday);
  const paused = today.workday.totalPausedMs;
  return (
    <Card.Root variant="outline" bg="gray.50" mb={3}>
      <Card.Body p={3}>
        {readOnlyBanner}
        <HStack gap={2} align="center" wrap="wrap">
          <Box color="gray.500" flexShrink={0}>
            <Clock size={16} />
          </Box>
          <VStack align="start" gap={0} flex="1" minW="180px">
            <Text fontSize="sm" fontWeight="medium">
              {viewAsName ? `${viewAsName}'s workday complete` : "Workday complete"} · {fmtDuration(active)} active
            </Text>
            <Text fontSize="xs" color="fg.muted">
              {fmtClockTime(today.workday.startedAt)}
              {today.workday.endedAt && ` – ${fmtClockTime(today.workday.endedAt)}`}
              {paused > 0 && ` · ${fmtDuration(paused)} paused`}
            </Text>
          </VStack>
          {canAct && (
            <Button size="xs" variant="ghost" onClick={() => onEdit(today.workday)}>
              <Edit3 size={12} /> <Text ml={1}>Edit times</Text>
            </Button>
          )}
        </HStack>
      </Card.Body>
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
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  footer: React.ReactNode;
  onClose: () => void;
  viewAsName?: string | null;
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
  const errorRef = useRef<string | null>(null);

  async function submit() {
    setSaving(true);
    try {
      // Empty input → server uses "now". Allows the simple case of "just
      // start me right now" without the worker needing to confirm the
      // pre-filled timestamp.
      const iso = localToIso(startedAt);
      await onConfirm({ startedAt: iso ?? null });
    } catch (err) {
      errorRef.current = getErrorMessage("Failed to start.", err);
      publishInlineMessage({ type: "ERROR", text: errorRef.current });
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
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button colorPalette="green" onClick={() => void submit()} disabled={saving}>
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

function EndWorkdayDialog({
  workday,
  activeJobs,
  activeCheckouts,
  onClose,
  onConfirm,
  viewAsName,
}: {
  workday: WorkdaySummary;
  activeJobs: JobBlockingSummary[];
  activeCheckouts: EquipmentCheckoutSummary[];
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

  const liveActive = useMemo(() => {
    const startMs = Date.parse(localToIso(startedAt) ?? workday.startedAt);
    const endMs = Date.parse(localToIso(endedAt) ?? new Date().toISOString());
    const ms = endMs - startMs - pausedMin * 60000;
    return Math.max(0, ms);
  }, [startedAt, endedAt, pausedMin, workday.startedAt]);

  async function submit() {
    setSaving(true);
    try {
      await onConfirm({
        startedAt: localToIso(startedAt),
        endedAt: localToIso(endedAt),
        totalPausedMs: pausedMin * 60000,
      });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to end.", err) });
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
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button colorPalette="red" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner size="xs" /> : "End anyway"}
          </Button>
        </HStack>
      }
    >
      <VStack align="stretch" gap={3}>
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

  const liveActive = useMemo(() => {
    const startMs = Date.parse(localToIso(startedAt) ?? workday.startedAt);
    const endMs = Date.parse(localToIso(endedAt) ?? workday.endedAt ?? new Date().toISOString());
    const ms = endMs - startMs - pausedMin * 60000;
    return Math.max(0, ms);
  }, [startedAt, endedAt, pausedMin, workday.startedAt, workday.endedAt]);

  async function submit() {
    setSaving(true);
    try {
      await onConfirm({
        startedAt: localToIso(startedAt),
        endedAt: localToIso(endedAt),
        totalPausedMs: pausedMin * 60000,
      });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to update.", err) });
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

  const liveActive = useMemo(() => {
    const startMs = Date.parse(localToIso(startedAt) ?? workday.startedAt);
    const endMs = Date.parse(localToIso(endedAt) ?? defaultEndIso);
    const ms = endMs - startMs - pausedMin * 60000;
    return Math.max(0, ms);
  }, [startedAt, endedAt, pausedMin, workday.startedAt, defaultEndIso]);

  async function submit() {
    setSaving(true);
    try {
      await onConfirm({
        startedAt: localToIso(startedAt),
        endedAt: localToIso(endedAt),
        totalPausedMs: pausedMin * 60000,
      });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Failed to end.", err) });
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
  onConfirm: () => void;
  viewAsName?: string | null;
}) {
  const startedDuration = useMemo(
    () => fmtDuration(activeMs(workday)),
    [workday],
  );
  return (
    <DialogShell
      open
      title="Cancel this workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose}>Keep workday</Button>
          <Button colorPalette="red" onClick={onConfirm}>
            Cancel workday
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
  onConfirm: () => void;
  viewAsName?: string | null;
}) {
  const activeSoFar = useMemo(
    () => fmtDuration(activeMs(workday)),
    [workday],
  );
  return (
    <DialogShell
      open
      title="Pause workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose}>Keep going</Button>
          <Button colorPalette="yellow" onClick={onConfirm}>
            Pause workday
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
  onConfirm: () => void;
  viewAsName?: string | null;
}) {
  const pausedSoFar = useMemo(
    () => fmtDuration(totalPausedMsLive(workday)),
    [workday],
  );
  return (
    <DialogShell
      open
      title="Resume workday?"
      viewAsName={viewAsName}
      onClose={onClose}
      footer={
        <HStack justify="flex-end" w="full" gap={2}>
          <Button variant="ghost" onClick={onClose}>Stay paused</Button>
          <Button colorPalette="green" onClick={onConfirm}>
            Resume workday
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
