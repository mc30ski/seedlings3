// "Today's hourly pay" collapsible for the Admin Jobs Home tab.
// Shows current $/hr for each worker (or the selected subset) based on
// completed jobs today + completed workdays today. In-progress workdays
// are excluded so the number is stable — it only shifts when a worker
// clocks out.
//
// See /admin/workers/earnings-today for how the numbers are computed.

import { useCallback, useEffect, useState } from "react";
import { Box, Button, HStack, Text, VStack, Badge, IconButton } from "@chakra-ui/react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { usePersistedState } from "@/src/lib/usePersistedState";
import { apiGet } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

type WorkerEarningsToday = {
  userId: string;
  displayName: string;
  workerType: string | null;
  hoursToday: number;
  netPaidToday: number;
  jobsCompleted: number;
  equivalentHourlyRate: number;
};

type Props = {
  // Comma-joined worker id list (from the AdminHomeTab picker). Empty
  // string = all approved workers. Undefined = same as empty string.
  workerIds?: string;
  // Bump to force a refetch (e.g. after "Started/Ended workday" mutations).
  refreshNonce?: number;
};

function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function fmtHours(n: number): string {
  return `${n.toFixed(2)}h`;
}

export default function TodayHourlyPayPanel({ workerIds, refreshNonce = 0 }: Props) {
  const [open, setOpen] = usePersistedState<boolean>("adminHome_hourlyPayCollapsed", false);
  const [rows, setRows] = useState<WorkerEarningsToday[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = workerIds ? `?workerIds=${encodeURIComponent(workerIds)}` : "";
      const data = await apiGet<WorkerEarningsToday[]>(`/api/admin/workers/earnings-today${q}`);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load today's hourly pay.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [workerIds]);

  useEffect(() => {
    if (open) void load();
  }, [open, load, refreshNonce]);

  // Roll-up totals for the header (only when we have data). Hours are
  // additive; the team-level $/hr uses total pay ÷ total hours (a true
  // team-weighted average, not a mean of per-worker rates — matches how
  // ReconcileTab aggregates).
  const totals = rows
    ? rows.reduce(
        (acc, r) => ({
          hours: acc.hours + r.hoursToday,
          netPaid: acc.netPaid + r.netPaidToday,
          jobs: acc.jobs + r.jobsCompleted,
        }),
        { hours: 0, netPaid: 0, jobs: 0 },
      )
    : null;
  const teamRate = totals && totals.hours > 0 ? totals.netPaid / totals.hours : 0;

  return (
    <Box
      borderWidth={1}
      borderColor="gray.200"
      borderRadius="md"
      bg="white"
      overflow="hidden"
    >
      <HStack
        justify="space-between"
        px={3}
        py={2}
        cursor="pointer"
        onClick={() => setOpen((v) => !v)}
        _hover={{ bg: "gray.50" }}
      >
        <HStack gap={2}>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          <Text fontSize="sm" fontWeight="semibold">
            Today's hourly pay
          </Text>
          {totals && (
            <Text fontSize="xs" color="fg.muted">
              {totals.jobs} job{totals.jobs === 1 ? "" : "s"} · {fmtHours(totals.hours)} ·{" "}
              {fmtUSD(totals.netPaid)}
              {totals.hours > 0 && ` · ${fmtUSD(teamRate)}/hr`}
            </Text>
          )}
        </HStack>
        {open && (
          <IconButton
            aria-label="Refresh"
            size="xs"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              void load();
            }}
            loading={loading}
          >
            <RefreshCw size={12} />
          </IconButton>
        )}
      </HStack>
      {open && (
        <Box borderTopWidth={1} borderColor="gray.200" px={3} py={2}>
          {loading && rows === null ? (
            <Text fontSize="xs" color="fg.muted">Loading…</Text>
          ) : rows && rows.length === 0 ? (
            <Text fontSize="xs" color="fg.muted">
              No approved workers found.
            </Text>
          ) : rows ? (
            <VStack align="stretch" gap={1}>
              <HStack fontSize="2xs" color="fg.muted" fontWeight="semibold" px={1}>
                <Text flex={2}>Worker</Text>
                <Text w="60px" textAlign="right">Jobs</Text>
                <Text w="80px" textAlign="right">Hours</Text>
                <Text w="90px" textAlign="right">Earned</Text>
                <Text w="90px" textAlign="right">$/hr</Text>
              </HStack>
              {rows.map((r) => {
                const hasActivity = r.hoursToday > 0 || r.jobsCompleted > 0;
                return (
                  <HStack
                    key={r.userId}
                    fontSize="sm"
                    px={1}
                    py={1}
                    borderRadius="sm"
                    color={hasActivity ? undefined : "fg.muted"}
                  >
                    <HStack flex={2} gap={2} minW={0}>
                      <Text truncate>{r.displayName}</Text>
                      {r.workerType && (
                        <Badge size="xs" variant="outline">
                          {r.workerType.toLowerCase()}
                        </Badge>
                      )}
                    </HStack>
                    <Text w="60px" textAlign="right">{r.jobsCompleted}</Text>
                    <Text w="80px" textAlign="right">{fmtHours(r.hoursToday)}</Text>
                    <Text w="90px" textAlign="right">{fmtUSD(r.netPaidToday)}</Text>
                    <Text w="90px" textAlign="right" fontWeight={hasActivity ? "semibold" : undefined}>
                      {r.hoursToday > 0 ? `${fmtUSD(r.equivalentHourlyRate)}` : "—"}
                    </Text>
                  </HStack>
                );
              })}
              <Text fontSize="2xs" color="fg.muted" mt={1} pt={1} borderTopWidth={1} borderColor="gray.100">
                Excludes in-progress workdays. $/hr = today's pay ÷ hours from completed workdays.
              </Text>
            </VStack>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
