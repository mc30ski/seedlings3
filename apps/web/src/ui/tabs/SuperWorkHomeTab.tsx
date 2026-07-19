// Super Work Home — operations pulse dashboard.
//
// One tab that answers "what's happening right now?" for money, jobs,
// equipment, team activity, and clients — all sections styled after
// the "Approximate pay per hour · Team" grid so the whole page reads
// as a single overview. One period button at the top drives every
// section (rolling window ending today). Fetches:
//
//   • /api/admin/operations?from=…&to=…  — big rollup (money / jobs /
//     equipment / clients / recent audit)
//   • /api/me/hourly-pay?viewAsUserId=… (via AllWorkersHourlyPayCards)
//
// Super-only surface — mounted from pages/index.tsx under the Super
// outer tab, "Work" category, "home" inner value.

"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  HStack,
  IconButton,
  SimpleGrid,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  Activity,
  AlertTriangle,
  Briefcase,
  Building2,
  Calendar,
  CheckCircle2,
  ChevronsUpDown,
  Clock,
  DollarSign,
  FileText,
  Percent,
  RefreshCw,
  Star,
  Hammer,
  TrendingDown,
  TrendingUp,
  Truck,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { bizAddDays, bizToday } from "@/src/lib/lib";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";
import {
  ADMIN_PERIODS,
  buttonPeriodLabel,
} from "@/src/ui/components/WorkerHourlyPayCard";

// SuperWorkHome-specific period list. Same day counts as the pay-per-
// hour card's ADMIN_PERIODS, but the day-1 slot is relabeled "today" —
// the dashboard's from/to range is a calendar-day span (from=to=today
// when days=1), which matches the operator's mental model of "what
// happened today". The pay-per-hour card still passes through days=1
// to /me/hourly-pay (a rolling 24h window), which is close enough to
// "today's earnings" for someone working a normal shift today.
const SUPER_PERIODS: Array<{ days: number; label: string }> = [
  { days: 1, label: "today" },
  ...ADMIN_PERIODS.slice(1),
];
import AllWorkersHourlyPayCards from "@/src/ui/components/AllWorkersHourlyPayCards";
import MiniStatCard, { type MiniStatColor } from "@/src/ui/components/MiniStatCard";

// Shape of the /admin/operations response — inlined here rather than
// imported from a shared type file because the endpoint's return type
// is Fastify-inferred (no shared d.ts). Kept narrow to just the fields
// this dashboard reads.
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

// Rolling window helpers.
//   to   = today (ET)
//   from = today − (days − 1)
// Matches the "past N days ending today" model the pay-per-hour card
// uses so the dashboard's window and the AllWorkersHourlyPayCards
// grid stay in sync. `days = 1` collapses to a single-day range
// (today itself).
function computeRange(days: number): { from: string; to: string } {
  const to = bizToday();
  const from = bizAddDays(to, -(Math.max(1, days) - 1));
  return { from, to };
}

// Landing period — the dashboard opens on "today" so the Super sees
// what's happening right now first, then cycles back through the
// rolling windows for longer-arc context. Distinct from the pay-per-
// hour card's DEFAULT_DAYS (30) which is a "how am I doing lately"
// default appropriate for a single-worker earnings view.
const DEFAULT_SUPER_DAYS = 1;

export default function SuperWorkHomeTab() {
  const [days, setDays] = useState<number>(DEFAULT_SUPER_DAYS);
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const range = useMemo(() => computeRange(days), [days]);

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

  const period =
    SUPER_PERIODS.find((p) => p.days === days) ??
    SUPER_PERIODS.find((p) => p.days === DEFAULT_SUPER_DAYS) ??
    SUPER_PERIODS[0];
  // "today" reads standalone; every other label reads as "last {label}".
  const periodDisplay = period.label === "today" ? "today" : buttonPeriodLabel(period.label);

  function cyclePeriod() {
    const idx = SUPER_PERIODS.findIndex((p) => p.days === days);
    const next = SUPER_PERIODS[(idx + 1) % SUPER_PERIODS.length];
    setDays(next.days);
  }

  return (
    <VStack align="stretch" gap={4} pb={6}>
      {/* Sticky-ish period header — one control drives every section. */}
      <Card.Root variant="outline" bg="gray.50" borderColor="gray.200">
        <Card.Body p={3}>
          <HStack justify="space-between" align="center" wrap="wrap" gap={2}>
            <VStack align="start" gap={0}>
              <Text fontSize="sm" fontWeight="semibold">
                Operations pulse
              </Text>
              <Text fontSize="xs" color="fg.muted">
                {range.from} → {range.to} · {periodDisplay}
              </Text>
            </VStack>
            <HStack gap={1}>
              <Button
                size="sm"
                variant="outline"
                onClick={cyclePeriod}
                title="Change period"
              >
                {periodDisplay}
                <Box as="span" ml={1} display="inline-flex" opacity={0.7}>
                  <ChevronsUpDown size={12} />
                </Box>
              </Button>
              <IconButton
                aria-label="Refresh dashboard"
                size="sm"
                variant="ghost"
                onClick={() => void load()}
                loading={loading}
              >
                <RefreshCw size={14} />
              </IconButton>
            </HStack>
          </HStack>
        </Card.Body>
      </Card.Root>

      {/* Section 1 — Money.
          Neutral-toned cards (money isn't good/bad in the abstract);
          Net revenue swings its color by sign so a loss reads red. */}
      <Section
        title="Money · This period"
        loading={loading && !data}
      >
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
      </Section>

      {/* Section 2 — Jobs.
          Colored by health: green = shipped, red = trouble, orange
          = attention. Numbers here scan the same as the pay grid so a
          Super can eyeball the whole tab. */}
      <Section title="Jobs · This period" loading={loading && !data}>
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
      </Section>

      {/* Section 3 — Approximate pay per hour · team.
          Reuses the same grid as Admin Work Home; the outer period
          button drives it via daysOverride so the whole tab shares
          one window. */}
      <AllWorkersHourlyPayCards daysOverride={days} />

      {/* Section 4 — Equipment.
          "Now" snapshot (BSD-independent) plus the window-scoped
          usage. Utilization = distinctUsed / total when we have both. */}
      <Section title="Equipment · Now" loading={loading && !data}>
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
      </Section>

      {/* Section 5 — Team + Clients.
          "Who worked this window" and "who did we serve this window."
          Answers the two questions a Super asks most often when
          catching up on the business. */}
      <Section title="Team & Clients · This period" loading={loading && !data}>
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
      </Section>
    </VStack>
  );
}

/** Simple titled section wrapper — matches the header treatment on
 *  AllWorkersHourlyPayCards so the whole tab reads as one visual family. */
function Section({
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
