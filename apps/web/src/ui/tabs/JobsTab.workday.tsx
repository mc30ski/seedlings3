"use client";

// ─────────────────────────────────────────────────────────────────────────────
// JobsTab.workday — compact workday + mileage banners.
//
// Every action is an inline real Button with an icon. No text-link
// pseudo-buttons, no "go to Home" punts. Actions:
//   • Start / Pause / Resume / Cancel-mileage → direct POST
//   • Stop mileage → inline dialog (odometer + optional notes)
//   • End workday → direct POST; blocked with a red warning banner
//     if openMileageEntries or activeCheckouts are present, and the
//     End button is hidden until the user handles those inline
//   • Set end time (forgot-prior) → inline dialog with a datetime
//     picker on the missed workday's date
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Button, Dialog, HStack, Input, Portal, Select, SimpleGrid, Text, VStack, createListCollection } from "@chakra-ui/react";
import {
  AlertTriangle,
  Car,
  CheckCircle2,
  Clock,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import { bumpWorkday } from "@/src/lib/bus";
import {
  fetchWorkdayToday,
  startWorkday,
  pauseWorkday,
  resumeWorkday,
  endWorkday,
  reopenWorkday,
  editWorkdayTimes,
  activeMs,
  type OpenMileageSummary,
  type WorkdaySummary,
  type WorkdayTodayPayload,
} from "@/src/lib/workday";
import {
  fmtTimeOpts,
  fmtDateWeekday,
  bizDateKey,
  bizToLocalInputValue,
  bizParseLocalInputValue,
} from "@/src/lib/lib";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { CompactBanner, SkeletonBanner } from "@/src/ui/tabs/JobsTab.parts";

/** Human-friendly duration ("2h 15m" / "36m") from ms. Module-scope
 *  so both WorkdayBanner and MileageBanner can share it. */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Bounded label/value tile used inside every expanded banner's
// detail grid. Label + value sit within one grid column so on a
// large screen they stay adjacent instead of being pushed to
// opposite edges of the tab.
function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <HStack
      justify="space-between"
      gap={2}
      px={2}
      py={1}
      borderRadius="sm"
      bg="blackAlpha.50"
    >
      <Text fontSize="xs" color="fg.muted" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" flex="1" minW={0}>
        {label}
      </Text>
      <Text fontSize="sm" fontWeight="medium" flexShrink={0}>{value}</Text>
    </HStack>
  );
}
// Responsive grid used to lay out StatTiles. 3-up on large screens,
// 2-up on tablets, 1-up on phones. Keeps every label-value pair
// bounded to its column width.
const STAT_GRID_COLS = { base: 1, sm: 2, lg: 3 };

function useWorkdayToday(viewAsUserId?: string | null) {
  const [payload, setPayload] = useState<WorkdayTodayPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    fetchWorkdayToday(viewAsUserId ? { viewAsUserId } : undefined)
      .then((p) => { setPayload(p); setLoaded(true); })
      .catch(() => { setPayload(null); setLoaded(true); });
  }, [viewAsUserId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onChange = () => load();
    window.addEventListener("seedlings:workday-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener("seedlings:workday-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [load]);
  return { payload, loaded, reload: load };
}

// ─── Stop-mileage dialog ──────────────────────────────────────────────────
function StopMileageDialog({
  entry,
  onClose,
  onStopped,
}: {
  entry: OpenMileageSummary;
  onClose: () => void;
  onStopped: () => void;
}) {
  const [odometer, setOdometer] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const endNum = Number(odometer);
  const valid = /^\d+$/.test(odometer.trim()) && endNum >= entry.startOdometer;
  const miles = valid ? endNum - entry.startOdometer : null;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await apiPost(`/api/me/mileage/${entry.id}/stop`, {
        endOdometer: endNum,
        notes: notes.trim() || undefined,
      });
      // Cross-component broadcast — the WorkdayBanner has its own
      // useWorkdayToday() instance and needs to know its blocking
      // state (open mileage / active checkouts) may have changed.
      bumpWorkday();
      publishInlineMessage({
        type: "SUCCESS",
        text: `Recorded ${miles} mi on ${entry.vehicleName}.`,
      });
      onStopped();
      onClose();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Stop failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      role="alertdialog"
      open
      onOpenChange={(e) => { if (!e.open) onClose(); }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Stop {entry.vehicleName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">
                  Started at {entry.startOdometer.toLocaleString()} mi
                </Text>
                <VStack align="stretch" gap={1}>
                  <Text fontSize="sm" fontWeight="medium">Ending odometer (mi)</Text>
                  <Input
                    size="sm"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={String(entry.startOdometer)}
                    autoFocus
                  />
                  {miles != null && (
                    <Text fontSize="xs" color="green.700">= {miles} mi driven</Text>
                  )}
                  {odometer.trim() !== "" && !valid && (
                    <Text fontSize="xs" color="red.600">
                      Must be a whole number ≥ {entry.startOdometer.toLocaleString()}
                    </Text>
                  )}
                </VStack>
                <VStack align="stretch" gap={1}>
                  <Text fontSize="sm" fontWeight="medium">Notes (optional)</Text>
                  <Input size="sm" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </VStack>
                <HStack justify="flex-end" gap={2} pt={2}>
                  <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                  <Button
                    size="sm"
                    colorPalette="orange"
                    onClick={() => void submit()}
                    disabled={!valid || busy}
                    loading={busy}
                  >
                    <Square size={14} />
                    <Text ml={1}>Stop</Text>
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─── Set-end-time dialog (forgot-prior workday) ───────────────────────────
function SetEndTimeDialog({
  workday,
  viewAsUserId,
  onClose,
  onSaved,
}: {
  workday: WorkdaySummary;
  /** When set, the endWorkday call operates on the impersonated
   *  worker's row instead of the caller's. Passed by WorkdayBanner
   *  in Admin/Super view-as mode. */
  viewAsUserId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Default the picker to 6pm ET on the same date the workday
  // started. `workday.workdayDate` comes from Prisma as an ISO
  // datetime (UTC midnight for the ET day) — passing that raw into
  // a datetime-local input produces garbage. Route through
  // bizDateKey to get the pure YYYY-MM-DD ET date, then build the
  // local input value directly.
  const workdayDateKey = bizDateKey(workday.workdayDate);
  const defaultEnd = `${workdayDateKey}T18:00`;
  const [when, setWhen] = useState(defaultEnd);
  const [busy, setBusy] = useState(false);

  // Client-side guard: end time must be strictly after start time,
  // otherwise the server rejects with a confusing error.
  const startedAtMs = new Date(workday.startedAt).getTime();
  const pickedMs = when ? new Date(bizParseLocalInputValue(when)).getTime() : NaN;
  const isBeforeStart = Number.isFinite(pickedMs) && pickedMs <= startedAtMs;

  async function submit() {
    if (isBeforeStart) return;
    setBusy(true);
    try {
      const endedIso = bizParseLocalInputValue(when);
      // Forgot-prior is still IN_PROGRESS — END it at the picked
      // time. editWorkdayTimes only accepts COMPLETED rows and
      // would reject with "Workday must be ended before editing
      // times". endWorkday accepts workdayId + endedAt.
      await endWorkday(
        { workdayId: workday.id, endedAt: endedIso },
        viewAsUserId ? { viewAsUserId } : undefined,
      );
      publishInlineMessage({ type: "SUCCESS", text: "End time set." });
      onSaved();
      onClose();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      role="alertdialog"
      open
      onOpenChange={(e) => { if (!e.open) onClose(); }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>
                Set end time — {fmtDateWeekday(bizDateKey(workday.workdayDate))}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Text fontSize="sm" color="fg.muted">
                  Pick when you actually finished. The gap between now and
                  this time is treated as off-the-clock, not payable hours.
                </Text>
                <VStack align="stretch" gap={1}>
                  <Text fontSize="sm" fontWeight="medium">
                    Ended at (started {fmtTimeOpts(workday.startedAt, { hour: "numeric", minute: "2-digit" })})
                  </Text>
                  <Input
                    size="sm"
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    autoFocus
                  />
                  {isBeforeStart && (
                    <Text fontSize="xs" color="red.600">
                      End time must be after the workday's start time.
                    </Text>
                  )}
                </VStack>
                <HStack justify="flex-end" gap={2} pt={2}>
                  <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                  <Button
                    size="sm"
                    colorPalette="orange"
                    onClick={() => void submit()}
                    disabled={!when || isBeforeStart || busy}
                    loading={busy}
                  >
                    <CheckCircle2 size={14} />
                    <Text ml={1}>Save</Text>
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─── Workday banner ────────────────────────────────────────────────────────
export function WorkdayBanner({ viewAsUserId }: { viewAsUserId?: string | null } = {}) {
  const { payload, loaded, reload } = useWorkdayToday(viewAsUserId);
  // Every mutation helper accepts { viewAsUserId } via the shared
  // AsParam type — see apps/web/src/lib/workday.ts. Kept in a single
  // const so every callsite below stays consistent.
  const asOpts = viewAsUserId ? { viewAsUserId } : undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const [setEndFor, setSetEndFor] = useState<WorkdaySummary | null>(null);

  async function run(kind: string, label: string, exec: () => Promise<unknown>) {
    setBusy(kind);
    try {
      await exec();
      publishInlineMessage({ type: "SUCCESS", text: `${label} succeeded.` });
      reload();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage(`${label} failed.`, err) });
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return <SkeletonBanner label="workday" />;
  if (!payload) return null;
  const state = payload.today.state;
  const openMileageCount = payload.openMileageEntries.length;
  const activeCheckoutCount = payload.activeCheckouts.length;
  const endBlocked = openMileageCount + activeCheckoutCount > 0;
  const blockerSummary = (() => {
    const parts: string[] = [];
    if (openMileageCount > 0) {
      parts.push(`${openMileageCount} mileage`);
    }
    if (activeCheckoutCount > 0) {
      parts.push(`${activeCheckoutCount} equipment`);
    }
    return parts.join(" + ");
  })();
  // Detail tiles shown when a workday banner is expanded. Kept in a
  // helper so IN_PROGRESS / PAUSED / COMPLETED share the layout.
  // Rendered as a responsive tile grid so label + value stay
  // adjacent regardless of viewport width.
  const workdayDetail = (w: WorkdaySummary) => (
    <SimpleGrid columns={STAT_GRID_COLS} gap={1.5}>
      <StatTile label="Started" value={fmtTimeOpts(w.startedAt, { hour: "numeric", minute: "2-digit" })} />
      {w.endedAt && (
        <StatTile label="Ended" value={fmtTimeOpts(w.endedAt, { hour: "numeric", minute: "2-digit" })} />
      )}
      <StatTile label="Active" value={fmtDuration(activeMs(w))} />
      {w.totalPausedMs > 0 && (
        <StatTile label="Paused" value={fmtDuration(w.totalPausedMs)} />
      )}
      <StatTile
        label="Jobs today"
        value={
          <>
            {payload.todayJobs.scheduled - payload.todayJobs.remaining} of {payload.todayJobs.scheduled}
            {payload.todayJobs.remaining > 0 ? ` (${payload.todayJobs.remaining} left)` : " (all done)"}
          </>
        }
      />
    </SimpleGrid>
  );
  // Pulse rules — mirror the shipped WorkdayStrip:
  //   forgot-prior      → always glow (action required)
  //   NOT_STARTED       → glow only when there are jobs scheduled today
  //   IN_PROGRESS       → glow only when all today's jobs are done
  //                       (time to clock out)
  //   PAUSED            → glow (needs resume or end)
  //   COMPLETED         → no glow
  const glowNotStarted = payload.todayJobs.remaining > 0;
  const glowInProgress = payload.todayJobs.scheduled > 0 && payload.todayJobs.remaining === 0;

  // End workday is always visible in the workday banner; when
  // something's blocking it (open mileage / active equipment
  // checkouts), the click surfaces a helpful inline message instead
  // of a permanent red banner sitting on the tab with no context.
  // The mileage/checkout banners below give the user the affordances
  // to actually resolve the block.
  function attemptEnd() {
    if (openMileageCount + activeCheckoutCount > 0) {
      const parts: string[] = [];
      if (openMileageCount > 0) {
        parts.push(`${openMileageCount} open mileage session${openMileageCount === 1 ? "" : "s"}`);
      }
      if (activeCheckoutCount > 0) {
        parts.push(`${activeCheckoutCount} active equipment checkout${activeCheckoutCount === 1 ? "" : "s"}`);
      }
      publishInlineMessage({
        type: "ERROR",
        text: `Can't end workday — close ${parts.join(" and ")} first.`,
      });
      return;
    }
    void run("end", "End workday", () => endWorkday({}, asOpts));
  }

  return (
    <>
      {payload.openPrior.length > 0 && (
        <CompactBanner
          palette="orange"
          icon={<AlertTriangle size={16} />}
          glow
          actions={[
            {
              label: "Set end time",
              icon: <Clock size={14} />,
              onClick: () => setSetEndFor(payload.openPrior[0]),
            },
          ]}
          expandedContent={
            <VStack align="stretch" gap={1}>
              <Text fontSize="xs" color="fg.muted">
                A workday you started but never formally ended. Tap
                "Set end time" to record when you actually finished
                — everything after that time is treated as
                off-the-clock, not payable hours.
              </Text>
              {payload.openPrior.map((w) => (
                <HStack key={w.id} justify="space-between">
                  <Text fontSize="sm" fontWeight="semibold">{fmtDateWeekday(bizDateKey(w.workdayDate))}</Text>
                  <Text fontSize="xs" color="fg.muted">
                    started {fmtTimeOpts(w.startedAt, { hour: "numeric", minute: "2-digit" })}
                  </Text>
                </HStack>
              ))}
            </VStack>
          }
        >
          You didn't end your workday on{" "}
          <Text as="span" fontWeight="semibold">
            {fmtDateWeekday(bizDateKey(payload.openPrior[0].workdayDate))}
          </Text>
          {payload.openPrior.length > 1 && (
            <Text as="span"> ({payload.openPrior.length - 1} more after this)</Text>
          )}
          .
        </CompactBanner>
      )}

      {state === "NOT_STARTED" && (() => {
        // Gate the Start button on any prior workday being closed
        // out first. Starting today's session while yesterday's is
        // still open leaves the user with two overlapping open
        // workdays — set the end time on the prior one before
        // opening a new session.
        const priorPending = payload.openPrior.length > 0;
        return (
        <CompactBanner
          palette="orange"
          icon={<Clock size={16} />}
          glow={glowNotStarted}
          expandedContent={
            <VStack align="stretch" gap={1}>
              <Text fontSize="xs" color="fg.muted">
                A workday is your on-the-clock session. Starting it is
                required before you can begin any job — Start-job on any
                card will prompt you to start the workday first if you
                haven't already.
              </Text>
              {priorPending && (
                <Text fontSize="xs" color="orange.700" fontWeight="medium">
                  Set the end time on your prior workday above before
                  starting a new one.
                </Text>
              )}
              <HStack justify="space-between" pt={1}>
                <Text fontSize="xs" color="fg.muted">Jobs today</Text>
                <Text fontSize="sm">
                  {payload.todayJobs.scheduled}
                  {payload.todayJobs.scheduled > 0 ? ` (${payload.todayJobs.remaining} remaining)` : ""}
                </Text>
              </HStack>
            </VStack>
          }
          actions={[
            {
              label: "Start",
              icon: <Play size={14} />,
              busy: busy === "start",
              disabled: priorPending,
              onClick: () => run("start", "Start workday", () => startWorkday({}, asOpts)),
            },
          ]}
        >
          <Text as="span" fontWeight="semibold">Workday not started.</Text>{" "}
          <Text as="span">
            {priorPending
              ? "Close out the prior workday above first."
              : "Required before you can begin any jobs."}
          </Text>
        </CompactBanner>
        );
      })()}

      {state === "IN_PROGRESS" && (
        <CompactBanner
          palette="blue"
          icon={<Play size={16} />}
          glow={glowInProgress}
          expandedContent={workdayDetail(payload.today.workday)}
          actions={[
            {
              label: "Pause",
              icon: <Pause size={14} />,
              variant: "outline",
              busy: busy === "pause",
              onClick: () => run("pause", "Pause workday", () => pauseWorkday(asOpts)),
            },
            {
              label: "End",
              icon: <Square size={14} />,
              busy: busy === "end",
              disabled: endBlocked,
              onClick: attemptEnd,
            },
          ]}
        >
          <Text as="span" fontWeight="semibold">On the clock</Text>{" "}
          <Text as="span">
            since {fmtTimeOpts(payload.today.workday.startedAt, { hour: "numeric", minute: "2-digit" })}
          </Text>
          {endBlocked && (
            <>
              {" · "}
              <Text as="span" color="red.700" fontWeight="semibold">
                End blocked ({blockerSummary} open below)
              </Text>
            </>
          )}
        </CompactBanner>
      )}

      {state === "PAUSED" && (
        <CompactBanner
          palette="yellow"
          icon={<Pause size={16} />}
          expandedContent={workdayDetail(payload.today.workday)}
          actions={[
            {
              label: "Resume",
              icon: <Play size={14} />,
              busy: busy === "resume",
              onClick: () => run("resume", "Resume workday", () => resumeWorkday(asOpts)),
            },
            {
              label: "End",
              icon: <Square size={14} />,
              variant: "outline",
              busy: busy === "end",
              disabled: endBlocked,
              onClick: attemptEnd,
            },
          ]}
        >
          <Text as="span" fontWeight="semibold">Workday paused.</Text>
          {endBlocked && (
            <>
              {" · "}
              <Text as="span" color="red.700" fontWeight="semibold">
                End blocked ({blockerSummary} open below)
              </Text>
            </>
          )}
        </CompactBanner>
      )}

      {state === "COMPLETED" && (
        <CompactBanner
          palette="gray"
          icon={<CheckCircle2 size={16} />}
          expandedContent={workdayDetail(payload.today.workday)}
          actions={[
            {
              label: "Restart",
              icon: <Play size={14} />,
              variant: "outline",
              palette: "blue",
              busy: busy === "reopen",
              onClick: () => run("reopen", "Restart workday", () => reopenWorkday(asOpts)),
            },
          ]}
        >
          <Text as="span" fontWeight="semibold">Workday complete.</Text>{" "}
          <Text as="span">
            Ended at {payload.today.workday.endedAt ? fmtTimeOpts(payload.today.workday.endedAt, { hour: "numeric", minute: "2-digit" }) : "—"}.
          </Text>
        </CompactBanner>
      )}

      {setEndFor && (
        <SetEndTimeDialog
          workday={setEndFor}
          viewAsUserId={viewAsUserId}
          onClose={() => setSetEndFor(null)}
          onSaved={reload}
        />
      )}
    </>
  );
}

// ─── Start-mileage dialog ─────────────────────────────────────────────────
type Vehicle = {
  id: string;
  displayName: string;
  currentOdometer?: number | null;
};

function StartMileageDialog({
  vehicles,
  onClose,
  onStarted,
}: {
  vehicles: Vehicle[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const [vehicleId, setVehicleId] = useState<string>(vehicles[0]?.id ?? "");
  const selected = vehicles.find((v) => v.id === vehicleId);
  const [odometer, setOdometer] = useState<string>(
    selected?.currentOdometer != null ? String(selected.currentOdometer) : "",
  );
  const [busy, setBusy] = useState(false);
  const valid = /^\d+$/.test(odometer.trim()) && !!vehicleId;

  // On mount, look up the caller's most-recent mileage entry so we
  // can default the picker to whatever vehicle they last drove.
  // Falls through to vehicles[0] if the endpoint returns nothing or
  // the last-driven vehicle is no longer in the available set (e.g.
  // it's currently mid-session on another vehicle).
  useEffect(() => {
    type MileageEntryRow = { vehicleId: string; startedAt: string };
    (async () => {
      try {
        const rows = await apiGet<MileageEntryRow[]>("/api/me/mileage");
        if (!Array.isArray(rows) || rows.length === 0) return;
        const sorted = [...rows].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
        for (const r of sorted) {
          if (vehicles.some((v) => v.id === r.vehicleId)) {
            pickVehicle(r.vehicleId);
            return;
          }
        }
      } catch { /* ignore — keep the vehicles[0] default */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickVehicle(id: string) {
    setVehicleId(id);
    const v = vehicles.find((x) => x.id === id);
    setOdometer(v?.currentOdometer != null ? String(v.currentOdometer) : "");
  }

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await apiPost("/api/me/mileage/start", {
        vehicleId,
        startOdometer: Number(odometer),
      });
      bumpWorkday();
      publishInlineMessage({ type: "SUCCESS", text: "Mileage session started." });
      onStarted();
      onClose();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Start failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  const vehicleCollection = createListCollection({
    items: vehicles.map((v) => ({ label: v.displayName, value: v.id })),
  });

  return (
    <Dialog.Root
      role="alertdialog"
      open
      onOpenChange={(e) => { if (!e.open) onClose(); }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>Start driving</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {vehicles.length > 1 && (
                  <VStack align="stretch" gap={1}>
                    <Text fontSize="sm" fontWeight="medium">Vehicle</Text>
                    <Select.Root
                      collection={vehicleCollection}
                      value={vehicleId ? [vehicleId] : []}
                      onValueChange={(e) => { const v = e.value?.[0]; if (v) pickVehicle(v); }}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Choose a vehicle" />
                          <Select.Indicator />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {vehicleCollection.items.map((item) => (
                            <Select.Item key={item.value} item={item.value}>
                              <Select.ItemText>{item.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </VStack>
                )}
                {vehicles.length === 1 && (
                  <Text fontSize="sm">{vehicles[0].displayName}</Text>
                )}
                <VStack align="stretch" gap={1}>
                  <Text fontSize="sm" fontWeight="medium">Starting odometer (mi)</Text>
                  <Input
                    size="sm"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={selected?.currentOdometer != null ? String(selected.currentOdometer) : "0"}
                    autoFocus
                  />
                </VStack>
                <HStack justify="flex-end" gap={2} pt={2}>
                  <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                  <Button
                    size="sm"
                    colorPalette="orange"
                    onClick={() => void submit()}
                    disabled={!valid || busy}
                    loading={busy}
                  >
                    <Play size={14} />
                    <Text ml={1}>Start</Text>
                  </Button>
                </HStack>
              </VStack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─── Mileage banner ────────────────────────────────────────────────────────
// One row per open session, PLUS a "Not driving" row when no session
// is open so the surface never disappears — otherwise the worker
// couldn't start a fresh session from this tab.
export function MileageBanner() {
  const { payload, loaded, reload } = useWorkdayToday();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stopFor, setStopFor] = useState<OpenMileageSummary | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [cancelFor, setCancelFor] = useState<OpenMileageSummary | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);

  // Refetch on mount, on focus, and whenever a workday/mileage
  // mutation broadcasts a change. Without the extra triggers, this
  // list can go stale — e.g., after a reseed or an admin assigning
  // a new vehicle mid-session — and the picker would render with
  // fewer options than the DB actually holds.
  const loadVehicles = useCallback(() => {
    apiGet<Vehicle[]>("/api/me/vehicles")
      .then((v) => setVehicles(Array.isArray(v) ? v : []))
      .catch(() => setVehicles([]));
  }, []);
  useEffect(() => { loadVehicles(); }, [loadVehicles]);
  useEffect(() => {
    const onChange = () => loadVehicles();
    window.addEventListener("seedlings:workday-changed", onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.removeEventListener("seedlings:workday-changed", onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [loadVehicles]);

  async function cancelEntry(entry: OpenMileageSummary) {
    setBusyId(entry.id);
    try {
      await apiPost(`/api/me/mileage/${entry.id}/cancel`, {});
      bumpWorkday();
      publishInlineMessage({ type: "SUCCESS", text: `Canceled ${entry.vehicleName} session.` });
      reload();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Cancel failed.", err) });
    } finally {
      setBusyId(null);
    }
  }

  if (!loaded) return <SkeletonBanner label="mileage" />;
  if (!payload) return null;
  const open = payload.openMileageEntries;
  const openVehicleIds = new Set(open.map((e) => e.vehicleId));
  const availableVehicles = vehicles.filter((v) => !openVehicleIds.has(v.id));

  // Nothing to render if the worker has no vehicles at all AND no
  // open session — matches the shipped MileageStrip's self-hide.
  if (open.length === 0 && vehicles.length === 0) return null;

  return (
    <>
      {open.map((entry) => (
        <CompactBanner
          key={entry.id}
          palette="orange"
          icon={<Car size={16} />}
          actions={[
            {
              label: "Cancel",
              icon: <X size={14} />,
              variant: "outline",
              palette: "red",
              busy: busyId === entry.id,
              onClick: () => setCancelFor(entry),
            },
            {
              label: "Stop",
              icon: <Square size={14} />,
              onClick: () => setStopFor(entry),
            },
          ]}
          expandedContent={
            <SimpleGrid columns={STAT_GRID_COLS} gap={1.5}>
              <StatTile label="Vehicle" value={entry.vehicleName} />
              <StatTile
                label="Started"
                value={fmtTimeOpts(entry.startedAt, { hour: "numeric", minute: "2-digit" })}
              />
              <StatTile
                label="Elapsed"
                value={fmtDuration(Date.now() - new Date(entry.startedAt).getTime())}
              />
              <StatTile
                label="Start odometer"
                value={`${entry.startOdometer.toLocaleString()} mi`}
              />
            </SimpleGrid>
          }
        >
          <Text as="span" fontWeight="semibold">Driving {entry.vehicleName}</Text>{" "}
          <Text as="span">· started at {entry.startOdometer.toLocaleString()} mi</Text>
        </CompactBanner>
      ))}

      {/* "Not driving" prompt only when no session is open at all —
          otherwise it read as contradictory alongside an active
          "Driving X" row above. If you want to start a second
          concurrent session for a different vehicle, that flow lives
          on the Home tab's shipped MileageStrip. */}
      {open.length === 0 && availableVehicles.length > 0 && (
        <CompactBanner
          palette="gray"
          icon={<Car size={16} />}
          actions={[
            {
              label: "Start",
              icon: <Play size={14} />,
              palette: "orange",
              onClick: () => setStartOpen(true),
            },
          ]}
          expandedContent={
            <VStack align="stretch" gap={1}>
              <Text fontSize="xs" color="fg.muted">
                Starting a mileage session logs the miles you drive between
                jobs. Enter your ending odometer when you Stop and the
                session is submitted for approval alongside the workday.
              </Text>
              <HStack justify="space-between" pt={1}>
                <Text fontSize="xs" color="fg.muted">Vehicles you can drive</Text>
                <Text fontSize="sm">{availableVehicles.length}</Text>
              </HStack>
              {availableVehicles.map((v) => (
                <HStack key={v.id} justify="space-between">
                  <Text fontSize="sm">{v.displayName}</Text>
                  {v.currentOdometer != null && (
                    <Text fontSize="xs" color="fg.muted">
                      {v.currentOdometer.toLocaleString()} mi
                    </Text>
                  )}
                </HStack>
              ))}
            </VStack>
          }
        >
          <Text as="span" fontWeight="semibold">Not driving.</Text>{" "}
          <Text as="span">Start a mileage session when you head out.</Text>
        </CompactBanner>
      )}

      {stopFor && (
        <StopMileageDialog
          entry={stopFor}
          onClose={() => setStopFor(null)}
          onStopped={reload}
        />
      )}
      {startOpen && (
        <StartMileageDialog
          vehicles={availableVehicles}
          onClose={() => setStartOpen(false)}
          onStarted={reload}
        />
      )}
      <ConfirmDialog
        open={!!cancelFor}
        title="Cancel mileage session?"
        message={cancelFor
          ? `Cancel the ${cancelFor.vehicleName} session? This deletes the session — no miles will be recorded.`
          : ""}
        confirmLabel="Cancel session"
        confirmColorPalette="red"
        onConfirm={() => {
          const entry = cancelFor;
          setCancelFor(null);
          if (entry) void cancelEntry(entry);
        }}
        onCancel={() => setCancelFor(null)}
      />
    </>
  );
}
