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

export default function MileageStrip() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [openEntries, setOpenEntries] = useState<OpenEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Which vehicle is the "start" dialog for. null = dialog closed.
  const [startDialog, setStartDialog] = useState<Vehicle | null>(null);
  // Which open entry is the "stop" dialog for. null = dialog closed.
  const [stopDialog, setStopDialog] = useState<OpenEntry | null>(null);

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

  return (
    <Box
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      p={3}
      mb={3}
      bg="white"
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
                  colorPalette="teal"
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
}: {
  entry: OpenEntry;
  onStop: () => void;
}) {
  // Live elapsed timer — updates every 30s so the strip doesn't
  // burn cycles for a value that's ~minute-granularity anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = formatElapsed(now - new Date(entry.startedAt).getTime());
  return (
    <HStack
      justify="space-between"
      align="center"
      p={2}
      borderWidth="1px"
      borderColor="teal.200"
      bg="teal.50"
      borderRadius="md"
    >
      <VStack align="start" gap={0}>
        <HStack gap={2}>
          <Badge colorPalette="teal" variant="solid" fontSize="2xs">Driving</Badge>
          <Text fontSize="sm" fontWeight="semibold">{entry.vehicle.displayName}</Text>
        </HStack>
        <Text fontSize="xs" color="fg.muted">
          Started at {entry.startOdometer.toLocaleString()} mi · {elapsed}
        </Text>
      </VStack>
      <Button size="sm" colorPalette="teal" onClick={onStop}>
        <StopCircle size={14} />
        <Text ml={1}>Stop</Text>
      </Button>
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
                <Button colorPalette="teal" onClick={submit} loading={busy} disabled={!valid}>
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
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" onClick={submit} loading={busy} disabled={!valid}>
                  Stop &amp; save
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

function formatElapsed(ms: number): string {
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
}
