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
import { X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { fmtDate, bizDateKey } from "@/src/lib/lib";

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

export default function StatisticsTab() {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Date range
  const thirtyAgo = new Date();
  thirtyAgo.setDate(thirtyAgo.getDate() - 30);
  const [dateFrom, setDateFrom] = usePersistedState("stats_from", bizDateKey(thirtyAgo));
  const [dateTo, setDateTo] = usePersistedState("stats_to", bizDateKey(new Date()));

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
      const res = await apiGet<StatsResponse>(`/api/admin/statistics?${qs}`);
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
    if (selectedWorkers.length === 0) return allWorkers;
    const set = new Set(selectedWorkers);
    return allWorkers.filter((w) => set.has(w.userId));
  }, [allWorkers, selectedWorkers]);

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
      <HStack mb={3} gap={2} wrap="wrap" align="flex-end">
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>From</Text>
          <Input type="date" size="sm" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </Box>
        <Box>
          <Text fontSize="xs" fontWeight="medium" mb={1}>To</Text>
          <Input type="date" size="sm" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </Box>
        <Box ref={dropRef} position="relative">
          <Text fontSize="xs" fontWeight="medium" mb={1}>Compare Workers</Text>
          <Input
            size="sm"
            w="200px"
            placeholder={selectedWorkers.length > 0
              ? selectedWorkers.map((id) => workerNameMap[id] || id).join(", ")
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
        </Box>
        {selectedWorkers.length > 0 && (
          <Button variant="ghost" size="sm" px="2" minW="0" onClick={() => { setSelectedWorkers([]); setSearchText(""); }}>
            <X size={14} />
          </Button>
        )}
      </HStack>

      {selectedWorkers.length > 0 && (
        <HStack mb={3} gap={1} wrap="wrap">
          {selectedWorkers.map((id) => (
            <Badge key={id} size="sm" colorPalette="blue" variant="solid">{workerNameMap[id] || id}</Badge>
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

          {/* Worker cards */}
          <VStack align="stretch" gap={3}>
            {displayed.map((w) => {
              const jobsPerDay = data.daysInRange > 0 ? Math.round((w.jobsCompleted / data.daysInRange) * 10) / 10 : 0;
              const isEfficient = w.efficiencyPercent != null && w.efficiencyPercent >= 100;
              const isSlow = w.efficiencyPercent != null && w.efficiencyPercent < 80;

              return (
                <Card.Root key={w.userId} variant="outline">
                  <Card.Body py="3" px="4">
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
                        {/* Stats grid */}
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
        </>
      )}
    </Box>
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
