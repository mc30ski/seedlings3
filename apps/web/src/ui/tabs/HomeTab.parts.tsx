"use client";

// ─────────────────────────────────────────────────────────────────────────────
// HomeTab.parts — pieces added on top of the baseline HomeTab layout
// for the blended-role Home tab.
//
// Admin scope does NOT get a separate section here — the shipped
// AdminViewAsSelector (re-exported from JobsTab.parts) is mounted
// at the top of HomeTab and drives the SAME hero/tile/chart area
// with aggregate / subset / single-worker data. That matches how the
// shipped Admin → Work → Home tab works: default = All Workers
// aggregate, pick to narrow.
//
// This file only contains the Super-scope Operations rollup, which
// mirrors OpsSummaryStrip in JobsTab — a Dashboard-wrapped
// stats-grid of the operations pulse (money, jobs, equipment,
// team & clients).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Box, Button, Card, HStack, IconButton, Select, SimpleGrid, Spinner, Text, VStack, createListCollection } from "@chakra-ui/react";
import {
  Activity, AlertTriangle, Briefcase, Building2, Calendar, CheckCircle2,
  ChevronsUpDown, Clock, DollarSign, FileText, Hammer, Percent, RefreshCw,
  Star, TrendingDown, TrendingUp, Truck, Users, Wrench, XCircle,
} from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { bizAddDays, bizToday, fmtDateKey, type EtDateKey } from "@/src/lib/dates";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import MiniStatCard from "@/src/ui/components/MiniStatCard";
import {
  ADMIN_PERIODS,
  DEFAULT_PERIOD,
  SUPER_PERIODS,
  WORKER_PERIODS,
  periodKey,
  periodTimeframe,
  usePersistedPeriod,
  periodToRange,
  type Period,
} from "@/src/ui/components/WorkerHourlyPayCard";



// ─── Operations panel (super scope) ──────────────────────────────────────
// Dashboard-collapsible operations rollup mounted at the top of the
// Home tab when scope.isSuper. One period button drives every
// section (money / jobs / hourly-pay / equipment / team & clients).
type OperationsResponse = {
  jobs: {
    scheduled: number;
    inProgress: number;
    completed: number;
    canceled: number;
    overdue: number;
    unclaimed: number;
  };
  financial: {
    totalRevenue: number;
    totalExpenses: number;
    netRevenue: number;
    totalPlatformFees: number;
    totalBusinessMargin: number;
    totalTopUps: number;
    totalOwnerEarnings: number;
    avgJobPrice: number;
    paymentsByMethod: Record<string, number>;
  };
  team: {
    activeInWindow: number;
    workersByTypeInWindow: Record<string, number>;
    topWorkers: Array<{ name: string; jobs: number; earnings: number }>;
  };
  equipment: {
    total: number;
    available: number;
    checkedOut: number;
    reserved: number;
    inMaintenance: number;
    windowDays: number;
    windowCheckouts: number;
    windowIncome: number;
    windowDistinctUsed: number;
  };
  estimates: {
    pending: number;
    accepted: number;
    rejected: number;
  };
  clients: {
    workedWithInWindow: number;
    newInWindow: number;
    vipWithWorkInWindow: number;
  };
  unapprovedHoursInWindow: number;
};

function fmtUSD(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
function fmtUSDPrecise(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const DEFAULT_SUPER_PERIOD: Period = { preset: "today", label: "today" };

export function OperationsPanel({
  onReady,
}: {
  /**
   * Hands the section's loader, busy flag and collapsed-header summary up
   * to the Dashboard wrapper — the panel owns the data, the wrapper owns
   * the frame.
   */
  onReady?: (api: {
    refresh: () => Promise<void>;
    loading: boolean;
    summary: React.ReactNode;
    timeframe: ReturnType<typeof periodTimeframe>;
  }) => void;
} = {}) {
  const [period, setPeriod] = usePersistedPeriod(
    "homeInsights_period",
    SUPER_PERIODS,
    DEFAULT_SUPER_PERIOD,
  );
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => periodToRange(period), [period]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      const d = await apiGet<OperationsResponse>(`/api/admin/operations?${qs.toString()}`);
      setData(d);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load operations dashboard.", err),
      });
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);
  /**
   * Collapsed-header summary: the timeframe plus the three figures an
   * operator actually opens this section for.
   *
   * The timeframe LEADS and always shows — collapsing hides the picker, so
   * "$3,125" with no window attached is unreadable. Same rule as the pay
   * sections.
   */
  const summaryNode = useMemo(
    () => (
      <Text fontSize="xs" color="orange.900" lineClamp={1}>
        {period.label}
        {data ? (
          <>
            {" · "}
            <Box as="span" fontWeight="bold">{fmtUSD(data.financial.totalRevenue)}</Box> rev
            {" · "}
            <Box as="span" fontWeight="bold">{fmtUSD(data.financial.netRevenue)}</Box> net
            {" · "}
            <Box as="span" fontWeight="bold">{fmtInt(data.jobs.completed)}</Box> done
          </>
        ) : null}
      </Text>
    ),
    [period.label, data],
  );

  useEffect(() => {
    onReady?.({
      refresh: load,
      loading,
      summary: summaryNode,
      timeframe: periodTimeframe(SUPER_PERIODS, period, setPeriod),
    });
  }, [onReady, load, loading, summaryNode, period]);

  // Chakra Select, never a native <select> — house rule. The collection is
  // keyed by `periodKey` so "days:0" (all time) and "preset:today" are
  // distinguishable; two entries could otherwise collide on label alone.
  const periodCollection = useMemo(
    () =>
      createListCollection({
        items: SUPER_PERIODS.map((p) => ({ label: p.label, value: periodKey(p) })),
      }),
    [],
  );

  // Renders bare content — the caller (HomeTab) wraps this in the
  // orange Insights card so the Super visual language is consistent
  // across tabs (matches JobsTab + InventoryTab Insights sections).
  return (
    <VStack align="stretch" gap={3}>


        {/* Section 1 — Money. */}
        <OpsSection title="Money" loading={loading && !data}>
          {data && (
            <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
              <MiniStatCard
                label="Revenue"
                value={fmtUSD(data.financial.totalRevenue)}
                hint={data.jobs.completed > 0 ? `avg ${fmtUSDPrecise(data.financial.avgJobPrice)}/job` : undefined}
                color="green"
                icon={DollarSign}
              />
              <MiniStatCard
                label="Expenses"
                value={fmtUSD(data.financial.totalExpenses)}
                color="orange"
                icon={TrendingDown}
              />
              <MiniStatCard
                label="Net"
                value={fmtUSD(data.financial.netRevenue)}
                hint="revenue − expenses"
                color={data.financial.netRevenue < 0 ? "red" : "green"}
                icon={data.financial.netRevenue < 0 ? TrendingDown : TrendingUp}
              />
              <MiniStatCard
                label="Business margin"
                value={fmtUSD(data.financial.totalBusinessMargin)}
                hint="operator's cut"
                color="teal"
                icon={Percent}
              />
              <MiniStatCard
                label="Owner earnings"
                value={fmtUSD(data.financial.totalOwnerEarnings)}
                color="purple"
                icon={Star}
              />
              <MiniStatCard
                label="Top-ups paid"
                value={fmtUSD(data.financial.totalTopUps)}
                hint="employees made whole"
                color="blue"
                icon={Users}
              />
              <MiniStatCard
                label="Processor fees"
                value={fmtUSD(data.financial.totalPlatformFees)}
                color="gray"
                icon={Percent}
              />
              <MiniStatCard
                label="Avg job"
                value={
                  data.jobs.completed > 0
                    ? fmtUSDPrecise(data.financial.avgJobPrice)
                    : "—"
                }
                hint={`${fmtInt(data.jobs.completed)} completed`}
                color="gray"
                icon={Briefcase}
              />
            </SimpleGrid>
          )}
        </OpsSection>

        {/* Section 2 — Jobs. */}
        <OpsSection title="Jobs" loading={loading && !data}>
          {data && (
            <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
              <MiniStatCard
                label="Completed"
                value={fmtInt(data.jobs.completed)}
                color="green"
                icon={CheckCircle2}
              />
              <MiniStatCard
                label="In progress"
                value={fmtInt(data.jobs.inProgress)}
                color="blue"
                icon={Activity}
              />
              <MiniStatCard
                label="Scheduled"
                value={fmtInt(data.jobs.scheduled)}
                color="gray"
                icon={Calendar}
              />
              <MiniStatCard
                label="Overdue"
                value={fmtInt(data.jobs.overdue)}
                color={data.jobs.overdue > 0 ? "red" : "gray"}
                icon={AlertTriangle}
              />
              <MiniStatCard
                label="Unclaimed"
                value={fmtInt(data.jobs.unclaimed)}
                color={data.jobs.unclaimed > 0 ? "orange" : "gray"}
                icon={AlertTriangle}
              />
              <MiniStatCard
                label="Canceled"
                value={fmtInt(data.jobs.canceled)}
                color={data.jobs.canceled > 0 ? "red" : "gray"}
                icon={XCircle}
              />
              <MiniStatCard
                label="Unapproved hours"
                value={fmtInt(data.unapprovedHoursInWindow)}
                hint="await review"
                color={data.unapprovedHoursInWindow > 0 ? "orange" : "gray"}
                icon={Clock}
              />
              <MiniStatCard
                label="Est. pending"
                value={fmtInt(data.estimates.pending)}
                hint={
                  data.estimates.accepted + data.estimates.rejected > 0
                    ? `${fmtInt(data.estimates.accepted)} won · ${fmtInt(data.estimates.rejected)} lost`
                    : undefined
                }
                color={data.estimates.pending > 0 ? "orange" : "gray"}
                icon={FileText}
              />
            </SimpleGrid>
          )}
        </OpsSection>

        {/* NOTE: "Pay per hour · team" is deliberately NOT a
            section here. It lives on Home OUTSIDE this panel, where it has
            always been, with its own timeframe picker. It was mounted here
            as well, so on Super Home the section rendered TWICE the moment
            Insights was expanded (2026-08-27).

            Don't "restore" it as a section to make it follow the Insights
            period — it is a per-worker pay view, not part of the
            operations rollup, and the operator wants it standing on its
            own. */}

        {/* Section 4 — Equipment. */}
        <OpsSection title="Equipment" loading={loading && !data}>
          {data && (
            <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
              <MiniStatCard
                label="Available"
                value={fmtInt(data.equipment.available)}
                hint={`of ${fmtInt(data.equipment.total)} total`}
                color="green"
                icon={Wrench}
              />
              <MiniStatCard
                label="Checked out"
                value={fmtInt(data.equipment.checkedOut)}
                color="blue"
                icon={Truck}
              />
              <MiniStatCard
                label="Reserved"
                value={fmtInt(data.equipment.reserved)}
                color="teal"
                icon={Wrench}
              />
              <MiniStatCard
                label="In maintenance"
                value={fmtInt(data.equipment.inMaintenance)}
                color={data.equipment.inMaintenance > 0 ? "orange" : "gray"}
                icon={Hammer}
              />
              <MiniStatCard
                label="Rental income"
                value={fmtUSD(data.equipment.windowIncome)}
                hint={`over ${fmtInt(data.equipment.windowDays)}d`}
                color="green"
                icon={DollarSign}
              />
              <MiniStatCard
                label="Checkouts"
                value={fmtInt(data.equipment.windowCheckouts)}
                hint="this period"
                color="gray"
                icon={Truck}
              />
              <MiniStatCard
                label="Distinct used"
                value={fmtInt(data.equipment.windowDistinctUsed)}
                hint={
                  data.equipment.total > 0
                    ? `${Math.round(
                        (data.equipment.windowDistinctUsed / data.equipment.total) * 100,
                      )}% of fleet`
                    : undefined
                }
                color="cyan"
                icon={Percent}
              />
              <MiniStatCard
                label="Fleet idle"
                value={fmtInt(
                  Math.max(
                    0,
                    data.equipment.total - data.equipment.windowDistinctUsed,
                  ),
                )}
                hint="never touched"
                color={
                  data.equipment.total > 0 &&
                  data.equipment.total - data.equipment.windowDistinctUsed >=
                    data.equipment.total / 2
                    ? "orange"
                    : "gray"
                }
                icon={AlertTriangle}
              />
            </SimpleGrid>
          )}
        </OpsSection>

        {/* Section 5 — Team + Clients. */}
        <OpsSection title="Team & Clients" loading={loading && !data}>
          {data && (
            <SimpleGrid columns={{ base: 2, sm: 3, md: 4 }} gap={2}>
              <MiniStatCard
                label="Active workers"
                value={fmtInt(data.team.activeInWindow)}
                hint="had ≥ 1 job"
                color={data.team.activeInWindow > 0 ? "blue" : "gray"}
                icon={Users}
              />
              <MiniStatCard
                label="Employees"
                value={fmtInt(
                  (data.team.workersByTypeInWindow["EMPLOYEE"] ?? 0) +
                    (data.team.workersByTypeInWindow["TRAINEE"] ?? 0),
                )}
                hint="+ trainees"
                color="cyan"
                icon={Users}
              />
              <MiniStatCard
                label="Contractors"
                value={fmtInt(data.team.workersByTypeInWindow["CONTRACTOR"] ?? 0)}
                color="teal"
                icon={Users}
              />
              <MiniStatCard
                label="Clients served"
                value={fmtInt(data.clients.workedWithInWindow)}
                hint={
                  data.clients.vipWithWorkInWindow > 0
                    ? `${fmtInt(data.clients.vipWithWorkInWindow)} VIP`
                    : undefined
                }
                color="purple"
                icon={Building2}
              />
              <MiniStatCard
                label="New clients"
                value={fmtInt(data.clients.newInWindow)}
                hint="signed up"
                color={data.clients.newInWindow > 0 ? "green" : "gray"}
                icon={Star}
              />
              <MiniStatCard
                label="VIP served"
                value={fmtInt(data.clients.vipWithWorkInWindow)}
                hint={
                  data.clients.workedWithInWindow > 0
                    ? `${Math.round(
                        (data.clients.vipWithWorkInWindow /
                          data.clients.workedWithInWindow) *
                          100,
                      )}% of clients`
                    : undefined
                }
                color="purple"
                icon={Star}
              />
              {data.team.topWorkers.slice(0, 2).map((w, i) => (
                <MiniStatCard
                  key={`${w.name}-${i}`}
                  label={i === 0 ? "Top worker" : "Runner-up"}
                  value={w.name}
                  hint={`${fmtInt(w.jobs)} jobs · ${fmtUSD(w.earnings)}`}
                  color={i === 0 ? "green" : "cyan"}
                  icon={i === 0 ? Star : Users}
                />
              ))}
            </SimpleGrid>
          )}
        </OpsSection>
    </VStack>
  );
}

// Titled outlined card wrapper for each subsection of the
// OPERATIONS rollup (Money, Jobs, Equipment, Team & Clients).
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

// ─── My Vehicles (per-driver) ────────────────────────────────────────────
// Home → MY VEHICLES. One row per vehicle assigned to the scoped worker,
// summarising THEIR driving on it over the section's timeframe.
//
// Scoped to the driver, not the vehicle: two workers can share the crew
// van, and "how far did the van go" is the fleet question the Super
// Vehicles tab answers. This section answers "how far did I take it".
//
// Self-hiding: a worker with no assigned vehicle gets nothing at all —
// not an empty frame. Same rule the MileageStrip follows, and the reason
// the section can sit unconditionally in the page body.
export function MyVehiclesSection({
  viewAsUserId,
  onReady,
}: {
  /** Set when an admin has the Home worker picker on ONE worker. The
   *  endpoint is view-as aware, so the rows belong to that worker. */
  viewAsUserId?: string | null;
  onReady?: (api: {
    refresh: () => Promise<void>;
    loading: boolean;
    summary: React.ReactNode;
    timeframe: ReturnType<typeof periodTimeframe>;
    /** False once we know the scoped worker has no vehicles — the caller
     *  unmounts the whole frame rather than render an empty section. */
    hasVehicles: boolean;
  }) => void;
} = {}) {
  const isAdminView = !!viewAsUserId;
  // Same split as the pay card: a worker gets the short list ("how am I
  // doing lately"), an admin inspecting one worker gets the long one.
  const periods = isAdminView ? ADMIN_PERIODS : WORKER_PERIODS;
  const [period, setPeriod] = usePersistedPeriod(
    "homeMyVehicles_period",
    periods,
    DEFAULT_PERIOD,
  );
  const [rows, setRows] = useState<VehicleSummaryRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  const range = useMemo(() => periodToRange(period), [period]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ from: range.from, to: range.to });
      if (viewAsUserId) qs.set("viewAsUserId", viewAsUserId);
      const d = await apiGet<VehicleSummaryRow[]>(`/api/me/vehicle-summary?${qs.toString()}`);
      setRows(Array.isArray(d) ? d : []);
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Failed to load vehicle summary.", err),
      });
      // Leave the previous rows in place on a failed refresh — blanking
      // them would collapse the section out from under the reader.
      setRows((prev) => prev ?? []);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, viewAsUserId]);

  useEffect(() => { void load(); }, [load]);

  // Re-read when a mileage session starts or stops anywhere on the page,
  // so the totals agree with the strip the reader just used.
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener("seedlings:workday-changed", onChange);
    return () => window.removeEventListener("seedlings:workday-changed", onChange);
  }, [load]);

  const totals = useMemo(() => {
    const list = rows ?? [];
    return {
      miles: list.reduce((s, r) => s + r.totalMiles, 0),
      sessions: list.reduce((s, r) => s + r.sessionCount, 0),
      unapproved: list.reduce((s, r) => s + r.unapprovedMiles, 0),
      open: list.reduce((s, r) => s + r.openSessionCount, 0),
    };
  }, [rows]);

  // Collapsed-header summary. The timeframe LEADS and always shows —
  // "128 mi" with no window attached is unreadable. Same rule as the pay
  // and Insights sections.
  const summaryNode = useMemo(
    () => (
      <Text fontSize="xs" color="fg.muted" lineClamp={1}>
        {period.label}
        {rows ? (
          <>
            {" · "}
            <Box as="span" fontWeight="bold">{fmtMiles(totals.miles)}</Box> mi
            {" · "}
            <Box as="span" fontWeight="bold">{totals.sessions}</Box>{" "}
            {totals.sessions === 1 ? "trip" : "trips"}
            {totals.open > 0 && (
              <>
                {" · "}
                <Box as="span" fontWeight="bold" color="orange.700">
                  {totals.open} driving now
                </Box>
              </>
            )}
          </>
        ) : null}
      </Text>
    ),
    [period.label, rows, totals],
  );

  useEffect(() => {
    onReady?.({
      refresh: load,
      loading,
      summary: summaryNode,
      timeframe: periodTimeframe(periods, period, setPeriod),
      // `rows === null` means "not loaded yet" — treat that as HAS
      // vehicles so the frame doesn't flash out and back in on every
      // period change. Only a loaded, genuinely empty list hides it.
      hasVehicles: rows === null || rows.length > 0,
    });
  }, [onReady, load, loading, summaryNode, periods, period, setPeriod, rows]);

  if (loading && rows === null) {
    return <HStack justify="center" py={4}><Spinner size="sm" /></HStack>;
  }
  if (!rows || rows.length === 0) return null;

  return (
    /* Stable hook for the e2e spec. The section's own title text sits in
       the Dashboard header ABOVE this subtree, so a "div containing the
       title" selector resolves to the header, not the content. */
    <VStack align="stretch" gap={3} data-testid="my-vehicles">
      {/* Fleet-wide-for-me totals first, then the per-vehicle detail —
          same shape as the Insights sections: the number you came for,
          then the breakdown that explains it. */}
      <SimpleGrid columns={{ base: 2, sm: 4 }} gap={2}>
        <MiniStatCard label="Miles" value={fmtMiles(totals.miles)} color="blue" icon={Truck} />
        <MiniStatCard
          label="Trips"
          value={String(totals.sessions)}
          hint={totals.open > 0 ? `${totals.open} still open` : undefined}
          color={totals.open > 0 ? "orange" : "gray"}
        />
        <MiniStatCard label="Vehicles" value={String(rows.length)} color="gray" />
        <MiniStatCard
          label="Unapproved"
          value={fmtMiles(totals.unapproved)}
          hint={totals.unapproved > 0 ? "awaiting review" : "all reviewed"}
          color={totals.unapproved > 0 ? "orange" : "green"}
        />
      </SimpleGrid>

      <VStack align="stretch" gap={2}>
        {rows.map((r) => {
          const modelLine = [r.year, r.make, r.vehicleModel].filter(Boolean).join(" ");
          return (
            <Box
              key={r.vehicleId}
              p={2.5}
              borderWidth="1px"
              borderRadius="md"
              borderColor={r.openSessionCount > 0 ? "orange.300" : "gray.200"}
              bg={r.openSessionCount > 0 ? "orange.50" : "white"}
            >
              <HStack justify="space-between" align="flex-start" gap={2} wrap="wrap">
                <VStack align="start" gap={0} minW={0} flex="1">
                  <HStack gap={2} wrap="wrap">
                    <Text fontSize="sm" fontWeight="semibold" lineClamp={1}>
                      {r.displayName}
                    </Text>
                    {r.openSessionCount > 0 && (
                      <Badge size="sm" colorPalette="orange" variant="solid" fontSize="2xs">
                        Driving now
                      </Badge>
                    )}
                  </HStack>
                  <HStack gap={2} wrap="wrap" fontSize="2xs" color="fg.muted">
                    {modelLine && <Text>{modelLine}</Text>}
                    {r.plate && <Text>· {r.plate}</Text>}
                    {r.currentOdometer != null && (
                      <Text>· {r.currentOdometer.toLocaleString()} mi on the clock</Text>
                    )}
                  </HStack>
                </VStack>
                <VStack align="end" gap={0} flexShrink={0}>
                  <Text fontSize="md" fontWeight="bold" lineHeight="1.1">
                    {fmtMiles(r.totalMiles)} <Text as="span" fontSize="2xs" fontWeight="normal">mi</Text>
                  </Text>
                  <Text fontSize="2xs" color="fg.muted">
                    {r.sessionCount} {r.sessionCount === 1 ? "trip" : "trips"}
                    {r.lastDrivenOn ? ` · last ${fmtDateKey(r.lastDrivenOn as EtDateKey)}` : ""}
                  </Text>
                </VStack>
              </HStack>
              {r.unapprovedMiles > 0 && (
                <Text fontSize="2xs" color="orange.700" mt={1}>
                  {fmtMiles(r.unapprovedMiles)} mi still awaiting review
                </Text>
              )}
              {r.sessionCount === 0 && r.openSessionCount === 0 && (
                <Text fontSize="2xs" color="fg.muted" mt={1}>
                  Nothing recorded in this window.
                </Text>
              )}
            </Box>
          );
        })}
      </VStack>
    </VStack>
  );
}

type VehicleSummaryRow = {
  vehicleId: string;
  displayName: string;
  make: string | null;
  vehicleModel: string | null;
  year: number | null;
  plate: string | null;
  currentOdometer: number | null;
  totalMiles: number;
  approvedMiles: number;
  unapprovedMiles: number;
  sessionCount: number;
  openSessionCount: number;
  lastDrivenOn: string | null;
};

/** Miles read as whole numbers everywhere else in the app; a trip of
 *  4.5 keeps its half so short hops don't all render as "5". */
function fmtMiles(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}
