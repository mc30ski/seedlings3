"use client";
import type { WorkerType } from "@repo/money";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Scope } from "@/src/lib/scope";
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
import { fmtDate, bizDateKey, bizToday, bizAddDays, type EtDateKey } from "@/src/lib/dates";
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
import { payClassLabel } from "../../lib/paymentMath";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";

type WorkerStat = {
  userId: string;
  displayName: string;
  workerType: WorkerType | null;
  jobsCompleted: number;
  // OPTIONAL BECAUSE THE SERVER OMITS THEM. `/statistics` drops all three
  // for a caller without `payroll.view`. Typed as required, every read
  // compiled and crashed at runtime on `undefined.toFixed(2)`; typed
  // optional, the compiler names each one.
  totalEarnings?: number;
  totalExpenses?: number;
  netEarnings?: number;
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

function workerTypeLabel(wt: WorkerType | null): string {
  return payClassLabel(wt);
}

function workerTypeColor(wt: WorkerType | null): string {
  if (wt === "EMPLOYEE") return "blue";
  if (wt === "CONTRACTOR") return "orange";
  if (wt === "UNPAID") return "purple";
  return "gray";
}

/**
 * The chart series palette, as THEME TOKENS rather than hex.
 *
 * It was eight literal hex values, which meant eight identical bars in all
 * fourteen themes — including the four dark-grounded ones, where a
 * near-black series sat on a near-black page. Hex cannot theme; that is the
 * whole rule.
 *
 * `.solid` is the right slot: it is a FILL, which is what a bar is, as
 * opposed to `.fg` which is ink for text. The win is visible on `gray`,
 * which resolves to #18181b on a light theme and #FFFFFF on a dark one —
 * the series that used to disappear now inverts on its own.
 *
 * NO `yellow`, deliberately. `yellow.solid` is #fde047 in every theme but
 * `contrast` — a pale wash that reads as a disabled bar on white. `pink`
 * takes that slot; `cyan` was the other candidate and sits too close to
 * `teal` two places away.
 *
 * Written as `var(--chakra-colors-…)` because these are consumed by
 * recharts `fill=` (plain SVG, which needs a real CSS value) as well as by
 * Chakra `bg=`. Verified to resolve and paint at runtime — a token in a
 * CUSTOM namespace does not emit a CSS variable and silently resolves to
 * nothing, which is how the title bar once lost its gradient. These eight
 * are standard palette tokens and do emit.
 */
const CHART_COLORS = [
  "var(--chakra-colors-blue-solid)",
  "var(--chakra-colors-green-solid)",
  "var(--chakra-colors-orange-solid)",
  "var(--chakra-colors-purple-solid)",
  "var(--chakra-colors-red-solid)",
  "var(--chakra-colors-teal-solid)",
  "var(--chakra-colors-pink-solid)",
  "var(--chakra-colors-gray-solid)",
];

type Props = {
  /** If set, only show this worker's stats and hide the worker selector */
  myId?: string;
  /** Needed to gate the per-worker money columns, which the server omits
   *  for a caller without `payroll.view`. Absent fails closed. */
  scope?: Scope;
};

export default function StatisticsTab({ myId, scope }: Props = {}) {
  // THE MONEY COLUMNS ARE OMITTED, NOT ZEROED.
  //
  // `/statistics` drops `netEarnings`, `totalEarnings` and `totalExpenses`
  // unless the caller holds `payroll.view` — they used to be readable by the
  // baseline Trainee. Rendering them unguarded is a TypeError on
  // `undefined.toFixed(2)`, not a blank, and the team average quietly
  // becomes NaN.
  //
  // The server must keep OMITTING rather than sending 0: a zero reads as
  // "this person earned nothing", which is a lie about somebody's pay.
  const showsPay = !!scope?.can?.("payroll.view");
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
      const endpoint = myId ? "/api/me/statistics" : "/api/statistics";
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
      // Averaged over the rows that CARRY the field, not over everyone —
      // a missing column must not drag the team average toward zero.
      netEarnings: (() => {
        const paid = active.flatMap((w) =>
          typeof w.netEarnings === "number" ? [w.netEarnings] : [],
        );
        if (paid.length === 0) return null;
        return Math.round((paid.reduce((a, b) => a + b, 0) / paid.length) * 100) / 100;
      })(),
      efficiencyPercent: (() => {
        const withEff = active.filter((w) => w.efficiencyPercent != null);
        if (withEff.length === 0) return null;
        return Math.round(withEff.reduce((s, w) => s + w.efficiencyPercent!, 0) / withEff.length);
      })(),
    };
  }, [allWorkers]);

  return (
    <Box w="full" pb={8}>
      {/* The "Preview Feature" banner that used to sit here is GONE
          (2026-10-26). It dated from before this tab was unwired, and it
          was still claiming the screen was provisional on the day it became
          the only way a portfolio lead rolls up their district. A standing
          "this will change" notice on a shipped surface teaches people to
          discount every other notice on the page — including the one below
          that says the figures are a slice, which they must not discount. */}

      {/* THE HELP, and it leads with WHO this is about.
          Every other tab on Insight and Money reports the business. This one
          reports named individuals — their hours, their pace against an
          estimate, their pay — which changes how it should be read and who
          should be shown it. Saying so first is the point of the panel. */}
      <TabExplainer explainerId="seedlings:statisticsTab:guideOpen">
        <ExplainerText>
          <Em>This page is about people, not the business.</Em> Every row is
          one person: the visits they finished, the time they took against
          what was estimated, and the properties they covered. For company
          numbers — jobs by status, revenue, equipment — use the Insights
          panel on Jobs instead.
        </ExplainerText>
        <ExplainerText>
          <Em>Treat it as you would a payslip.</Em> These are real people&rsquo;s
          hours and earnings, shown next to each other and ranked. Earnings
          appear only for someone allowed to read pay, and when they are
          hidden they are left out rather than shown as zero — a zero would
          read as &ldquo;earned nothing&rdquo;, which is a lie about somebody&rsquo;s wages.
        </ExplainerText>
        <ExplainerText>
          <Em>Efficiency is a comparison, not a verdict.</Em> It is actual
          time against the estimate on the job, so a run of hard properties
          or a stale estimate moves it as much as the worker does.
        </ExplainerText>
        <ExplainerText>
          <Em>Narrowed to a portfolio, the totals are partial.</Em> If your access
          covers one territory, or you have picked a portfolio in the title bar,
          these figures count only work done there — somebody who also worked
          the next district shows less here than they were actually paid. The
          strip above the tabs names the portfolio whenever that is the case.
        </ExplainerText>
      </TabExplainer>

      {/* Controls */}
      <HStack mb={2} gap={2} wrap="wrap" align="flex-end">
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>From</Text>
          <Input type="date" size="sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value as EtDateKey)} />
        </Box>
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>To</Text>
          <Input type="date" size="sm" value={dateTo} onChange={(e) => setDateTo(e.target.value as EtDateKey)} />
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
            <Box position="fixed" zIndex={9999} bg="bg.panel" borderWidth="1px" borderColor="gray.emphasized" rounded="md" shadow="lg" w="240px" mt="1"
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
                    bg={selectedWorkers.includes(w.userId) ? "blue.faint" : undefined}
                    _hover={{ bg: "gray.subtle" }}
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
                      {selectedWorkers.includes(w.userId) && <Text color="blue.fg" fontWeight="bold">✓</Text>}
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
          css={viewMode === "charts" ? { background: "var(--chakra-colors-gray-muted)", color: "var(--chakra-colors-gray-fg)" } : undefined}
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
      {error && <Text color="red.fg" fontSize="sm" mb={4}>{error}</Text>}

      {data && !loading && (
        <>
          {/* THE "SHOWING DURHAM ONLY" NOTICE IS NOT HERE ANY MORE.
              This tab had its own, and once the app-wide strip landed
              above the tab row the two stacked — the same fact twice on
              one screen, which on a phone pushed the first number below
              the fold. One notice, one place: PortfolioScopeNotice. */}
          {/* Summary bar */}
          <HStack gap={4} mb={4} p={3} bg="blue.faint" rounded="xl" borderWidth="1px" borderColor="blue.emphasized" wrap="wrap" justify="center">
            <VStack gap={0}>
              <Text fontSize="xl" fontWeight="bold" color="blue.fg">{data.totalOccurrences}</Text>
              <Text fontSize="xs" color="blue.fg">Total Jobs</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="xl" fontWeight="bold" color="blue.fg">{displayed.filter((w) => w.jobsCompleted > 0).length}</Text>
              <Text fontSize="xs" color="blue.fg">Active Workers</Text>
            </VStack>
            <VStack gap={0}>
              <Text fontSize="xl" fontWeight="bold" color="blue.fg">{data.daysInRange}</Text>
              <Text fontSize="xs" color="blue.fg">Work Days</Text>
            </VStack>
            {teamAvg && (
              <VStack gap={0}>
                <Text fontSize="xl" fontWeight="bold" color="blue.fg">{teamAvg.jobsCompleted}</Text>
                <Text fontSize="xs" color="blue.fg">Avg Jobs/Worker</Text>
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
                            {showsPay && typeof w.netEarnings === "number" && (
                              <StatBox label="Net Earnings" value={`$${w.netEarnings.toFixed(2)}`} highlight={teamAvg?.netEarnings != null && w.netEarnings > teamAvg.netEarnings ? "green" : undefined} />
                            )}
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
                            {showsPay && typeof w.totalEarnings === "number" && (
                              <StatBox label="Gross Earnings" value={`$${w.totalEarnings.toFixed(2)}`} />
                            )}
                            {showsPay && typeof w.totalExpenses === "number" && (
                              <StatBox label="Charges on jobs" value={`$${w.totalExpenses.toFixed(2)}`} />
                            )}
                            {showsPay && typeof w.netEarnings === "number" && (
                              <StatBox label="Earnings/Job" value={w.jobsCompleted > 0 ? `$${(w.netEarnings / w.jobsCompleted).toFixed(2)}` : "—"} />
                            )}
                            {showsPay && typeof w.netEarnings === "number" && (
                              <StatBox label="Earnings/Hour" value={w.totalActualMinutes > 0 ? `$${(w.netEarnings / (w.totalActualMinutes / 60)).toFixed(2)}` : "—"} />
                            )}
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
      // null, not 0 — a worker whose pay this caller may not read has no
      // bar, rather than a bar at the bottom claiming they earned nothing.
      get: (w: WorkerStat) =>
        typeof w.netEarnings === "number" ? Math.round(w.netEarnings * 100) / 100 : null,
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
  // A worker whose value this caller may not read is dropped from the chart
  // rather than plotted at zero, which would rank them last on a bar labelled
  // "Net Earnings".
  const chartData = workers
    .map((w) => ({ name: w.displayName, value: active.get(w) }))
    .filter((d): d is { name: string; value: number } => d.value !== null)
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
    <Box p={2} bg={highlight === "green" ? "green.faint" : highlight === "red" ? "red.faint" : "gray.faint"} rounded="md">
      <Text fontSize="lg" fontWeight="bold" color={highlight === "green" ? "green.fg" : highlight === "red" ? "red.fg" : undefined}>
        {value}
      </Text>
      <Text fontSize="xs" color="fg.muted">{label}</Text>
      {subtitle && <Text fontSize="xs" color={highlight === "green" ? "green.fg" : "red.fg"}>{subtitle}</Text>}
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
    // Same rule as the chart series above: absent reads as "not shown to
    // you", and must never be flattened to a zero that reads as "earned
    // nothing".
    netEarnings: typeof w.netEarnings === "number" ? Math.round(w.netEarnings) : null,
    earningsPerJob:
      typeof w.netEarnings === "number" && w.jobsCompleted > 0
        ? Math.round(w.netEarnings / w.jobsCompleted)
        : null,
    earningsPerHour:
      typeof w.netEarnings === "number" && w.totalActualMinutes > 0
        ? Math.round(w.netEarnings / (w.totalActualMinutes / 60))
        : null,
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
