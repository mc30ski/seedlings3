"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PreviewRoutesTab.parts — extracted, self-contained pieces used by
// PreviewRoutesTab. Each part is small, testable, and has no reach into
// the parent's state — they take props and callbacks.
//
// Right now this file holds:
//   • AdminWorkerPicker    — inline "View as" worker picker, mounted
//                             when scope.isAdmin. Empty = plan own
//                             routes; picking a worker plans on their
//                             behalf via the on-behalf endpoints.
//   • SectionExpander      — a bordered collapsible section wrapper.
//                             Used for "Advanced settings" and
//                             "All available jobs" to keep the first
//                             render uncluttered.
//   • RoutesOperationsPanel — Super-only team-travel rollup (miles,
//                             drive time, top drivers, top vehicles)
//                             mounted at the top of the tab.
//
// If more parts get extracted (RouteDay, RouteStop, SummaryPanel,
// etc.) they should live here too — keep the tab file focused on
// wiring + state.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Card, HStack, IconButton, Input, SimpleGrid, Spinner, Text, VStack } from "@chakra-ui/react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Gauge,
  ListChecks,
  MapPin,
  RefreshCw,
  Route,
  Star,
  Truck,
  Users,
} from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { bizAddDays, bizToday } from "@/src/lib/lib";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import MiniStatCard from "@/src/ui/components/MiniStatCard";
import { Dashboard } from "@/src/ui/components/Dashboard";
import {
  ADMIN_PERIODS,
  buttonPeriodLabel,
  periodKey,
  type Period,
} from "@/src/ui/components/WorkerHourlyPayCard";

// ─── Admin "View as" picker ───────────────────────────────────────────────
type Worker = { id: string; displayName?: string | null; email?: string | null };

export function AdminWorkerPicker({
  selectedWorkerId,
  onChange,
}: {
  /** Current selection. null = "plan my own routes" (self). */
  selectedWorkerId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<Worker[]>("/api/workers")
      .then((list) => setWorkers(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
        setSearchText("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropOpen]);

  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of workers) map[w.id] = w.displayName || w.email || w.id;
    return map;
  }, [workers]);

  const searchLc = searchText.toLowerCase();
  const filtered = searchText
    ? workers.filter((w) => (w.displayName || w.email || "").toLowerCase().includes(searchLc))
    : workers;
  const limited = filtered.slice(0, 10);

  return (
    <HStack gap={2} align="center" wrap="wrap">
      <Text fontSize="sm" fontWeight="medium" whiteSpace="nowrap">
        Plan for:
      </Text>
      <Box ref={dropRef} position="relative">
        <Input
          size="sm"
          w="200px"
          placeholder={selectedWorkerId ? (workerNameMap[selectedWorkerId] || "Loading…") : "Me"}
          value={searchText}
          onChange={(e) => { setSearchText(e.target.value); if (!dropOpen) setDropOpen(true); }}
          onFocus={() => { setDropOpen(true); setSearchText(""); }}
        />
        {dropOpen && (
          <Box
            position="fixed" zIndex={9999} bg="white" borderWidth="1px" borderColor="gray.200"
            rounded="md" shadow="lg" w="240px" mt="1"
            ref={(el: HTMLDivElement | null) => {
              if (el && dropRef.current) {
                const rect = dropRef.current.getBoundingClientRect();
                el.style.top = `${rect.bottom + 4}px`;
                el.style.left = `${rect.left}px`;
              }
            }}
          >
            <Box maxH="250px" overflowY="auto">
              {/* "Me" option — clears selection back to self. */}
              <Box
                px="3" py="1.5" fontSize="sm" cursor="pointer"
                bg={selectedWorkerId === null ? "blue.50" : undefined}
                _hover={{ bg: "gray.100" }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(null);
                  setDropOpen(false);
                  setSearchText("");
                }}
              >
                <HStack gap={2}>
                  <Text flex="1" fontStyle="italic">Me (plan my own routes)</Text>
                  {selectedWorkerId === null && <Text color="blue.500" fontWeight="bold">✓</Text>}
                </HStack>
              </Box>
              {limited.map((w) => (
                <Box
                  key={w.id} px="3" py="1.5" fontSize="sm" cursor="pointer"
                  bg={selectedWorkerId === w.id ? "blue.50" : undefined}
                  _hover={{ bg: "gray.100" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(w.id);
                    setDropOpen(false);
                    setSearchText("");
                  }}
                >
                  <HStack gap={2}>
                    <Text flex="1">{w.displayName || w.email || w.id}</Text>
                    {selectedWorkerId === w.id && <Text color="blue.500" fontWeight="bold">✓</Text>}
                  </HStack>
                </Box>
              ))}
              {filtered.length === 0 && (
                <Text fontSize="xs" color="fg.muted" px="3" py="2">No matches</Text>
              )}
            </Box>
          </Box>
        )}
      </Box>
      {selectedWorkerId && (
        <Badge size="sm" colorPalette="blue" variant="solid">
          {workerNameMap[selectedWorkerId] || "Loading…"}
        </Badge>
      )}
    </HStack>
  );
}

// ─── Bordered collapsible section wrapper ────────────────────────────────
// Small utility with the "chevron + title" header + expandable body,
// used to fold advanced settings and the "All available jobs" listing
// out of the way on first render. Persists open/closed state via
// localStorage when a storageKey is provided.
export function SectionExpander({
  title,
  storageKey,
  defaultOpen = false,
  children,
}: {
  title: React.ReactNode;
  /** When provided, open state is remembered across sessions. */
  storageKey?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(defaultOpen);
  useEffect(() => {
    if (!storageKey) return;
    try {
      const v = localStorage.getItem(storageKey);
      if (v === "1") setOpen(true);
      else if (v === "0") setOpen(false);
    } catch { /* ignore */ }
  }, [storageKey]);
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (storageKey) {
        try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
      }
      return next;
    });
  };

  return (
    <Box borderWidth="1px" borderColor="gray.200" rounded="md" bg="white">
      <HStack
        as="button"
        onClick={toggle}
        gap={2}
        align="center"
        w="full"
        px={3}
        py={2}
        cursor="pointer"
        _hover={{ bg: "gray.50" }}
        textAlign="left"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Text fontSize="sm" fontWeight="medium" color="fg.default" flex="1" minW={0}>
          {title}
        </Text>
      </HStack>
      {open && (
        <Box px={3} py={3} borderTopWidth="1px" borderColor="gray.200">
          {children}
        </Box>
      )}
    </Box>
  );
}

// ─── Operations panel (super scope) ──────────────────────────────────────
// Team travel rollup — pulls from GET /api/super/routes/operations which
// aggregates every closed MileageEntry in the picked period. Mounted at
// the top of PreviewRoutesTab when scope.isSuper. Same period-cycle affordance
// pattern as the HomeTab OperationsPanel (buttons live in the
// expanded body; collapsed header stays MY-WORKDAY-height for visual
// parity).
type RoutesOpsResponse = {
  totalMiles: number;
  totalDriveMinutes: number;
  entryCount: number;
  approvedCount: number;
  pendingCount: number;
  activeDrivers: number;
  activeVehicles: number;
  avgMilesPerDriver: number;
  avgMilesPerEntry: number;
  topDrivers: Array<{ userId: string; displayName: string; miles: number; entries: number }>;
  topVehicles: Array<{ vehicleId: string; vehicleName: string; miles: number; entries: number }>;
};

const ROUTES_OPS_PERIODS: Period[] = ADMIN_PERIODS;
const DEFAULT_ROUTES_OPS_PERIOD: Period = { preset: "today", label: "today" };

function periodToRange(p: Period): { from: string; to: string } {
  if (p.preset === "today") {
    const today = bizToday();
    return { from: today, to: today };
  }
  if (p.preset === "yesterday") {
    const y = bizAddDays(bizToday(), -1);
    return { from: y, to: y };
  }
  const days = Math.max(1, p.days ?? 1);
  const to = bizToday();
  const from = bizAddDays(to, -(days - 1));
  return { from, to };
}

function fmtMi(n: number): string {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} mi`;
}
function fmtHrs(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function RoutesOperationsPanel() {
  const [period, setPeriod] = useState<Period>(DEFAULT_ROUTES_OPS_PERIOD);
  const [data, setData] = useState<RoutesOpsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => periodToRange(period), [period]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      const d = await apiGet<RoutesOpsResponse>(`/api/super/routes/operations?${qs.toString()}`);
      setData(d);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load routes operations.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  const periodDisplay = buttonPeriodLabel(period.label);

  function cyclePeriod() {
    const idx = ROUTES_OPS_PERIODS.findIndex((p) => periodKey(p) === periodKey(period));
    const next = ROUTES_OPS_PERIODS[(idx + 1) % ROUTES_OPS_PERIODS.length];
    setPeriod(next);
  }

  return (
    <Dashboard
      storageKey="seedlings:routesTab:operationsOpen"
      title="Operations"
      icon={Activity}
      summarySlot={
        <Text
          fontSize="xs"
          color="gray.700"
          textAlign="right"
          w="full"
          truncate
          display={{ base: "none", sm: "block" }}
        >
          {periodDisplay} · {range.from} → {range.to}
        </Text>
      }
    >
      <VStack align="stretch" gap={3}>
        {/* Period + refresh controls at the top of the expanded body
            (not in the header, to match MY WORKDAY collapsed height). */}
        <HStack justify="flex-end" gap={1}>
          <Button size="xs" variant="outline" onClick={cyclePeriod} title="Change period">
            {periodDisplay}
            <Box as="span" ml={1} display="inline-flex" opacity={0.7}>
              <ChevronsUpDown size={12} />
            </Box>
          </Button>
          <IconButton
            aria-label="Refresh routes operations"
            size="xs"
            variant="ghost"
            onClick={() => void load()}
            loading={loading}
          >
            <RefreshCw size={12} />
          </IconButton>
        </HStack>

        {/* Section 1 — Travel totals. */}
        <OpsSection title="Travel · This period" loading={loading && !data}>
          {data && (
            <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
              <MiniStatCard
                label="Total miles"
                value={fmtMi(data.totalMiles)}
                hint={
                  data.activeDrivers > 0
                    ? `${fmtMi(data.avgMilesPerDriver)} avg/driver`
                    : undefined
                }
                color="blue"
                icon={Route}
              />
              <MiniStatCard
                label="Drive time"
                value={fmtHrs(data.totalDriveMinutes)}
                hint="total across team"
                color="teal"
                icon={Clock}
              />
              <MiniStatCard
                label="Sessions"
                value={fmtInt(data.entryCount)}
                hint={`${fmtMi(data.avgMilesPerEntry)} avg`}
                color="cyan"
                icon={ListChecks}
              />
              <MiniStatCard
                label="Pending review"
                value={fmtInt(data.pendingCount)}
                hint={
                  data.approvedCount + data.pendingCount > 0
                    ? `${fmtInt(data.approvedCount)} approved`
                    : undefined
                }
                color={data.pendingCount > 0 ? "orange" : "gray"}
                icon={Gauge}
              />
            </SimpleGrid>
          )}
        </OpsSection>

        {/* Section 2 — Team + fleet. */}
        <OpsSection title="Team & fleet · This period" loading={loading && !data}>
          {data && (
            <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
              <MiniStatCard
                label="Active drivers"
                value={fmtInt(data.activeDrivers)}
                hint="had ≥ 1 trip"
                color={data.activeDrivers > 0 ? "blue" : "gray"}
                icon={Users}
              />
              <MiniStatCard
                label="Vehicles used"
                value={fmtInt(data.activeVehicles)}
                color="teal"
                icon={Truck}
              />
              {data.topDrivers.slice(0, 2).map((d, i) => (
                <MiniStatCard
                  key={d.userId}
                  label={i === 0 ? "Top driver" : "Runner-up driver"}
                  value={d.displayName}
                  hint={`${fmtMi(d.miles)} · ${d.entries} trip${d.entries === 1 ? "" : "s"}`}
                  color={i === 0 ? "green" : "cyan"}
                  icon={i === 0 ? Star : Users}
                />
              ))}
              {data.topVehicles.slice(0, 2).map((v, i) => (
                <MiniStatCard
                  key={v.vehicleId}
                  label={i === 0 ? "Top vehicle" : "Runner-up vehicle"}
                  value={v.vehicleName}
                  hint={`${fmtMi(v.miles)} · ${v.entries} trip${v.entries === 1 ? "" : "s"}`}
                  color={i === 0 ? "purple" : "teal"}
                  icon={Truck}
                />
              ))}
              {data.activeDrivers === 0 && (
                <MiniStatCard
                  label="No trips"
                  value="—"
                  hint="nothing logged this period"
                  color="gray"
                  icon={MapPin}
                />
              )}
            </SimpleGrid>
          )}
        </OpsSection>
      </VStack>
    </Dashboard>
  );
}

// Titled outlined card wrapper — mirrors the OpsSection in
// HomeTab.parts.tsx / HomeTab so the Routes Operations
// panel reads as the same visual family across the shell.
function OpsSection({
  title,
  loading,
  children,
}: {
  title: string;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card.Root variant="outline">
      <Card.Body p={4}>
        <HStack justify="space-between" mb={3}>
          <Text
            fontSize="xs"
            fontWeight="semibold"
            color="fg.default"
            textTransform="uppercase"
            letterSpacing="wide"
          >
            {title}
          </Text>
          {loading && <Spinner size="xs" />}
        </HStack>
        {children}
      </Card.Body>
    </Card.Root>
  );
}
