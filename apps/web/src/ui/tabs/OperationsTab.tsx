"use client";

import { ReactNode, useEffect, useMemo, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Card,
  HStack,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { BarChart3, CalendarRange, ChevronDown, ChevronRight, LayoutGrid, Maximize2, Minimize2 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import DateInput from "@/src/ui/components/DateInput";
import { Button, Dialog, Portal } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { bizDateKey, fmtDate, fmtDateTime, prettyStatus, clientLabel } from "@/src/lib/lib";
import { usePaymentMethodLabels } from "@/src/lib/usePaymentMethodLabels";
import { openEventSearch } from "@/src/lib/bus";
import { StatusBadge } from "@/src/ui/components/StatusBadge";
import { MapLink } from "@/src/ui/helpers/Link";
import { type DatePreset, computeDatesFromPreset, PRESET_LABELS } from "@/src/lib/datePresets";

type UnclaimedItem = {
  id: string; jobId: string | null; startAt: string | null; jobType: string | null; price: number | null;
  property: string | null; client: string | null; address: string;
};

type WorkerStat = {
  id: string; name: string; workerType: string | null;
  jobsCompleted: number; scheduledJobs: number;
  totalEarnings: number; totalExpenses: number; netEarnings: number;
  totalActualMinutes: number; totalEstimatedMinutes: number; efficiency: number;
};

type OpsData = {
  jobs: { scheduled: number; inProgress: number; completed: number; canceled: number; overdue: number; unclaimed: number };
  financial: { totalRevenue: number; totalExpenses: number; netRevenue: number; totalPlatformFees: number; totalBusinessMargin: number; avgJobPrice: number; paymentsByMethod: Record<string, number> };
  team: { activeInWindow: number; workersByTypeInWindow: Record<string, number>; topWorkers: { name: string; jobs: number; earnings: number }[] };
  equipment: {
    total: number; available: number; checkedOut: number; reserved: number; inMaintenance: number;
    // Window-scoped usage (anchored on Checkout.checkedOutAt inside the
    // selected date range). See routes/admin.ts equipmentLeaderboard.
    windowDays: number;
    windowCheckouts: number;
    windowIncome: number;
    windowDistinctUsed: number;
    leaderboard: {
      id: string; shortDesc: string | null; brand: string | null; model: string | null; type: string | null;
      checkouts: number; daysOut: number; income: number; utilizationPct: number;
      // Sum of jobs billed across the window, derived from per-checkout
      // rentalBreakdown lines. Null when this piece's recent rentals were
      // all on flat-daily billing (the model isn't job-driven).
      jobsBilled: number | null;
    }[];
    idle: {
      id: string; shortDesc: string | null; brand: string | null; model: string | null; type: string | null; status: string;
    }[];
  };
  estimates: { pending: number; accepted: number; rejected: number };
  clients: { workedWithInWindow: number; newInWindow: number; vipWithWorkInWindow: number };
  unclaimedItems: UnclaimedItem[];
  workerStats: WorkerStat[];
  recentAudit: { id: string; scope: string; verb: string; action?: string | null; actorName: string; createdAt: string; metadata?: any }[];
};

const presetItems = [
  { value: "rolling", label: "Rolling" },
  { value: "now", label: "Now" },
  { value: "yesterday", label: "Yesterday" },
  { value: "lastWeek", label: "Last week" },
  { value: "lastMonth", label: "Last month" },
  { value: "thisWeek", label: "This week" },
  { value: "thisMonth", label: "This month" },
  { value: "all", label: "All time" },
];
const presetCollection = createListCollection({ items: presetItems });

function MetricCard({ label, value, color = "fg.default", sub, onClick }: { label: string; value: string | number; color?: string; sub?: string; onClick?: () => void }) {
  const interactive = !!onClick;
  return (
    <Card.Root
      variant="outline"
      cursor={interactive ? "pointer" : undefined}
      onClick={onClick}
      _hover={interactive ? { bg: "gray.50", borderColor: "blue.300" } : undefined}
      transition={interactive ? "all 0.15s" : undefined}
      title={interactive ? `Open Admin Jobs filtered to "${label}"` : undefined}
    >
      <Card.Body py="2" px="3">
        <Text fontSize="2xl" fontWeight="bold" color={color} lineHeight="1">{value}</Text>
        <Text fontSize="xs" color="fg.muted" mt={1}>{label}</Text>
        {sub && <Text fontSize="xs" color="fg.muted">{sub}</Text>}
      </Card.Body>
    </Card.Root>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <Text fontSize="xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide" mt={4} mb={2} px={1}>
      {children}
    </Text>
  );
}

// Same visual treatment as SectionHeader but wraps a chevron toggle and
// renders children only when `open`. Click anywhere on the header row
// flips the section. Used for every operator-level Operations section so
// the page can be shrunk to "just the headers I care about" — useful on
// laptop screens where the full page is tall.
function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <HStack
        mt={4}
        mb={open ? 2 : 0}
        px={1}
        py={1}
        gap={1.5}
        cursor="pointer"
        onClick={onToggle}
        _hover={{ color: "fg" }}
        color="fg.muted"
        userSelect="none"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Text fontSize="xs" fontWeight="semibold" textTransform="uppercase" letterSpacing="wide">
          {title}
        </Text>
      </HStack>
      {open && children}
    </>
  );
}

// Section list — order here matches the render order below. Used by the
// expand/collapse-all toggle so adding/removing a section in one place
// keeps the toggle button consistent. Each key gets a persisted boolean
// (default open) under `ops_sectionsOpen`.
const SECTION_KEYS = [
  "jobs",
  "unclaimed",
  "financial",
  "workers",
  "equipment",
  "estimates",
  "clients",
  "activity",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

function formatDuration(mins: number): string {
  if (mins <= 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function OperationsTab() {
  const [data, setData] = useState<OpsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAllWorkers, setShowAllWorkers] = useState(false);
  const [showAllUnclaimed, setShowAllUnclaimed] = useState(false);
  const { labelFor: methodLabel } = usePaymentMethodLabels();
  const [confirmAllTime, setConfirmAllTime] = useState(false);
  const [quickDateMenuOpen, setQuickDateMenuOpen] = useState(false);

  // Worker Performance view toggle + metric selector. Table is the default
  // because the row layout shows multiple metrics side-by-side; chart mode
  // is single-metric but easier to scan for relative differences. Both
  // states are persisted so the operator's preference survives reloads.
  const [workerView, setWorkerView] = usePersistedState<"table" | "chart">("ops_workerView", "table");
  const [workerChartMetric, setWorkerChartMetric] = usePersistedState<
    "jobsCompleted" | "scheduledJobs" | "totalEarnings" | "totalActualMinutes" | "efficiency"
  >("ops_workerChartMetric", "jobsCompleted");
  // Equipment leaderboard view + metric. Same toggle pattern as the worker
  // section. Idle list rendering is gated on its own collapsed-by-default
  // disclosure inside the equipment section.
  const [equipmentView, setEquipmentView] = usePersistedState<"table" | "chart">("ops_equipmentView", "table");
  const [equipmentChartMetric, setEquipmentChartMetric] = usePersistedState<
    "daysOut" | "checkouts" | "income" | "utilizationPct" | "jobsBilled"
  >("ops_equipmentChartMetric", "daysOut");
  const [equipmentIdleOpen, setEquipmentIdleOpen] = useState(false);

  // Per-section open state, persisted. Default all sections open. Missing
  // keys are treated as "open" so adding a new SECTION_KEYS entry doesn't
  // surprise users with a collapsed-by-default state.
  const [sectionsOpen, setSectionsOpen] = usePersistedState<Record<string, boolean>>(
    "ops_sectionsOpen",
    Object.fromEntries(SECTION_KEYS.map((k) => [k, true])),
  );
  const isOpen = (key: SectionKey): boolean => sectionsOpen[key] !== false;
  const toggleSection = (key: SectionKey) =>
    setSectionsOpen((prev) => ({ ...prev, [key]: !(prev[key] !== false) }));
  // Expand/collapse-all toggle: if any section is currently open, the next
  // click collapses everything; otherwise it expands everything. Lets the
  // operator switch between "headers only" and "full page" with one tap.
  const anySectionOpen = SECTION_KEYS.some((k) => isOpen(k));
  const toggleAllSections = () => {
    const next = !anySectionOpen;
    setSectionsOpen(Object.fromEntries(SECTION_KEYS.map((k) => [k, next])));
  };

  const [datePreset, setDatePreset] = useState<DatePreset>(() => {
    try {
      const stored = localStorage.getItem("seedlings_ops_preset");
      if (stored) {
        localStorage.removeItem("seedlings_ops_preset");
        return stored as DatePreset;
      }
    } catch {}
    return "rolling";
  });
  const presetDates = useMemo(() => computeDatesFromPreset(datePreset), [datePreset]);
  const [dateFrom, setDateFrom] = usePersistedState("ops_dateFrom", presetDates.from);
  const [dateTo, setDateTo] = usePersistedState("ops_dateTo", presetDates.to);

  useEffect(() => {
    if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }, [datePreset]);

  useEffect(() => {
    if (!quickDateMenuOpen) return;
    const close = () => setQuickDateMenuOpen(false);
    const timer = setTimeout(() => document.addEventListener("click", close), 50);
    return () => { clearTimeout(timer); document.removeEventListener("click", close); };
  }, [quickDateMenuOpen]);

  async function load() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const result = await apiGet<OpsData>(`/api/admin/operations?${qs}`);
      setData(result);
    } catch {
      setData(null);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [dateFrom, dateTo]);

  // Hand off to Admin → Jobs with a pre-applied filter. Mirrors the
  // pendingHighlight pattern used elsewhere (e.g. HomeTab/SuppliesTab
  // jumping to a specific occurrence) but carries a filter spec instead
  // of an ID. The JobsTab consumes `seedlings_jobs_pendingFilter` from
  // localStorage on mount and replays it via the existing
  // jobs:applyFilter handler.
  function navigateToAdminJobs(detail: Record<string, unknown>) {
    try {
      localStorage.setItem("seedlings_jobs_pendingFilter", JSON.stringify(detail));
    } catch {}
    window.dispatchEvent(
      new CustomEvent("navigate:adminTab", {
        detail: { tab: "admin-jobs", remount: true },
      }),
    );
  }

  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const today = bizDateKey(new Date());

  return (
    <Box w="full" pb={8}>
      {/* Date controls */}
      <HStack mb={2} gap={2} wrap="wrap">
        <DateInput value={dateFrom} onChange={(v) => { setDateFrom(v); setDatePreset(null); }} />
        <Text fontSize="sm">–</Text>
        <DateInput value={dateTo} onChange={(v) => { setDateTo(v); setDatePreset(null); }} />
        <Select.Root
          collection={presetCollection}
          value={datePreset ? [datePreset] : []}
          onValueChange={(e) => {
            const val = e.value[0] as DatePreset;
            if (!val) return;
            if (val === "all") {
              setConfirmAllTime(true);
            } else {
              setDatePreset(val);
            }
          }}
          size="sm"
          positioning={{ strategy: "fixed", hideWhenDetached: true }}
          css={{ width: "auto", flex: "0 0 auto" }}
        >
          <Select.Control>
            <Select.Trigger w="auto" minW="0" px="2">
              <CalendarRange size={14} />
              <Select.ValueText placeholder="Date range" />
              <Select.Indicator display="none" />
            </Select.Trigger>
          </Select.Control>
          <Select.Positioner>
            <Select.Content>
              {presetItems.map((it) => (
                <Select.Item key={it.value} item={it.value}>
                  <Select.ItemText>{it.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Positioner>
        </Select.Root>
        {/* Expand/collapse-all toggle. Lives at the end of the date-controls
            row so it doesn't compete with the date picker for space. Icon
            flips based on the current aggregate state so the affordance
            self-describes ("anything open → click to minimize"). */}
        <Button
          size="sm"
          variant="ghost"
          px="2"
          minW="0"
          onClick={toggleAllSections}
          title={anySectionOpen ? "Collapse all sections" : "Expand all sections"}
          aria-label={anySectionOpen ? "Collapse all sections" : "Expand all sections"}
        >
          {anySectionOpen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
      </HStack>

      <HStack mb={2} gap={1} px={1}>
        <Box position="relative" onClick={(e: any) => e.stopPropagation()}>
          <Badge size="sm" colorPalette="green" variant="subtle" cursor="pointer" onClick={() => setQuickDateMenuOpen((v) => !v)}>
            {datePreset ? (PRESET_LABELS[datePreset] ?? datePreset) : "Select"}
            {" "}<Box as="span" display="inline-flex" alignItems="center" justifyContent="center" w="14px" h="14px" borderRadius="full" bg="green.500" color="white" verticalAlign="middle"><ChevronDown size={9} /></Box>
          </Badge>
          {quickDateMenuOpen && (
            <VStack position="fixed" bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" zIndex={10000} p={1} gap={0} minW="140px"
              ref={(el: HTMLDivElement | null) => { if (el && el.parentElement) { const rect = el.parentElement.getBoundingClientRect(); el.style.top = `${rect.bottom + 4}px`; el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 148))}px`; } }}>
              {presetItems.map((it) => (
                <Button key={it.value} size="xs" variant={datePreset === it.value ? "solid" : "ghost"} colorPalette={datePreset === it.value ? "green" : undefined} w="full" justifyContent="start"
                  onClick={() => {
                    setQuickDateMenuOpen(false);
                    if (it.value === "all") { setConfirmAllTime(true); return; }
                    setDatePreset(it.value as DatePreset);
                  }}>
                  {it.label}
                </Button>
              ))}
            </VStack>
          )}
        </Box>
      </HStack>

      {loading && !data && (
        <Box py={10} textAlign="center"><Spinner size="lg" /></Box>
      )}

      {data && (
        <>
          {/* Jobs Overview — each card hands off to the Admin Jobs tab with
              the matching filter pre-applied. The filter payload is stashed
              in localStorage (consumed on JobsTab mount), then a
              navigate:adminTab event with remount=true forces a fresh
              JobsTab so the filter replay can't race the existing tab's
              state. See JobsTab seedlings_jobs_pendingFilter consumer. */}
          <CollapsibleSection title="Jobs Overview" open={isOpen("jobs")} onToggle={() => toggleSection("jobs")}>
            <Box display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(3, 1fr)" }} gap={2}>
              <MetricCard label="Scheduled" value={data.jobs.scheduled} color="gray.600"
                onClick={() => navigateToAdminJobs({ status: "SCHEDULED", dateFrom, dateTo })} />
              <MetricCard label="In Progress" value={data.jobs.inProgress} color="blue.600"
                onClick={() => navigateToAdminJobs({ status: "IN_PROGRESS", dateFrom, dateTo })} />
              {/* "Completed" maps to JobsTab's FINISHED bucket
                  (COMPLETED + CLOSED + PENDING_PAYMENT). Operations counts
                  CLOSED + PENDING_PAYMENT only, so the resulting JobsTab list
                  may include a small number of transient COMPLETED rows on
                  top of the metric count. */}
              <MetricCard label="Completed" value={data.jobs.completed} color="green.600"
                onClick={() => navigateToAdminJobs({ status: "FINISHED", dateFrom, dateTo })} />
              <MetricCard label="Canceled" value={data.jobs.canceled} color="red.500"
                onClick={() => navigateToAdminJobs({ status: "CANCELED", dateFrom, dateTo })} />
              <MetricCard label="Overdue" value={data.jobs.overdue} color={data.jobs.overdue > 0 ? "red.600" : "gray.400"}
                onClick={() => navigateToAdminJobs({ overdue: true, dateFrom, dateTo })} />
              <MetricCard label="Unclaimed" value={data.jobs.unclaimed} color={data.jobs.unclaimed > 0 ? "orange.600" : "gray.400"}
                onClick={() => navigateToAdminJobs({ status: "UNCLAIMED", dateFrom, dateTo })} />
            </Box>
          </CollapsibleSection>

          {/* Unclaimed Jobs */}
          {data.unclaimedItems.length > 0 && (() => {
            const overdue = data.unclaimedItems.filter((item: UnclaimedItem) => item.startAt && bizDateKey(item.startAt) < today);
            const upcoming = data.unclaimedItems.filter((item: UnclaimedItem) => !item.startAt || bizDateKey(item.startAt) >= today);
            const visibleItems = showAllUnclaimed ? [...overdue, ...upcoming] : overdue;
            const headerCount = overdue.length + (showAllUnclaimed ? upcoming.length : 0);
            return (
              <CollapsibleSection title={`Unclaimed Jobs (${headerCount})`} open={isOpen("unclaimed")} onToggle={() => toggleSection("unclaimed")}>
                {visibleItems.length === 0 && !showAllUnclaimed && upcoming.length > 0 && (
                  <Text fontSize="xs" color="fg.muted" px={1} mb={1}>No overdue unclaimed jobs.</Text>
                )}
                <VStack align="stretch" gap={1}>
                  {visibleItems.map((item: UnclaimedItem) => {
                    const isOverdue = item.startAt && bizDateKey(item.startAt) < today;
                    return (
                      <Card.Root key={item.id} variant="outline" borderColor={isOverdue ? "red.200" : "orange.200"} bg={isOverdue ? "red.50" : "orange.50"}>
                        <Card.Body py="2" px="3">
                          <HStack justify="space-between" align="start" gap={2}>
                            <VStack align="start" gap={0.5} flex="1" minW={0}>
                              <Text fontSize="sm" fontWeight="medium">
                                {item.property ?? "Unknown property"}
                                {item.client && <Text as="span" color="fg.muted" fontWeight="normal"> — {clientLabel(item.client)}</Text>}
                              </Text>
                              <HStack gap={2} fontSize="xs" wrap="wrap">
                                {isOverdue && <StatusBadge status="Overdue" palette="red" variant="solid" />}
                                {item.jobType && <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="1.5" borderRadius="full">{prettyStatus(item.jobType)}</Badge>}
                                {item.price != null && <Text color="green.600">${item.price.toFixed(2)}</Text>}
                              </HStack>
                              {item.address && <Box fontSize="xs"><MapLink address={item.address} /></Box>}
                              <Button
                                size="xs"
                                variant="solid"
                                colorPalette="blue"
                                mt={1}
                                onClick={() =>
                                  openEventSearch(
                                    "jobsTabToServicesTabSearch",
                                    item.property ?? "",
                                    true,
                                    `${item.jobId}:${item.id}`,
                                  )
                                }
                              >
                                Manage in Services
                              </Button>
                            </VStack>
                            <Text fontSize="xs" color="fg.muted" flexShrink={0}>
                              {item.startAt ? fmtDate(item.startAt) : ""}
                            </Text>
                          </HStack>
                        </Card.Body>
                      </Card.Root>
                    );
                  })}
                  {upcoming.length > 0 && !showAllUnclaimed && (
                    <Button size="xs" variant="ghost" colorPalette="orange" onClick={() => setShowAllUnclaimed(true)}>
                      Show {upcoming.length} upcoming unclaimed
                    </Button>
                  )}
                  {showAllUnclaimed && upcoming.length > 0 && (
                    <Button size="xs" variant="ghost" onClick={() => setShowAllUnclaimed(false)}>
                      Hide upcoming
                    </Button>
                  )}
                </VStack>
              </CollapsibleSection>
            );
          })()}

          {/* Financial */}
          <CollapsibleSection title="Financial" open={isOpen("financial")} onToggle={() => toggleSection("financial")}>
            <Card.Root variant="outline" bg={data.financial.netRevenue >= 0 ? "green.50" : "red.50"} borderColor={data.financial.netRevenue >= 0 ? "green.200" : "red.200"} mb={2}>
              <Card.Body py="2" px="3">
                <Text fontSize="3xl" fontWeight="bold" color={data.financial.netRevenue >= 0 ? "green.700" : "red.700"} lineHeight="1">
                  {fmt(data.financial.netRevenue)}
                </Text>
                <Text fontSize="xs" color="fg.muted" mt={1}>Net Revenue</Text>
              </Card.Body>
            </Card.Root>
            <Box display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} gap={2}>
              <MetricCard label="Revenue" value={fmt(data.financial.totalRevenue)} color="green.600" />
              <MetricCard label="Expenses" value={fmt(data.financial.totalExpenses)} color="red.500" />
              <MetricCard label="Platform Fees" value={fmt(data.financial.totalPlatformFees)} color="orange.600" />
              <MetricCard label="Business Margin" value={fmt(data.financial.totalBusinessMargin)} color="blue.600" />
            </Box>
            {data.financial.avgJobPrice > 0 && (
              <Text fontSize="xs" color="fg.muted" mt={1} px={1}>Avg job price: {fmt(data.financial.avgJobPrice)}</Text>
            )}
            {Object.keys(data.financial.paymentsByMethod).length > 0 && (
              <HStack mt={2} gap={2} wrap="wrap" px={1}>
                {Object.entries(data.financial.paymentsByMethod).map(([method, amount]) => (
                  <Badge key={method} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                    {methodLabel(method)}: {fmt(amount)}
                  </Badge>
                ))}
              </HStack>
            )}
          </CollapsibleSection>

          {/* Worker Comparison */}
          <CollapsibleSection title="Worker Performance" open={isOpen("workers")} onToggle={() => toggleSection("workers")}>
          <HStack gap={2} wrap="wrap" mb={2}>
            <Badge colorPalette="blue" variant="solid" fontSize="sm" px="3" borderRadius="full">
              {data.team.activeInWindow} Active in window
            </Badge>
            {Object.entries(data.team.workersByTypeInWindow).map(([type, count]) => (
              <Badge key={type} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                {prettyStatus(type)}: {count}
              </Badge>
            ))}
          </HStack>

          {data.workerStats.length > 0 && (() => {
            // Single source of truth for the chartable metrics — the
            // selector below and the chart accessor + tooltip pull from
            // this array. Add a metric by appending an entry with the
            // value extractor + axis label + tooltip formatter.
            const WORKER_METRICS = [
              { key: "jobsCompleted",     label: "Jobs Done", color: "#38A169", getter: (w: typeof data.workerStats[number]) => w.jobsCompleted,        tip: (v: number) => `${v}` },
              { key: "scheduledJobs",     label: "Scheduled", color: "#3182CE", getter: (w: typeof data.workerStats[number]) => w.scheduledJobs,        tip: (v: number) => `${v}` },
              { key: "totalEarnings",     label: "Earnings",  color: "#319795", getter: (w: typeof data.workerStats[number]) => Math.round(w.totalEarnings * 100) / 100, tip: (v: number) => `$${v.toFixed(2)}` },
              { key: "totalActualMinutes",label: "Hours",     color: "#D69E2E", getter: (w: typeof data.workerStats[number]) => Math.round(w.totalActualMinutes / 60 * 10) / 10, tip: (v: number) => `${v}h` },
              { key: "efficiency",        label: "Efficiency",color: "#805AD5", getter: (w: typeof data.workerStats[number]) => w.efficiency,           tip: (v: number) => `${v}%` },
            ] as const;
            const activeMetric = WORKER_METRICS.find((m) => m.key === workerChartMetric) ?? WORKER_METRICS[0];
            // Sort chart data DESC by the active metric so the longest bar
            // sits at the top — that's the convention people scan for
            // first ("who's leading on this metric?"). The table view
            // keeps server order so admins can compare side-by-side.
            const chartData = data.workerStats
              .map((w) => ({ name: w.name, value: activeMetric.getter(w) }))
              .sort((a, b) => b.value - a.value);
            // Truncate names to keep the Y axis readable on narrow screens.
            const truncName = (n: string) => (n.length > 18 ? n.slice(0, 17) + "…" : n);
            return (
              <>
                <HStack gap={2} mb={2} wrap="wrap" align="center">
                  {/* Metric selector — left side; only meaningful in chart
                      mode (table already shows every metric). Takes flex=1
                      so the toggle is pushed flush against the right edge
                      regardless of how many metric pills are visible. */}
                  {workerView === "chart" ? (
                    <HStack gap={1} wrap="wrap" flex="1" minW={0}>
                      {WORKER_METRICS.map((m) => (
                        <Badge
                          key={m.key}
                          size="sm"
                          variant={workerChartMetric === m.key ? "solid" : "outline"}
                          colorPalette="gray"
                          cursor="pointer"
                          onClick={() => setWorkerChartMetric(m.key)}
                        >
                          {m.label}
                        </Badge>
                      ))}
                    </HStack>
                  ) : (
                    // Table mode has no metric selector — keep an empty
                    // flex=1 spacer so the toggle stays right-aligned
                    // identically across views.
                    <Box flex="1" minW={0} />
                  )}
                  {/* View toggle — table vs chart. Right-aligned per
                      operator preference. */}
                  <HStack gap={0} borderWidth="1px" borderColor="gray.300" borderRadius="md" overflow="hidden" flexShrink={0}>
                    <Button
                      size="xs"
                      variant={workerView === "table" ? "solid" : "ghost"}
                      colorPalette={workerView === "table" ? "blue" : undefined}
                      borderRadius="0"
                      onClick={() => setWorkerView("table")}
                      title="Table view"
                    >
                      <LayoutGrid size={12} />
                    </Button>
                    <Button
                      size="xs"
                      variant={workerView === "chart" ? "solid" : "ghost"}
                      colorPalette={workerView === "chart" ? "blue" : undefined}
                      borderRadius="0"
                      onClick={() => setWorkerView("chart")}
                      title="Chart view"
                    >
                      <BarChart3 size={12} />
                    </Button>
                  </HStack>
                </HStack>

                {workerView === "table" && (
                  <Card.Root variant="outline">
                    <Card.Body py="2" px="0">
                      {/* Header */}
                      <HStack px={3} py={1} borderBottomWidth="1px" borderColor="gray.200" fontSize="xs" fontWeight="semibold" color="fg.muted" gap={2}>
                        <Text flex="1" minW={0}>Worker</Text>
                        <Text w="50px" textAlign="right">Done</Text>
                        <Text w="50px" textAlign="right">Sched</Text>
                        <Text w="65px" textAlign="right" display={{ base: "none", md: "block" }}>Earned</Text>
                        <Text w="50px" textAlign="right" display={{ base: "none", md: "block" }}>Time</Text>
                        <Text w="40px" textAlign="right" display={{ base: "none", md: "block" }}>Eff</Text>
                      </HStack>
                      {/* Rows */}
                      {(showAllWorkers ? data.workerStats : data.workerStats.slice(0, 5)).map((w) => (
                        <HStack key={w.id} px={3} py={1.5} borderBottomWidth="1px" borderColor="gray.50" fontSize="xs" gap={2}
                          _hover={{ bg: "gray.50" }}
                        >
                          <VStack align="start" gap={0} flex="1" minW={0}>
                            <Text fontWeight="medium">{w.name}</Text>
                            <Badge colorPalette={w.workerType === "CONTRACTOR" ? "orange" : w.workerType === "TRAINEE" ? "purple" : "blue"} variant="subtle" fontSize="2xs" px="1" borderRadius="full">
                              {w.workerType === "CONTRACTOR" ? "1099" : w.workerType === "TRAINEE" ? "Trainee" : "W-2"}
                            </Badge>
                          </VStack>
                          <Text w="50px" textAlign="right" fontWeight="medium" color="green.600">{w.jobsCompleted}</Text>
                          <Text w="50px" textAlign="right" color="fg.muted">{w.scheduledJobs}</Text>
                          <Text w="65px" textAlign="right" color="green.600" display={{ base: "none", md: "block" }}>{fmt(w.totalEarnings)}</Text>
                          <Text w="50px" textAlign="right" color="fg.muted" display={{ base: "none", md: "block" }}>{w.totalActualMinutes > 0 ? formatDuration(w.totalActualMinutes) : "—"}</Text>
                          <Text w="40px" textAlign="right" display={{ base: "none", md: "block" }}
                            color={w.efficiency >= 100 ? "green.600" : w.efficiency > 0 ? "orange.600" : "fg.muted"}
                            fontWeight={w.efficiency > 0 ? "medium" : "normal"}
                          >
                            {w.efficiency > 0 ? `${w.efficiency}%` : "—"}
                          </Text>
                        </HStack>
                      ))}
                      {data.workerStats.length > 5 && (
                        <Box px={3} py={1}>
                          <Text
                            as="button"
                            fontSize="xs"
                            color="blue.600"
                            cursor="pointer"
                            onClick={() => setShowAllWorkers(!showAllWorkers)}
                          >
                            {showAllWorkers ? "Show less" : `Show all ${data.workerStats.length} workers`}
                          </Text>
                        </Box>
                      )}
                    </Card.Body>
                  </Card.Root>
                )}

                {workerView === "chart" && (
                  <Card.Root variant="outline">
                    <Card.Body py="3" px="2">
                      {/* Vertical bar chart — one row per worker, sized so
                          even a 10-worker team fits without scrolling. Same
                          recharts pattern as StatisticsTab. */}
                      <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 28)}>
                        <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                          <XAxis type="number" fontSize={11} tickFormatter={(v: number) => activeMetric.tip(v)} />
                          <YAxis
                            type="category"
                            dataKey="name"
                            width={120}
                            tick={{ fontSize: 10, style: { fontSize: "10px" } }}
                            tickFormatter={truncName}
                          />
                          <Tooltip formatter={(v: any) => [activeMetric.tip(Number(v)), activeMetric.label]} />
                          <Bar dataKey="value" fill={activeMetric.color} radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </Card.Body>
                  </Card.Root>
                )}
              </>
            );
          })()}
          </CollapsibleSection>

          {/* Equipment */}
          <CollapsibleSection title="Equipment" open={isOpen("equipment")} onToggle={() => toggleSection("equipment")}>
            {/* "Today" snapshot — current state of the fleet, NOT scoped
                to the date range. Kept as a thin strip above the timeframe
                data so the operator can answer both "what's out today?"
                and "what's earned its keep this period?" without switching
                screens. The label is explicit so there's no ambiguity that
                this strip is time-of-load, not window-scoped. */}
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide" mb={1} px={1}>Today</Text>
            <HStack gap={2} wrap="wrap" mb={3}>
              <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">Available: {data.equipment.available}</Badge>
              <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">Checked Out: {data.equipment.checkedOut}</Badge>
              <Badge colorPalette="yellow" variant="subtle" fontSize="xs" px="2" borderRadius="full">Reserved: {data.equipment.reserved}</Badge>
              <Badge colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full">Maintenance: {data.equipment.inMaintenance}</Badge>
              <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">Total: {data.equipment.total}</Badge>
            </HStack>

            {/* "In this window" — checkout-anchored usage stats. Answers
                "what's been doing real work in the selected timeframe?"
                Leaderboard + idle list driven by Checkout.checkedOutAt
                inside [dateFrom, dateTo]. */}
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide" mb={1} px={1}>
              In This Window ({data.equipment.windowDays} {data.equipment.windowDays === 1 ? "day" : "days"})
            </Text>
            <Box display="grid" gridTemplateColumns={{ base: "repeat(3, 1fr)" }} gap={2} mb={2}>
              <MetricCard label="Checkouts" value={data.equipment.windowCheckouts} color="blue.600" />
              <MetricCard label="Rental Income" value={fmt(data.equipment.windowIncome)} color="green.600" />
              <MetricCard label="Pieces Used" value={`${data.equipment.windowDistinctUsed} / ${data.equipment.total}`} color="gray.700" />
            </Box>

            {data.equipment.leaderboard.length > 0 && (() => {
              const EQ_METRICS = [
                { key: "daysOut",        label: "Days Out",    color: "#3182CE", getter: (e: typeof data.equipment.leaderboard[number]) => e.daysOut,        tip: (v: number) => `${v}d` },
                { key: "jobsBilled",     label: "Jobs Billed", color: "#319795", getter: (e: typeof data.equipment.leaderboard[number]) => e.jobsBilled ?? 0,tip: (v: number) => `${v}` },
                { key: "checkouts",      label: "Checkouts",   color: "#805AD5", getter: (e: typeof data.equipment.leaderboard[number]) => e.checkouts,      tip: (v: number) => `${v}` },
                { key: "income",         label: "Income",      color: "#38A169", getter: (e: typeof data.equipment.leaderboard[number]) => Math.round(e.income * 100) / 100, tip: (v: number) => `$${v.toFixed(2)}` },
                { key: "utilizationPct", label: "Utilization", color: "#D69E2E", getter: (e: typeof data.equipment.leaderboard[number]) => e.utilizationPct, tip: (v: number) => `${v}%` },
              ] as const;
              const activeMetric = EQ_METRICS.find((m) => m.key === equipmentChartMetric) ?? EQ_METRICS[0];
              const chartData = data.equipment.leaderboard
                .map((e) => ({ name: e.shortDesc ?? e.id, value: activeMetric.getter(e) }))
                .sort((a, b) => b.value - a.value);
              const truncName = (n: string) => (n.length > 22 ? n.slice(0, 21) + "…" : n);
              return (
                <>
                  <HStack gap={2} mb={2} wrap="wrap" align="center">
                    {equipmentView === "chart" ? (
                      <HStack gap={1} wrap="wrap" flex="1" minW={0}>
                        {EQ_METRICS.map((m) => (
                          <Badge
                            key={m.key}
                            size="sm"
                            variant={equipmentChartMetric === m.key ? "solid" : "outline"}
                            colorPalette="gray"
                            cursor="pointer"
                            onClick={() => setEquipmentChartMetric(m.key)}
                          >
                            {m.label}
                          </Badge>
                        ))}
                      </HStack>
                    ) : (
                      <Box flex="1" minW={0} />
                    )}
                    <HStack gap={0} borderWidth="1px" borderColor="gray.300" borderRadius="md" overflow="hidden" flexShrink={0}>
                      <Button
                        size="xs"
                        variant={equipmentView === "table" ? "solid" : "ghost"}
                        colorPalette={equipmentView === "table" ? "blue" : undefined}
                        borderRadius="0"
                        onClick={() => setEquipmentView("table")}
                        title="Table view"
                      >
                        <LayoutGrid size={12} />
                      </Button>
                      <Button
                        size="xs"
                        variant={equipmentView === "chart" ? "solid" : "ghost"}
                        colorPalette={equipmentView === "chart" ? "blue" : undefined}
                        borderRadius="0"
                        onClick={() => setEquipmentView("chart")}
                        title="Chart view"
                      >
                        <BarChart3 size={12} />
                      </Button>
                    </HStack>
                  </HStack>

                  {equipmentView === "table" && (
                    <Card.Root variant="outline" mb={2}>
                      <Card.Body py="2" px="0">
                        <HStack px={3} py={1} borderBottomWidth="1px" borderColor="gray.200" fontSize="xs" fontWeight="semibold" color="fg.muted" gap={2}>
                          <Text flex="1" minW={0}>Equipment</Text>
                          <Text w="55px" textAlign="right">Days</Text>
                          {/* Jobs Billed — only meaningful for per-job
                              pieces. Shown as "—" for flat-daily rows
                              (jobsBilled is null on the server). */}
                          <Text w="50px" textAlign="right" display={{ base: "none", sm: "block" }} title="Number of billed jobs across the window (per-job billing)">Jobs</Text>
                          <Text w="55px" textAlign="right">Rentals</Text>
                          <Text w="70px" textAlign="right" display={{ base: "none", md: "block" }}>Income</Text>
                          <Text w="55px" textAlign="right">Util %</Text>
                        </HStack>
                        {data.equipment.leaderboard.map((e) => (
                          <HStack key={e.id} px={3} py={1.5} borderBottomWidth="1px" borderColor="gray.50" fontSize="xs" gap={2}
                            _hover={{ bg: "gray.50" }}
                          >
                            <VStack align="start" gap={0} flex="1" minW={0}>
                              <Text fontWeight="medium" truncate>{e.shortDesc ?? "—"}</Text>
                              {(e.brand || e.model) && (
                                <Text color="fg.muted" fontSize="2xs" truncate>
                                  {[e.brand, e.model].filter(Boolean).join(" ")}
                                </Text>
                              )}
                            </VStack>
                            <Text w="55px" textAlign="right" color="blue.600" fontWeight="medium">{e.daysOut}</Text>
                            <Text w="50px" textAlign="right" color="teal.600" display={{ base: "none", sm: "block" }}>
                              {e.jobsBilled != null ? e.jobsBilled : "—"}
                            </Text>
                            <Text w="55px" textAlign="right" color="fg.muted">{e.checkouts}</Text>
                            <Text w="70px" textAlign="right" color="green.600" display={{ base: "none", md: "block" }}>{fmt(e.income)}</Text>
                            <Text w="55px" textAlign="right" color={e.utilizationPct >= 50 ? "green.600" : e.utilizationPct > 0 ? "orange.600" : "fg.muted"}>{e.utilizationPct}%</Text>
                          </HStack>
                        ))}
                      </Card.Body>
                    </Card.Root>
                  )}

                  {equipmentView === "chart" && (
                    <Card.Root variant="outline" mb={2}>
                      <Card.Body py="3" px="2">
                        <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 28)}>
                          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                            <XAxis type="number" fontSize={11} tickFormatter={(v: number) => activeMetric.tip(v)} />
                            <YAxis
                              type="category"
                              dataKey="name"
                              width={150}
                              tick={{ fontSize: 10, style: { fontSize: "10px" } }}
                              tickFormatter={truncName}
                            />
                            <Tooltip formatter={(v: any) => [activeMetric.tip(Number(v)), activeMetric.label]} />
                            <Bar dataKey="value" fill={activeMetric.color} radius={[0, 4, 4, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </Card.Body>
                    </Card.Root>
                  )}
                </>
              );
            })()}

            {data.equipment.leaderboard.length === 0 && data.equipment.idle.length > 0 && (
              <Text fontSize="xs" color="fg.muted" mt={1} mb={2} px={1}>
                No equipment was checked out in this window.
              </Text>
            )}

            {/* Idle list — equipment with zero checkouts in the window.
                Candidates for sale / retire / "why do we own this?" review.
                Collapsed by default since it's typically a long, low-
                frequency list. */}
            {data.equipment.idle.length > 0 && (
              <Box>
                <HStack
                  gap={1.5}
                  cursor="pointer"
                  onClick={() => setEquipmentIdleOpen((v) => !v)}
                  _hover={{ color: "fg" }}
                  color="fg.muted"
                  userSelect="none"
                  py={1}
                  px={1}
                >
                  {equipmentIdleOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Text fontSize="xs" fontWeight="medium">
                    Idle ({data.equipment.idle.length}) — no checkouts in this window
                  </Text>
                </HStack>
                {equipmentIdleOpen && (
                  <HStack gap={1} wrap="wrap" mt={1} px={1}>
                    {data.equipment.idle.map((e) => (
                      <Badge key={e.id} size="sm" colorPalette="gray" variant="subtle" fontSize="2xs" px="2" borderRadius="full">
                        {e.shortDesc ?? "—"}
                        {(e.brand || e.model) && (
                          <Text as="span" color="fg.muted" ml={1}>
                            ({[e.brand, e.model].filter(Boolean).join(" ")})
                          </Text>
                        )}
                      </Badge>
                    ))}
                  </HStack>
                )}
              </Box>
            )}
          </CollapsibleSection>

          {/* Estimates */}
          {(data.estimates.pending + data.estimates.accepted + data.estimates.rejected) > 0 && (
            <CollapsibleSection title="Estimates Pipeline" open={isOpen("estimates")} onToggle={() => toggleSection("estimates")}>
              <Box display="grid" gridTemplateColumns="repeat(3, 1fr)" gap={2}>
                <MetricCard label="Pending" value={data.estimates.pending} color="purple.600" />
                <MetricCard label="Accepted" value={data.estimates.accepted} color="green.600" />
                <MetricCard label="Rejected" value={data.estimates.rejected} color="red.500" />
              </Box>
            </CollapsibleSection>
          )}

          {/* Clients — window-scoped: who got worked with, who's new,
              and how many VIPs were among the worked-with set. */}
          <CollapsibleSection title="Clients" open={isOpen("clients")} onToggle={() => toggleSection("clients")}>
            <HStack gap={2} wrap="wrap" mb={2}>
              <Badge colorPalette="blue" variant="solid" fontSize="sm" px="3" borderRadius="full">
                Worked with: {data.clients.workedWithInWindow}
              </Badge>
              {data.clients.vipWithWorkInWindow > 0 && (
                <Badge colorPalette="yellow" variant="solid" fontSize="xs" px="2" borderRadius="full">
                  VIP: {data.clients.vipWithWorkInWindow}
                </Badge>
              )}
              {data.clients.newInWindow > 0 && (
                <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                  New: {data.clients.newInWindow}
                </Badge>
              )}
            </HStack>
          </CollapsibleSection>

          {/* Recent Activity */}
          <CollapsibleSection title="Recent Activity" open={isOpen("activity")} onToggle={() => toggleSection("activity")}>
            <VStack align="stretch" gap={0}>
              {data.recentAudit.map((a) => (
                <HStack key={a.id} px={2} py={1.5} fontSize="xs" gap={2} borderBottomWidth="1px" borderColor="gray.100">
                  <Text color="fg.muted" flexShrink={0} w={{ base: "70px", md: "120px" }}>{fmtDateTime(a.createdAt)}</Text>
                  <Badge colorPalette="gray" variant="subtle" fontSize="2xs" px="1.5" borderRadius="full" flexShrink={0}>{a.scope}</Badge>
                  <Text flex="1" minW={0}>
                    <Text as="span" fontWeight="medium">{a.actorName}</Text>
                    {" "}{prettyStatus(a.verb).toLowerCase()}
                    {a.action ? ` (${a.action})` : ""}
                  </Text>
                </HStack>
              ))}
              {data.recentAudit.length === 0 && (
                <Text fontSize="xs" color="fg.muted" px={2}>No recent activity</Text>
              )}
            </VStack>
          </CollapsibleSection>
        </>
      )}
      {/* Confirm All Time */}
      <Dialog.Root open={confirmAllTime} onOpenChange={(e) => { if (!e.open) setConfirmAllTime(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm">
              <Dialog.Header><Dialog.Title>Load All Data</Dialog.Title></Dialog.Header>
              <Dialog.Body>
                <Text fontSize="sm">This will load all data for all time. This may be slow. Are you sure?</Text>
              </Dialog.Body>
              <Dialog.Footer>
                <HStack justify="flex-end" gap={2}>
                  <Button variant="ghost" onClick={() => setConfirmAllTime(false)}>Cancel</Button>
                  <Button colorPalette="orange" onClick={() => { setConfirmAllTime(false); setDatePreset("all"); }}>Load All</Button>
                </HStack>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}
