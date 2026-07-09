"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { AlertTriangle } from "lucide-react";
import {
  type WorkdayState,
  type WorkdaySummary,
  fetchWorkdayToday,
  startWorkday,
  resumeWorkday,
  reopenWorkday,
  fmtClockTime,
  fmtWorkdayDate,
} from "@/src/lib/workday";
import { getErrorMessage } from "@/src/ui/components/InlineMessage";
import ImpersonationWarning from "@/src/ui/components/ImpersonationWarning";

// ─────────────────────────────────────────────────────────────────────────
// WorkdayRequiredDialog — the client-side gate for "Start job" actions.
//
// Used via `useWorkdayGate()`: any worker UI that wants to start (or
// resume) a job wraps the action through the gate. The gate checks
// workday state; if active it runs the action immediately, if not it
// surfaces this dialog. The dialog handles three states:
//   NOT_STARTED → "Start workday & continue" creates today's workday at
//                 the current time, then runs the wrapped action.
//   PAUSED      → "Resume workday & continue" resumes the workday, then
//                 runs the wrapped action.
//   COMPLETED   → "Continue workday" reopens the ended row; the gap
//                 between endedAt and now lands in totalPausedMs so the
//                 off-the-clock interval doesn't count toward hours.
//                 Refused server-side once the row is approved or the
//                 same-day edit window has closed.
//
// `assertWorkdayActiveOrPrompt` on the server is the defense-in-depth
// layer that also blocks if this gate is somehow bypassed.
// ─────────────────────────────────────────────────────────────────────────

type GateResult = "ok" | "cancelled";

type GateState = {
  open: boolean;
  state: WorkdayState | null;
  /** Prior workdays the user forgot to end. When non-empty, the gate
   *  shows a "close out [date] first" panel INSTEAD of the today-state
   *  branches — those past rows have to be cleared before any job-start
   *  can proceed (the server's assertWorkdayActiveOrPrompt enforces it). */
  openPrior: WorkdaySummary[];
  resolve: ((r: GateResult) => void) | null;
  busy: boolean;
  /** Error from the most recent confirm attempt. Rendered inline above
   *  the footer (NOT as a toast — a toast over a centered dialog is hidden
   *  on mobile). Cleared on next confirm attempt or by the close-x. */
  error: string | null;
};

export function useWorkdayGate() {
  const [gate, setGate] = useState<GateState>({
    open: false,
    state: null,
    openPrior: [],
    resolve: null,
    busy: false,
    error: null,
  });

  /**
   * Run `action` only if the worker has an active workday. If not, show
   * the gate dialog. On NOT_STARTED / PAUSED the worker can confirm and
   * the gate resumes/starts the workday then runs `action`. On COMPLETED
   * the worker can only cancel.
   *
   * Returns whatever `action` returns. If the gate was cancelled, the
   * promise rejects with a "GATE_CANCELLED" error so the caller can
   * silently swallow it (or skip its own success toast).
   */
  async function withWorkday<T>(action: () => Promise<T>): Promise<T> {
    const payload = await fetchWorkdayToday();
    if (payload.openPrior.length > 0 || payload.today.state !== "IN_PROGRESS") {
      // Open the dialog and wait for the worker to resolve it. If they
      // confirm, the gate has already started/resumed the workday by
      // then; if they cancel, throw a recognized error.
      const result = await new Promise<GateResult>((resolve) => {
        setGate({
          open: true,
          state: payload.today,
          openPrior: payload.openPrior,
          resolve,
          busy: false,
          error: null,
        });
      });
      if (result === "cancelled") {
        throw new Error("GATE_CANCELLED");
      }
    }
    return action();
  }

  async function onConfirm() {
    if (!gate.state) return;
    setGate((g) => ({ ...g, busy: true, error: null }));
    try {
      if (gate.state.state === "NOT_STARTED") {
        await startWorkday({}); // server default = now
      } else if (gate.state.state === "PAUSED") {
        await resumeWorkday();
      } else if (gate.state.state === "COMPLETED") {
        // Re-open the ended row. Server adds the gap between the
        // old endedAt and now to totalPausedMs so off-the-clock
        // time stays out of payable hours.
        await reopenWorkday();
      }
      const resolve = gate.resolve;
      setGate({ open: false, state: null, openPrior: [], resolve: null, busy: false, error: null });
      resolve?.("ok");
    } catch (err) {
      // Compliance sign wizard cancelled: api.ts's POLICIES_REQUIRED
      // branch waits for the wizard to close and, if the worker cancels
      // instead of signing, re-throws the original POLICIES_REQUIRED
      // error. Treat that as a clean gate cancel — closing this dialog
      // silently and resolving as "cancelled" — because the worker has
      // already been shown what they need to do and chose to bail out.
      // No inline error, no double-cancel.
      const anyErr = err as { code?: string } | null;
      if (anyErr?.code === "POLICIES_REQUIRED") {
        const resolve = gate.resolve;
        setGate({ open: false, state: null, openPrior: [], resolve: null, busy: false, error: null });
        resolve?.("cancelled");
        return;
      }
      // Real failure — inline error, NOT a toast. On mobile the toast
      // is hidden behind this centered dialog, so failure reasons
      // (e.g. "approval window closed", "already approved") need to
      // render in the dialog itself.
      setGate((g) => ({
        ...g,
        busy: false,
        error: getErrorMessage("Failed to start workday.", err),
      }));
    }
  }

  function onCancel() {
    const resolve = gate.resolve;
    setGate({ open: false, state: null, openPrior: [], resolve: null, busy: false, error: null });
    resolve?.("cancelled");
  }

  function onDismissError() {
    setGate((g) => ({ ...g, error: null }));
  }

  const dialog = (
    <WorkdayRequiredDialog
      open={gate.open}
      state={gate.state}
      openPrior={gate.openPrior}
      busy={gate.busy}
      error={gate.error}
      onDismissError={onDismissError}
      onConfirm={() => void onConfirm()}
      onCancel={onCancel}
    />
  );

  return { withWorkday, dialog };
}

// ── Dialog presentation ────────────────────────────────────────────────

// Sourced from the shared component. The gate dialog never has a
// per-user viewAsName (the gate runs in the actor's own self-service
// path), but the role-impersonation banner still fires when applicable.
const ImpersonationWarningBlock = () => <ImpersonationWarning />;

function WorkdayRequiredDialog({
  open,
  state,
  openPrior,
  busy,
  error,
  onDismissError,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  state: WorkdayState | null;
  openPrior: WorkdaySummary[];
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!state) return null;

  // Forgot-to-end-yesterday(s) takes precedence over today's state — the
  // server's start-job guard refuses while open prior workdays exist, so
  // the user MUST close them out first. Without this branch, clicking
  // Start while IN_PROGRESS+openPrior would silently no-op (the dialog
  // would open then render null because of the IN_PROGRESS fall-through).
  if (openPrior.length > 0) {
    const oldest = openPrior[0];
    return (
      <Dialog.Root
        open={open}
        onOpenChange={(e) => { if (!e.open) onCancel(); }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
              <Dialog.Header>
                <Dialog.Title>Close out a previous workday first</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <ImpersonationWarningBlock />
                <VStack align="stretch" gap={3}>
                  <Text fontSize="sm">
                    You didn't end your workday on{" "}
                    <Text as="span" fontWeight="semibold">{fmtWorkdayDate(oldest.workdayDate)}</Text>
                    {openPrior.length > 1 && (
                      <Text as="span" color="fg.muted">
                        {" "}(plus {openPrior.length - 1} more)
                      </Text>
                    )}.
                    Set the end time on the <Text as="span" fontWeight="semibold">Home</Text> tab
                    (orange "didn't end your workday" banner) before starting any new jobs.
                  </Text>
                  <Box
                    p={3}
                    bg="orange.50"
                    borderWidth="1px"
                    borderColor="orange.300"
                    borderRadius="md"
                  >
                    <HStack gap={2} align="start">
                      <Box color="orange.600" flexShrink={0} mt="2px">
                        <AlertTriangle size={16} />
                      </Box>
                      <Text fontSize="xs" color="orange.900">
                        Past workdays don't auto-close — they need an end time so your hours
                        for that day are recorded correctly.
                      </Text>
                    </HStack>
                  </Box>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" w="full" gap={2}>
                  <Button colorPalette="orange" onClick={onCancel}>OK</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    );
  }

  let title = "Start your workday first";
  let body: React.ReactNode = null;
  let confirmLabel = "Start workday & continue";
  let confirmDisabled = busy;
  let confirmPalette = "green";

  if (state.state === "NOT_STARTED") {
    body = (
      <Text fontSize="sm">
        You haven't started your workday today. Start it now to begin this job.
      </Text>
    );
  } else if (state.state === "PAUSED") {
    title = "Resume your workday";
    confirmLabel = "Resume workday & continue";
    body = (
      <Text fontSize="sm">
        Your workday is paused since {fmtClockTime(state.workday.pausedAt!)}. Resume it to start this job.
      </Text>
    );
  } else if (state.state === "COMPLETED") {
    // Ended workdays can be reopened — useful when the worker tapped
    // End by mistake. The server adds the gap between endedAt and
    // now to totalPausedMs, so the off-the-clock interval doesn't
    // count toward payable hours. Refused server-side if the row was
    // already approved or the same-day edit window has closed.
    title = "Your workday is ended";
    confirmLabel = "Continue workday";
    body = (
      <Text fontSize="sm">
        You ended at {fmtClockTime(state.workday.endedAt!)}. If that was a mistake, continue your
        workday now — the time between then and now will be recorded as a pause so it doesn't count
        toward your hours.
      </Text>
    );
  } else {
    // IN_PROGRESS shouldn't render the dialog (the gate would have run
    // the action straight through). Render nothing if it slips through.
    return null;
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => { if (!e.open) onCancel(); }}
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
              <ImpersonationWarningBlock />
              {body}
            </Dialog.Body>
            {error && (
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
                    {error}
                  </Text>
                  <Button
                    size="xs"
                    variant="ghost"
                    colorPalette="red"
                    onClick={onDismissError}
                    px={2}
                    minW="auto"
                  >
                    ×
                  </Button>
                </HStack>
              </Box>
            )}
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                <Button
                  colorPalette={confirmPalette}
                  onClick={onConfirm}
                  disabled={confirmDisabled}
                >
                  {busy ? <Spinner size="xs" /> : confirmLabel}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TeamWorkdayRequiredDialog — the centered modal counterpart to the
// claimer-side gate above, for when the BACKEND rejects a Start with
// TEAM_WORKDAY_NOT_ACTIVE (a teammate hasn't clocked in). The claimer
// can't fix it themselves — only the teammates can — so this dialog
// is informational: it lists who isn't ready and tells the claimer
// what to do (ask the teammates to clock in, then retry).
//
// Used via `useTeamWorkdayDialog()`. The caller catches the 409 from
// /occurrences/:id/start, reads `err.details.notReady`, and calls
// `show(...)` to surface the modal. Render `dialog` in the tree once.
// ─────────────────────────────────────────────────────────────────────────

export type NotReadyTeammate = { userId: string; name: string };

export function useTeamWorkdayDialog() {
  const [open, setOpen] = useState(false);
  const [teammates, setTeammates] = useState<NotReadyTeammate[]>([]);

  function show(list: NotReadyTeammate[]) {
    setTeammates(list);
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

  const dialog = (
    <TeamWorkdayRequiredDialog
      open={open}
      teammates={teammates}
      onClose={close}
    />
  );

  return { show, dialog };
}

function TeamWorkdayRequiredDialog({
  open,
  teammates,
  onClose,
}: {
  open: boolean;
  teammates: NotReadyTeammate[];
  onClose: () => void;
}) {
  const plural = teammates.length !== 1;
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
              <Dialog.Title>
                <HStack gap={2} align="center">
                  <AlertTriangle size={20} color="var(--chakra-colors-orange-500)" />
                  <Text>
                    {plural ? "Teammates aren't ready yet" : "Teammate isn't ready yet"}
                  </Text>
                </HStack>
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <ImpersonationWarning />
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm">
                  {plural
                    ? "The following team members haven't started their workday yet. They each need to clock in before you can start this job."
                    : "This team member hasn't started their workday yet. They need to clock in before you can start this job."}
                </Text>
                <Box
                  p={3}
                  bg="orange.50"
                  borderWidth="1px"
                  borderColor="orange.200"
                  rounded="md"
                >
                  <VStack align="stretch" gap={1.5}>
                    {teammates.map((t) => (
                      <HStack key={t.userId} gap={2}>
                        <Box
                          w="6px"
                          h="6px"
                          borderRadius="full"
                          bg="orange.400"
                          flexShrink={0}
                        />
                        <Text fontSize="sm" fontWeight="medium" color="orange.900">
                          {t.name}
                        </Text>
                      </HStack>
                    ))}
                  </VStack>
                </Box>
                <Text fontSize="xs" color="fg.muted">
                  Ask {plural ? "them" : "them"} to open the app and tap <Text as="span" fontWeight="semibold">Start workday</Text>. Once they have, try starting the job again.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full" gap={2}>
                <Button colorPalette="blue" onClick={onClose}>
                  Got it
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
