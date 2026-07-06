"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  Badge,
  Box,
  Button,
  Card,
  HStack,
  Input,
  Text,
  VStack,
  Spinner,
} from "@chakra-ui/react";
import { BarChart3, LayoutGrid, X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDate, bizDateKey, bizToday, bizAddDays } from "@/src/lib/lib";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  CartesianGrid,
} from "recharts";

type WorkerStat = {
  userId: string;
  displayName: string;
  workerType: string | null;
  jobsCompleted: number;
  totalEarnings: number;
  totalExpenses: number;
  netEarnings: number;
  totalActualMinutes: number;
  totalEstimatedMinutes: number;
  jobsWithTiming: number;
  avgActualMinutes: number;
  avgEstimatedMinutes: number;
  efficiencyPercent: number | null;
  propertiesServiced: number;
  paymentMethods: Record<string, number>;
  jobsByDay: Record<string, number>;
};

type StatsResponse = {
  workers: WorkerStat[];
  totalOccurrences: number;
  daysInRange: number;
};

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function workerTypeLabel(wt: string | null): string {
  if (wt === "EMPLOYEE") return "W-2";
  if (wt === "CONTRACTOR") return "1099";
  if (wt === "TRAINEE") return "Trainee";
  return "Unclassified";
}

function workerTypeColor(wt: string | null): string {
  if (wt === "EMPLOYEE") return "blue";
  if (wt === "CONTRACTOR") return "orange";
  if (wt === "TRAINEE") return "cyan";
  return "gray";
}

const CHART_COLORS = ["#3182CE", "#38A169", "#DD6B20", "#805AD5", "#E53E3E", "#319795", "#D69E2E", "#718096"];

type Props = {
  /** If set, only show this worker's stats and hide the worker selector */
  myId?: string;
};

export default function StatisticsTab({ myId }: Props = {}) {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [viewMode, setViewMode] = usePersistedState<"cards" | "charts">("stats_view", "cards");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Date range — default to the last 30 days, ET-anchored.
  const [dateFrom, setDateFrom] = usePersistedState("stats_from", bizAddDays(bizToday(), -30));
  const [dateTo, setDateTo] = usePersistedState("stats_to", bizToday());

  // Team Comparison chart — metric to plot across the displayed
  // worker set. Persisted so the operator's last pick sticks across
  // date-range changes.
  const [comparisonMetric, setComparisonMetric] = usePersistedState<
    "jobsCompleted" | "netEarnings" | "totalActualMinutes" | "efficiencyPercent"
  >("stats_comparisonMetric", "jobsCompleted");

  // Worker selection
  const [selectedWorkers, setSelectedWorkers] = usePersistedState<string[]>("stats_workers", []);
  const [searchText, setSearchText] = useState("");
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

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

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const endpoint = myId ? "/api/me/statistics" : "/api/admin/statistics";
      const res = await apiGet<StatsResponse>(`${endpoint}?${qs}`);
      setData(res);
    } catch (err: any) {
      setError(err?.message || "Failed to load statistics");
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [dateFrom, dateTo]);

  const allWorkers = data?.workers ?? [];
  const workerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const w of allWorkers) map[w.userId] = w.displayName;
    return map;
  }, [allWorkers]);

  const displayed = useMemo(() => {
    if (myId) return allWorkers.filter((w) => w.userId === myId);
    if (selectedWorkers.length === 0) return allWorkers;
    const set = new Set(selectedWorkers);
    return allWorkers.filter((w) => set.has(w.userId));
  }, [allWorkers, selectedWorkers, myId]);

  const searchLc = searchText.toLowerCase();
  const dropdownItems = searchText
    ? allWorkers.filter((w) => w.displayName.toLowerCase().includes(searchLc))
    : allWorkers;
  const limited = dropdownItems.slice(0, 10);

  // Compute team averages for comparison
  const teamAvg = useMemo(() => {
    const active = allWorkers.filter((w) => w.jobsCompleted > 0);
    if (active.length === 0) return null;
    return {
      jobsCompleted: Math.round(active.reduce((s, w) => s + w.jobsCompleted, 0) / active.length),
      avgActualMinutes: Math.round(active.reduce((s, w) => s + w.avgActualMinutes, 0) / active.length),
      netEarnings: Math.round(active.reduce((s, w) => s + w.netEarnings, 0) / active.length * 100) / 100,
      efficiencyPercent: (() => {
        const withEff = active.filter((w) => w.efficiencyPercent != null);
        if (withEff.length === 0) return null;
        return Math.round(withEff.reduce((s, w) => s + w.efficiencyPercent!, 0) / withEff.length);
      })(),
    };
  }, [allWorkers]);

  return (
    <Box w="full" pb={8}>
      {/* Preview banner */}
      <Box mb={3} p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md">
        <Text fontSize="sm" fontWeight="medium" color="yellow.700">Preview Feature</Text>
        <Text fontSize="xs" color="yellow.600">This feature is in preview and will be updated.</Text>
      </Box>

      {/* Controls */}
      <HStack mb={2} gap={2} wrap="wrap" align="flex-end">
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>From</Text>
          <Input type="date" size="sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Box>
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>To</Text>
          <Input type="date" size="sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Box>
        {!myId && <Box ref={dropRef} position="relative">
          <Text fontSize="xs" fontWeight="medium" mb={1}>Compare Workers</Text>
          <Input
            size="sm"
            w="200px"
            placeholder={selectedWorkers.length > 0
              ? selectedWorkers.map((id) => workerNameMap[id] || "Loading…").join(", ")
              : "All Workers"
            }
            value={searchText}
            onChange={(e) => { setSearchText(e.target.value); if (!dropOpen) setDropOpen(true); }}
            onFocus={() => { setDropOpen(true); setSearchText(""); }}
          />
          {dropOpen && (
            <Box position="fixed" zIndex={9999} bg="white" borderWidth="1px" borderColor="gray.200" rounded="md" shadow="lg" w="240px" mt="1"
              ref={(el: HTMLDivElement | null) => {
                if (el && dropRef.current) {
                  const rect = dropRef.current.getBoundingClientRect();
                  el.style.top = `${rect.bottom + 4}px`;
                  el.style.left = `${rect.left}px`;
                }
              }}
            >
              <Box maxH="250px" overflowY="auto">
                {limited.map((w) => (
                  <Box key={w.userId} px="3" py="1.5" fontSize="sm" cursor="pointer"
                    bg={selectedWorkers.includes(w.userId) ? "blue.50" : undefined}
                    _hover={{ bg: "gray.100" }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setSelectedWorkers((prev) =>
                        prev.includes(w.userId) ? prev.filter((id) => id !== w.userId) : [...prev, w.userId]
                      );
                    }}
                  >
                    <HStack gap={2}>
                      <Text flex="1">{w.displayName}</Text>
                      <Badge size="xs" colorPalette={workerTypeColor(w.workerType)}>{workerTypeLabel(w.workerType)}</Badge>
                      {selectedWorkers.includes(w.userId) && <Text color="blue.500" fontWeight="bold">✓</Text>}
                    </HStack>
                  </Box>
                ))}
              </Box>
            </Box>
          )}
        </Box>}
        {!myId && selectedWorkers.length > 0 && (
          <Button variant="outline" size="xs" colorPalette="red" onClick={() => { setSelectedWorkers([]); setSearchText(""); }}>
            Clear
          </Button>
        )}
        <Button
          size="sm"
          variant={viewMode === "charts" ? "solid" : "ghost"}
          px="2"
          onClick={() => setViewMode(viewMode === "cards" ? "charts" : "cards")}
          css={viewMode === "charts" ? { background: "var(--chakra-colors-gray-200)", color: "var(--chakra-colors-gray-700)" } : undefined}
          title={viewMode === "cards" ? "Chart view" : "Card view"}
        >
          {viewMode === "cards" ? <BarChart3 size={14} /> : <LayoutGrid size={14} />}
        </Button>
      </HStack>

      {!myId && selectedWorkers.length > 0 && (
        <HStack mb={2} gap={1} wrap="wrap">
          {selectedWorkers.map((id) => (
            <Badge key={id} size="sm" colorPalette="blue" variant="solid">{workerNameMap[id] || "Loading…"}</Badge>
          ))}
        </HStack>
      )}

      {loading && <Box py={10} textAlign="center"><Spinner size="lg" /></Box>}
      {error && <Text color="red.500" fontSize="sm" mb={4}>{error}</Text>}

      {data && !loading && (
        <>
          {/* Summary bar */}
          <HStack gap={4} mb={4} p={3} bg="blue.50" rounded="xl" borderWidth="1px" borderColor="blue.200" wrap="wrap" justify="center">
            <VStack gap={0}>
              <Text fontSize="xl" fontWeight="bold" color="blue.700">{data.totalOccurrences}</Text>
              <Text fontSize="xs" color="blue.600">Total Jobs</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="xl" fontWeight="bold" color="blue.700">{displayed.filter((w) => w.jobsCompleted > 0).length}</Text>
              <Text fontSize="xs" color="blue.600">Active Workers</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="xl" fontWeight="bold" color="blue.700">{data.daysInRange}</Text>
              <Text fontSize="xs" color="blue.600">Work Days</Text>
            </VStack>
            {teamAvg && (
              <VStack gap={0}>
                <Text fontSize="xl" fontWeight="bold" color="blue.700">{teamAvg.jobsCompleted}</Text>
                <Text fontSize="xs" color="blue.600">Avg Jobs/Worker</Text>
              </VStack>
            )}
          </HStack>

          {/* Team Comparison — bar chart across the displayed worker
              set, one row per worker. Sits above the mode switch so
              it's visible whether the operator is on cards or charts.
              Metric selector chips let them pivot without leaving the
              tab. */}
          {displayed.filter((w) => w.jobsCompleted > 0).length > 0 && (
            <TeamComparisonChart
              workers={displayed}
              metric={comparisonMetric}
              onMetricChange={setComparisonMetric}
            />
          )}

          {viewMode === "cards" ? (
            /* Worker cards */
            <VStack align="stretch" gap={3}>
              {displayed.map((w) => {
                const jobsPerDay = data.daysInRange > 0 ? Math.round((w.jobsCompleted / data.daysInRange) * 10) / 10 : 0;
                const isEfficient = w.efficiencyPercent != null && w.efficiencyPercent >= 100;
                const isSlow = w.efficiencyPercent != null && w.efficiencyPercent < 80;

                return (
                  <Card.Root key={w.userId} variant="outline">
                    <Card.Body py="2" px="3">
                      <HStack justify="space-between" align="start" mb={2}>
                        <VStack align="start" gap={0}>
                          <Text fontSize="md" fontWeight="semibold">{w.displayName}</Text>
                          <Badge size="xs" colorPalette={workerTypeColor(w.workerType)}>{workerTypeLabel(w.workerType)}</Badge>
                        </VStack>
                        {w.jobsCompleted === 0 && (
                          <Text fontSize="xs" color="fg.muted">No completed jobs</Text>
                        )}
                      </HStack>

                      {w.jobsCompleted > 0 && (
                        <>
                          <Box display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} gap={3} mb={2}>
                            <StatBox label="Jobs Completed" value={String(w.jobsCompleted)} highlight={teamAvg && w.jobsCompleted > teamAvg.jobsCompleted ? "green" : undefined} />
                            <StatBox label="Jobs/Day" value={String(jobsPerDay)} />
                            <StatBox label="Properties" value={String(w.propertiesServiced)} />
                            <StatBox label="Net Earnings" value={`$${w.netEarnings.toFixed(2)}`} highlight={teamAvg && w.netEarnings > teamAvg.netEarnings ? "green" : undefined} />
                          </Box>
                          <Box display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} gap={3} mb={2}>
                            <StatBox label="Avg Actual Time" value={w.avgActualMinutes > 0 ? formatDuration(w.avgActualMinutes) : "—"} />
                            <StatBox label="Avg Estimated" value={w.avgEstimatedMinutes > 0 ? formatDuration(w.avgEstimatedMinutes) : "—"} />
                            <StatBox
                              label="Efficiency"
                              value={w.efficiencyPercent != null ? `${w.efficiencyPercent}%` : "—"}
                              highlight={isEfficient ? "green" : isSlow ? "red" : undefined}
                              subtitle={isEfficient ? "Faster than estimated" : isSlow ? "Slower than estimated" : undefined}
                            />
                            <StatBox label="Total Hours" value={w.totalActualMinutes > 0 ? formatDuration(w.totalActualMinutes) : "—"} />
                          </Box>
                          <Box display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} gap={3}>
                            <StatBox label="Gross Earnings" value={`$${w.totalEarnings.toFixed(2)}`} />
                            <StatBox label="Expenses" value={`$${w.totalExpenses.toFixed(2)}`} />
                            <StatBox label="Earnings/Job" value={w.jobsCompleted > 0 ? `$${(w.netEarnings / w.jobsCompleted).toFixed(2)}` : "—"} />
                            <StatBox label="Earnings/Hour" value={w.totalActualMinutes > 0 ? `$${(w.netEarnings / (w.totalActualMinutes / 60)).toFixed(2)}` : "—"} />
                          </Box>
                        </>
                      )}
                    </Card.Body>
                  </Card.Root>
                );
              })}
            </VStack>
          ) : (
            /* Chart view */
            <ChartView workers={displayed} daysInRange={data.daysInRange} />
          )}
        </>
      )}
    </Box>
  );
}

// Team Comparison — horizontal bar chart across the displayed worker
// set, sorted DESC by the active metric (longest bar at the top —
// scan convention for "who's leading?"). Metric pills let the
// operator pivot without leaving the tab. Truncates long names on
// the Y axis for readability on narrow screens.
function TeamComparisonChart({
  workers,
  metric,
  onMetricChange,
}: {
  workers: WorkerStat[];
  metric: "jobsCompleted" | "netEarnings" | "totalActualMinutes" | "efficiencyPercent";
  onMetricChange: (m: "jobsCompleted" | "netEarnings" | "totalActualMinutes" | "efficiencyPercent") => void;
}) {
  const METRICS = [
    {
      key: "jobsCompleted" as const,
      label: "Jobs",
      color: CHART_COLORS[1],
      get: (w: WorkerStat) => w.jobsCompleted,
      tip: (v: number) => `${v}`,
    },
    {
      key: "netEarnings" as const,
      label: "Net Earnings",
      color: CHART_COLORS[5],
      get: (w: WorkerStat) => Math.round(w.netEarnings * 100) / 100,
      tip: (v: number) => `$${v.toFixed(2)}`,
    },
    {
      key: "totalActualMinutes" as const,
      label: "Hours",
      color: CHART_COLORS[6],
      get: (w: WorkerStat) => Math.round((w.totalActualMinutes / 60) * 10) / 10,
      tip: (v: number) => `${v}h`,
    },
    {
      key: "efficiencyPercent" as const,
      label: "Efficiency",
      color: CHART_COLORS[3],
      get: (w: WorkerStat) => w.efficiencyPercent ?? 0,
      tip: (v: number) => `${v}%`,
    },
  ];
  const active = METRICS.find((m) => m.key === metric) ?? METRICS[0];
  const chartData = workers
    .map((w) => ({ name: w.displayName, value: active.get(w) }))
    .sort((a, b) => b.value - a.value);
  const truncName = (n: string) => (n.length > 18 ? n.slice(0, 17) + "…" : n);
  return (
    <Card.Root variant="outline" mb={3}>
      <Card.Body py="3" px="3">
        <HStack gap={2} mb={2} wrap="wrap">
          <Text fontSize="xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
            Team Comparison
          </Text>
          <HStack gap={1} wrap="wrap">
            {METRICS.map((m) => (
              <Badge
                key={m.key}
                size="sm"
                variant={metric === m.key ? "solid" : "outline"}
                colorPalette="gray"
                cursor="pointer"
                onClick={() => onMetricChange(m.key)}
              >
                {m.label}
              </Badge>
            ))}
          </HStack>
        </HStack>
        <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 28)}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} tickFormatter={(v: number) => active.tip(v)} />
            <YAxis
              type="category"
              dataKey="name"
              width={120}
              tick={{ fontSize: 10, style: { fontSize: "10px" } }}
              tickFormatter={truncName}
            />
            <Tooltip formatter={(v: any) => [active.tip(Number(v)), active.label]} />
            <Bar dataKey="value" fill={active.color} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card.Body>
    </Card.Root>
  );
}

function StatBox({ label, value, highlight, subtitle }: { label: string; value: string; highlight?: "green" | "red"; subtitle?: string }) {
  return (
    <Box p={2} bg={highlight === "green" ? "green.50" : highlight === "red" ? "red.50" : "gray.50"} rounded="md">
      <Text fontSize="lg" fontWeight="bold" color={highlight === "green" ? "green.700" : highlight === "red" ? "red.700" : undefined}>
        {value}
      </Text>
      <Text fontSize="xs" color="fg.muted">{label}</Text>
      {subtitle && <Text fontSize="xs" color={highlight === "green" ? "green.600" : "red.600"}>{subtitle}</Text>}
    </Box>
  );
}

function ChartView({ workers, daysInRange }: { workers: WorkerStat[]; daysInRange: number }) {
  const active = workers.filter((w) => w.jobsCompleted > 0);

  if (active.length === 0) {
    return <Text textAlign="center" color="fg.muted" py={8}>No data to chart.</Text>;
  }

  const barH = 28;
  const chartH = Math.max(80, active.length * barH + 40);
  // Calculate width needed for longest name
  const longestName = active.reduce((max, w) => w.displayName.length > max ? w.displayName.length : max, 0);
  const nameW = Math.min(Math.max(longestName * 7, 80), 160);

  const chartData = active.map((w) => ({
    name: w.displayName,
    fullName: w.displayName,
    jobs: w.jobsCompleted,
    jobsPerDay: daysInRange > 0 ? Math.round((w.jobsCompleted / daysInRange) * 10) / 10 : 0,
    netEarnings: Math.round(w.netEarnings),
    earningsPerJob: w.jobsCompleted > 0 ? Math.round(w.netEarnings / w.jobsCompleted) : 0,
    earningsPerHour: w.totalActualMinutes > 0 ? Math.round(w.netEarnings / (w.totalActualMinutes / 60)) : 0,
    avgActualMins: w.avgActualMinutes,
    avgEstimatedMins: w.avgEstimatedMinutes,
    efficiency: w.efficiencyPercent ?? 0,
    totalHours: Math.round(w.totalActualMinutes / 60 * 10) / 10,
    properties: w.propertiesServiced,
  }));

  return (
    <VStack align="stretch" gap={3}>
      <ChartSection title="Jobs Completed">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [v, "Jobs"]} />
            <Bar dataKey="jobs" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Net Earnings ($)">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [`$${v}`, "Earnings"]} />
            <Bar dataKey="netEarnings" fill={CHART_COLORS[1]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Earnings per Job ($)">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [`$${v}`, "Per Job"]} />
            <Bar dataKey="earningsPerJob" fill={CHART_COLORS[4]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Earnings per Hour ($)">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} tickFormatter={(v) => `$${v}`} />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [`$${v}/hr`, "Per Hour"]} />
            <Bar dataKey="earningsPerHour" fill={CHART_COLORS[3]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Avg Time per Job (min)" subtitle={<HStack gap={3} fontSize="xs"><HStack gap={1}><Box w="10px" h="10px" bg={CHART_COLORS[0]} rounded="sm" /><Text>Actual</Text></HStack><HStack gap={1}><Box w="10px" h="10px" bg={CHART_COLORS[7]} rounded="sm" /><Text>Estimated</Text></HStack></HStack>}>
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} unit="m" />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any, name: any) => [`${v} min`, name === "avgActualMins" ? "Actual" : "Estimated"]} />
            <Bar dataKey="avgActualMins" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} />
            <Bar dataKey="avgEstimatedMins" fill={CHART_COLORS[7]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Efficiency (100% = on time, >100% = faster)">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} unit="%" domain={[0, "auto"]} />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [`${v}%`, "Efficiency"]} />
            <Bar
              dataKey="efficiency"
              radius={[0, 4, 4, 0]}
              fill={CHART_COLORS[5]}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Total Hours Worked">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} unit="h" />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [`${v}h`, "Hours"]} />
            <Bar dataKey="totalHours" fill={CHART_COLORS[2]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>

      <ChartSection title="Properties Serviced">
        <ResponsiveContainer width="100%" height={chartH}>
          <BarChart data={chartData} layout="vertical" margin={{ left: 10, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />
            <XAxis type="number" fontSize={11} />
            <YAxis type="category" dataKey="name" width={nameW} tick={{ fontSize: 10, style: { fontSize: "10px" } }} />
            <Tooltip formatter={(v: any) => [v, "Properties"]} />
            <Bar dataKey="properties" fill={CHART_COLORS[5]} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartSection>
    </VStack>
  );
}

function ChartSection({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card.Root variant="outline">
      <Card.Body py="2" px="3">
        <HStack justify="space-between" align="center" mb={2}>
          <Text fontSize="sm" fontWeight="semibold">{title}</Text>
          {subtitle}
        </HStack>
        {children}
      </Card.Body>
    </Card.Root>
  );
}
