"use client";

// Super → Equipment → Vehicles.
//
// Admin surface for the fleet of dual-use vehicles (personal-owned,
// used partly for business). Super manages:
//   • Vehicle list (add / edit / archive / unarchive)
//   • Worker assignments (who can log mileage against which vehicle)
//   • Mileage log per vehicle (edit odometers, approve / unapprove
//     individual entries)
//
// Approval also flows through the unified daily approval UX
// (Workday + Mileage in one shot); this tab is the fallback for
// making corrections outside that flow.

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
  Spinner,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { bizToday, bizAddDays } from "@/src/lib/lib";
import MileageReviewDialog, { type MileageReviewEntry } from "@/src/ui/dialogs/MileageReviewDialog";
import StatusChip from "@/src/ui/components/StatusChip";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Vehicle = {
  id: string;
  displayName: string;
  make: string | null;
  vehicleModel: string | null;
  year: number | null;
  plate: string | null;
  inServiceDate: string | null;
  currentOdometer: number | null;
  archivedAt: string | null;
  assignments: Array<{
    id: string;
    userId: string;
    user: { id: string; displayName: string | null; email: string | null; workerType: string | null };
  }>;
};

type MileageEntry = {
  id: string;
  vehicleId: string;
  driverUserId: string;
  entryDate: string;
  startedAt: string;
  endedAt: string | null;
  startOdometer: number;
  endOdometer: number | null;
  miles: number | null;
  notes: string | null;
  approvedAt: string | null;
  driver: { id: string; displayName: string | null; email: string | null };
  approver: { id: string; displayName: string | null } | null;
};

type WorkerLite = { id: string; displayName: string | null; email: string | null };

export default function VehiclesTab() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [assigningVehicle, setAssigningVehicle] = useState<Vehicle | null>(null);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiGet<Vehicle[]>(
        `/api/super/vehicles${showArchived ? "?includeArchived=true" : ""}`,
      );
      setVehicles(Array.isArray(list) ? list : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load vehicles.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    // Worker directory — used by the assign dialog. Load once.
    apiGet<any[]>("/api/admin/users?includeInactive=false")
      .then((raw) => {
        if (!Array.isArray(raw)) return;
        setWorkers(
          raw.map((u) => ({
            id: u.id,
            displayName: u.displayName ?? u.name ?? null,
            email: u.email ?? null,
          })),
        );
      })
      .catch(() => {});
  }, []);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <VStack align="stretch" gap={3} p={3}>
      <HStack justify="space-between">
        <Text fontSize="lg" fontWeight="semibold">Vehicles</Text>
        <HStack gap={2}>
          <Button
            size="sm"
            variant={showArchived ? "solid" : "outline"}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" colorPalette="teal" onClick={() => setAddDialogOpen(true)}>
            <Plus size={14} />
            <Text ml={1}>Add vehicle</Text>
          </Button>
        </HStack>
      </HStack>

      {loading ? (
        <HStack justify="center" py={8}><Spinner /></HStack>
      ) : vehicles.length === 0 ? (
        <Box p={6} textAlign="center" color="fg.muted">
          <Text fontSize="sm">No vehicles yet.</Text>
          <Text fontSize="xs" mt={1}>Add one to start tracking business mileage.</Text>
        </Box>
      ) : (
        <Table.Root variant="outline" size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader w="24px" />
              <Table.ColumnHeader>Vehicle</Table.ColumnHeader>
              <Table.ColumnHeader>Make / Model</Table.ColumnHeader>
              <Table.ColumnHeader>Current odo</Table.ColumnHeader>
              <Table.ColumnHeader>Assigned</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {vehicles.map((v) => (
              <VehicleRow
                key={v.id}
                vehicle={v}
                expanded={expanded.has(v.id)}
                onToggle={() => toggle(v.id)}
                onEdit={() => setEditing(v)}
                onAssign={() => setAssigningVehicle(v)}
                onArchive={async () => {
                  try {
                    await apiPost(`/api/super/vehicles/${v.id}/archive`);
                    publishInlineMessage({ type: "SUCCESS", text: "Vehicle archived." });
                    void load();
                  } catch (err) {
                    publishInlineMessage({
                      type: "ERROR",
                      text: getErrorMessage("Archive failed.", err),
                    });
                  }
                }}
                onUnarchive={async () => {
                  try {
                    await apiPost(`/api/super/vehicles/${v.id}/unarchive`);
                    publishInlineMessage({ type: "SUCCESS", text: "Vehicle restored." });
                    void load();
                  } catch (err) {
                    publishInlineMessage({
                      type: "ERROR",
                      text: getErrorMessage("Restore failed.", err),
                    });
                  }
                }}
                onUnassign={async (userId) => {
                  try {
                    await apiPost(`/api/super/vehicles/${v.id}/unassign`, { userId });
                    publishInlineMessage({ type: "SUCCESS", text: "Assignment removed." });
                    void load();
                  } catch (err) {
                    publishInlineMessage({
                      type: "ERROR",
                      text: getErrorMessage("Unassign failed.", err),
                    });
                  }
                }}
              />
            ))}
          </Table.Body>
        </Table.Root>
      )}

      {addDialogOpen && (
        <EditVehicleDialog
          onClose={() => setAddDialogOpen(false)}
          onSaved={() => {
            setAddDialogOpen(false);
            void load();
          }}
        />
      )}
      {editing && (
        <EditVehicleDialog
          vehicle={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {assigningVehicle && (
        <AssignWorkerDialog
          vehicle={assigningVehicle}
          workers={workers}
          onClose={() => setAssigningVehicle(null)}
          onSaved={() => {
            setAssigningVehicle(null);
            void load();
          }}
        />
      )}
    </VStack>
  );
}

function VehicleRow({
  vehicle,
  expanded,
  onToggle,
  onEdit,
  onAssign,
  onArchive,
  onUnarchive,
  onUnassign,
}: {
  vehicle: Vehicle;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onAssign: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onUnassign: (userId: string) => void;
}) {
  const modelLine = [vehicle.year, vehicle.make, vehicle.vehicleModel]
    .filter(Boolean)
    .join(" ") || "—";
  return (
    <>
      <Table.Row>
        <Table.Cell>
          <Button size="xs" variant="ghost" onClick={onToggle} p={1}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </Button>
        </Table.Cell>
        <Table.Cell>
          <Text fontWeight="semibold">{vehicle.displayName}</Text>
          {vehicle.plate && (
            <Text fontSize="2xs" color="fg.muted">{vehicle.plate}</Text>
          )}
        </Table.Cell>
        <Table.Cell>
          <Text fontSize="sm">{modelLine}</Text>
        </Table.Cell>
        <Table.Cell>
          <Text fontSize="sm">
            {vehicle.currentOdometer != null
              ? `${vehicle.currentOdometer.toLocaleString()} mi`
              : "—"}
          </Text>
        </Table.Cell>
        <Table.Cell>
          <HStack gap={1} flexWrap="wrap">
            {vehicle.assignments.length === 0 ? (
              <Text fontSize="xs" color="fg.muted">Nobody</Text>
            ) : (
              vehicle.assignments.map((a) => (
                <Badge
                  key={a.id}
                  variant="subtle"
                  colorPalette="blue"
                  fontSize="2xs"
                  px={2}
                  gap={1}
                >
                  {a.user.displayName ?? a.user.email ?? a.userId}
                  <Box
                    as="button"
                    onClick={() => onUnassign(a.userId)}
                    color="blue.700"
                    _hover={{ color: "red.500" }}
                    ml={1}
                  >
                    <X size={10} />
                  </Box>
                </Badge>
              ))
            )}
          </HStack>
        </Table.Cell>
        <Table.Cell>
          {vehicle.archivedAt ? (
            <Badge colorPalette="gray" variant="subtle" fontSize="2xs">Archived</Badge>
          ) : (
            <Badge colorPalette="green" variant="subtle" fontSize="2xs">Active</Badge>
          )}
        </Table.Cell>
        <Table.Cell>
          <HStack gap={1} justify="flex-end">
            <Button size="xs" variant="ghost" onClick={onAssign} title="Assign worker">
              <UserPlus size={12} />
            </Button>
            <Button size="xs" variant="ghost" onClick={onEdit} title="Edit vehicle">
              <Pencil size={12} />
            </Button>
            {vehicle.archivedAt ? (
              <Button size="xs" variant="ghost" onClick={onUnarchive} title="Restore">
                <ArchiveRestore size={12} />
              </Button>
            ) : (
              <Button size="xs" variant="ghost" colorPalette="red" onClick={onArchive} title="Archive">
                <Archive size={12} />
              </Button>
            )}
          </HStack>
        </Table.Cell>
      </Table.Row>
      {expanded && (
        <Table.Row>
          <Table.Cell colSpan={7} bg="gray.50">
            <MileageLog vehicle={vehicle} />
          </Table.Cell>
        </Table.Row>
      )}
    </>
  );
}

function MileageLog({ vehicle }: { vehicle: Vehicle }) {
  const vehicleId = vehicle.id;
  const [rows, setRows] = useState<MileageEntry[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  // Per-entry Review dialog. Same MileageReviewDialog the WorkdaysTab
  // + PendingWorkdaysSection use, but here the caller passes a
  // single-element array so the dialog focuses on one entry — the
  // typical mode from the vehicle-focused log surface.
  const [reviewEntryId, setReviewEntryId] = useState<string | null>(null);
  const [totals, setTotals] = useState<{
    entryCount: number;
    totalMiles: number;
    approvedMiles: number;
    unapprovedMiles: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Default window: past 365 days. Enough to show yearly rollup.
      const toKey = bizToday();
      const fromKey = bizAddDays(toKey, -365);
      const res = await apiGet<{
        entries: MileageEntry[];
        totals: any | null;
      }>(`/api/super/vehicles/${vehicleId}/mileage?from=${fromKey}&to=${toKey}`);
      setRows(res.entries ?? []);
      setTotals(res.totals ?? null);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load mileage log.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [vehicleId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <HStack justify="center" py={4}><Spinner size="sm" /></HStack>;

  return (
    <VStack align="stretch" gap={2} p={2}>
      <HStack justify="space-between" gap={2}>
        {totals ? (
          <Text fontSize="xs" color="fg.muted">
            Last 365 days: <b>{totals.totalMiles.toLocaleString()} mi</b> ({totals.entryCount} sessions,{" "}
            <b>{totals.approvedMiles.toLocaleString()}</b> approved,{" "}
            <b>{totals.unapprovedMiles.toLocaleString()}</b> unapproved)
          </Text>
        ) : <Box />}
        <Button size="xs" colorPalette="teal" onClick={() => setAddOpen(true)}>
          <Plus size={12} />
          <Text ml={1}>Add entry</Text>
        </Button>
      </HStack>
      {rows.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" py={2}>No mileage entries yet.</Text>
      ) : (
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader>Date</Table.ColumnHeader>
              <Table.ColumnHeader>Driver</Table.ColumnHeader>
              <Table.ColumnHeader>Start</Table.ColumnHeader>
              <Table.ColumnHeader>End</Table.ColumnHeader>
              <Table.ColumnHeader>Miles</Table.ColumnHeader>
              <Table.ColumnHeader>Note</Table.ColumnHeader>
              <Table.ColumnHeader>Status</Table.ColumnHeader>
              <Table.ColumnHeader />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                onReview={() => setReviewEntryId(e.id)}
              />
            ))}
          </Table.Body>
        </Table.Root>
      )}
      {addOpen && (
        <AddMileageEntryDialog
          vehicle={vehicle}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void load();
          }}
        />
      )}
      {reviewEntryId && (() => {
        const entry = rows.find((r) => r.id === reviewEntryId);
        if (!entry) return null;
        const shaped: MileageReviewEntry = {
          id: entry.id,
          vehicleId: entry.vehicleId,
          vehicleName: vehicle.displayName,
          startedAt: entry.startedAt,
          endedAt: entry.endedAt,
          startOdometer: entry.startOdometer,
          endOdometer: entry.endOdometer,
          miles: entry.miles,
          notes: entry.notes,
          approvedAt: entry.approvedAt,
        };
        return (
          <MileageReviewDialog
            driverLabel={entry.driver.displayName ?? entry.driver.email ?? entry.driverUserId}
            entryDate={entry.entryDate}
            entries={[shaped]}
            onClose={() => setReviewEntryId(null)}
            onChanged={() => void load()}
          />
        );
      })()}
    </VStack>
  );
}

// Backfill dialog — Super creates a closed MileageEntry for a worker
// who forgot to log a past session. Row lands with approvedAt: null so
// it flows through the daily-approval queue like a normal
// worker-created entry.
function AddMileageEntryDialog({
  vehicle,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Default the odometer prefill to the vehicle's cached
  // currentOdometer so backfilling a recent entry needs less typing.
  // Driver picker is limited to assigned workers — matches the
  // worker-side constraint (only assignees can log against a vehicle).
  const assigned = vehicle.assignments.map((a) => ({
    userId: a.userId,
    label: a.user.displayName ?? a.user.email ?? a.userId,
  }));
  const [driverUserId, setDriverUserId] = useState<string>(
    assigned[0]?.userId ?? "",
  );
  const [date, setDate] = useState<string>(bizToday());
  const [startTime, setStartTime] = useState<string>("08:00");
  const [endTime, setEndTime] = useState<string>("17:00");
  const [startOdometer, setStartOdometer] = useState<string>(
    vehicle.currentOdometer != null ? String(vehicle.currentOdometer) : "",
  );
  const [endOdometer, setEndOdometer] = useState<string>("");
  const [notes, setNotes] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const driverCollection = useMemo(
    () =>
      createListCollection({
        items: assigned.map((a) => ({ label: a.label, value: a.userId })),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicle.id, vehicle.assignments.length],
  );

  const startNum = Number(startOdometer);
  const endNum = Number(endOdometer);
  const odometerValid =
    /^\d+$/.test(startOdometer.trim()) &&
    /^\d+$/.test(endOdometer.trim()) &&
    endNum >= startNum;
  const timesValid = startTime && endTime && endTime >= startTime;
  const valid =
    !!driverUserId && !!date && odometerValid && timesValid && !busy;
  const miles = odometerValid ? endNum - startNum : null;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    try {
      // Combine YYYY-MM-DD + HH:MM into local Date instants. Server
      // computes entryDate via ET timezone regardless of what timezone
      // the caller emits; using the local Date constructor is fine
      // because the backend takes the wall-clock as-is.
      const startedAt = new Date(`${date}T${startTime}:00`);
      const endedAt = new Date(`${date}T${endTime}:00`);
      await apiPost(`/api/super/vehicles/${vehicle.id}/mileage`, {
        driverUserId,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        startOdometer: startNum,
        endOdometer: endNum,
        notes: notes.trim() || null,
      });
      publishInlineMessage({
        type: "SUCCESS",
        text: "Mileage entry added. Awaiting approval.",
      });
      onSaved();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Couldn't add entry.", err),
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
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>Add mileage entry — {vehicle.displayName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                {assigned.length === 0 ? (
                  <Text fontSize="sm" color="red.600">
                    No workers are assigned to this vehicle. Assign at least one before backfilling entries.
                  </Text>
                ) : (
                  <Field label="Driver">
                    <Select.Root
                      collection={driverCollection}
                      value={driverUserId ? [driverUserId] : []}
                      onValueChange={(e) => setDriverUserId(e.value[0] ?? "")}
                      size="sm"
                      positioning={{ strategy: "fixed", hideWhenDetached: true }}
                    >
                      <Select.Control>
                        <Select.Trigger>
                          <Select.ValueText placeholder="Pick a driver…" />
                        </Select.Trigger>
                      </Select.Control>
                      <Select.Positioner>
                        <Select.Content>
                          {driverCollection.items.map((it) => (
                            <Select.Item key={it.value} item={it.value}>
                              <Select.ItemText>{it.label}</Select.ItemText>
                            </Select.Item>
                          ))}
                        </Select.Content>
                      </Select.Positioner>
                    </Select.Root>
                  </Field>
                )}
                <HStack gap={2}>
                  <Field label="Date">
                    <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                  <Field label="Start time">
                    <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                  </Field>
                  <Field label="End time">
                    <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                  </Field>
                </HStack>
                <HStack gap={2}>
                  <Field label="Starting odometer">
                    <Input
                      inputMode="numeric"
                      value={startOdometer}
                      onChange={(e) => setStartOdometer(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="e.g. 48231"
                    />
                  </Field>
                  <Field label="Ending odometer">
                    <Input
                      inputMode="numeric"
                      value={endOdometer}
                      onChange={(e) => setEndOdometer(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder={`≥ ${startOdometer || 0}`}
                    />
                  </Field>
                </HStack>
                {miles != null && miles >= 0 && (
                  <HStack justify="space-between" bg="gray.50" p={2} borderRadius="md">
                    <Text fontSize="xs" color="fg.muted">Session miles</Text>
                    <Text fontSize="sm" fontWeight="semibold">{miles.toLocaleString()} mi</Text>
                  </HStack>
                )}
                <Field label="Note (optional)">
                  <Input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Using vehicle to service lawns"
                  />
                </Field>
                <Text fontSize="2xs" color="fg.muted" fontStyle="italic">
                  Row will land as pending — approve it on this tab, on Workdays, or via the daily approval queue.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" onClick={submit} loading={busy} disabled={!valid || assigned.length === 0}>
                  Add
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function EntryRow({
  entry,
  onReview,
}: {
  entry: MileageEntry;
  /** Opens the MileageReviewDialog on this single entry — same
   *  lifecycle the WorkdaysTab surfaces use. All mutations (edit,
   *  approve, unapprove) live inside that dialog. */
  onReview: () => void;
}) {
  const isOpen = entry.endedAt == null;
  return (
    <Table.Row>
      <Table.Cell>{entry.entryDate}</Table.Cell>
      <Table.Cell>{entry.driver.displayName ?? entry.driver.email ?? "—"}</Table.Cell>
      <Table.Cell>{entry.startOdometer.toLocaleString()}</Table.Cell>
      <Table.Cell>
        {entry.endOdometer != null ? entry.endOdometer.toLocaleString() : "—"}
      </Table.Cell>
      <Table.Cell>
        {entry.miles != null ? `${entry.miles.toLocaleString()} mi` : "—"}
      </Table.Cell>
      <Table.Cell>
        <Text fontSize="xs" lineClamp={1}>{entry.notes ?? "—"}</Text>
      </Table.Cell>
      <Table.Cell>
        <StatusChip open={isOpen} approved={entry.approvedAt != null} />
      </Table.Cell>
      <Table.Cell>
        <Button size="xs" variant="outline" colorPalette="blue" onClick={onReview}>
          Review
        </Button>
      </Table.Cell>
    </Table.Row>
  );
}

function EditVehicleDialog({
  vehicle,
  onClose,
  onSaved,
}: {
  vehicle?: Vehicle;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!vehicle;
  const [displayName, setDisplayName] = useState(vehicle?.displayName ?? "");
  const [make, setMake] = useState(vehicle?.make ?? "");
  const [model, setModel] = useState(vehicle?.vehicleModel ?? "");
  const [year, setYear] = useState(vehicle?.year != null ? String(vehicle.year) : "");
  const [plate, setPlate] = useState(vehicle?.plate ?? "");
  const [inServiceDate, setInServiceDate] = useState(vehicle?.inServiceDate ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!displayName.trim()) return;
    setBusy(true);
    try {
      const payload = {
        displayName: displayName.trim(),
        make: make.trim() || null,
        vehicleModel: model.trim() || null,
        year: year.trim() ? Number(year) : null,
        plate: plate.trim() || null,
        inServiceDate: inServiceDate.trim() || null,
      };
      if (isEdit && vehicle) {
        await apiPatch(`/api/super/vehicles/${vehicle.id}`, payload);
      } else {
        await apiPost(`/api/super/vehicles`, payload);
      }
      publishInlineMessage({
        type: "SUCCESS",
        text: isEdit ? "Vehicle updated." : "Vehicle added.",
      });
      onSaved();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Save failed.", err),
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
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p={4}>
            <Dialog.Header>
              <Dialog.Title>{isEdit ? "Edit vehicle" : "Add vehicle"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Field label="Display name*">
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. Mike's Ram 2500"
                    autoFocus
                  />
                </Field>
                <HStack gap={2}>
                  <Field label="Make">
                    <Input value={make} onChange={(e) => setMake(e.target.value)} placeholder="Ram" />
                  </Field>
                  <Field label="Model">
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="2500" />
                  </Field>
                  <Field label="Year">
                    <Input
                      value={year}
                      onChange={(e) => setYear(e.target.value.replace(/[^\d]/g, ""))}
                      placeholder="2020"
                      w="80px"
                    />
                  </Field>
                </HStack>
                <HStack gap={2}>
                  <Field label="Plate">
                    <Input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="ABC-1234" />
                  </Field>
                  <Field label="In service since">
                    <Input
                      type="date"
                      value={inServiceDate ?? ""}
                      onChange={(e) => setInServiceDate(e.target.value)}
                    />
                  </Field>
                </HStack>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" onClick={save} loading={busy} disabled={!displayName.trim()}>
                  {isEdit ? "Save" : "Add"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function AssignWorkerDialog({
  vehicle,
  workers,
  onClose,
  onSaved,
}: {
  vehicle: Vehicle;
  workers: WorkerLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const already = new Set(vehicle.assignments.map((a) => a.userId));
  const available = workers.filter((w) => !already.has(w.id));
  const [userId, setUserId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const collection = useMemo(
    () =>
      createListCollection({
        items: available.map((w) => ({
          label: w.displayName ?? w.email ?? w.id,
          value: w.id,
        })),
      }),
    [available],
  );

  async function submit() {
    if (!userId) return;
    setBusy(true);
    try {
      await apiPost(`/api/super/vehicles/${vehicle.id}/assign`, { userId });
      publishInlineMessage({ type: "SUCCESS", text: "Worker assigned." });
      onSaved();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Assign failed.", err),
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
              <Dialog.Title>Assign a worker to {vehicle.displayName}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              {available.length === 0 ? (
                <Text fontSize="sm" color="fg.muted">
                  Everyone eligible is already assigned.
                </Text>
              ) : (
                <Select.Root
                  collection={collection}
                  value={userId ? [userId] : []}
                  onValueChange={(e) => setUserId(e.value[0] ?? "")}
                  size="sm"
                  positioning={{ strategy: "fixed", hideWhenDetached: true }}
                >
                  <Select.Control>
                    <Select.Trigger>
                      <Select.ValueText placeholder="Pick a worker…" />
                    </Select.Trigger>
                  </Select.Control>
                  <Select.Positioner>
                    <Select.Content>
                      {collection.items.map((it) => (
                        <Select.Item key={it.value} item={it.value}>
                          <Select.ItemText>{it.label}</Select.ItemText>
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Positioner>
                </Select.Root>
              )}
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2} w="full" justify="flex-end">
                <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
                <Button
                  colorPalette="teal"
                  onClick={submit}
                  loading={busy}
                  disabled={!userId || available.length === 0}
                >
                  Assign
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text fontSize="xs" color="fg.muted" mb={1}>{label}</Text>
      {children}
    </Box>
  );
}
