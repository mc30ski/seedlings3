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
  fetchWorkdayToday,
  startWorkday,
  resumeWorkday,
  fmtClockTime,
} from "@/src/lib/workday";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
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
//   COMPLETED   → no escape hatch — the worker ended for the day. They
//                 cancel and decide what to do.
//
// `assertWorkdayActiveOrPrompt` on the server is the defense-in-depth
// layer that also blocks if this gate is somehow bypassed.
// ─────────────────────────────────────────────────────────────────────────

type GateResult = "ok" | "cancelled";

type GateState = {
  open: boolean;
  state: WorkdayState | null;
  resolve: ((r: GateResult) => void) | null;
  busy: boolean;
};

export function useWorkdayGate() {
  const [gate, setGate] = useState<GateState>({
    open: false,
    state: null,
    resolve: null,
    busy: false,
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
        setGate({ open: true, state: payload.today, resolve, busy: false });
      });
      if (result === "cancelled") {
        throw new Error("GATE_CANCELLED");
      }
    }
    return action();
  }

  async function onConfirm() {
    if (!gate.state) return;
    setGate((g) => ({ ...g, busy: true }));
    try {
      if (gate.state.state === "NOT_STARTED") {
        await startWorkday({}); // server default = now
      } else if (gate.state.state === "PAUSED") {
        await resumeWorkday();
      }
      const resolve = gate.resolve;
      setGate({ open: false, state: null, resolve: null, busy: false });
      resolve?.("ok");
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to start workday.", err),
      });
      setGate((g) => ({ ...g, busy: false }));
    }
  }

  function onCancel() {
    const resolve = gate.resolve;
    setGate({ open: false, state: null, resolve: null, busy: false });
    resolve?.("cancelled");
  }

  const dialog = (
    <WorkdayRequiredDialog
      open={gate.open}
      state={gate.state}
      busy={gate.busy}
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
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  state: WorkdayState | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!state) return null;

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
    title = "You ended your workday today";
    confirmLabel = "Start workday & continue";
    confirmDisabled = true;
    confirmPalette = "gray";
    body = (
      <Text fontSize="sm">
        You ended at {fmtClockTime(state.workday.endedAt!)}. Pause next time if you need a break —
        your workday can't be re-opened today.
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
