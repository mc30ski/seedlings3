"use client";

import { useEffect, useMemo, useState } from "react";
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
import { CalendarRange } from "lucide-react";
import DateInput from "@/src/ui/components/DateInput";
import { Button, Dialog, Portal } from "@chakra-ui/react";
import { apiGet } from "@/src/lib/api";
import { bizDateKey, fmtDate, fmtDateTime, prettyStatus, clientLabel } from "@/src/lib/lib";
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
  team: { activeWorkers: number; workersByType: Record<string, number>; topWorkers: { name: string; jobs: number; earnings: number }[]; workersWithJobs: number; workersIdle: number };
  equipment: { total: number; available: number; checkedOut: number; reserved: number; inMaintenance: number };
  estimates: { pending: number; accepted: number; rejected: number };
  clients: { active: number; paused: number; archived: number; vip: number };
  unclaimedItems: UnclaimedItem[];
  workerStats: WorkerStat[];
  recentAudit: { id: string; scope: string; verb: string; action?: string | null; actorName: string; createdAt: string; metadata?: any }[];
};

const presetItems = [
  { value: "rolling", label: "Rolling" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "lastWeek", label: "Last 7 days" },
  { value: "nextWeek", label: "Next week" },
  { value: "nextMonth", label: "Next month" },
  { value: "all", label: "All time" },
];
const presetCollection = createListCollection({ items: presetItems });

function MetricCard({ label, value, color = "fg.default", sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <Card.Root variant="outline">
      <Card.Body py="3" px="4">
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
  const [confirmAllTime, setConfirmAllTime] = useState(false);

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
  const [dateFrom, setDateFrom] = useState(presetDates.from);
  const [dateTo, setDateTo] = useState(presetDates.to);

  useEffect(() => {
    if (datePreset) {
      const d = computeDatesFromPreset(datePreset);
      setDateFrom(d.from);
      setDateTo(d.to);
    }
  }, [datePreset]);

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

  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const today = bizDateKey(new Date());

  return (
    <Box w="full" pb={8}>
      {/* Date controls */}
      <HStack mb={3} gap={2} wrap="wrap">
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
      </HStack>

      {datePreset && (
        <HStack mb={2} gap={1} px={1}>
          <Badge size="sm" colorPalette="green" variant="subtle">{PRESET_LABELS[datePreset] ?? datePreset}</Badge>
        </HStack>
      )}

      {loading && !data && (
        <Box py={10} textAlign="center"><Spinner size="lg" /></Box>
      )}

      {data && (
        <>
          {/* Jobs Overview */}
          <SectionHeader>Jobs Overview</SectionHeader>
          <Box display="grid" gridTemplateColumns={{ base: "repeat(2, 1fr)", md: "repeat(3, 1fr)" }} gap={2}>
            <MetricCard label="Scheduled" value={data.jobs.scheduled} color="gray.600" />
            <MetricCard label="In Progress" value={data.jobs.inProgress} color="blue.600" />
            <MetricCard label="Completed" value={data.jobs.completed} color="green.600" />
            <MetricCard label="Canceled" value={data.jobs.canceled} color="red.500" />
            <MetricCard label="Overdue" value={data.jobs.overdue} color={data.jobs.overdue > 0 ? "red.600" : "gray.400"} />
            <MetricCard label="Unclaimed" value={data.jobs.unclaimed} color={data.jobs.unclaimed > 0 ? "orange.600" : "gray.400"} />
          </Box>

          {/* Unclaimed Jobs */}
          {data.unclaimedItems.length > 0 && (() => {
            const overdue = data.unclaimedItems.filter((item: UnclaimedItem) => item.startAt && bizDateKey(item.startAt) < today);
            const upcoming = data.unclaimedItems.filter((item: UnclaimedItem) => !item.startAt || bizDateKey(item.startAt) >= today);
            const visibleItems = showAllUnclaimed ? [...overdue, ...upcoming] : overdue;
            const headerCount = overdue.length + (showAllUnclaimed ? upcoming.length : 0);
            return (
              <>
                <SectionHeader>{`Unclaimed Jobs (${headerCount})`}</SectionHeader>
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
              </>
            );
          })()}

          {/* Financial */}
          <SectionHeader>Financial</SectionHeader>
          <Card.Root variant="outline" bg={data.financial.netRevenue >= 0 ? "green.50" : "red.50"} borderColor={data.financial.netRevenue >= 0 ? "green.200" : "red.200"} mb={2}>
            <Card.Body py="3" px="4">
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
                  {prettyStatus(method)}: {fmt(amount)}
                </Badge>
              ))}
            </HStack>
          )}

          {/* Worker Comparison */}
          <SectionHeader>Worker Performance</SectionHeader>
          <HStack gap={2} wrap="wrap" mb={2}>
            <Badge colorPalette="blue" variant="solid" fontSize="sm" px="3" borderRadius="full">
              {data.team.activeWorkers} Workers
            </Badge>
            {Object.entries(data.team.workersByType).map(([type, count]) => (
              <Badge key={type} colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                {prettyStatus(type)}: {count}
              </Badge>
            ))}
            <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">
              Working: {data.team.workersWithJobs}
            </Badge>
            {data.team.workersIdle > 0 && (
              <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                Idle: {data.team.workersIdle}
              </Badge>
            )}
          </HStack>

          {data.workerStats.length > 0 && (
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

          {/* Equipment */}
          <SectionHeader>Equipment</SectionHeader>
          <HStack gap={2} wrap="wrap" mb={2}>
            <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">Available: {data.equipment.available}</Badge>
            <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full">Checked Out: {data.equipment.checkedOut}</Badge>
            <Badge colorPalette="yellow" variant="subtle" fontSize="xs" px="2" borderRadius="full">Reserved: {data.equipment.reserved}</Badge>
            <Badge colorPalette="red" variant="subtle" fontSize="xs" px="2" borderRadius="full">Maintenance: {data.equipment.inMaintenance}</Badge>
            <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">Total: {data.equipment.total}</Badge>
          </HStack>

          {/* Estimates */}
          {(data.estimates.pending + data.estimates.accepted + data.estimates.rejected) > 0 && (
            <>
              <SectionHeader>Estimates Pipeline</SectionHeader>
              <Box display="grid" gridTemplateColumns="repeat(3, 1fr)" gap={2}>
                <MetricCard label="Pending" value={data.estimates.pending} color="purple.600" />
                <MetricCard label="Accepted" value={data.estimates.accepted} color="green.600" />
                <MetricCard label="Rejected" value={data.estimates.rejected} color="red.500" />
              </Box>
            </>
          )}

          {/* Clients */}
          <SectionHeader>Clients</SectionHeader>
          <HStack gap={2} wrap="wrap" mb={2}>
            <Badge colorPalette="green" variant="subtle" fontSize="xs" px="2" borderRadius="full">Active: {data.clients.active}</Badge>
            {data.clients.vip > 0 && <Badge colorPalette="yellow" variant="solid" fontSize="xs" px="2" borderRadius="full">VIP: {data.clients.vip}</Badge>}
            {data.clients.paused > 0 && <Badge colorPalette="orange" variant="subtle" fontSize="xs" px="2" borderRadius="full">Paused: {data.clients.paused}</Badge>}
            {data.clients.archived > 0 && <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">Archived: {data.clients.archived}</Badge>}
          </HStack>

          {/* Recent Activity */}
          <SectionHeader>Recent Activity</SectionHeader>
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
