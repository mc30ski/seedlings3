"use client";

// MileageStrip — worker-side start/stop mileage recording. Mounts on
// HomeTab beneath the WorkdayStrip. Renders nothing when the worker
// has no vehicle assignments (so unassigned workers don't see empty
// UI). Mirrors the WorkdayStrip's visual shape at a smaller scale.
//
// Flow:
//   1. Worker taps Start → picks vehicle (skipped when only one is
//      assigned) → enters starting odometer → session opens.
//   2. Session card shows: vehicle name, live duration since Start.
//   3. Worker taps Stop → enters ending odometer → optional note
//      (defaults to "Using vehicle to service lawns") → session
//      closes and moves into the day's log.
//
// Multiple sessions per day are allowed. Approvals happen daily on
// the Super side; this component only surfaces the driver-side flow.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  createListCollection,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Car, Play, StopCircle, X } from "lucide-react";
import { apiGet, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

const DEFAULT_NOTE = "Using vehicle to service lawns";

type Vehicle = {
  id: string;
  displayName: string;
  make?: string | null;
  vehicleModel?: string | null;
  year?: number | null;
  currentOdometer?: number | null;
};

type OpenEntry = {
  id: string;
  vehicleId: string;
  startedAt: string;
  startOdometer: number;
  vehicle: Vehicle;
};

export default function MileageStrip({
  embedded = false,
  compact = false,
}: {
  /** When true, MileageStrip renders without its own outer border/bg
   *  and instead attaches to whatever card contains it — used on
   *  HomeTab to combine visually with WorkdayStrip so the two sections
   *  read as one grouped area. Only a top divider separates them.
   *
   *  Collapse behavior in embedded mode is handled by the CONTAINING
   *  WorkdayCard: it wraps mileageSlot in a display:none Box on the
   *  collapsed row (so this component stays mounted across the
   *  collapse/expand cycle and its fetched vehicle list survives). */
  embedded?: boolean;
  /** Compact mode — renders only a small vehicle icon button that
   *  opens a quick-pick modal listing all start/stop actions. Used
   *  on the COLLAPSED WorkdayStrip row so a worker can start or stop
   *  driving without expanding. Bypasses the `embedded` styling
   *  (no container padding); returns null when the worker has no
   *  vehicles + no open sessions. */
  compact?: boolean;
} = {}) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [openEntries, setOpenEntries] = useState<OpenEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Which vehicle is the "start" dialog for. null = dialog closed.
  const [startDialog, setStartDialog] = useState<Vehicle | null>(null);
  // Which open entry is the "stop" dialog for. null = dialog closed.
  const [stopDialog, setStopDialog] = useState<OpenEntry | null>(null);
  // Compact-mode picker (small modal with the Start/Stop buttons).
  // Only used when `compact` is true — full-mode renders those buttons
  // inline instead.
  const [compactPickerOpen, setCompactPickerOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [vs, opens] = await Promise.all([
        apiGet<Vehicle[]>("/api/me/vehicles"),
        apiGet<OpenEntry[]>("/api/me/mileage/open"),
      ]);
      setVehicles(Array.isArray(vs) ? vs : []);
      setOpenEntries(Array.isArray(opens) ? opens : []);
    } catch {
      // Silent fail — the strip either doesn't render (no vehicles)
      // or shows a "reload" prompt. No point in a toast for a
      // background poll.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Self-hide when the worker has no assigned vehicles AND no open
  // sessions. Open sessions always render so a driver never loses
  // access to a Stop button, even if their assignment was revoked
  // mid-drive.
  if (loading) return null;
  if (vehicles.length === 0 && openEntries.length === 0) return null;

  // Vehicles that don't currently have an open session — those are
  // eligible for a new Start.
  const vehiclesWithoutOpenSession = vehicles.filter(
    (v) => !openEntries.some((o) => o.vehicleId === v.id),
  );

  // Compact render — small icon button + a single unified dialog that
  // handles vehicle-pick AND odometer input in one flow (no cross-
  // dialog transitions). Used by the collapsed WorkdayStrip so a
  // worker can start/stop driving without expanding.
  if (compact) {
    const hasOpen = openEntries.length > 0;
    return (
      <>
        {/* Filled circular icon button — matches the visual weight of
            the workday state icon (the solid orange/green/yellow circle
            on the left of the strip). Solid orange stays consistent
            with the rest of the mileage UI; a small white indicator
            ring signals the active "you're currently driving" state
            without introducing a second color that clashes with the
            workday backgrounds. */}
        <Box
          as="button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            setCompactPickerOpen(true);
          }}
          title={hasOpen ? "Stop driving" : "Start driving"}
          aria-label={hasOpen ? "Stop driving" : "Start driving"}
          display="flex"
          alignItems="center"
          justifyContent="center"
          p={1}
          borderRadius="full"
          cursor="pointer"
          color="white"
          bg="orange.600"
          transition="all 0.15s"
          _hover={{
            bg: "orange.700",
            transform: "scale(1.08)",
          }}
          position="relative"
          flexShrink={0}
        >
          <Car size={18} strokeWidth={2.2} />
          {hasOpen && (
            // Active-session indicator dot — white ring on orange so
            // the "you're currently driving" state reads at a glance
            // without introducing a second color that clashes with the
            // workday-state backgrounds.
            <Box
              position="absolute"
              top="-2px"
              right="-2px"
              w="10px"
              h="10px"
              bg="white"
              borderRadius="full"
              border="2px solid var(--chakra-colors-orange-700)"
            />
          )}
        </Box>
        {compactPickerOpen && (
          <CompactMileageDialog
            openEntries={openEntries}
            vehiclesWithoutOpenSession={vehiclesWithoutOpenSession}
            onClose={() => setCompactPickerOpen(false)}
            onDone={() => {
              setCompactPickerOpen(false);
              void load();
            }}
          />
        )}
      </>
    );
  }

  return (
    <Box
      borderWidth={embedded ? undefined : "1px"}
      borderColor={embedded ? "blackAlpha.200" : "gray.200"}
      borderRadius={embedded ? undefined : "lg"}
      borderTopWidth={embedded ? "1px" : undefined}
      borderTopStyle={embedded ? "dashed" : undefined}
      p={embedded ? 0 : 3}
      pt={embedded ? 3 : 3}
      mb={embedded ? 0 : 3}
      mt={embedded ? 3 : 0}
      bg={embedded ? undefined : "white"}
    >
      <HStack gap={2} mb={2} align="center">
        <Car size={16} />
        <Text fontSize="sm" fontWeight="semibold">Mileage</Text>
      </HStack>

      {/* Open sessions — one card per active drive. */}
      <VStack align="stretch" gap={2}>
        {openEntries.map((entry) => (
          <OpenSessionCard
            key={entry.id}
            entry={entry}
            onStop={() => setStopDialog(entry)}
            onCanceled={() => void load()}
          />
        ))}

        {/* Start row — one Start button per non-open vehicle. When
            only one vehicle is available and no session is open, the
            row reads "Start driving <name>". */}
        {vehiclesWithoutOpenSession.length > 0 && (
          <>
            <HStack gap={2} wrap="wrap">
              {vehiclesWithoutOpenSession.map((v) => (
                <Button
                  key={v.id}
                  size="sm"
                  variant="outline"
                  colorPalette="orange"
                  onClick={() => setStartDialog(v)}
                >
                  <Play size={12} />
                  <Text ml={1}>Start {v.displayName}</Text>
                </Button>
              ))}
            </HStack>
            {/* Usage hint — a session covers the whole day's route,
                not each individual job. If the worker stops between
                properties for less than 30 minutes and taps Start
                back at the same odometer, the server auto-continues
                the previous session instead of creating a new row. */}
            <Text fontSize="2xs" color="fg.muted" mt={0.5}>
              Start once when you leave, Stop when you're done for the day. You don't need to Stop between jobs.
            </Text>
          </>
        )}
      </VStack>

      {startDialog && (
        <StartDialog
          vehicle={startDialog}
          onClose={() => setStartDialog(null)}
          onStarted={() => {
            setStartDialog(null);
            void load();
          }}
        />
      )}
      {stopDialog && (
        <StopDialog
          entry={stopDialog}
          onClose={() => setStopDialog(null)}
          onStopped={() => {
            setStopDialog(null);
            void load();
          }}
        />
      )}
    </Box>
  );
}

function OpenSessionCard({
  entry,
  onStop,
  onCanceled,
}: {
  entry: OpenEntry;
  onStop: () => void;
  onCanceled: () => void;
}) {
  // Live elapsed timer — updates every 30s so the strip doesn't
  // burn cycles for a value that's ~minute-granularity anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = formatElapsed(now - new Date(entry.startedAt).getTime());
  const [canceling, setCanceling] = useState(false);
  async function cancel() {
    // Confirm — cancel deletes the row entirely (backend /cancel
    // endpoint hard-deletes since no odometer was ever recorded). No
    // undo, so a two-tap confirm is worth the extra step. Users hit
    // this most often after picking the wrong vehicle at Start.
    if (!window.confirm(
      `Cancel the ${entry.vehicle.displayName} session? This deletes the session — no miles will be recorded.`,
    )) return;
    setCanceling(true);
    try {
      await apiPost(`/api/me/mileage/${entry.id}/cancel`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: `Canceled ${entry.vehicle.displayName} session.`,
      });
      onCanceled();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't cancel session.", err),
      });
    } finally {
      setCanceling(false);
    }
  }
  return (
    <HStack
      justify="space-between"
      align="center"
      p={2}
      borderWidth="1px"
      borderColor="orange.200"
      bg="orange.50"
      borderRadius="md"
      gap={2}
      wrap="wrap"
    >
      <VStack align="start" gap={0} flex={1} minW={0}>
        <HStack gap={2}>
          <Badge colorPalette="orange" variant="solid" fontSize="2xs">Driving</Badge>
          <Text fontSize="sm" fontWeight="semibold">{entry.vehicle.displayName}</Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          Started at {entry.startOdometer.toLocaleString()} mi · {elapsed}
        </Text>
      </VStack>
      <HStack gap={1} flexShrink={0}>
        <Button
          size="xs"
          variant="ghost"
          colorPalette="red"
          onClick={cancel}
          loading={canceling}
          title="Cancel this session (deletes it — use if you picked the wrong vehicle)"
        >
          <X size={12} />
          <Text ml={1}>Cancel</Text>
        </Button>
        <Button size="sm" variant="outline" colorPalette="orange" onClick={onStop}>
          <StopCircle size={14} />
          <Text ml={1}>Stop</Text>
        </Button>
      </HStack>
    </HStack>
  );
}

function StartDialog({
  vehicle,
  onClose,
  onStarted,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [odometer, setOdometer] = useState(
    vehicle.currentOdometer != null ? String(vehicle.currentOdometer) : "",
  );
  const [busy, setBusy] = useState(false);
  const valid = /^\d+$/.test(odometer.trim());

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await apiPost("/api/me/mileage/start", {
        vehicleId: vehicle.id,
        startOdometer: Number(odometer),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Mileage session started." });
      onStarted();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't start session.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>Start driving {vehicle.displayName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>
                    Starting odometer reading
                  </Text>
                  <Input
                    autoFocus
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder="e.g. 48231"
                  />
                </Box>
                <Text fontSize="2xs" color="fg.muted">
                  Snap a quick mental note of the exact number on the dash before you drive.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button colorPalette="orange" onClick={submit} loading={busy} disabled={!valid}>
                  Start
                </Button>
              </HStack>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="xs" position="absolute" top={2} right={2}>
                <X size={14} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function StopDialog({
  entry,
  onClose,
  onStopped,
}: {
  entry: OpenEntry;
  onClose: () => void;
  onStopped: () => void;
}) {
  const [odometer, setOdometer] = useState("");
  const [notes, setNotes] = useState(DEFAULT_NOTE);
  const [busy, setBusy] = useState(false);
  const endNum = Number(odometer);
  const valid =
    /^\d+$/.test(odometer.trim()) && endNum >= entry.startOdometer;
  const miles = valid ? endNum - entry.startOdometer : null;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      await apiPost(`/api/me/mileage/${entry.id}/stop`, {
        endOdometer: endNum,
        notes,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Recorded ${miles} mi on ${entry.vehicle.displayName}.`,
      });
      onStopped();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't stop session.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(
      `Cancel the ${entry.vehicle.displayName} session? This deletes the session — no miles will be recorded.`,
    )) return;
    setBusy(true);
    try {
      await apiPost(`/api/me/mileage/${entry.id}/cancel`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: `Canceled ${entry.vehicle.displayName} session.`,
      });
      onStopped();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't cancel session.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(e) => { if (!e.open) onClose(); }} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>Stop {entry.vehicle.displayName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>
                    Ending odometer reading
                  </Text>
                  <Input
                    autoFocus
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value.replace(/[^\d]/g, ""))}
                    placeholder={`≥ ${entry.startOdometer.toLocaleString()}`}
                  />
                  {odometer && !valid && (
                    <Text fontSize="2xs" color="red.600" mt={1}>
                      Must be a whole number, not less than the starting odometer ({entry.startOdometer.toLocaleString()}).
                    </Text>
                  )}
                </Box>
                <Box>
                  <Text fontSize="xs" color="fg.muted" mb={1}>
                    Note (optional)
                  </Text>
                  <Input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={DEFAULT_NOTE}
                  />
                </Box>
                {miles != null && (
                  <HStack justify="space-between" bg="gray.50" p={2} borderRadius="md">
                    <Text fontSize="xs" color="fg.muted">Session miles</Text>
                    <Text fontSize="sm" fontWeight="semibold">{miles.toLocaleString()} mi</Text>
                  </HStack>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="space-between">
                <Button variant="ghost" colorPalette="red" onClick={cancel} disabled={busy} title="Cancel this session — deletes it without recording miles">
                  <X size={12} />
                  <Text ml={1}>Cancel session</Text>
                </Button>
                <HStack gap={2}>
                  <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
                  <Button colorPalette="orange" onClick={submit} loading={busy} disabled={!valid}>
                    Stop &amp; save
                  </Button>
                </HStack>
              </HStack>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <Button variant="ghost" size="xs" position="absolute" top={2} right={2}>
                <X size={14} />
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}

// Compact-mode picker dialog used by the collapsed WorkdayStrip. A
// SINGLE Chakra Dialog that handles both steps of the flow:
//   Step 1 ("pick") — choose which vehicle to Start or which session
//                     to Stop. Skipped automatically when there's
//                     exactly one option available.
//   Step 2 ("start") — enter starting odometer for the picked vehicle.
//   Step 2 ("stop")  — enter ending odometer + note for the picked
//                     session.
//
// Rewritten from a two-dialog approach (picker Dialog → separate
// Start/Stop Dialog) because Chakra v3's focus-management races when
// the second Dialog's Portal mounts while the first is still
// unmounting — clicks get eaten and the user sees nothing.
function CompactMileageDialog({
  openEntries,
  vehiclesWithoutOpenSession,
  onClose,
  onDone,
}: {
  openEntries: OpenEntry[];
  vehiclesWithoutOpenSession: Vehicle[];
  onClose: () => void;
  onDone: () => void;
}) {
  // If there's exactly one thing to do, skip the picker step entirely
  // and open the odometer step directly. Most workers have one vehicle
  // — no need to click through a picker with one item.
  const initialStep: Step = (() => {
    if (openEntries.length === 1 && vehiclesWithoutOpenSession.length === 0) {
      return { kind: "stop", entry: openEntries[0] };
    }
    if (vehiclesWithoutOpenSession.length === 1 && openEntries.length === 0) {
      return { kind: "start", vehicle: vehiclesWithoutOpenSession[0] };
    }
    return { kind: "pick" };
  })();
  type Step =
    | { kind: "pick" }
    | { kind: "start"; vehicle: Vehicle }
    | { kind: "stop"; entry: OpenEntry };

  const [step, setStep] = useState<Step>(initialStep);
  const [startOdo, setStartOdo] = useState<string>("");
  const [stopOdo, setStopOdo] = useState<string>("");
  const [notes, setNotes] = useState<string>(DEFAULT_NOTE);
  const [busy, setBusy] = useState(false);

  // Prefill starting odometer from vehicle.currentOdometer whenever we
  // enter the start step for a new vehicle. Runs on step change.
  useEffect(() => {
    if (step.kind === "start") {
      setStartOdo(
        step.vehicle.currentOdometer != null ? String(step.vehicle.currentOdometer) : "",
      );
    }
    if (step.kind === "stop") {
      setStopOdo("");
      setNotes(DEFAULT_NOTE);
    }
  }, [step]);

  const startValid = /^\d+$/.test(startOdo.trim());
  const stopEndNum = Number(stopOdo);
  const stopValid =
    step.kind === "stop" &&
    /^\d+$/.test(stopOdo.trim()) &&
    stopEndNum >= step.entry.startOdometer;
  const stopMiles = stopValid && step.kind === "stop" ? stopEndNum - step.entry.startOdometer : null;

  async function submitStart() {
    if (step.kind !== "start" || !startValid) return;
    setBusy(true);
    try {
      await apiPost("/api/me/mileage/start", {
        vehicleId: step.vehicle.id,
        startOdometer: Number(startOdo),
      });
      publishInlineMessage({ type: "SUCCESS", text: "Mileage session started." });
      onDone();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't start session.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitStop() {
    if (step.kind !== "stop" || !stopValid) return;
    setBusy(true);
    try {
      await apiPost(`/api/me/mileage/${step.entry.id}/stop`, {
        endOdometer: stopEndNum,
        notes,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Recorded ${stopMiles} mi on ${step.entry.vehicle.displayName}.`,
      });
      onDone();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't stop session.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancelStop() {
    if (step.kind !== "stop") return;
    if (!window.confirm(
      `Cancel the ${step.entry.vehicle.displayName} session? This deletes the session — no miles will be recorded.`,
    )) return;
    setBusy(true);
    try {
      await apiPost(`/api/me/mileage/${step.entry.id}/cancel`, {});
      publishInlineMessage({
        type: "SUCCESS",
        text: `Canceled ${step.entry.vehicle.displayName} session.`,
      });
      onDone();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't cancel session.", err),
      });
    } finally {
      setBusy(false);
    }
  }

  const title =
    step.kind === "pick"
      ? "Mileage"
      : step.kind === "start"
        ? `Start driving ${step.vehicle.displayName}`
        : `Stop ${step.entry.vehicle.displayName}`;

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => { if (!e.open && !busy) onClose(); }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="sm" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {step.kind === "pick" && (
                <VStack align="stretch" gap={2}>
                  {openEntries.map((entry) => (
                    <Button
                      key={entry.id}
                      size="md"
                      variant="outline"
                      colorPalette="orange"
                      justifyContent="flex-start"
                      onClick={() => setStep({ kind: "stop", entry })}
                    >
                      <StopCircle size={16} />
                      <Text ml={2}>Stop {entry.vehicle.displayName}</Text>
                    </Button>
                  ))}
                  {vehiclesWithoutOpenSession.map((v) => (
                    <Button
                      key={v.id}
                      size="md"
                      variant="outline"
                      colorPalette="orange"
                      justifyContent="flex-start"
                      onClick={() => setStep({ kind: "start", vehicle: v })}
                    >
                      <Play size={16} />
                      <Text ml={2}>Start {v.displayName}</Text>
                    </Button>
                  ))}
                </VStack>
              )}

              {step.kind === "start" && (
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="xs" color="fg.muted" mb={1}>
                      Starting odometer reading
                    </Text>
                    <Input
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={startOdo}
                      onChange={(e) => setStartOdo(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="e.g. 48231"
                    />
                  </Box>
                  <Text fontSize="2xs" color="fg.muted">
                    Snap a quick mental note of the exact number on the dash before you drive.
                  </Text>
                </VStack>
              )}

              {step.kind === "stop" && (
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="xs" color="fg.muted" mb={1}>
                      Ending odometer reading
                    </Text>
                    <Input
                      autoFocus
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={stopOdo}
                      onChange={(e) => setStopOdo(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder={`≥ ${step.entry.startOdometer.toLocaleString()}`}
                    />
                    {stopOdo && !stopValid && (
                      <Text fontSize="2xs" color="red.600" mt={1}>
                        Must be a whole number, not less than the starting odometer ({step.entry.startOdometer.toLocaleString()}).
                      </Text>
                    )}
                  </Box>
                  <Box>
                    <Text fontSize="xs" color="fg.muted" mb={1}>
                      Note (optional)
                    </Text>
                    <Input
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder={DEFAULT_NOTE}
                    />
                  </Box>
                  {stopMiles != null && (
                    <HStack justify="space-between" bg="gray.50" p={2} borderRadius="md">
                      <Text fontSize="xs" color="fg.muted">Session miles</Text>
                      <Text fontSize="sm" fontWeight="semibold">{stopMiles.toLocaleString()} mi</Text>
                    </HStack>
                  )}
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                {step.kind === "pick" ? (
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                ) : (
                  <>
                    {/* Back to picker only when we actually had a picker
                        step (i.e. multiple options were available). */}
                    {(openEntries.length + vehiclesWithoutOpenSession.length) > 1 && (
                      <Button
                        variant="ghost"
                        onClick={() => setStep({ kind: "pick" })}
                        disabled={busy}
                      >
                        Back
                      </Button>
                    )}
                    <Button variant="ghost" onClick={onClose} disabled={busy}>
                      Cancel
                    </Button>
                    {step.kind === "start" && (
                      <Button
                        colorPalette="orange"
                        onClick={submitStart}
                        loading={busy}
                        disabled={!startValid}
                      >
                        Start
                      </Button>
                    )}
                    {step.kind === "stop" && (
                      <>
                        <Button
                          variant="ghost"
                          colorPalette="red"
                          onClick={cancelStop}
                          disabled={busy}
                          title="Cancel this session — deletes it without recording miles"
                        >
                          <X size={12} />
                          <Text ml={1}>Cancel session</Text>
                        </Button>
                        <Button
                          colorPalette="orange"
                          onClick={submitStop}
                          loading={busy}
                          disabled={!stopValid}
                        >
                          Stop &amp; save
                        </Button>
                      </>
                    )}
                  </>
                )}
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
