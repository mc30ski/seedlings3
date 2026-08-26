// "Today's hourly pay" collapsible for the Admin Jobs Home tab.
// Shows current $/hr for each worker (or the selected subset) based on
// completed jobs today + completed workdays today. In-progress workdays
// are excluded so the number is stable — it only shifts when a worker
// clocks out.
//
// See /admin/workers/earnings-today for how the numbers are computed.

import { useCallback, useEffect, useState } from "react";
import { Box, Button, HStack, Text, VStack, Badge, IconButton } from "@chakra-ui/react";
import { Clock, RefreshCw } from "lucide-react";
import { Dashboard } from "@/src/ui/components/Dashboard";
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
  hasInProgressJob: boolean;
};

type Props = {
  // Comma-joined worker id list (from the HomeTab picker). Empty
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
    // Load on mount, NOT gated on an open flag. Collapse is now owned by
    // Dashboard, which keeps children mounted (display:none) — and the
    // header's summary line shows the day's totals, so the data has to be
    // fetched even while collapsed or that summary is permanently blank.
    //
    // This previously read `if (open)` against a local collapse flag. When
    // collapse moved to Dashboard that flag was orphaned — nothing set it
    // any more — and the panel silently rendered an empty body.
    void load();
  }, [load, refreshNonce]);

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
    // Shared Dashboard chrome, matching the other Home sections: left accent
    // stripe, collapse toggle, persisted open state. Previously this rolled
    // its own frame and chevron, so it looked like a different kind of thing
    // and forgot its collapse state on every visit.
    //
    // `team` (purple) — same shape as the yellow and blue sections: light
    // frame, tinted header band, accent stripe. NOT `default`, which has
    // neither band nor stripe and belongs to an older, unrelated surface.
    //
    // Purple because every nearer colour is taken or means something else:
    // green is MY ACTIVITIES, yellow is the worker's ESTIMATE, blue is what
    // they were ACTUALLY paid, orange is warnings, red is errors. This is an
    // operator-side team snapshot and needs its own slot.
    <Dashboard
      storageKey="seedlings:homeTab:todayHourlyPayOpen"
      // No name in the title, unlike the other Home sections: this is a
      // team roster, never one person's figures. It is not rendered at all
      // when a single worker is selected.
      title="Today's hourly pay"
      icon={Clock}
      variant="team"
      summarySlot={
        totals ? (
          <Text fontSize="xs" color="fg.muted" lineClamp={1}>
            {totals.jobs} job{totals.jobs === 1 ? "" : "s"} · {fmtHours(totals.hours)} ·{" "}
            {fmtUSD(totals.netPaid)}
            {totals.hours > 0 && ` · ${fmtUSD(teamRate)}/hr`}
          </Text>
        ) : undefined
      }
    >
      <Box>
        {/* Refresh lives in the BODY, not the header: the Dashboard header
            is itself a button, and nesting one inside would be invalid
            markup and would fight the collapse toggle. */}
        <HStack justify="flex-end" mb={1}>
          <IconButton
            aria-label="Refresh"
            size="xs"
            variant="ghost"
            onClick={() => void load()}
            loading={loading}
          >
            <RefreshCw size={12} />
          </IconButton>
        </HStack>
        <Box>
          {loading && rows === null ? (
            <Text fontSize="xs" color="fg.muted">Loading…</Text>
          ) : rows && rows.length === 0 ? (
            <Text fontSize="xs" color="fg.muted">
              No completed jobs yet today. Workers appear here as they
              finish their first job.
            </Text>
          ) : rows ? (
            <VStack align="stretch" gap={2}>
              {/* Table header — only on wide screens. On mobile the
                  stacked-row layout speaks for itself. */}
              <HStack
                fontSize="2xs"
                color="fg.muted"
                fontWeight="semibold"
                px={1}
                display={{ base: "none", md: "flex" }}
              >
                <Text flex={2}>Worker</Text>
                <Text w="60px" textAlign="right">Jobs</Text>
                <Text w="80px" textAlign="right">Hours</Text>
                <Text w="90px" textAlign="right">Earned</Text>
                <Text w="90px" textAlign="right">$/hr</Text>
              </HStack>
              {rows.map((r) => {
                const hasActivity = r.hoursToday > 0 || r.jobsCompleted > 0;
                const chip = r.workerType ? (
                  <Badge
                    size="xs"
                    variant="subtle"
                    colorPalette={
                      r.workerType === "EMPLOYEE" ? "blue"
                        : r.workerType === "CONTRACTOR" ? "orange"
                        : r.workerType === "TRAINEE" ? "cyan"
                        : "gray"
                    }
                  >
                    {r.workerType.toLowerCase()}
                  </Badge>
                ) : null;
                // "In progress" chip — signals that this row's Earned
                // and $/hr are still trailing (worker has an active job
                // that hasn't completed yet, so the numbers will bump
                // once it does).
                const inProgressChip = r.hasInProgressJob ? (
                  <Badge
                    size="xs"
                    variant="subtle"
                    colorPalette="green"
                    title="Currently on a job — this row's Earned and $/hr will update when they finish."
                  >
                    in progress
                  </Badge>
                ) : null;
                return (
                  <Box
                    key={r.userId}
                    fontSize="sm"
                    px={1}
                    py={1}
                    borderRadius="sm"
                    color={hasActivity ? undefined : "fg.muted"}
                  >
                    {/* Desktop: single-row grid with fixed columns. */}
                    <HStack display={{ base: "none", md: "flex" }}>
                      <HStack flex={2} gap={2} minW={0}>
                        <Text truncate>{r.displayName}</Text>
                        {chip}
                        {inProgressChip}
                      </HStack>
                      <Text w="60px" textAlign="right">{r.jobsCompleted}</Text>
                      <Text w="80px" textAlign="right">{fmtHours(r.hoursToday)}</Text>
                      <Text w="90px" textAlign="right">{fmtUSD(r.netPaidToday)}</Text>
                      <Text w="90px" textAlign="right" fontWeight={hasActivity ? "semibold" : undefined}>
                        {r.hoursToday > 0 ? `${fmtUSD(r.equivalentHourlyRate)}` : "—"}
                      </Text>
                    </HStack>
                    {/* Mobile: name + chip on one line, stats on next. */}
                    <VStack align="stretch" gap={0.5} display={{ base: "flex", md: "none" }}>
                      <HStack justify="space-between" gap={2}>
                        <HStack gap={2} minW={0} flex={1} wrap="wrap">
                          <Text truncate>{r.displayName}</Text>
                          {chip}
                          {inProgressChip}
                        </HStack>
                        <Text fontWeight={hasActivity ? "semibold" : undefined} flexShrink={0}>
                          {r.hoursToday > 0 ? `${fmtUSD(r.equivalentHourlyRate)}/hr` : "—"}
                        </Text>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">
                        {r.jobsCompleted} job{r.jobsCompleted === 1 ? "" : "s"} · {fmtHours(r.hoursToday)} · {fmtUSD(r.netPaidToday)}
                      </Text>
                    </VStack>
                  </Box>
                );
              })}
              <Text fontSize="2xs" color="fg.muted" mt={1} pt={1} borderTopWidth={1} borderColor="gray.100">
                Includes in-progress workdays (hours count up to now, or up to the current pause if paused). Earned = promised net for every completed job today (uses the same snapshot/projection payroll uses; doesn't wait for client payment). $/hr = Earned ÷ Hours.
              </Text>
            </VStack>
          ) : null}
        </Box>
      </Box>
    </Dashboard>
  );
}
