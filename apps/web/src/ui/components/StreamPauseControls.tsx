"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PAUSING A REPEATING SERVICE — the one implementation.
//
// Pausing is now the ONLY kind of pause in the app: job-service pause was
// removed because it was mechanically identical to archiving (same
// delete-schedule + rebuild-chain helpers), so it offered a second name for
// an operation that already had one. What is left holds a single recurring
// stream — "no hedging until spring" — and it lives on the occurrence.
//
// Services and Work→Jobs both show the same occurrences, so they must offer
// the same actions with the same copy and the same confirm behaviour. That is
// what this module is: the button cluster, the three-mode dialog, the API
// calls and the reason filter, once. A tab wires it up with the hook and
// renders `controls.dialogs` somewhere near its other dialogs.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { Select, createListCollection, Portal } from "@chakra-ui/react";
// PauseCircle, not Repeat. Services already spends the Repeat glyph on its
// repeating-STATE filter, and the two sat side by side reading as the same
// control. PauseCircle is what the paused callout and the paused card
// indicator already use, so the icon means one thing across the app.
import { PauseCircle } from "lucide-react";
import { apiPatch, apiPost } from "@/src/lib/api";
import { bizAddDays, bizDateKey, bizToday } from "@/src/lib/dates";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import StreamPauseDialog from "@/src/ui/dialogs/StreamPauseDialog";
import StatusButton from "@/src/ui/components/StatusButton";
import { type PauseReason } from "@/src/lib/pauseReasons";

/** The fields the pause surfaces read off an occurrence. Deliberately
 *  structural rather than the full `JobOccurrenceFull`, so JobsTab's row
 *  shape and ServicesTab's both satisfy it without a cast at every callsite. */
export type StreamPauseOcc = {
  id: string;
  /** The service this visit belongs to. Passed back to `onChanged` so a
   *  caller whose rows come from a per-job detail fetch can refresh the
   *  right one — see the note on `onChanged`. */
  jobId?: string | null;
  status?: string | null;
  title?: string | null;
  jobType?: string | null;
  frequencyDays?: number | null;
  streamPausedAt?: string | null;
  streamPauseReason?: string | null;
  streamPauseReasonCode?: string | null;
  streamResumeReminderAt?: string | null;
  job?: { frequencyDays?: number | null } | null;
};

/** Statuses that count as "this stream is alive" — used by the
 *  has-an-active-repeating filters in both tabs. PAUSED is the worker's
 *  mid-visit timer, not a stream hold: the visit is still happening. */
export const ACTIVE_OCCURRENCE_STATUSES = [
  "SCHEDULED",
  "IN_PROGRESS",
  "PENDING_PAYMENT",
  "PAUSED",
  "STREAM_PAUSED",
] as const;

export function isStreamPaused(occ: { status?: string | null }): boolean {
  return (occ.status as string | null | undefined) === "STREAM_PAUSED";
}

/** Human label for an occurrence in dialog copy. */
function occLabel(occ: StreamPauseOcc): string {
  return (occ.jobType ?? null) || (occ.title ?? null) || "recurring service";
}

/** Default new-start date offered by the resume dialog: today plus one
 *  cadence, so "restart it soon" lands on the natural rhythm rather than
 *  tomorrow. ET-anchored via the canonical helpers — `.setDate()` drifts
 *  across a DST boundary. */
function defaultResumeStartAt(occ: StreamPauseOcc): string {
  const freq = occ.frequencyDays ?? occ.job?.frequencyDays ?? 14;
  return bizAddDays(bizToday(), freq);
}

type DialogState =
  | { mode: "pause"; occ: StreamPauseOcc }
  | { mode: "update"; occ: StreamPauseOcc }
  | { mode: "resume"; occ: StreamPauseOcc };

export type StreamPauseControls = {
  openPause: (occ: StreamPauseOcc) => void;
  openUpdate: (occ: StreamPauseOcc) => void;
  openResume: (occ: StreamPauseOcc) => void;
  busy: boolean;
  /** Render this once per tab, alongside the tab's other dialogs. */
  dialogs: React.ReactNode;
};

/** Owns the pause dialogs and the writes behind them.
 *
 *  `onChanged` is the caller's reload — it runs after every successful
 *  write, because a pause moves the occurrence between the lists these
 *  tabs are filtering on and a stale row is worse than a flicker.
 *
 *  IT RECEIVES THE OCCURRENCE THAT CHANGED, and a caller that renders
 *  occurrences from a per-job detail fetch MUST refresh that job's detail
 *  and not just its list. Services does exactly that, and reloading only
 *  the list looked like the write had failed: clearing a reminder reported
 *  success, the reminder was gone from the database, and reopening "Edit
 *  pause" still showed the old date — because the card was still holding
 *  the occurrence object from the last detail fetch. */
export function useStreamPauseControls({
  onChanged,
}: {
  onChanged: (occ: StreamPauseOcc) => void | Promise<void>;
}): StreamPauseControls {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);

  // Every write ends the same way: tell the operator, close, bump the
  // alerts badge (pages/index.tsx listens), reload the caller's list.
  async function run(
    occ: StreamPauseOcc,
    work: () => Promise<void>,
    successText: string,
    failureText: string,
    opts: { close?: boolean } = {},
  ) {
    setBusy(true);
    try {
      await work();
      publishInlineMessage({ type: "SUCCESS", text: successText });
      if (opts.close !== false) setDialog(null);
      window.dispatchEvent(new CustomEvent("seedlings:stream-pauses-changed"));
      await onChanged(occ);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(failureText, err) });
    } finally {
      setBusy(false);
    }
  }

  const dialogs = (
    <>
      {dialog?.mode === "pause" && (
        <StreamPauseDialog
          open
          mode="pause"
          occurrenceLabel={occLabel(dialog.occ)}
          busy={busy}
          onCancel={() => { if (!busy) setDialog(null); }}
          onConfirm={async ({ reasonCode, reason, reminderAt }) =>
            run(
              dialog.occ,
              async () => {
                await apiPost(`/api/admin/occurrences/${dialog.occ.id}/stream-pause`, {
                  reasonCode,
                  reason,
                  reminderAt,
                });
              },
              "Repeating service paused.",
              "Failed to pause repeating.",
            )
          }
        />
      )}
      {dialog?.mode === "update" && (
        <StreamPauseDialog
          open
          mode="update"
          occurrenceLabel={occLabel(dialog.occ)}
          currentReason={dialog.occ.streamPauseReason ?? null}
          currentReasonCode={dialog.occ.streamPauseReasonCode ?? null}
          currentReminderAt={
            dialog.occ.streamResumeReminderAt
              ? bizDateKey(dialog.occ.streamResumeReminderAt)
              : null
          }
          busy={busy}
          onCancel={() => { if (!busy) setDialog(null); }}
          onConfirm={async ({ reasonCode, reason, reminderAt }) =>
            run(
              dialog.occ,
              async () => {
                await apiPatch(`/api/admin/occurrences/${dialog.occ.id}/stream-pause`, {
                  reasonCode,
                  reason,
                  reminderAt,
                });
              },
              "Repeating pause updated.",
              "Failed to update repeating pause.",
            )
          }
        />
      )}
      {dialog?.mode === "resume" && (
        <StreamPauseDialog
          open
          mode="resume"
          occurrenceLabel={occLabel(dialog.occ)}
          defaultNewStartAt={defaultResumeStartAt(dialog.occ)}
          busy={busy}
          onCancel={() => { if (!busy) setDialog(null); }}
          onConfirm={async ({ newStartAt }) =>
            run(
              dialog.occ,
              async () => {
                await apiPost(`/api/admin/occurrences/${dialog.occ.id}/stream-resume`, {
                  newStartAt,
                });
              },
              "Repeating service resumed.",
              "Failed to resume repeating.",
            )
          }
        />
      )}
    </>
  );

  return {
    openPause: (occ) => setDialog({ mode: "pause", occ }),
    openUpdate: (occ) => setDialog({ mode: "update", occ }),
    openResume: (occ) => setDialog({ mode: "resume", occ }),
    busy,
    dialogs,
  };
}

/** The pause/resume/edit cluster for one occurrence.
 *
 *  Renders nothing unless the occurrence is in a state where a pause action
 *  makes sense, so callers drop it into an action row unconditionally.
 *
 *  Admin/super only: a worker pausing a stream would silently stop the work
 *  they are scheduled for, and they have no way to see the consequence. */
export function StreamPauseActions({
  occ,
  canManage,
  controls,
  busyId,
  setBusyId,
  size = "sm",
}: {
  occ: StreamPauseOcc;
  canManage: boolean;
  controls: StreamPauseControls;
  busyId: string;
  setBusyId: (id: string) => void;
  size?: "xs" | "sm" | "md";
}) {
  if (!canManage) return null;

  const status = (occ.status as string | null | undefined) ?? "";

  if (status === "SCHEDULED") {
    return (
      <StatusButton
        id="occ-stream-pause"
        itemId={occ.id}
        label="Pause repeating"
        title="Hold this recurring stream — the job service and its other streams keep running"
        onClick={async () => { controls.openPause(occ); }}
        variant="outline"
        colorPalette="purple"
        busyId={busyId}
        setBusyId={setBusyId}
        size={size}
      />
    );
  }

  if (status !== "STREAM_PAUSED") return null;

  return (
    <>
      <StatusButton
        id="occ-stream-resume"
        itemId={occ.id}
        label="Resume repeating"
        onClick={async () => { controls.openResume(occ); }}
        variant="outline"
        colorPalette="green"
        busyId={busyId}
        setBusyId={setBusyId}
        size={size}
      />
      <StatusButton
        id="occ-stream-edit-pause"
        itemId={occ.id}
        label="Edit pause"
        title="Change the reason, the note, or when to check back — or clear the reminder without resuming"
        onClick={async () => { controls.openUpdate(occ); }}
        variant="outline"
        colorPalette="purple"
        busyId={busyId}
        setBusyId={setBusyId}
        size={size}
      />
    </>
  );
}

/** "Paused, any reason" — the filter is on but not narrowed. Empty string
 *  would collide with Chakra's own cleared-selection value. */
export const ALL_PAUSE_REASONS = "__ALL__";
/** "Not filtering by pause state at all" — the control's off position. */
const PAUSE_FILTER_OFF = "__OFF__";

/** ONE CONTROL FOR THE WHOLE QUESTION: is this list narrowed to held visits,
 *  and if so to which reason.
 *
 *  It was a toggle button plus a dropdown sitting next to each other, which
 *  is two controls and two chunks of toolbar width for one filter — and on
 *  Work → Jobs, where the toolbar is already a dense row of icons, that was
 *  width it could not spare. It also put the two halves in states that read
 *  oddly together: a reason dropdown showing "Non-payment" while the toggle
 *  beside it was off, saying nothing was filtered.
 *
 *  Off is an option in the same list, so there is one value, one place to
 *  read it, and no way for the halves to disagree. */
export function StreamPauseFilter({
  active,
  reasonCode,
  onChange,
  reasons,
  size = "sm",
}: {
  /** Whether the list is narrowed to held visits at all. */
  active: boolean;
  /** ALL_PAUSE_REASONS, or the one reason to narrow to. */
  reasonCode: string;
  onChange: (next: { active: boolean; reasonCode: string }) => void;
  reasons: PauseReason[];
  size?: "xs" | "sm" | "md";
}) {
  const value = active ? reasonCode : PAUSE_FILTER_OFF;

  const collection = useMemo(
    () =>
      createListCollection({
        items: [
          // The menu carries the words the trigger no longer does, so
          // picking is unambiguous even though the button is a bare icon.
          { label: "All visits", value: PAUSE_FILTER_OFF },
          { label: "Paused — any reason", value: ALL_PAUSE_REASONS },
          ...reasons.map((r) => ({ label: `Paused — ${r.label}`, value: r.code })),
        ],
      }),
    [reasons],
  );

  // ICON ONLY, like every other filter trigger in these toolbars. What is
  // selected is said by the fill (on/off) and, when it is on, by the chip
  // row underneath, which names the reason in full. Putting the reason on
  // the trigger too made this one control wider than the five beside it and
  // repeated what the chip already said.
  const activeLabel =
    reasonCode === ALL_PAUSE_REASONS
      ? "any reason"
      : reasons.find((r) => r.code === reasonCode)?.label ?? reasonCode;

  return (
    <Select.Root
      collection={collection}
      value={[value]}
      onValueChange={(e) => {
        const picked = e.value[0] ?? PAUSE_FILTER_OFF;
        if (picked === PAUSE_FILTER_OFF) {
          // Switching off also drops the reason — a reason left armed would
          // silently empty the list the next time paused is switched on.
          onChange({ active: false, reasonCode: ALL_PAUSE_REASONS });
        } else {
          onChange({ active: true, reasonCode: picked });
        }
      }}
      size={size}
      positioning={{ strategy: "fixed", hideWhenDetached: true }}
      css={{ width: "auto", flex: "0 0 auto" }}
    >
      <Select.HiddenSelect />
      <Select.Control>
        <Select.Trigger
          w="auto"
          minW="0"
          px="2"
          title={
            active
              ? `Showing only paused repeating visits — ${activeLabel}`
              : "Filter by pause state"
          }
          css={{
            background: active
              ? "var(--chakra-colors-purple-muted)"
              : "var(--chakra-colors-purple-subtle)",
            border: active
              ? "1px solid var(--chakra-colors-purple-strong)"
              : "1px solid var(--chakra-colors-purple-emphasized)",
            borderRadius: "6px",
            color: active ? "var(--chakra-colors-purple-fg)" : undefined,
          }}
        >
          <PauseCircle size={14} />
          <Select.Indicator display="none" />
        </Select.Trigger>
      </Select.Control>
      <Portal>
        <Select.Positioner>
          <Select.Content>
            {collection.items.map((item) => (
              <Select.Item item={item} key={item.value}>
                {item.label}
                <Select.ItemIndicator />
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Portal>
    </Select.Root>
  );
}

/** Does this occurrence pass the paused-plus-reason filter pair?
 *
 *  One function so Services and Jobs can't drift on what "paused, awaiting
 *  payment" means. `reasonCode` is ignored unless `pausedOnly` is on. */
export function passesPauseFilter(
  occ: { status?: string | null; streamPauseReasonCode?: string | null },
  pausedOnly: boolean,
  reasonCode: string,
): boolean {
  if (!pausedOnly) return true;
  if (!isStreamPaused(occ)) return false;
  if (reasonCode === ALL_PAUSE_REASONS) return true;
  return (occ.streamPauseReasonCode ?? null) === reasonCode;
}

/** Counts of repeating streams on a job service, for the card summary.
 *
 *  The user's framing: a job service is "just the default" — what matters
 *  is whether it actually has a live repeating stream, and if some are
 *  paused, why. So the card states the total, the live count, and the
 *  paused count rather than a single derived status word that would hide
 *  a half-paused job behind "active". */
export function summarizeRepeatings(
  occurrences: { status?: string | null; frequencyDays?: number | null }[],
  jobFrequencyDays: number | null | undefined,
): { total: number; active: number; paused: number } {
  // Repeating means the stream recurs — the occurrence's own cadence when
  // it overrides, otherwise the job's. A one-off has neither.
  const repeating = occurrences.filter(
    (o) => (o.frequencyDays ?? jobFrequencyDays ?? null) !== null,
  );
  const active = repeating.filter((o) =>
    (ACTIVE_OCCURRENCE_STATUSES as readonly string[]).includes((o.status as string) ?? ""),
  );
  return {
    total: repeating.length,
    active: active.filter((o) => !isStreamPaused(o)).length,
    paused: repeating.filter((o) => isStreamPaused(o)).length,
  };
}
