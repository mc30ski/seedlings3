// Aggregate variant of WorkerHourlyPayCard — shows the "Pay per hour"
// figure for EVERY approved worker side-by-side. Rendered on
// Admin → Work → Home when no specific worker is selected (aggregate
// view / no viewAsUserId). The single-worker card handles the "one
// worker at a time" surface; this handles the "team snapshot" surface.
//
// Data: fires N parallel /api/me/hourly-pay?viewAsUserId=<id>&days=D
// requests so the tier / share / rate math stays in one place on the
// backend. N is small (a handful of workers) and the requests are
// cheap; a batch endpoint would just duplicate the math.

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Card,
  HStack,
  SimpleGrid,
  Select,
  Spinner,
  Text,
  VStack,
  createListCollection,
} from "@chakra-ui/react";
import { ChevronsUpDown, Sparkles } from "lucide-react";
import { Dashboard } from "@/src/ui/components/Dashboard";
import { apiGet } from "@/src/lib/api";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import {
  SUPER_PERIODS,
  buttonPeriodLabel,
  fmtHours,
  fmtUSD,
  periodKey,
  periodTimeframe,
  usePersistedPeriod,
  periodQueryParams,
  tierFor,
  type HourlyPay,
  type Period,
} from "@/src/ui/components/WorkerHourlyPayCard";

type WorkerListItem = {
  id: string;
  displayName: string | null;
  workerType: string | null;
};

type WorkerCardRow = WorkerListItem & {
  data: HourlyPay | null;
  loading: boolean;
};

/** Sort key for the top→bottom order. Higher = closer to the top.
 *  Loading rows and rows with no logged hours sink to the bottom so
 *  the top slots reflect actual earners. */
function sortRank(row: WorkerCardRow): number {
  if (row.loading || !row.data) return -Infinity;
  if (row.data.hours <= 0) return -1;
  return row.data.ratePerHour;
}

type Props = {
  /** When set, the outer surface controls the period and the internal
   *  picker is hidden. */
  periodOverride?: Period;
  /**
   * Narrow to a specific set of workers (the Home picker's subset mode).
   * Undefined / empty = every approved worker.
   *
   * Added when this section absorbed "Today's hourly pay", which was the
   * only surface that handled subsets — without it, picking N workers
   * would have left no team view at all.
   */
  workerIds?: string[];
};

export default function AllWorkersHourlyPayCards({ periodOverride, workerIds }: Props = {}) {
  /**
   * Defaults to TODAY, not the shared DEFAULT_PERIOD ("last month").
   *
   * This section replaced the always-visible "Today's hourly pay" panel,
   * and today's numbers are what an operator expects to find on Home
   * without touching anything. Longer windows are one click away in the
   * picker. The shared DEFAULT_PERIOD is left alone — it still governs a
   * worker's own MY EARNINGS card, where "last month" is the right frame
   * for a rate.
   */
  const [internalPeriod, setInternalPeriod] = usePersistedPeriod(
    "teamPayPerHour_period",
    SUPER_PERIODS,
    { preset: "today", label: "today" },
  );
  const period = periodOverride ?? internalPeriod;
  const externallyControlled = periodOverride != null;
  const [workers, setWorkers] = useState<WorkerListItem[] | null>(null);
  // Per-worker HourlyPay results keyed by userId. Held separately from
  // the workers array so the workers list load isn't tied to N per-user
  // fetches — the list renders skeletons immediately and cards fill in
  // as each response lands.
  const [payByUser, setPayByUser] = useState<Record<string, HourlyPay | null>>({});
  const [payLoading, setPayLoading] = useState(false);

  // Load the approved-workers list once. This is stable across period
  // cycles; only the pay data reloads when the period changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await apiGet<Array<any>>("/api/admin/users?approved=true&role=WORKER");
        if (cancelled) return;
        const mapped: WorkerListItem[] = (Array.isArray(list) ? list : []).map((u) => ({
          id: String(u.id),
          displayName: u.displayName ?? null,
          workerType: u.workerType ?? null,
        }));
        // Filter client-side: the subset comes from the Home picker, which
        // already chose from this same approved-worker list.
        const wanted = new Set(workerIds ?? []);
        setWorkers(wanted.size > 0 ? mapped.filter((w) => wanted.has(w.id)) : mapped);
      } catch (err) {
        publishInlineMessage({
          type: "ERROR",
          text: getErrorMessage("Failed to load worker list.", err),
        });
        setWorkers([]);
      }
    })();
    return () => { cancelled = true; };
  }, [workerIds]);

  const loadPay = useCallback(async () => {
    if (!workers || workers.length === 0) return;
    setPayLoading(true);
    // Clear the map so all cards render their skeleton state during
    // the reload (avoids showing stale numbers under a spinning icon).
    setPayByUser({});
    try {
      // Fan out N parallel requests. Each promise settles independently
      // so one slow worker doesn't block the rest of the grid from
      // rendering. A failed fetch resolves to null; the card falls back
      // to the "—" empty state rather than crashing the panel.
      await Promise.all(
        workers.map(async (w) => {
          try {
            const qs = new URLSearchParams(periodQueryParams(period));
            qs.set("viewAsUserId", w.id);
            const d = await apiGet<HourlyPay>(
              `/api/me/hourly-pay?${qs.toString()}`,
            );
            setPayByUser((prev) => ({ ...prev, [w.id]: d }));
          } catch {
            setPayByUser((prev) => ({ ...prev, [w.id]: null }));
          }
        }),
      );
    } finally {
      setPayLoading(false);
    }
  }, [workers, periodKey(period)]);

  useEffect(() => { void loadPay(); }, [loadPay]);

  // Options for the timeframe dropdown. Keyed by `periodKey` so entries
  // stay distinguishable by more than their label.
  const periodCollection = useMemo(
    () =>
      createListCollection({
        items: SUPER_PERIODS.map((p) => ({ label: p.label, value: periodKey(p) })),
      }),
    [],
  );

  // Rows sorted highest → lowest $/hr, so the top earners lead. Workers
  // still loading OR with no hours sink to the bottom (they'd otherwise
  // slot in at rate=0 and shove the earners down as data lands). Ties
  // break by displayName for a stable order.
  const rows: WorkerCardRow[] = useMemo(() => {
    const list = workers ?? [];
    return list
      .map((w) => ({
        ...w,
        data: payByUser[w.id] ?? null,
        loading: payLoading && !(w.id in payByUser),
      }))
      .sort((a, b) => {
        const aRank = sortRank(a);
        const bRank = sortRank(b);
        if (aRank !== bRank) return bRank - aRank;
        return (a.displayName ?? "").localeCompare(b.displayName ?? "");
      });
  }, [workers, payByUser, payLoading]);

  /**
   * The single row worth seeing without opening the section.
   *
   * `rows` is already sorted by `sortRank`, which puts the highest
   * $/hr first and sinks loading rows and anyone with no logged hours —
   * so rows[0] IS the top earner, and re-sorting here would be a second
   * source of truth for the same ordering.
   *
   * Null while loading or when nobody has hours yet: a header that says
   * "Trainee Worker · $0.00/hr" because everyone is at zero reads as a
   * real result rather than an empty period.
   */
  const topEarner = useMemo(() => {
    const first = rows[0];
    if (!first || first.loading || !first.data) return null;
    if (first.data.hours <= 0) return null;
    return first;
  }, [rows]);

  if (workers === null) {
    // Same frame while loading, so the section doesn't change colour or
    // shape as the worker list settles.
    return (
      <Dashboard
        storageKey="seedlings:homeTab:teamPayPerHourOpen"
        title="Pay per hour · team"
        icon={Sparkles}
        variant="team"
      >
        <HStack gap={2}>
          <Spinner size="sm" />
          <Text fontSize="sm" color="fg.muted">Loading worker list…</Text>
        </HStack>
      </Dashboard>
    );
  }

  if (workers.length === 0) return null;

  return (
    <Dashboard
      storageKey="seedlings:homeTab:teamPayPerHourOpen"
      title="Pay per hour · team"
      icon={Sparkles}
      variant="team"
      timeframe={
        externallyControlled
          ? undefined
          : periodTimeframe(SUPER_PERIODS, period, setInternalPeriod)
      }
      onRefresh={loadPay}
      refreshing={payLoading}
      /* Collapsed, the section still answers "over what window, and who's
         earning most" — the two questions the grid exists to answer.
         `collapsedSummarySlot` (not `summarySlot`) so it doesn't duplicate
         the cards that already state it prominently when open.

         THE TIMEFRAME LEADS, and shows even when nobody has hours. A rate
         with no window attached is ambiguous — "$24.92/hr" means something
         very different over today than over last year — and collapsing the
         section hides the picker that would otherwise tell you. */
      collapsedSummarySlot={
        <Text fontSize="xs" color="purple.800" lineClamp={1}>
          {period.label}
          {topEarner ? (
            <>
              {" · top: "}
              {topEarner.displayName ?? "(unnamed)"}{" "}
              {/* `$${rate.toFixed(2)}`, matching the card below EXACTLY.
                  fmtUSD rounds to whole dollars, so the header read "$25"
                  over a card reading "$24.92" — two different numbers for
                  the same figure, one line apart. */}
              <Box as="span" fontWeight="bold">
                ${topEarner.data!.ratePerHour.toFixed(2)}
              </Box>
              /hr
            </>
          ) : null}
        </Text>
      }
    >
      <Box position="relative">
        {/* Refreshing state, scoped to this section — same treatment as
            Insights. Without it, hitting refresh spun only the icon while
            stale figures sat there looking current. An overlay rather than
            unmounting keeps the grid's height, so nothing below jumps. */}


        {/* Responsive grid — 1 card wide on phones, up to 4 across on
            desktop. Each card is small enough to scan at a glance but
            keeps the tier styling that makes the single-worker card
            recognizable. */}
        <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4 }} gap={2}>
          {rows.map((row) => (
            <MiniPayCard key={row.id} row={row} />
          ))}
        </SimpleGrid>
      </Box>
    </Dashboard>
  );
}

function MiniPayCard({ row }: { row: WorkerCardRow }) {
  const name = row.displayName ?? "(unnamed)";

  if (row.loading || !row.data) {
    // Skeleton — matches the full card height so the grid doesn't
    // jump on load.
    return (
      <Card.Root variant="outline" bg="gray.50" borderColor="gray.200">
        <Card.Body p={3}>
          <VStack align="start" gap={1}>
            <Text fontSize="xs" fontWeight="semibold" color="fg.muted" truncate w="full">
              {name}
            </Text>
            <HStack gap={2}>
              <Spinner size="xs" />
              <Text fontSize="xs" color="fg.muted">Loading…</Text>
            </HStack>
          </VStack>
        </Card.Body>
      </Card.Root>
    );
  }

  const rate = row.data.ratePerHour;
  const tier = tierFor(rate);
  const hasHours = row.data.hours > 0;

  return (
    <Card.Root
      variant="outline"
      bg={tier.bg}
      borderColor={tier.border}
      borderWidth={tier.animation ? "2px" : "1px"}
    >
      <Card.Body p={3}>
        <HStack justify="space-between" align="start" mb={1} gap={1}>
          <Text
            fontSize="xs"
            fontWeight="semibold"
            color={tier.fg}
            truncate
            flex={1}
            minW={0}
          >
            {name}
          </Text>
          {tier.sparkle && (
            <Box color={tier.numberFg} flexShrink={0}>
              <Sparkles size={12} />
            </Box>
          )}
        </HStack>

        {hasHours ? (
          <>
            <HStack align="baseline" gap={0.5}>
              <Text
                fontSize="2xl"
                fontWeight="bold"
                color={tier.numberFg}
                lineHeight="1"
              >
                ${rate.toFixed(2)}
              </Text>
              <Text fontSize="xs" color={tier.fg} fontWeight="medium">/hr</Text>
            </HStack>
            <Text fontSize="2xs" color={tier.fg} opacity={0.85} mt={1}>
              {tier.label}
            </Text>
            <Text fontSize="2xs" color={tier.fg} opacity={0.75} mt={1}>
              {fmtUSD(row.data.dollars)} · {fmtHours(row.data.hours)} ·{" "}
              {row.data.jobs} job{row.data.jobs === 1 ? "" : "s"}
            </Text>
          </>
        ) : (
          <VStack align="start" gap={0.5}>
            <Text fontSize="lg" fontWeight="bold" color={tier.fg} lineHeight="1">—</Text>
            <Text fontSize="2xs" color={tier.fg} opacity={0.7}>
              No hours logged
            </Text>
          </VStack>
        )}
      </Card.Body>
    </Card.Root>
  );
}
