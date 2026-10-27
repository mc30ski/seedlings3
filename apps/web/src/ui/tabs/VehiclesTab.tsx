"use client";

// Equipment → Vehicles. ONE tab. Every control asks for the entitlement
// its own endpoint is guarded on:
//   • `equipment.view`   — opens the tab (TAB_REQUIREMENTS) and is the
//     guard on `GET /vehicles`, the fleet list. A driver's own history
//     comes from the MileageStrip on HomeTab, not from here.
//   • `equipment.manage` — `POST /vehicles`, `PATCH /vehicles/:id`, and
//     archive / unarchive / assign / unassign. Also the driver dropdown,
//     which reads `/users`, and the Insights strip.
//   • `time.view`        — `GET /vehicles/:id/mileage`, so it gates the
//     per-vehicle mileage log drill-down.
//   • `time.manage`      — `POST /vehicles/:id/mileage` (Add entry) and
//     every action in MileageReviewDialog (`PATCH /mileage/:id`,
//     approve / unapprove / reject).
//
// The mileage log was gated on `equipment.manage`, which is neither of
// the two entitlements its endpoints check: a bookkeeper holding
// `time.view` could not open a log the API would have served, and
// somebody holding `equipment.manage` without `time.view` got a 403 on
// expanding one.
//
// This header described three roles — worker, admin and super — each
// getting a different build of the tab, and said admin CRUD might be
// "opened up later". That was the old model's whole problem in one
// sentence: whether you may edit a vehicle is `equipment.manage`, which
// an operator grants by putting it in a role, not something the code
// decides by rank.
//
// Approval of individual mileage entries flows through the unified
// daily approval UX (Workday + Mileage in one shot); this tab is
// the fallback for making corrections outside that flow.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  createListCollection,
  Dialog,
  HStack,
  Input,
  Portal,
  Select,
  SimpleGrid,
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
  Zap,
  BarChart3,
} from "lucide-react";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import { bizToday, bizAddDays, bizInstantFromEtParts, type EtDateKey } from "@/src/lib/dates";
import MileageReviewDialog, { type MileageReviewEntry } from "@/src/ui/dialogs/MileageReviewDialog";
import StatusChip from "@/src/ui/components/StatusChip";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import { Dashboard } from "@/src/ui/components/Dashboard";
import {
  ALL_TIME_PERIOD,
  DEFAULT_PERIOD,
  FULL_PERIODS,
  periodKey,
  periodTimeframe,
  periodToRange,
  usePersistedPeriod,
  type Period,
} from "@/src/ui/components/WorkerHourlyPayCard";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import TabExplainer, { Em, ExplainerText, CapabilitySection } from "@/src/ui/components/TabExplainer";
import type { Scope } from "@/src/lib/scope";
import { isPaid } from "@repo/money";

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


export default function VehiclesTab({ scope }: { scope: Scope }) {
  // Capabilities layer additively. Worker + Admin see the fleet
  // list read-only; only `equipment.manage` gets mutations and the per-vehicle
  // mileage drill-down (the underlying endpoints are all
  // `time.manage`-guarded). `equipment.manage` also adds the orange Insights strip.
  // Adding and editing vehicles is `equipment.manage`.
  // EVERY VEHICLE MUTATION ON THIS TAB IS `equipment.capital`, not
  // `equipment.manage`. The two were one entitlement until 2026-10-20 and it
  // spanned two authorities: editing the fleet you own, and deciding what
  // the fleet IS. Adding a vehicle, editing it, archiving it and assigning a
  // driver are all the second — `POST /vehicles`, `PATCH /vehicles/:id`,
  // `POST /vehicles/:id/archive|unarchive|assign|unassign` are guarded on
  // `equipment.capital`. Name the capability the control's own endpoint
  // checks; asking for the wrong one is a guaranteed 403 the UI hides.
  const canManageFleet = scope.can("equipment.capital");
  // The Insights strip's travel figures come from `/routes/operations`,
  // which is guarded on `routes.plan` — NOT on the capability that opens
  // this tab. Asking for the wrong one made a scheduler's every visit here
  // a silent 403. Take the capability from the control's own endpoint.
  const canPlanRoutes = scope.can("routes.plan");
  // The mileage log's own endpoints: `GET /vehicles/:id/mileage` is
  // `time.view`, and every write in it is `time.manage`.
  const canViewTime = scope.can("time.view");
  const canManageTime = scope.can("time.manage");

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
        `/api/vehicles${showArchived ? "?includeArchived=true" : ""}`,
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
    // Worker directory — used by the assign dialog. Admin+ only; the
    // list endpoint is admin-guarded and workers don't need it (they
    // can't open the assign dialog anyway).
    //
    // FILTERED BY PAY CLASS. `/users` is every account in the system, and
    // this mapped all of them straight into the picker — so "Assign a
    // worker to Crew Van" offered Client User, Client Pending User and a
    // client placeholder account alongside the crew. Assigning one would
    // have worked: nothing on either side checked. A vehicle assignment is
    // the right to log deductible miles, so a customer would have been
    // filing business mileage.
    //
    // `isPaid` is the same call `assignUserToVehicle` now makes before it
    // writes, from the one module that decides worker class — so the list
    // and the endpoint cannot disagree about who is eligible.
    if (!canManageFleet) return;
    apiGet<any[]>("/api/users?includeInactive=false")
      .then((raw) => {
        if (!Array.isArray(raw)) return;
        setWorkers(
          raw
            .filter((u) => isPaid(u.workerType))
            .map((u) => ({
              id: u.id,
              displayName: u.displayName ?? u.name ?? null,
              email: u.email ?? null,
            })),
        );
      })
      .catch(() => {});
  }, [canManageFleet]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <VStack align="stretch" gap={3} pb={3}>
      {/* Surface-tailored orientation. The two variants are close but not
          identical: both are read-only here (mutations need
          `equipment.manage`, the mileage drill-down `time.view`), but the
          worker layout needs pointing at the MileageStrip on Home, where
          their own driving actually gets recorded. */}
      <TabExplainer
        explainerId="seedlings:vehiclesTab:guideOpen"
      >
        <ExplainerText>
          The company vehicles and who is assigned to each, so you know which truck is yours
          and who to ask about the others. Each card carries the make and model, plate, the
          latest odometer reading, and whether it is active or archived.
        </ExplainerText>
        <ExplainerText>
          The miles you drive are not recorded here: start and stop your trips on the mileage
          strip on your Home tab, and that is what feeds these odometer readings.
        </ExplainerText>
        {/* Say so when the fleet is read-only for this reader, rather than
            letting them hunt for buttons that are not rendered. */}
        {!canManageFleet && (
          <ExplainerText>
            The fleet is <Em>Read-only</Em> for you — adding, editing, archiving and
            assigning a vehicle all need equipment-management authority.
          </ExplainerText>
        )}
        <CapabilitySection capability="equipment.manage" scope={scope}>
          <ExplainerText>
            Add and edit vehicles, assign or unassign drivers, and <Em>archive</Em> one that
            is out of service — archiving keeps all of its history, and &ldquo;Show
            archived&rdquo; brings it back into view.
          </ExplainerText>
        </CapabilitySection>
        {/* The mileage log is its OWN pair of entitlements, because it is
            its own pair of endpoints: `GET /vehicles/:id/mileage` is
            `time.view` and `POST` is `time.manage`. It used to be described
            here as part of managing equipment, which is neither. */}
        <CapabilitySection capability="time.view" scope={scope}>
          <ExplainerText>
            Expand a vehicle for its <Em>mileage log</Em> — the last 365 days of driving
            sessions, with approved and unapproved miles split out.
          </ExplainerText>
        </CapabilitySection>
        <CapabilitySection capability="time.manage" scope={scope}>
          <ExplainerText>
            Add a mileage entry by hand when one is missing, and correct or approve one
            that is wrong. Day-to-day approval happens in the combined
            workday-and-mileage flow; this tab is where you come to fix things outside it.
          </ExplainerText>
        </CapabilitySection>
      </TabExplainer>
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
          {canManageFleet && (
            <Button size="sm" colorPalette="teal" onClick={() => setAddDialogOpen(true)}>
              <Plus size={14} />
              <Text ml={1}>Add vehicle</Text>
            </Button>
          )}
        </HStack>
      </HStack>

      {/* INSIGHTS is business-wide and gated on `reports.business`
          everywhere. It was mounted on fleet-management authority, which
          is a different question: managing the fleet is not the same as
          reading the company's rollup. */}
      {scope.can("reports.business") && (
        <VehiclesInsightsSection vehicles={vehicles} canPlanRoutes={canPlanRoutes} />
      )}

      {loading ? (
        <HStack justify="center" py={8}><Spinner /></HStack>
      ) : vehicles.length === 0 ? (
        <Box p={6} textAlign="center" color="fg.muted">
          <Text fontSize="sm">No vehicles yet.</Text>
          <Text fontSize="xs" mt={1}>Add one to start tracking business mileage.</Text>
        </Box>
      ) : (
        <VStack align="stretch" gap={2}>
          {vehicles.map((v) => (
            <VehicleCard
              key={v.id}
              vehicle={v}
              canManageFleet={canManageFleet}
              canViewTime={canViewTime}
              canManageTime={canManageTime}
              expanded={expanded.has(v.id)}
              onToggle={() => toggle(v.id)}
              onEdit={() => setEditing(v)}
              onAssign={() => setAssigningVehicle(v)}
              onArchive={async () => {
                try {
                  await apiPost(`/api/vehicles/${v.id}/archive`);
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
                  await apiPost(`/api/vehicles/${v.id}/unarchive`);
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
                  await apiPost(`/api/vehicles/${v.id}/unassign`, { userId });
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
        </VStack>
      )}

      {canManageFleet && addDialogOpen && (
        <EditVehicleDialog
          onClose={() => setAddDialogOpen(false)}
          onSaved={() => {
            setAddDialogOpen(false);
            void load();
          }}
        />
      )}
      {canManageFleet && editing && (
        <EditVehicleDialog
          vehicle={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {canManageFleet && assigningVehicle && (
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

// Vehicle card — one per fleet vehicle. Replaces the earlier
// Table.Row-based layout which overflowed on narrow mobile screens.
// Fields stack vertically inside a Card so the row always fits the
// viewport regardless of width.
//
// Three separate answers decide what the card offers, because its
// controls call three different endpoints: `equipment.manage` for the
// edit/assign/archive actions, `time.view` for the mileage log, and
// `time.manage` for adding to it. This comment used to say "Super gets
// the chevron + actions + log; everyone else sees the static card",
// which bundled all three into one rank.
function VehicleCard({
  vehicle,
  canManageFleet,
  canViewTime,
  canManageTime,
  expanded,
  onToggle,
  onEdit,
  onAssign,
  onArchive,
  onUnarchive,
  onUnassign,
}: {
  vehicle: Vehicle;
  canManageFleet: boolean;
  canViewTime: boolean;
  canManageTime: boolean;
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
    .join(" ") || null;
  const isArchived = !!vehicle.archivedAt;
  return (
    <Card.Root variant="outline">
      <Card.Body py={2.5} px={3}>
        {/* Header row: expand chevron (super) + name/plate on left,
            status badge on right. Wraps if title is unusually long. */}
        <HStack gap={2} align="flex-start" justify="space-between" flexWrap="wrap">
          <HStack gap={2} align="flex-start" flex="1" minW={0}>
            {canManageFleet && (
              <Button size="xs" variant="ghost" onClick={onToggle} p={1} flexShrink={0} mt={0.5}>
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </Button>
            )}
            <VStack align="start" gap={0} minW={0} flex="1">
              <Text fontWeight="semibold" lineClamp={1}>{vehicle.displayName}</Text>
              {(modelLine || vehicle.plate) && (
                <HStack gap={2} wrap="wrap" fontSize="xs" color="fg.muted">
                  {modelLine && <Text>{modelLine}</Text>}
                  {vehicle.plate && <Text>· {vehicle.plate}</Text>}
                </HStack>
              )}
            </VStack>
          </HStack>
          {isArchived ? (
            <Badge colorPalette="gray" variant="subtle" fontSize="2xs" flexShrink={0}>Archived</Badge>
          ) : (
            <Badge colorPalette="green" variant="subtle" fontSize="2xs" flexShrink={0}>Active</Badge>
          )}
        </HStack>

        {/* Meta row: current odometer + assignment chips. Wraps
            naturally on narrow. */}
        <HStack gap={2} mt={2} wrap="wrap" align="center">
          <Badge colorPalette="purple" variant="subtle" fontSize="2xs">
            {vehicle.currentOdometer != null
              ? `${vehicle.currentOdometer.toLocaleString()} mi`
              : "no odo"}
          </Badge>
          {vehicle.assignments.length === 0 ? (
            <Text fontSize="xs" color="fg.muted">Nobody assigned</Text>
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
                {canManageFleet && (
                  <Box
                    as="button"
                    onClick={() => onUnassign(a.userId)}
                    color="blue.fg"
                    _hover={{ color: "red.fg" }}
                    ml={1}
                  >
                    <X size={10} />
                  </Box>
                )}
              </Badge>
            ))
          )}
        </HStack>

        {/* Super actions row */}
        {canManageFleet && (
          <HStack gap={1} mt={2} wrap="wrap">
            <Button size="xs" variant="outline" onClick={onAssign}>
              <UserPlus size={12} /><Text ml={1}>Assign</Text>
            </Button>
            <Button size="xs" variant="outline" onClick={onEdit}>
              <Pencil size={12} /><Text ml={1}>Edit</Text>
            </Button>
            {isArchived ? (
              <Button size="xs" variant="outline" onClick={onUnarchive}>
                <ArchiveRestore size={12} /><Text ml={1}>Restore</Text>
              </Button>
            ) : (
              <Button size="xs" variant="outline" colorPalette="red" onClick={onArchive}>
                <Archive size={12} /><Text ml={1}>Archive</Text>
              </Button>
            )}
          </HStack>
        )}
      </Card.Body>

      {/* Mileage log drill-down — `time.view`, which is the guard on
          `GET /vehicles/:id/mileage`. Kept inline within the card so the
          log's rows sit with their parent vehicle rather than in a modal. */}
      {canViewTime && expanded && (
        <Box bg="gray.faint" borderTopWidth="1px" borderColor="gray.emphasized" px={0} py={0}>
          <MileageLog vehicle={vehicle} canManageTime={canManageTime} />
        </Box>
      )}
    </Card.Root>
  );
}

function MileageLog({ vehicle, canManageTime }: { vehicle: Vehicle; canManageTime: boolean }) {
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
      }>(`/api/vehicles/${vehicleId}/mileage?from=${fromKey}&to=${toKey}`);
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
        {/* `POST /vehicles/:id/mileage` is `time.manage`. */}
        {canManageTime && (
          <Button size="xs" colorPalette="teal" onClick={() => setAddOpen(true)}>
            <Plus size={12} />
            <Text ml={1}>Add entry</Text>
          </Button>
        )}
      </HStack>
      {rows.length === 0 ? (
        <Text fontSize="sm" color="fg.muted" py={2}>No mileage entries yet.</Text>
      ) : (
        // Wide multi-column log — wrap in overflow-x so narrow
        // mobile viewports can scroll horizontally instead of the
        // whole page bleeding wider than the viewport.
        <Box overflowX="auto">
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
        </Box>
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
      // Combine YYYY-MM-DD + HH:MM ET wall-clock into UTC ISO instants.
      // Previously used `new Date(`${date}T${startTime}:00`)` which
      // parses in the BROWSER's local timezone — someone with `equipment.manage` in another zone
      // (e.g. traveling) would submit an instant that misrepresents the
      // ET wall-clock the operator typed. bizInstantFromEtParts is the
      // canonical fix and DST-safe (auto-picks EDT vs EST).
      const startedAt = bizInstantFromEtParts(date as EtDateKey, startTime);
      const endedAt = bizInstantFromEtParts(date as EtDateKey, endTime);
      await apiPost(`/api/vehicles/${vehicle.id}/mileage`, {
        driverUserId,
        startedAt,
        endedAt,
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
                  <Text fontSize="sm" color="red.fg">
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
                  <HStack justify="space-between" bg="gray.faint" p={2} borderRadius="md">
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
        await apiPatch(`/api/vehicles/${vehicle.id}`, payload);
      } else {
        await apiPost(`/api/vehicles`, payload);
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
      await apiPost(`/api/vehicles/${vehicle.id}/assign`, { userId });
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

// ─── Insights ─────────────────────────────────────────────────────
// Fleet-view rollups, mirroring the orange Insights strip on the
// Inventory + Collections tabs. TWO SOURCES, and they need different
// capabilities:
//
//   Fleet / Unassigned      — the already-loaded vehicle list. Nothing
//                             beyond what opened the tab.
//   Pending approvals /     — GET /routes/operations, guarded on
//   Last 30d miles            `routes.plan`.
//
// The whole strip used to render on `equipment.manage` and fetch
// unconditionally, so anyone holding that without `routes.plan` — the
// scheduler — got a 403 on every open. A bare `catch {}` swallowed it and
// the tiles just sat at zero, so nobody would ever have reported it.
function VehiclesInsightsSection({
  vehicles,
  canPlanRoutes,
}: {
  vehicles: Vehicle[];
  canPlanRoutes: boolean;
}) {
  const [rollup, setRollup] = useState<{
    unapprovedEntries: number;
    activeDrivers: number;
    windowMiles: number;
    windowEntries: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped by the header refresh control; re-runs the rollup fetch.
  const [refreshTick, setRefreshTick] = useState(0);
  // THE WINDOW WAS HARDCODED AT 30 DAYS. The card showed a tile reading
  // "Last 30d miles" with no way to change it, while every other INSIGHTS
  // card takes a period — so the one number here that actually HAS a
  // window was the one you could not adjust.
  const [period, setPeriod] = usePersistedPeriod(
    "seedlings:vehiclesTab:insightsPeriod",
    FULL_PERIODS,
    DEFAULT_PERIOD,
  );
  const range = useMemo(() => periodToRange(period), [period]);
  // Holds the pending all-time selection while its confirm is open.
  const [pendingAllTime, setPendingAllTime] = useState<Period | null>(null);

  useEffect(() => {
    if (!canPlanRoutes) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const ops = await apiGet<{
          totalMiles: number;
          entryCount: number;
          pendingCount: number;
          activeDrivers: number;
        }>(
          `/api/routes/operations?from=${range.from}&to=${range.to}`,
        );
        if (cancelled) return;
        setRollup({
          unapprovedEntries: ops.pendingCount ?? 0,
          activeDrivers: ops.activeDrivers ?? 0,
          windowMiles: ops.totalMiles ?? 0,
          windowEntries: ops.entryCount ?? 0,
        });
      } catch {
        // Insights are non-critical; silent fail is fine.
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [canPlanRoutes, refreshTick, range.from, range.to]);

  const fleetSummary = useMemo(() => {
    const active = vehicles.filter((v) => !v.archivedAt);
    const archived = vehicles.length - active.length;
    const assigned = active.filter((v) => v.assignments.length > 0).length;
    return { active: active.length, archived, assignedActive: assigned };
  }, [vehicles]);

  return (
    <Dashboard
      storageKey="seedlings:vehiclesTab:insightsOpen"
      title="Insights"
      icon={BarChart3}
      variant="insights"
      // In the title bar, like every other section.
      onRefresh={() => setRefreshTick((t) => t + 1)}
      refreshing={loading}
      timeframe={(() => {
        const tf = periodTimeframe(FULL_PERIODS, period, setPeriod);
        return {
          ...tf,
          // ALL TIME GOES THROUGH A CONFIRM, as it does on Jobs Insights
          // and on ServicesTab. It is the one option with no bound: it
          // scans every mileage entry the fleet has ever logged, and a
          // mis-click in a dropdown is far easier to make than a click on
          // a button labelled "Load All".
          onChange: (v: string) => {
            const next = FULL_PERIODS.find((p) => periodKey(p) === v);
            if (!next) return;
            if (periodKey(next) !== periodKey(ALL_TIME_PERIOD)) {
              setPeriod(next);
              return;
            }
            setPendingAllTime(next);
          },
        };
      })()}
    >
        <SimpleGrid columns={{ base: 2, md: 4 }} gap={2}>
          <InsightPanel
            title="Fleet"
            value={String(fleetSummary.active)}
            hint={`${fleetSummary.assignedActive} assigned · ${fleetSummary.archived} archived`}
          />
          {canPlanRoutes && (
            <>
              <InsightPanel
                title="Pending approvals"
                value={loading ? "…" : String(rollup?.unapprovedEntries ?? 0)}
                hint={loading
                  ? "loading…"
                  : (rollup?.activeDrivers ?? 0) === 0
                    ? `no drivers ${period.label}`
                    : `${rollup!.activeDrivers} driver${rollup!.activeDrivers === 1 ? "" : "s"} active`}
                palette={(rollup?.unapprovedEntries ?? 0) > 0 ? "red" : "gray"}
              />
              <InsightPanel
                title={`Miles · ${period.label}`}
                value={loading ? "…" : (rollup?.windowMiles ?? 0).toLocaleString()}
                hint={loading ? "loading…" : `${rollup?.windowEntries ?? 0} sessions`}
                palette="blue"
              />
            </>
          )}
          <InsightPanel
            title="Unassigned"
            value={String(fleetSummary.active - fleetSummary.assignedActive)}
            hint="active w/o a driver"
            palette={(fleetSummary.active - fleetSummary.assignedActive) > 0 ? "yellow" : "gray"}
          />
        </SimpleGrid>
        <ConfirmDialog
          open={!!pendingAllTime}
          title="Load All Data"
          message="This will roll up every mileage entry for all time. This may be slow. Are you sure?"
          confirmLabel="Load All"
          confirmColorPalette="orange"
          onConfirm={() => {
            if (pendingAllTime) setPeriod(pendingAllTime);
            setPendingAllTime(null);
          }}
          onCancel={() => setPendingAllTime(null)}
        />
    </Dashboard>
  );
}

function InsightPanel({
  title,
  value,
  hint,
  palette,
}: {
  title: string;
  value: string;
  hint: string;
  palette?: string;
}) {
  return (
    <Box borderWidth="1px" borderColor="gray.emphasized" borderRadius="md" bg="bg.panel" p={2}>
      <Text fontSize="2xs" fontWeight="semibold" color="gray.fg" textTransform="uppercase" letterSpacing="wide">
        {title}
      </Text>
      <Text fontSize="xl" fontWeight="bold" color={palette ? `${palette}.fg` : undefined}>
        {value}
      </Text>
      <Text fontSize="xs" color="fg.muted">{hint}</Text>
    </Box>
  );
}
